import { checkAdsTxt } from './ads-txt';
import { sendGmailMessage, type GmailMessageInput } from './gmail-send';
import type { GmailOAuthEnv } from './gmail-oauth';
import { apiError, getActor, json } from './http';
import { getMonitoringEmailPreviewData } from './monitoring-email-preview';
import type { MonitoringEmailDraft } from './monitoring-email-settings';
import {
  appendMonitoringNotificationLog,
  readMonitoringNotificationSettings,
  readMonitoringNotificationState,
  writeMonitoringNotificationState,
  type MonitoringNotificationState,
} from './monitoring-notification-settings';

export interface MonitoringNotificationRunEnv extends GmailOAuthEnv {}

type AdsTxtEntry = {
  sourceLabel?: string;
  entry?: string;
  required?: boolean;
  found?: boolean;
};

type AdsTxtCheck = {
  status?: string;
  url?: string;
  finalUrl?: string | null;
  fetchedAt?: string;
  httpStatus?: number | null;
  requiredMissingCount?: number;
  missing?: AdsTxtEntry[];
};

type PreviewData = {
  ok: true;
  fetchedAt: string;
  site: {
    id: string;
    name: string;
    domain: string;
    publisherName: string;
    adsTxtUrl: string;
  };
  live: {
    finalUrl: string | null;
    httpStatus: number | null;
    content: string;
    error: string | null;
  };
  expected: Array<{
    sourceLabel: string;
    entry: string;
    required: boolean;
  }>;
};

type SiteRow = {
  id: string;
  name: string;
  domain: string;
  current_version: string;
};

type DraftRow = {
  settings_json: string;
};

type Decision = {
  kind: 'missing' | 'reminder' | 'recovery' | 'none';
  reason: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniqueEntries<T extends { entry?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = String(item.entry ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groupedEntries(items: Array<{ sourceLabel?: string; entry?: string }>): string {
  const groups = new Map<string, string[]>();
  for (const item of uniqueEntries(items)) {
    const entry = String(item.entry ?? '').trim();
    if (!entry) continue;
    const label = String(item.sourceLabel ?? '').trim() || 'Other';
    groups.set(label, [...(groups.get(label) ?? []), entry]);
  }
  return Array.from(groups.entries())
    .map(([label, entries]) => `# ${label}\n${entries.join('\n')}`)
    .join('\n\n');
}

function correctedAdsTxt(liveContent: string, missingEntries: AdsTxtEntry[]): string {
  const live = liveContent.replace(/\s+$/g, '');
  const additions = groupedEntries(missingEntries);
  if (!additions) return live ? `${live}\n` : '';
  return `${live ? `${live}\n\n` : ''}# Tessera additions\n${additions}\n`;
}

function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/{{\s*([a-z0-9_]+)\s*}}/gi, (match, key: string) => variables[key] ?? match);
}

function safeFileName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .slice(0, 180);
  const base = cleaned || 'ads.txt';
  return base.toLowerCase().endsWith('.txt') ? base : `${base}.txt`;
}

function normalizeDraft(value: unknown): MonitoringEmailDraft | null {
  if (!isRecord(value)) return null;
  const bodyFormat = value.bodyFormat === 'html' ? 'html' : 'plain';
  const attachmentMode = ['full-corrected', 'missing-only', 'expected-only'].includes(String(value.attachmentMode))
    ? value.attachmentMode as MonitoringEmailDraft['attachmentMode']
    : 'full-corrected';
  return {
    senderName: String(value.senderName ?? '').trim().slice(0, 120),
    senderEmail: String(value.senderEmail ?? '').trim().toLowerCase().slice(0, 254),
    replyTo: String(value.replyTo ?? '').trim().toLowerCase().slice(0, 254),
    to: String(value.to ?? '').trim().slice(0, 4_000),
    cc: String(value.cc ?? '').trim().slice(0, 4_000),
    subjectTemplate: String(value.subjectTemplate ?? '').trim().slice(0, 500),
    bodyTemplate: String(value.bodyTemplate ?? '').trim().slice(0, 50_000),
    bodyFormat,
    attachmentMode,
    attachmentNameTemplate: String(value.attachmentNameTemplate ?? '').trim().slice(0, 180) || '{{domain}}-ads.txt',
  };
}

async function loadSavedDraft(db: D1Database, siteId: string): Promise<MonitoringEmailDraft | null> {
  try {
    const row = await db.prepare(
      'SELECT settings_json FROM monitoring_email_drafts WHERE site_id = ? LIMIT 1',
    ).bind(siteId).first<DraftRow>();
    if (!row) return null;
    return normalizeDraft(JSON.parse(row.settings_json) as unknown);
  } catch (error) {
    if (/no such table:\s*monitoring_email_drafts/i.test(error instanceof Error ? error.message : String(error))) {
      return null;
    }
    throw error;
  }
}

