import { checkAdsTxt } from './ads-txt';
import { apiError, getActor, json, readJson } from './http';
import type { DatabaseEnv } from './publishers';

export type EmailBinding = {
  send(message: {
    to: string | string[];
    from: string | { email: string; name?: string };
    subject: string;
    text?: string;
    html?: string;
    cc?: string[];
    replyTo?: string;
    attachments?: Array<{
      content: string;
      filename: string;
      type: string;
      disposition: 'attachment';
    }>;
  }): Promise<{ messageId: string }>;
};

export interface MonitoringEnv extends DatabaseEnv {
  BUILDS?: R2Bucket;
  EMAIL?: EmailBinding;
}

type JsonRecord = Record<string, unknown>;
type BodyFormat = 'plain' | 'html';
type AttachmentMode = 'full-corrected' | 'missing-only' | 'expected-only';
type MonitorSeverity = 'ok' | 'warning' | 'error' | 'not-configured';
type NotificationKind = 'test' | 'missing' | 'reminder' | 'recovery' | 'manual';

type MonitoringEmailSettings = {
  enabled: boolean;
  senderName: string;
  senderEmail: string;
  replyTo: string;
  to: string[];
  cc: string[];
  subjectTemplate: string;
  bodyTemplate: string;
  bodyFormat: BodyFormat;
  attachmentMode: AttachmentMode;
  attachmentNameTemplate: string;
  notifyOnChangeOnly: boolean;
  reminderHours: number;
  sendRecovery: boolean;
};

type MonitoringSettings = {
  enabled: boolean;
  runtimeChecks: boolean;
  adsTxtChecks: boolean;
  checkIntervalHours: number;
  email: MonitoringEmailSettings;
};

type SiteRow = {
  id: string;
  name: string;
  domain: string;
  current_version: string;
  current_release_id: string | null;
  ads_txt_url: string | null;
  publisher_account_id: string | null;
  publisher_name: string | null;
};

type RequirementRow = {
  source_label: string;
  entry: string;
  required: number;
};

type AdsTxtRequirementResult = {
  id?: string;
  sourceLabel: string;
  entry: string;
  required: boolean;
  found: boolean;
};

type AdsTxtCheck = {
  status: 'ok' | 'missing' | 'empty' | 'fetch-error';
  url: string;
  finalUrl: string | null;
  fetchedAt: string;
  httpStatus: number | null;
  message?: string;
  actualEntryCount?: number;
  invalidLineCount?: number;
  duplicateLineCount?: number;
  requirementCount?: number;
  foundCount?: number;
  requiredMissingCount?: number;
  optionalMissingCount?: number;
  results: AdsTxtRequirementResult[];
  missing: AdsTxtRequirementResult[];
  optionalMissing: AdsTxtRequirementResult[];
};

type ArtifactStatus = {
  fileName: string;
  key: string;
  required: boolean;
  found: boolean;
  size: number | null;
  uploadedAt: string | null;
};

type MonitoringStatus = {
  severity: MonitorSeverity;
  checkedAt: string;
  siteId: string;
  siteName: string;
  domain: string;
  expectedVersion: string | null;
  manifestVersion: string | null;
  versionMatches: boolean | null;
  currentReleaseId: string | null;
  manifestFound: boolean;
  artifacts: ArtifactStatus[];
  adsTxt: AdsTxtCheck | null;
  messages: string[];
};

type StateRow = {
  last_checked_at: string | null;
  status_json: string;
  ads_txt_fingerprint: string | null;
  last_notified_fingerprint: string | null;
  last_notified_at: string | null;
  last_recovery_at: string | null;
  updated_at: string;
};

type NotificationLogRow = {
  id: string;
  kind: NotificationKind;
  status: 'sent' | 'failed' | 'skipped';
  recipients_json: string;
  subject: string | null;
  attachment_name: string | null;
  message_id: string | null;
  error_message: string | null;
  details_json: string;
  created_by: string | null;
  created_at: string;
};

type RenderedEmail = {
  subject: string;
  body: string;
  bodyFormat: BodyFormat;
  text: string;
  html: string | null;
  attachmentName: string;
  attachmentContent: string;
  recipients: string[];
  cc: string[];
  variables: Record<string, string>;
};

const MAX_ADS_TXT_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;
const ARTIFACT_FILES = [
  'ads.js',
  'ads.min.js',
  'prebid.js',
  'config.json',
  'manifest.json',
  'min-height.css',
  'sticky.css',
  'div-export.csv',
  'implementation.html',
] as const;

