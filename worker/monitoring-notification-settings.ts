import { apiError, getActor, json, readJson } from './http';
import type { DatabaseEnv } from './publishers';

export type MonitoringNotificationSettings = {
  enabled: boolean;
  notifyOnMissing: boolean;
  notifyOnChange: boolean;
  reminderEnabled: boolean;
  reminderHours: number;
  recoveryEnabled: boolean;
};

export type MonitoringNotificationState = {
  lastStatus: string | null;
  lastFingerprint: string | null;
  lastCheckedAt: string | null;
  lastNotifiedFingerprint: string | null;
  lastNotifiedAt: string | null;
  lastRecoveryAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
};

export type MonitoringNotificationLogEntry = {
  id: string;
  kind: string;
  status: string;
  provider: string | null;
  messageId: string | null;
  recipients: string[];
  subject: string | null;
  attachmentName: string | null;
  errorMessage: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

type SettingsRow = {
  settings_json: string;
  updated_by: string | null;
  updated_at: string;
};

type StateRow = {
  last_status: string | null;
  last_fingerprint: string | null;
  last_checked_at: string | null;
  last_notified_fingerprint: string | null;
  last_notified_at: string | null;
  last_recovery_at: string | null;
  last_error: string | null;
  updated_at: string;
};

type LogRow = {
  id: string;
  kind: string;
  status: string;
  provider: string | null;
  message_id: string | null;
  recipients_json: string;
  subject: string | null;
  attachment_name: string | null;
  error_message: string | null;
  details_json: string;
  created_at: string;
};

export const DEFAULT_NOTIFICATION_SETTINGS: MonitoringNotificationSettings = {
  enabled: false,
  notifyOnMissing: true,
  notifyOnChange: true,
  reminderEnabled: true,
  reminderHours: 24,
  recoveryEnabled: true,
};

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured.', 503);
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeSettings(value: unknown): { settings: MonitoringNotificationSettings; errors: string[] } {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const reminderHoursRaw = Number(input.reminderHours ?? DEFAULT_NOTIFICATION_SETTINGS.reminderHours);
  const reminderHours = Number.isFinite(reminderHoursRaw)
    ? Math.round(reminderHoursRaw)
    : DEFAULT_NOTIFICATION_SETTINGS.reminderHours;
  const settings: MonitoringNotificationSettings = {
    enabled: input.enabled === true,
    notifyOnMissing: input.notifyOnMissing !== false,
    notifyOnChange: input.notifyOnChange !== false,
    reminderEnabled: input.reminderEnabled !== false,
    reminderHours,
    recoveryEnabled: input.recoveryEnabled !== false,
  };
  const errors: string[] = [];
  if (settings.reminderHours < 1 || settings.reminderHours > 720) {
    errors.push('Reminder interval must be between 1 and 720 hours.');
  }
  return { settings, errors };
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1').bind(siteId).first<{ id: string }>();
  return Boolean(row);
}

export async function ensureMonitoringNotificationTables(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS monitoring_notification_settings (
      site_id TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL DEFAULT '{}',
      updated_by TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS monitoring_notification_state (
      site_id TEXT PRIMARY KEY,
      last_status TEXT,
      last_fingerprint TEXT,
      last_checked_at TEXT,
      last_notified_fingerprint TEXT,
      last_notified_at TEXT,
      last_recovery_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS monitoring_notification_log (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT,
      message_id TEXT,
      recipients_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT,
      attachment_name TEXT,
      error_message TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_monitoring_notification_log_site
      ON monitoring_notification_log(site_id, created_at DESC)`),
  ]);
}

export async function readMonitoringNotificationSettings(
  db: D1Database,
  siteId: string,
): Promise<MonitoringNotificationSettings> {
  await ensureMonitoringNotificationTables(db);
  const row = await db.prepare(
    'SELECT settings_json FROM monitoring_notification_settings WHERE site_id = ? LIMIT 1',
  ).bind(siteId).first<{ settings_json: string }>();
  if (!row) return { ...DEFAULT_NOTIFICATION_SETTINGS };
  return normalizeSettings(parseJsonRecord(row.settings_json)).settings;
}

export async function readMonitoringNotificationState(
  db: D1Database,
  siteId: string,
): Promise<MonitoringNotificationState> {
  await ensureMonitoringNotificationTables(db);
  const row = await db.prepare(`SELECT last_status, last_fingerprint, last_checked_at,
      last_notified_fingerprint, last_notified_at, last_recovery_at, last_error, updated_at
    FROM monitoring_notification_state WHERE site_id = ? LIMIT 1`).bind(siteId).first<StateRow>();
  return row ? {
    lastStatus: row.last_status,
    lastFingerprint: row.last_fingerprint,
    lastCheckedAt: row.last_checked_at,
    lastNotifiedFingerprint: row.last_notified_fingerprint,
    lastNotifiedAt: row.last_notified_at,
    lastRecoveryAt: row.last_recovery_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  } : {
    lastStatus: null,
    lastFingerprint: null,
    lastCheckedAt: null,
    lastNotifiedFingerprint: null,
    lastNotifiedAt: null,
    lastRecoveryAt: null,
    lastError: null,
    updatedAt: null,
  };
}

export async function writeMonitoringNotificationState(
  db: D1Database,
  siteId: string,
  state: MonitoringNotificationState,
): Promise<void> {
  await ensureMonitoringNotificationTables(db);
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO monitoring_notification_state (
      site_id, last_status, last_fingerprint, last_checked_at, last_notified_fingerprint,
      last_notified_at, last_recovery_at, last_error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_id) DO UPDATE SET
      last_status = excluded.last_status,
      last_fingerprint = excluded.last_fingerprint,
      last_checked_at = excluded.last_checked_at,
      last_notified_fingerprint = excluded.last_notified_fingerprint,
      last_notified_at = excluded.last_notified_at,
      last_recovery_at = excluded.last_recovery_at,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at`)
    .bind(
      siteId,
      state.lastStatus,
      state.lastFingerprint,
      state.lastCheckedAt,
      state.lastNotifiedFingerprint,
      state.lastNotifiedAt,
      state.lastRecoveryAt,
      state.lastError,
      now,
    ).run();
}

export async function appendMonitoringNotificationLog(
  db: D1Database,
  siteId: string,
  entry: Omit<MonitoringNotificationLogEntry, 'id' | 'createdAt'>,
): Promise<void> {
  await ensureMonitoringNotificationTables(db);
  await db.prepare(`INSERT INTO monitoring_notification_log (
      id, site_id, kind, status, provider, message_id, recipients_json, subject,
      attachment_name, error_message, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      siteId,
      entry.kind,
      entry.status,
      entry.provider,
      entry.messageId,
      JSON.stringify(entry.recipients),
      entry.subject,
      entry.attachmentName,
      entry.errorMessage,
      JSON.stringify(entry.details),
      new Date().toISOString(),
    ).run();
}

async function readRecentLogs(db: D1Database, siteId: string): Promise<MonitoringNotificationLogEntry[]> {
  await ensureMonitoringNotificationTables(db);
  const result = await db.prepare(`SELECT id, kind, status, provider, message_id, recipients_json,
      subject, attachment_name, error_message, details_json, created_at
    FROM monitoring_notification_log
    WHERE site_id = ?
    ORDER BY created_at DESC
    LIMIT 12`).bind(siteId).all<LogRow>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    provider: row.provider,
    messageId: row.message_id,
    recipients: parseStringArray(row.recipients_json),
    subject: row.subject,
    attachmentName: row.attachment_name,
    errorMessage: row.error_message,
    details: parseJsonRecord(row.details_json),
    createdAt: row.created_at,
  }));
}

export async function getMonitoringNotificationSettings(
  env: DatabaseEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);
  await ensureMonitoringNotificationTables(env.DB);
  const [settings, state, logs, row] = await Promise.all([
    readMonitoringNotificationSettings(env.DB, siteId),
    readMonitoringNotificationState(env.DB, siteId),
    readRecentLogs(env.DB, siteId),
    env.DB.prepare('SELECT updated_by, updated_at FROM monitoring_notification_settings WHERE site_id = ? LIMIT 1')
      .bind(siteId).first<Pick<SettingsRow, 'updated_by' | 'updated_at'>>(),
  ]);
  return json({
    ok: true,
    settings,
    state,
    recent: logs,
    saved: Boolean(row),
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
    scheduler: 'manual-preview-only',
  });
}

export async function updateMonitoringNotificationSettings(
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
    return apiError('Notification settings JSON could not be read.', 400, error instanceof Error ? error.message : String(error));
  }
  const { settings, errors } = normalizeSettings(body.settings);
  if (errors.length) return apiError('Notification settings are not valid.', 422, errors);
  const actor = getActor(request);
  const now = new Date().toISOString();
  await ensureMonitoringNotificationTables(env.DB);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO monitoring_notification_settings (
        site_id, settings_json, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(site_id) DO UPDATE SET
        settings_json = excluded.settings_json,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at`)
      .bind(siteId, JSON.stringify(settings), actor, now, now),
    env.DB.prepare(`INSERT INTO audit_log (
        id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
      ) VALUES (?, ?, 'monitoring.notification_settings.saved', ?, 'monitoring_notification_settings', ?, ?, ?)`)
      .bind(crypto.randomUUID(), actor, siteId, siteId, JSON.stringify(settings), now),
  ]);
  return json({ ok: true, settings, saved: true, updatedBy: actor, updatedAt: now });
}