async function readCheck(env: MonitoringNotificationRunEnv, siteId: string): Promise<AdsTxtCheck> {
  const response = await checkAdsTxt(new Request(`https://monitoring.internal/${encodeURIComponent(siteId)}`), env, siteId);
  const payload = await response.json() as { check?: unknown; error?: string };
  if (!response.ok || !isRecord(payload.check)) {
    throw new Error(payload.error || `Ads.txt checker returned HTTP ${response.status}.`);
  }
  return payload.check as AdsTxtCheck;
}

async function readPreviewData(env: MonitoringNotificationRunEnv, siteId: string): Promise<PreviewData> {
  const response = await getMonitoringEmailPreviewData(env, siteId);
  const payload = await response.json() as PreviewData & { error?: string; details?: unknown };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Email preview data returned HTTP ${response.status}.`);
  }
  return payload;
}

async function fingerprint(entries: AdsTxtEntry[]): Promise<string | null> {
  const keys = uniqueEntries(entries)
    .map((item) => String(item.entry ?? '').trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (!keys.length) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(keys)));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hoursSince(value: string | null, now: number): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (now - timestamp) / 3_600_000);
}

function decide(
  status: string,
  currentFingerprint: string | null,
  state: MonitoringNotificationState,
  settings: Awaited<ReturnType<typeof readMonitoringNotificationSettings>>,
  now: number,
): Decision {
  if (!settings.enabled) return { kind: 'none', reason: 'Notifications are disabled for this site.' };
  if (status === 'missing') {
    if (!settings.notifyOnMissing) return { kind: 'none', reason: 'Missing-entry notifications are disabled.' };
    if (!state.lastNotifiedAt || !state.lastNotifiedFingerprint) {
      return { kind: 'missing', reason: 'Missing entries were detected and no previous notification was sent.' };
    }
    if (currentFingerprint !== state.lastNotifiedFingerprint && settings.notifyOnChange) {
      return { kind: 'missing', reason: 'The missing-entry list changed since the last notification.' };
    }
    const elapsed = hoursSince(state.lastNotifiedAt, now);
    if (settings.reminderEnabled && elapsed !== null && elapsed >= settings.reminderHours) {
      return { kind: 'reminder', reason: `The same issue has remained unresolved for ${Math.floor(elapsed)} hour(s).` };
    }
    return { kind: 'none', reason: 'The missing-entry list is unchanged and the reminder interval has not elapsed.' };
  }
  if (status === 'ok') {
    if (settings.recoveryEnabled && state.lastNotifiedFingerprint && state.lastNotifiedAt) {
      return { kind: 'recovery', reason: 'The site recovered after a previously notified missing-entry state.' };
    }
    return { kind: 'none', reason: 'Ads.txt is healthy and no recovery notification is pending.' };
  }
  return { kind: 'none', reason: `No automatic email is sent for ads.txt status "${status}".` };
}

function messageFor(
  draft: MonitoringEmailDraft,
  preview: PreviewData,
  site: SiteRow,
  check: AdsTxtCheck,
  kind: Exclude<Decision['kind'], 'none'>,
  missingEntries: AdsTxtEntry[],
): GmailMessageInput {
  const missingText = groupedEntries(missingEntries) || 'None';
  const statusLabel = kind === 'recovery'
    ? 'OK'
    : `${check.requiredMissingCount ?? missingEntries.length} MISSING`;
  const baseVariables: Record<string, string> = {
    publisher_name: preview.site.publisherName || '',
    site_name: preview.site.name,
    domain: preview.site.domain,
    ads_txt_url: preview.live.finalUrl || preview.site.adsTxtUrl,
    status: statusLabel,
    checked_at: new Date(check.fetchedAt || preview.fetchedAt).toLocaleString('en'),
    missing_count: String(check.requiredMissingCount ?? missingEntries.length),
    missing_entries: missingText,
    current_version: site.current_version && site.current_version !== 'draft' ? site.current_version : '',
    manifest_version: '',
    sender_name: draft.senderName,
    notification_kind: kind,
    attachment_name: '',
  };
  const attachmentName = safeFileName(renderTemplate(draft.attachmentNameTemplate, baseVariables));
  const variables = { ...baseVariables, attachment_name: attachmentName };
  const expectedEntries = preview.expected.filter((item) => item.required);
  let attachmentContent = '';
  if (draft.attachmentMode === 'missing-only') {
    attachmentContent = groupedEntries(missingEntries);
  } else if (draft.attachmentMode === 'expected-only') {
    attachmentContent = groupedEntries(expectedEntries);
  } else if (preview.live.error) {
    attachmentContent = groupedEntries(expectedEntries);
  } else {
    attachmentContent = correctedAdsTxt(preview.live.content, missingEntries);
  }
  if (attachmentContent && !attachmentContent.endsWith('\n')) attachmentContent += '\n';
  return {
    senderName: draft.senderName,
    to: draft.to,
    cc: draft.cc,
    replyTo: draft.replyTo,
    subject: renderTemplate(draft.subjectTemplate, variables),
    body: renderTemplate(draft.bodyTemplate, variables),
    bodyFormat: draft.bodyFormat,
    attachmentName,
    attachmentContent,
  };
}

export async function runMonitoringNotification(
  request: Request,
  env: MonitoringNotificationRunEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);
  const site = await env.DB.prepare(
    'SELECT id, name, domain, current_version FROM publishers WHERE id = ? LIMIT 1',
  ).bind(siteId).first<SiteRow>();
  if (!site) return apiError('Site not found.', 404);

  const actor = getActor(request);
  const checkedAt = new Date().toISOString();
  let state = await readMonitoringNotificationState(env.DB, siteId);
  try {
    const [settings, check] = await Promise.all([
      readMonitoringNotificationSettings(env.DB, siteId),
      readCheck(env, siteId),
    ]);
    const missingEntries = uniqueEntries(check.missing ?? []);
    const currentFingerprint = await fingerprint(missingEntries);
    const decision = decide(String(check.status ?? 'fetch-error'), currentFingerprint, state, settings, Date.now());
    state = {
      ...state,
      lastStatus: String(check.status ?? 'fetch-error'),
      lastFingerprint: currentFingerprint,
      lastCheckedAt: checkedAt,
      lastError: null,
      updatedAt: checkedAt,
    };

    if (decision.kind === 'none') {
      await writeMonitoringNotificationState(env.DB, siteId, state);
      await appendMonitoringNotificationLog(env.DB, siteId, {
        kind: 'check',
        status: 'skipped',
        provider: 'gmail',
        messageId: null,
        recipients: [],
        subject: null,
        attachmentName: null,
        errorMessage: null,
        details: {
          actor,
          reason: decision.reason,
          adsTxtStatus: check.status ?? 'fetch-error',
          missingCount: missingEntries.length,
          fingerprint: currentFingerprint,
        },
      });
      return json({
        ok: true,
        sent: false,
        decision: decision.kind,
        reason: decision.reason,
        checkedAt,
        adsTxtStatus: check.status ?? 'fetch-error',
        missingCount: missingEntries.length,
        state,
      });
    }

    const draft = await loadSavedDraft(env.DB, siteId);
    if (!draft) throw new Error('Save the ads.txt email template to Tessera before enabling notifications.');
    if (!draft.to.trim()) throw new Error('The saved email template does not contain a recipient.');
    if (!draft.subjectTemplate.trim() || !draft.bodyTemplate.trim()) {
      throw new Error('The saved email template must contain both a subject and message body.');
    }
    const preview = await readPreviewData(env, siteId);
    const message = messageFor(draft, preview, site, check, decision.kind, missingEntries);
    const result = await sendGmailMessage(env, message);
    const nextState: MonitoringNotificationState = {
      ...state,
      lastNotifiedFingerprint: decision.kind === 'recovery' ? null : currentFingerprint,
      lastNotifiedAt: decision.kind === 'recovery' ? state.lastNotifiedAt : result.sentAt,
      lastRecoveryAt: decision.kind === 'recovery' ? result.sentAt : state.lastRecoveryAt,
      lastError: null,
      updatedAt: result.sentAt,
    };
    await writeMonitoringNotificationState(env.DB, siteId, nextState);
    await appendMonitoringNotificationLog(env.DB, siteId, {
      kind: decision.kind,
      status: 'sent',
      provider: 'gmail',
      messageId: result.messageId,
      recipients: result.to,
      subject: String(message.subject ?? ''),
      attachmentName: String(message.attachmentName ?? ''),
      errorMessage: null,
      details: {
        actor,
        reason: decision.reason,
        adsTxtStatus: check.status ?? 'fetch-error',
        missingCount: missingEntries.length,
        fingerprint: currentFingerprint,
        cc: result.cc,
        from: result.from,
      },
    });
    return json({
      ok: true,
      sent: true,
      decision: decision.kind,
      reason: decision.reason,
      checkedAt,
      adsTxtStatus: check.status ?? 'fetch-error',
      missingCount: missingEntries.length,
      messageId: result.messageId,
      from: result.from,
      recipients: result.to,
      attachmentName: String(message.attachmentName ?? ''),
      state: nextState,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    state = {
      ...state,
      lastCheckedAt: checkedAt,
      lastError: errorMessage,
      updatedAt: checkedAt,
    };
    await writeMonitoringNotificationState(env.DB, siteId, state).catch(() => undefined);
    await appendMonitoringNotificationLog(env.DB, siteId, {
      kind: 'check',
      status: 'failed',
      provider: 'gmail',
      messageId: null,
      recipients: [],
      subject: null,
      attachmentName: null,
      errorMessage,
      details: { actor },
    }).catch(() => undefined);
    return apiError('Monitoring notification evaluation failed.', 502, errorMessage);
  }
}