const DEFAULT_SETTINGS: MonitoringSettings = {
  enabled: false,
  runtimeChecks: true,
  adsTxtChecks: true,
  checkIntervalHours: 24,
  email: {
    enabled: false,
    senderName: '',
    senderEmail: '',
    replyTo: '',
    to: [],
    cc: [],
    subjectTemplate: '',
    bodyTemplate: '',
    bodyFormat: 'plain',
    attachmentMode: 'full-corrected',
    attachmentNameTemplate: '{{domain}}-ads.txt',
    notifyOnChangeOnly: true,
    reminderHours: 72,
    sendRecovery: true,
  },
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseRecord(value: string | null | undefined): JsonRecord {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function addressList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : String(value ?? '').split(/[;,\n]+/);
  return Array.from(new Set(values.map((item) => String(item).trim().toLowerCase()).filter(Boolean)));
}

function normalizeSettings(value: unknown): MonitoringSettings {
  const source = isRecord(value) ? value : {};
  const emailSource = isRecord(source.email) ? source.email : {};
  const bodyFormat: BodyFormat = emailSource.bodyFormat === 'html' ? 'html' : 'plain';
  const attachmentMode: AttachmentMode = ['missing-only', 'expected-only'].includes(String(emailSource.attachmentMode))
    ? emailSource.attachmentMode as AttachmentMode
    : 'full-corrected';

  return {
    enabled: booleanValue(source.enabled, DEFAULT_SETTINGS.enabled),
    runtimeChecks: booleanValue(source.runtimeChecks, DEFAULT_SETTINGS.runtimeChecks),
    adsTxtChecks: booleanValue(source.adsTxtChecks, DEFAULT_SETTINGS.adsTxtChecks),
    checkIntervalHours: boundedNumber(source.checkIntervalHours, DEFAULT_SETTINGS.checkIntervalHours, 1, 720),
    email: {
      enabled: booleanValue(emailSource.enabled, DEFAULT_SETTINGS.email.enabled),
      senderName: String(emailSource.senderName ?? '').trim().slice(0, 120),
      senderEmail: String(emailSource.senderEmail ?? '').trim().toLowerCase().slice(0, 254),
      replyTo: String(emailSource.replyTo ?? '').trim().toLowerCase().slice(0, 254),
      to: addressList(emailSource.to).slice(0, 50),
      cc: addressList(emailSource.cc).slice(0, 50),
      subjectTemplate: String(emailSource.subjectTemplate ?? '').slice(0, 998),
      bodyTemplate: String(emailSource.bodyTemplate ?? '').slice(0, 100_000),
      bodyFormat,
      attachmentMode,
      attachmentNameTemplate: String(emailSource.attachmentNameTemplate ?? DEFAULT_SETTINGS.email.attachmentNameTemplate).slice(0, 240),
      notifyOnChangeOnly: booleanValue(emailSource.notifyOnChangeOnly, DEFAULT_SETTINGS.email.notifyOnChangeOnly),
      reminderHours: boundedNumber(emailSource.reminderHours, DEFAULT_SETTINGS.email.reminderHours, 1, 8_760),
      sendRecovery: booleanValue(emailSource.sendRecovery, DEFAULT_SETTINGS.email.sendRecovery),
    },
  };
}

function monitoringTablesError(error: unknown): Response | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/no such table: (site_monitoring_settings|site_monitoring_state|monitoring_notification_log)/i.test(message)) {
    return apiError(
      'Monitoring database tables are not installed yet.',
      503,
      'Apply D1 migration 0003_site_monitoring.sql, then reload this page.',
    );
  }
  return null;
}

async function fetchSite(db: D1Database, siteId: string): Promise<SiteRow | null> {
  return db.prepare(`SELECT
      p.id,
      p.name,
      p.domain,
      p.current_version,
      p.current_release_id,
      p.ads_txt_url,
      p.publisher_account_id,
      pa.name AS publisher_name
    FROM publishers p
    LEFT JOIN publisher_accounts pa ON pa.id = p.publisher_account_id
    WHERE p.id = ?
    LIMIT 1`)
    .bind(siteId)
    .first<SiteRow>();
}

async function readSettings(db: D1Database, siteId: string): Promise<MonitoringSettings> {
  const row = await db.prepare('SELECT settings_json FROM site_monitoring_settings WHERE site_id = ? LIMIT 1')
    .bind(siteId)
    .first<{ settings_json: string }>();
  return row ? normalizeSettings(parseRecord(row.settings_json)) : DEFAULT_SETTINGS;
}

