import { apiError, getActor, json, readJson } from './http';
import type { DatabaseEnv } from './publishers';

export type MonitoringEmailDraft = {
  senderName: string;
  senderEmail: string;
  replyTo: string;
  to: string;
  cc: string;
  subjectTemplate: string;
  bodyTemplate: string;
  bodyFormat: 'plain' | 'html';
  attachmentMode: 'full-corrected' | 'missing-only' | 'expected-only';
  attachmentNameTemplate: string;
};

type DraftRow = {
  settings_json: string;
  updated_by: string | null;
  updated_at: string;
};

const EMPTY_DRAFT: MonitoringEmailDraft = {
  senderName: '',
  senderEmail: '',
  replyTo: '',
  to: '',
  cc: '',
  subjectTemplate: '',
  bodyTemplate: '',
  bodyFormat: 'plain',
  attachmentMode: 'full-corrected',
  attachmentNameTemplate: '{{domain}}-ads.txt',
};

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured.', 503);
}

function text(value: unknown, maxLength: number): string {
  return String(value ?? '').trim().slice(0, maxLength);
}

function validEmail(value: string): boolean {
  return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeDraft(value: unknown): { draft: MonitoringEmailDraft; errors: string[] } {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const draft: MonitoringEmailDraft = {
    senderName: text(input.senderName, 120),
    senderEmail: text(input.senderEmail, 254).toLowerCase(),
    replyTo: text(input.replyTo, 254).toLowerCase(),
    to: text(input.to, 4_000),
    cc: text(input.cc, 4_000),
    subjectTemplate: text(input.subjectTemplate, 500),
    bodyTemplate: text(input.bodyTemplate, 50_000),
    bodyFormat: input.bodyFormat === 'html' ? 'html' : 'plain',
    attachmentMode: ['full-corrected', 'missing-only', 'expected-only'].includes(String(input.attachmentMode))
      ? input.attachmentMode as MonitoringEmailDraft['attachmentMode']
      : 'full-corrected',
    attachmentNameTemplate: text(input.attachmentNameTemplate, 180) || '{{domain}}-ads.txt',
  };
  const errors: string[] = [];
  if (!validEmail(draft.senderEmail)) errors.push('Sender email is not valid.');
  if (!validEmail(draft.replyTo)) errors.push('Reply-To email is not valid.');
  return { draft, errors };
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1').bind(siteId).first<{ id: string }>();
  return Boolean(row);
}

async function ensureTable(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS monitoring_email_drafts (
    site_id TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL DEFAULT '{}',
    updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
  )`).run();
}

function isMissingTable(error: unknown): boolean {
  return /no such table:\s*monitoring_email_drafts/i.test(error instanceof Error ? error.message : String(error));
}

export async function getMonitoringEmailDraft(env: DatabaseEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  let row: DraftRow | null = null;
  try {
    row = await env.DB.prepare(
      'SELECT settings_json, updated_by, updated_at FROM monitoring_email_drafts WHERE site_id = ? LIMIT 1',
    ).bind(siteId).first<DraftRow>();
  } catch (error) {
    if (!isMissingTable(error)) {
      return apiError('Monitoring email draft could not be loaded.', 500, error instanceof Error ? error.message : String(error));
    }
  }

  if (!row) {
    return json({
      ok: true,
      saved: false,
      settings: EMPTY_DRAFT,
      updatedBy: null,
      updatedAt: null,
      storage: 'not-created',
    });
  }

  let stored: unknown = {};
  try {
    stored = JSON.parse(row.settings_json);
  } catch {
    stored = {};
  }
  const { draft } = normalizeDraft(stored);
  return json({
    ok: true,
    saved: true,
    settings: draft,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    storage: 'd1',
  });
}

export async function updateMonitoringEmailDraft(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  let body: { settings?: unknown };
  try {
    body = await readJson<{ settings?: unknown }>(request);
  } catch (error) {
    return apiError('Monitoring email draft JSON could not be read.', 400, error instanceof Error ? error.message : String(error));
  }
  const { draft, errors } = normalizeDraft(body.settings);
  if (errors.length) return apiError('Monitoring email draft is not valid.', 422, errors);

  const actor = getActor(request);
  const now = new Date().toISOString();
  try {
    await ensureTable(env.DB);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO monitoring_email_drafts (
          site_id, settings_json, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(site_id) DO UPDATE SET
          settings_json = excluded.settings_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at`)
        .bind(siteId, JSON.stringify(draft), actor, now, now),
      env.DB.prepare(`INSERT INTO audit_log (
          id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
        ) VALUES (?, ?, 'monitoring.email_draft.saved', ?, 'monitoring_email_draft', ?, ?, ?)`)
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          siteId,
          JSON.stringify({
            bodyFormat: draft.bodyFormat,
            attachmentMode: draft.attachmentMode,
            hasSender: Boolean(draft.senderEmail),
            hasRecipients: Boolean(draft.to),
            subjectLength: draft.subjectTemplate.length,
            bodyLength: draft.bodyTemplate.length,
          }),
          now,
        ),
    ]);
  } catch (error) {
    return apiError('Monitoring email draft could not be saved.', 500, error instanceof Error ? error.message : String(error));
  }

  return json({
    ok: true,
    saved: true,
    settings: draft,
    updatedBy: actor,
    updatedAt: now,
    storage: 'd1',
  });
}