async function readState(db: D1Database, siteId: string): Promise<StateRow | null> {
  return db.prepare(`SELECT last_checked_at, status_json, ads_txt_fingerprint,
      last_notified_fingerprint, last_notified_at, last_recovery_at, updated_at
    FROM site_monitoring_state
    WHERE site_id = ?
    LIMIT 1`)
    .bind(siteId)
    .first<StateRow>();
}

async function readHistory(db: D1Database, siteId: string): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(`SELECT id, kind, status, recipients_json, subject,
      attachment_name, message_id, error_message, details_json, created_by, created_at
    FROM monitoring_notification_log
    WHERE site_id = ?
    ORDER BY created_at DESC
    LIMIT 30`)
    .bind(siteId)
    .all<NotificationLogRow>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    recipients: parseArray(row.recipients_json),
    subject: row.subject,
    attachmentName: row.attachment_name,
    messageId: row.message_id,
    errorMessage: row.error_message,
    details: parseRecord(row.details_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

function statePayload(row: StateRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    lastCheckedAt: row.last_checked_at,
    status: parseRecord(row.status_json),
    adsTxtFingerprint: row.ads_txt_fingerprint,
    lastNotifiedFingerprint: row.last_notified_fingerprint,
    lastNotifiedAt: row.last_notified_at,
    lastRecoveryAt: row.last_recovery_at,
    updatedAt: row.updated_at,
  };
}

function blockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return true;
  if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true;
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return true;
  const [a, b] = octets;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function validatedPublicUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS ads.txt URLs are allowed.');
  if (url.username || url.password) throw new Error('Ads.txt URLs cannot contain credentials.');
  if (blockedHostname(url.hostname)) throw new Error('The ads.txt URL must use a public hostname.');
  return url;
}

async function limitedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_ADS_TXT_BYTES) throw new Error('The ads.txt response is larger than 2 MB.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_ADS_TXT_BYTES) {
      await reader.cancel();
      throw new Error('The ads.txt response is larger than 2 MB.');
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchAdsTxtSource(initialUrl: string): Promise<{ text: string; finalUrl: string; httpStatus: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('ads.txt fetch timed out'), FETCH_TIMEOUT_MS);
  let current = validatedPublicUrl(initialUrl);
  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const response = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/plain,text/*;q=0.9,*/*;q=0.5',
          'user-agent': 'Tessera-Monitoring/1.0',
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`Redirect ${response.status} did not include a Location header.`);
        current = validatedPublicUrl(new URL(location, current).toString());
        continue;
      }
      return {
        text: response.ok ? await limitedText(response) : '',
        finalUrl: current.toString(),
        httpStatus: response.status,
      };
    }
    throw new Error('The ads.txt URL redirected too many times.');
  } finally {
    clearTimeout(timeout);
  }
}

async function runAdsTxtCheck(env: MonitoringEnv, siteId: string): Promise<AdsTxtCheck> {
  const response = await checkAdsTxt(new Request(`https://monitoring.internal/${encodeURIComponent(siteId)}`), env, siteId);
  const text = await response.text();
  let payload: { ok?: boolean; check?: AdsTxtCheck; error?: string } = {};
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new Error(text || `Ads.txt checker returned ${response.status}.`);
  }
  if (!response.ok || !payload.check) throw new Error(payload.error || `Ads.txt checker returned ${response.status}.`);
  return payload.check;
}

async function runtimeStatus(env: MonitoringEnv, site: SiteRow): Promise<{
  manifestFound: boolean;
  manifestVersion: string | null;
  versionMatches: boolean | null;
  artifacts: ArtifactStatus[];
  messages: string[];
}> {
  if (!env.BUILDS) {
    return {
      manifestFound: false,
      manifestVersion: null,
      versionMatches: null,
      artifacts: [],
      messages: ['R2 build storage is not configured.'],
    };
  }

  const prefix = `publishers/${site.id}/current/`;
  const manifestObject = await env.BUILDS.get(`${prefix}manifest.json`);
  let manifest: JsonRecord = {};
  if (manifestObject) {
    try {
      const parsed = JSON.parse(await manifestObject.text()) as unknown;
      if (isRecord(parsed)) manifest = parsed;
    } catch {
      manifest = {};
    }
  }
  const manifestVersion = typeof manifest.version === 'string' ? manifest.version : null;
  const prebidRequired = manifest.prebidEnabled !== false && manifest.demandMode !== 'gam-adx-only';
  const artifacts = await Promise.all(ARTIFACT_FILES.map(async (fileName): Promise<ArtifactStatus> => {
    const key = `${prefix}${fileName}`;
    const object = await env.BUILDS!.head(key);
    const required = fileName !== 'sticky.css' && (fileName !== 'prebid.js' || prebidRequired);
    return {
      fileName,
      key,
      required,
      found: Boolean(object),
      size: object?.size ?? null,
      uploadedAt: object?.uploaded?.toISOString?.() ?? null,
    };
  }));

  const expectedVersion = site.current_version && site.current_version !== 'draft' ? site.current_version : null;
  const versionMatches = expectedVersion && manifestVersion ? expectedVersion === manifestVersion : null;
  const messages: string[] = [];
  if (!manifestObject) messages.push('Production channel manifest.json is missing.');
  else if (!manifestVersion) messages.push('Production manifest does not report a version.');
  if (versionMatches === false) messages.push(`Production manifest ${manifestVersion} does not match site version ${expectedVersion}.`);
  const missing = artifacts.filter((artifact) => artifact.required && !artifact.found);
  if (missing.length) messages.push(`Missing production artifact(s): ${missing.map((item) => item.fileName).join(', ')}.`);
  return { manifestFound: Boolean(manifestObject), manifestVersion, versionMatches, artifacts, messages };
}

function severityFor(
  status: Omit<MonitoringStatus, 'severity'>,
  settings: MonitoringSettings,
): MonitorSeverity {
  if (settings.runtimeChecks && (!status.currentReleaseId || !status.expectedVersion)) return 'not-configured';
  if (settings.runtimeChecks) {
    const requiredMissing = status.artifacts.some((artifact) => artifact.required && !artifact.found);
    if (!status.manifestFound || status.versionMatches === false || requiredMissing) return 'error';
  }
  if (settings.adsTxtChecks) {
    if (status.adsTxt?.status === 'missing' || status.adsTxt?.status === 'fetch-error') return 'error';
    if (status.adsTxt?.status === 'empty' || (status.adsTxt?.optionalMissingCount ?? 0) > 0) return 'warning';
  }
  return 'ok';
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function adsFingerprint(check: AdsTxtCheck | null): Promise<string | null> {
  if (!check) return null;
  const entries = check.status === 'missing'
    ? check.missing.filter((item) => item.required).map((item) => item.entry.trim().toLowerCase()).sort()
    : [];
  return sha256(JSON.stringify({ status: check.status, entries }));
}

async function persistState(env: MonitoringEnv, status: MonitoringStatus, fingerprint: string | null): Promise<void> {
  if (!env.DB) return;
  const now = status.checkedAt;
  await env.DB.prepare(`INSERT INTO site_monitoring_state (
      site_id, last_checked_at, status_json, ads_txt_fingerprint, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(site_id) DO UPDATE SET
      last_checked_at = excluded.last_checked_at,
      status_json = excluded.status_json,
      ads_txt_fingerprint = excluded.ads_txt_fingerprint,
      updated_at = excluded.updated_at`)
    .bind(status.siteId, status.checkedAt, JSON.stringify(status), fingerprint, now)
    .run();
}

async function performCheck(env: MonitoringEnv, siteId: string, settings?: MonitoringSettings): Promise<{ status: MonitoringStatus; fingerprint: string | null }> {
  if (!env.DB) throw new Error('D1 database binding is not configured.');
  const site = await fetchSite(env.DB, siteId);
  if (!site) throw new Error('Site not found.');
  const effective = settings ?? await readSettings(env.DB, siteId);
  const checkedAt = new Date().toISOString();
  const runtime = effective.runtimeChecks
    ? await runtimeStatus(env, site)
    : { manifestFound: false, manifestVersion: null, versionMatches: null, artifacts: [], messages: ['Runtime checks are disabled.'] };
  let adsTxt: AdsTxtCheck | null = null;
  const messages = [...runtime.messages];
  if (effective.adsTxtChecks) {
    try {
      adsTxt = await runAdsTxtCheck(env, siteId);
      if (adsTxt.status === 'missing') messages.push(`${adsTxt.requiredMissingCount ?? adsTxt.missing.length} required ads.txt entr${(adsTxt.requiredMissingCount ?? adsTxt.missing.length) === 1 ? 'y is' : 'ies are'} missing.`);
      if (adsTxt.status === 'fetch-error') messages.push(adsTxt.message || 'Ads.txt could not be fetched.');
      if (adsTxt.status === 'empty') messages.push('No expected ads.txt entries are configured.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      adsTxt = {
        status: 'fetch-error',
        url: site.ads_txt_url || `https://${site.domain}/ads.txt`,
        finalUrl: null,
        fetchedAt: checkedAt,
        httpStatus: null,
        message,
        results: [],
        missing: [],
        optionalMissing: [],
      };
      messages.push(message);
    }
  }

  const base = {
    checkedAt,
    siteId: site.id,
    siteName: site.name,
    domain: site.domain,
    expectedVersion: site.current_version && site.current_version !== 'draft' ? site.current_version : null,
    manifestVersion: runtime.manifestVersion,
    versionMatches: runtime.versionMatches,
    currentReleaseId: site.current_release_id,
    manifestFound: runtime.manifestFound,
    artifacts: runtime.artifacts,
    adsTxt,
    messages,
  };
  const status: MonitoringStatus = { ...base, severity: severityFor(base, effective) };
  const fingerprint = await adsFingerprint(adsTxt);
  await persistState(env, status, fingerprint);
  return { status, fingerprint };
}

async function requirements(db: D1Database, siteId: string): Promise<RequirementRow[]> {
  const result = await db.prepare(`SELECT source_label, entry, required
    FROM ads_txt_requirements
    WHERE publisher_id = ?
    ORDER BY required DESC, source_label COLLATE NOCASE, entry COLLATE NOCASE`)
    .bind(siteId)
    .all<RequirementRow>();
  return result.results ?? [];
}

function groupedAdsTxt(rows: Array<{ sourceLabel: string; entry: string }>): string {
  const groups = new Map<string, string[]>();
  rows.forEach((row) => {
    const label = row.sourceLabel.trim() || 'Ads.txt';
    const current = groups.get(label) ?? [];
    if (!current.includes(row.entry)) current.push(row.entry);
    groups.set(label, current);
  });
  return Array.from(groups.entries())
    .map(([label, entries]) => `# ${label}\n${entries.join('\n')}`)
    .join('\n\n')
    .trim();
}

function correctedAdsTxt(source: string, missing: AdsTxtRequirementResult[]): string {
  const base = source.replace(/\s+$/g, '');
  const appendix = groupedAdsTxt(missing.map((item) => ({ sourceLabel: item.sourceLabel, entry: item.entry })));
  if (!appendix) return `${base}\n`;
  if (!base) return `${appendix}\n`;
  return `${base}\n\n# Entries added by Tessera\n${appendix}\n`;
}

function sanitizeFileName(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  const name = cleaned || fallback;
  return name.toLowerCase().endsWith('.txt') ? name : `${name}.txt`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderTemplate(template: string, variables: Record<string, string>, html = false): string {
  return template.replace(/{{\s*([a-z0-9_]+)\s*}}/gi, (_match, key: string) => {
    const value = variables[key] ?? '';
    if (!html) return value;
    return escapeHtml(value).replace(/\r?\n/g, '<br>');
  });
}

function plainTextFromHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim();
}

async function renderEmail(
  env: MonitoringEnv,
  site: SiteRow,
  settings: MonitoringSettings,
  status: MonitoringStatus,
): Promise<RenderedEmail> {
  if (!env.DB) throw new Error('D1 database binding is not configured.');
  const email = settings.email;
  const expectedRows = await requirements(env.DB, site.id);
  const missing = status.adsTxt?.missing.filter((item) => item.required) ?? [];
  const requestedUrl = site.ads_txt_url || `https://${site.domain}/ads.txt`;
  let sourceText = '';
  if (email.attachmentMode === 'full-corrected') {
    try {
      const fetched = await fetchAdsTxtSource(requestedUrl);
      if (fetched.httpStatus >= 200 && fetched.httpStatus < 300) sourceText = fetched.text;
    } catch {
      sourceText = '';
    }
  }

  let attachmentContent = '';
  if (email.attachmentMode === 'missing-only') {
    attachmentContent = `${groupedAdsTxt(missing.map((item) => ({ sourceLabel: item.sourceLabel, entry: item.entry })))}\n`;
  } else if (email.attachmentMode === 'expected-only') {
    attachmentContent = `${groupedAdsTxt(expectedRows
      .filter((row) => row.required === 1)
      .map((row) => ({ sourceLabel: row.source_label, entry: row.entry })))}\n`;
  } else {
    attachmentContent = correctedAdsTxt(sourceText, missing);
  }

  const initialVariables: Record<string, string> = {
    publisher_name: site.publisher_name || site.publisher_account_id || '',
    site_name: site.name,
    domain: site.domain,
    ads_txt_url: requestedUrl,
    status: status.adsTxt?.status ?? status.severity,
    checked_at: status.checkedAt,
    missing_count: String(missing.length),
    missing_entries: missing.map((item) => item.entry).join('\n'),
    current_version: status.expectedVersion || '',
    manifest_version: status.manifestVersion || '',
    sender_name: email.senderName,
    attachment_name: '',
  };
  const attachmentName = sanitizeFileName(
    renderTemplate(email.attachmentNameTemplate, initialVariables),
    `${site.domain}-ads.txt`,
  );
  const variables = { ...initialVariables, attachment_name: attachmentName };
  const subject = renderTemplate(email.subjectTemplate, variables).trim();
  const body = renderTemplate(email.bodyTemplate, variables, email.bodyFormat === 'html').trim();
  const html = email.bodyFormat === 'html' ? body : null;
  const text = email.bodyFormat === 'html' ? plainTextFromHtml(body) : body;

  return {
    subject,
    body,
    bodyFormat: email.bodyFormat,
    text,
    html,
    attachmentName,
    attachmentContent,
    recipients: email.to,
    cc: email.cc,
    variables,
  };
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateEmailSettings(settings: MonitoringSettings, rendered: RenderedEmail): string[] {
  const email = settings.email;
  const errors: string[] = [];
  if (!validEmail(email.senderEmail)) errors.push('A valid sender email is required.');
  if (email.replyTo && !validEmail(email.replyTo)) errors.push('Reply-To must be a valid email address.');
  if (!email.to.length) errors.push('At least one recipient is required.');
  email.to.concat(email.cc).forEach((address) => {
    if (!validEmail(address)) errors.push(`Invalid recipient email: ${address}`);
  });
  if (email.to.length + email.cc.length > 50) errors.push('To and CC may contain at most 50 addresses in total.');
  if (!rendered.subject) errors.push('Subject template must produce a non-empty subject.');
  if (!rendered.text && !rendered.html) errors.push('Email body template must produce content.');
  if (new TextEncoder().encode(rendered.attachmentContent).byteLength > 4 * 1024 * 1024) {
    errors.push('The generated attachment is too large to send.');
  }
  return Array.from(new Set(errors));
}

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function logNotification(
  env: MonitoringEnv,
  siteId: string,
  kind: NotificationKind,
  status: 'sent' | 'failed' | 'skipped',
  rendered: RenderedEmail | null,
  actor: string,
  details: JsonRecord,
  messageId?: string,
  errorMessage?: string,
): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare(`INSERT INTO monitoring_notification_log (
      id, site_id, kind, status, recipients_json, subject, attachment_name,
      message_id, error_message, details_json, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      siteId,
      kind,
      status,
      JSON.stringify(rendered ? [...rendered.recipients, ...rendered.cc] : []),
      rendered?.subject ?? null,
      rendered?.attachmentName ?? null,
      messageId ?? null,
      errorMessage ?? null,
      JSON.stringify(details),
      actor,
      new Date().toISOString(),
    )
    .run();
}

async function sendRenderedEmail(
  env: MonitoringEnv,
  site: SiteRow,
  settings: MonitoringSettings,
  rendered: RenderedEmail,
  kind: NotificationKind,
  actor: string,
  fingerprint: string | null,
): Promise<{ sent: boolean; messageId?: string; error?: string }> {
  const errors = validateEmailSettings(settings, rendered);
  if (errors.length) {
    const message = errors.join(' ');
    await logNotification(env, site.id, kind, 'failed', rendered, actor, { fingerprint }, undefined, message);
    return { sent: false, error: message };
  }
  if (!env.EMAIL) {
    const message = 'Cloudflare Email Service binding EMAIL is not configured.';
    await logNotification(env, site.id, kind, 'failed', rendered, actor, { fingerprint }, undefined, message);
    return { sent: false, error: message };
  }

  try {
    const result = await env.EMAIL.send({
      to: rendered.recipients,
      cc: rendered.cc.length ? rendered.cc : undefined,
      from: settings.email.senderName
        ? { email: settings.email.senderEmail, name: settings.email.senderName }
        : settings.email.senderEmail,
      replyTo: settings.email.replyTo || undefined,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html || undefined,
      attachments: [{
        content: toBase64(rendered.attachmentContent),
        filename: rendered.attachmentName,
        type: 'text/plain; charset=utf-8',
        disposition: 'attachment',
      }],
    });
    await logNotification(env, site.id, kind, 'sent', rendered, actor, { fingerprint }, result.messageId);
    return { sent: true, messageId: result.messageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logNotification(env, site.id, kind, 'failed', rendered, actor, { fingerprint }, undefined, message);
    return { sent: false, error: message };
  }
}

function hoursSince(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;
  return (Date.now() - timestamp) / 3_600_000;
}

async function maybeSendNotification(
  env: MonitoringEnv,
  site: SiteRow,
  settings: MonitoringSettings,
  status: MonitoringStatus,
  fingerprint: string | null,
  actor: string,
  forceKind?: NotificationKind,
): Promise<{ sent: boolean; skipped?: boolean; kind?: NotificationKind; messageId?: string; error?: string }> {
  const state = env.DB ? await readState(env.DB, site.id) : null;
  const missingCount = status.adsTxt?.missing.filter((item) => item.required).length ?? 0;
  let kind: NotificationKind | null = forceKind ?? null;

  if (!kind) {
    if (!settings.email.enabled) return { sent: false, skipped: true };
    if (status.adsTxt?.status === 'missing' && missingCount > 0) {
      const changed = fingerprint !== state?.last_notified_fingerprint;
      if (changed || !settings.email.notifyOnChangeOnly) kind = 'missing';
      else if (hoursSince(state?.last_notified_at ?? null) >= settings.email.reminderHours) kind = 'reminder';
      else return { sent: false, skipped: true };
    } else if (status.adsTxt?.status === 'ok' && settings.email.sendRecovery && state?.last_notified_fingerprint) {
      const recoveryAlreadySent = state.last_recovery_at && state.last_notified_at
        ? Date.parse(state.last_recovery_at) >= Date.parse(state.last_notified_at)
        : false;
      if (!recoveryAlreadySent) kind = 'recovery';
      else return { sent: false, skipped: true };
    } else {
      return { sent: false, skipped: true };
    }
  }

  const rendered = await renderEmail(env, site, settings, status);
  const result = await sendRenderedEmail(env, site, settings, rendered, kind, actor, fingerprint);
  if (result.sent && env.DB) {
    const now = new Date().toISOString();
    if (kind === 'recovery') {
      await env.DB.prepare(`UPDATE site_monitoring_state
        SET last_recovery_at = ?, updated_at = ?
        WHERE site_id = ?`)
        .bind(now, now, site.id)
        .run();
    } else if (kind !== 'test') {
      await env.DB.prepare(`UPDATE site_monitoring_state
        SET last_notified_fingerprint = ?, last_notified_at = ?, updated_at = ?
        WHERE site_id = ?`)
        .bind(fingerprint, now, now, site.id)
        .run();
    }
  }
  return { ...result, kind };
}

export async function getMonitoring(env: MonitoringEnv, siteId: string): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);
  try {
    const site = await fetchSite(env.DB, siteId);
    if (!site) return apiError('Site not found.', 404);
    const [settings, state, history] = await Promise.all([
      readSettings(env.DB, siteId),
      readState(env.DB, siteId),
      readHistory(env.DB, siteId),
    ]);
    return json({
      ok: true,
      site: {
        id: site.id,
        name: site.name,
        domain: site.domain,
        publisherName: site.publisher_name,
        adsTxtUrl: site.ads_txt_url || `https://${site.domain}/ads.txt`,
      },
      settings,
      state: statePayload(state),
      history,
      capabilities: {
        database: true,
        storage: Boolean(env.BUILDS),
        email: Boolean(env.EMAIL),
      },
      templateVariables: [
        'publisher_name', 'site_name', 'domain', 'ads_txt_url', 'status', 'checked_at',
        'missing_count', 'missing_entries', 'attachment_name', 'current_version',
        'manifest_version', 'sender_name',
      ],
    });
  } catch (error) {
    return monitoringTablesError(error) ?? apiError('Monitoring settings could not be loaded.', 500, error instanceof Error ? error.message : String(error));
  }
}

export async function updateMonitoring(request: Request, env: MonitoringEnv, siteId: string): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);
  try {
    const site = await fetchSite(env.DB, siteId);
    if (!site) return apiError('Site not found.', 404);
    const body = await readJson<{ settings?: unknown }>(request);
    const settings = normalizeSettings(body.settings);
    const actor = getActor(request);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO site_monitoring_settings (
          site_id, settings_json, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(site_id) DO UPDATE SET
          settings_json = excluded.settings_json,
          updated_at = excluded.updated_at`)
        .bind(siteId, JSON.stringify(settings), actor, now, now),
      env.DB.prepare(`INSERT INTO audit_log (
          id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
        ) VALUES (?, ?, 'monitoring.settings.updated', ?, 'monitoring_settings', ?, ?, ?)`)
        .bind(crypto.randomUUID(), actor, siteId, siteId, JSON.stringify({ settings }), now),
    ]);
    return json({ ok: true, settings, capabilities: { email: Boolean(env.EMAIL) } });
  } catch (error) {
    return monitoringTablesError(error) ?? apiError('Monitoring settings could not be saved.', 422, error instanceof Error ? error.message : String(error));
  }
}

export async function checkMonitoring(request: Request, env: MonitoringEnv, siteId: string): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);
  try {
    const body = (request.headers.get('content-type') ?? '').includes('application/json')
      ? await request.json() as { notify?: unknown }
      : {};
    const settings = await readSettings(env.DB, siteId);
    const site = await fetchSite(env.DB, siteId);
    if (!site) return apiError('Site not found.', 404);
    const result = await performCheck(env, siteId, settings);
    const notification = booleanValue(body.notify, false)
      ? await maybeSendNotification(env, site, settings, result.status, result.fingerprint, getActor(request))
      : null;
    return json({ ok: true, status: result.status, notification });
  } catch (error) {
    return monitoringTablesError(error) ?? apiError('Monitoring check failed.', 500, error instanceof Error ? error.message : String(error));
  }
}

export async function previewMonitoringEmail(request: Request, env: MonitoringEnv, siteId: string): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);
  try {
    const site = await fetchSite(env.DB, siteId);
    if (!site) return apiError('Site not found.', 404);
    const body = await readJson<{ settings?: unknown }>(request);
    const settings = body.settings ? normalizeSettings(body.settings) : await readSettings(env.DB, siteId);
    const result = await performCheck(env, siteId, settings);
    const rendered = await renderEmail(env, site, settings, result.status);
    return json({
      ok: true,
      status: result.status,
      preview: rendered,
      validationErrors: validateEmailSettings(settings, rendered),
    });
  } catch (error) {
    return monitoringTablesError(error) ?? apiError('Email preview could not be generated.', 422, error instanceof Error ? error.message : String(error));
  }
}

export async function sendMonitoringEmail(
  request: Request,
  env: MonitoringEnv,
  siteId: string,
  kind: 'test' | 'manual',
): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);
  try {
    const site = await fetchSite(env.DB, siteId);
    if (!site) return apiError('Site not found.', 404);
    const body = await readJson<{ settings?: unknown }>(request);
    const settings = body.settings ? normalizeSettings(body.settings) : await readSettings(env.DB, siteId);
    const result = await performCheck(env, siteId, settings);
    const rendered = await renderEmail(env, site, settings, result.status);
    const sent = await sendRenderedEmail(env, site, settings, rendered, kind, getActor(request), result.fingerprint);
    if (!sent.sent) return apiError('Email could not be sent.', 422, sent.error);
    return json({ ok: true, messageId: sent.messageId, preview: rendered, status: result.status });
  } catch (error) {
    return monitoringTablesError(error) ?? apiError('Email could not be sent.', 500, error instanceof Error ? error.message : String(error));
  }
}

export async function runScheduledMonitoring(env: MonitoringEnv): Promise<void> {
  if (!env.DB) return;
  try {
    const result = await env.DB.prepare(`SELECT s.site_id, s.settings_json, st.last_checked_at
      FROM site_monitoring_settings s
      LEFT JOIN site_monitoring_state st ON st.site_id = s.site_id`)
      .all<{ site_id: string; settings_json: string; last_checked_at: string | null }>();

    for (const row of result.results ?? []) {
      const settings = normalizeSettings(parseRecord(row.settings_json));
      if (!settings.enabled) continue;
      if (hoursSince(row.last_checked_at) < settings.checkIntervalHours) continue;
      try {
        const site = await fetchSite(env.DB, row.site_id);
        if (!site) continue;
        const check = await performCheck(env, row.site_id, settings);
        await maybeSendNotification(env, site, settings, check.status, check.fingerprint, 'scheduled-monitoring');
      } catch (error) {
        console.error('Scheduled monitoring failed for', row.site_id, error);
      }
    }
  } catch (error) {
    console.error('Scheduled monitoring sweep failed', error);
  }
}
