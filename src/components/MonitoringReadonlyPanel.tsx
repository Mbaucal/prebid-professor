import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Site } from '../shared/types';
import MonitoringEmailSendTest from './MonitoringEmailSendTest';
import GmailConnectionPanel from './GmailConnectionPanel';
import MonitoringNotificationRules from './MonitoringNotificationRules';

type Props = {
  site: Site;
};

type OverallStatus = 'healthy' | 'warning' | 'error' | 'not-published';
type AttachmentMode = 'full-corrected' | 'missing-only' | 'expected-only';
type BodyFormat = 'plain' | 'html';

type ArtifactStatus = {
  fileName: string;
  required: boolean;
  found: boolean;
  size: number | null;
  uploadedAt: string | null;
  url: string;
};

type AdsTxtResult = {
  sourceLabel?: string;
  entry?: string;
  required?: boolean;
  found?: boolean;
};

type AdsTxtStatus = {
  status?: 'ok' | 'missing' | 'empty' | 'fetch-error';
  url?: string;
  finalUrl?: string | null;
  fetchedAt?: string;
  httpStatus?: number | null;
  message?: string;
  actualEntryCount?: number;
  requirementCount?: number;
  foundCount?: number;
  requiredMissingCount?: number;
  optionalMissingCount?: number;
  invalidLineCount?: number;
  duplicateLineCount?: number;
  results?: AdsTxtResult[];
  missing?: AdsTxtResult[];
  optionalMissing?: AdsTxtResult[];
};

type MonitoringPayload = {
  ok: true;
  checkedAt: string;
  overall: OverallStatus;
  site: {
    id: string;
    name: string;
    domain: string;
    adsTxtUrl: string;
  };
  runtime: {
    published: boolean;
    currentReleaseId: string | null;
    expectedVersion: string | null;
    manifestVersion: string | null;
    versionMatches: boolean | null;
    demandMode: string;
    artifacts: ArtifactStatus[];
  };
  adsTxt: AdsTxtStatus;
  messages: string[];
  readOnly: true;
};

type EmailPreviewData = {
  ok: true;
  readOnly: true;
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

type EmailDraft = {
  senderName: string;
  senderEmail: string;
  replyTo: string;
  to: string;
  cc: string;
  subjectTemplate: string;
  bodyTemplate: string;
  bodyFormat: BodyFormat;
  attachmentMode: AttachmentMode;
  attachmentNameTemplate: string;
};

type RenderedPreview = {
  subject: string;
  body: string;
  bodyFormat: BodyFormat;
  attachmentName: string;
  attachmentContent: string;
  variables: Record<string, string>;
  warnings: string[];
};

type ServerDraftPayload = {
  ok: true;
  saved: boolean;
  settings: EmailDraft;
  updatedBy: string | null;
  updatedAt: string | null;
  storage: 'd1' | 'not-created';
};

type FailurePayload = {
  error?: string;
  details?: unknown;
};

const EMPTY_DRAFT: EmailDraft = {
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

const TEMPLATE_VARIABLES = [
  '{{publisher_name}}',
  '{{site_name}}',
  '{{domain}}',
  '{{ads_txt_url}}',
  '{{status}}',
  '{{checked_at}}',
  '{{missing_count}}',
  '{{missing_entries}}',
  '{{attachment_name}}',
  '{{current_version}}',
  '{{manifest_version}}',
  '{{sender_name}}',
  '{{notification_kind}}',
] as const;

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text();
  let payload: (T & FailurePayload) | null = null;
  try {
    payload = text ? JSON.parse(text) as T & FailurePayload : null;
  } catch {
    throw new Error(text || `Request failed with status ${response.status}.`);
  }
  if (!response.ok || !payload) {
    const details = payload?.details === undefined
      ? ''
      : typeof payload.details === 'string'
        ? ` ${payload.details}`
        : ` ${JSON.stringify(payload.details)}`;
    throw new Error(`${payload?.error || `Request failed with status ${response.status}.`}${details}`);
  }
  return payload as T;
}

async function requestStatus(siteId: string): Promise<MonitoringPayload> {
  return requestJson<MonitoringPayload>(
    `/api/publishers/${encodeURIComponent(siteId)}/monitoring/status?ts=${Date.now()}`,
    {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    },
  );
}

async function requestEmailPreviewData(siteId: string): Promise<EmailPreviewData> {
  return requestJson<EmailPreviewData>(
    `/api/publishers/${encodeURIComponent(siteId)}/monitoring/email-preview-data?ts=${Date.now()}`,
    {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    },
  );
}

async function requestMonitoringEmailDraft(siteId: string): Promise<ServerDraftPayload> {
  return requestJson<ServerDraftPayload>(
    `/api/publishers/${encodeURIComponent(siteId)}/monitoring/email-settings?ts=${Date.now()}`,
    {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    },
  );
}

async function persistMonitoringEmailDraft(siteId: string, settings: EmailDraft): Promise<ServerDraftPayload> {
  return requestJson<ServerDraftPayload>(
    `/api/publishers/${encodeURIComponent(siteId)}/monitoring/email-settings`,
    {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ settings }),
    },
  );
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('en', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatBytes(value: number | null): string {
  if (value === null) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function overallLabel(value: OverallStatus): string {
  if (value === 'healthy') return 'HEALTHY';
  if (value === 'warning') return 'WARNING';
  if (value === 'error') return 'ACTION REQUIRED';
  return 'NOT PUBLISHED';
}

function adsTxtLabel(status: AdsTxtStatus): string {
  if (status.status === 'ok') return 'OK';
  if (status.status === 'missing') return `${status.requiredMissingCount ?? status.missing?.length ?? 0} MISSING`;
  if (status.status === 'empty') return 'NO EXPECTED ENTRIES';
  if (status.status === 'fetch-error') return 'FETCH ERROR';
  return 'NOT CHECKED';
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

function correctedAdsTxt(liveContent: string, missingEntries: AdsTxtResult[]): string {
  const live = liveContent.replace(/\s+$/g, '');
  const additions = groupedEntries(missingEntries);
  if (!additions) return live ? `${live}\n` : '';
  return `${live ? `${live}\n\n` : ''}${additions}\n`;
}

function triggerTextDownload(content: string, fileName: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard) throw new Error('Clipboard access is not available in this browser.');
  await navigator.clipboard.writeText(value);
}

function storageKey(siteId: string): string {
  return `tessera.monitoring.email-draft.v2.${siteId}`;
}

function loadDraft(siteId: string): EmailDraft {
  try {
    const raw = window.localStorage.getItem(storageKey(siteId));
    if (!raw) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as Partial<EmailDraft>;
    return {
      ...EMPTY_DRAFT,
      ...parsed,
      bodyFormat: parsed.bodyFormat === 'html' ? 'html' : 'plain',
      attachmentMode: ['full-corrected', 'missing-only', 'expected-only'].includes(String(parsed.attachmentMode))
        ? parsed.attachmentMode as AttachmentMode
        : 'full-corrected',
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

export default function MonitoringReadonlyPanel({ site }: Props) {
  const [payload, setPayload] = useState<MonitoringPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<EmailDraft>(EMPTY_DRAFT);
  const [preview, setPreview] = useState<RenderedPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<'subject' | 'body' | null>(null);
  const [serverDraft, setServerDraft] = useState<ServerDraftPayload | null>(null);
  const [serverSaving, setServerSaving] = useState(false);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailEmail, setGmailEmail] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPayload(await requestStatus(site.id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Monitoring could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [site.id]);

  const loadServerDraft = useCallback(async () => {
    try {
      const savedDraft = await requestMonitoringEmailDraft(site.id);
      setServerDraft(savedDraft);
      setDraft(savedDraft.saved ? savedDraft.settings : loadDraft(site.id));
    } catch (requestError) {
      setServerDraft(null);
      setDraft(loadDraft(site.id));
      setError(requestError instanceof Error ? requestError.message : 'Saved email draft could not be loaded.');
    }
  }, [site.id]);

  useEffect(() => {
    setPayload(null);
    setPreview(null);
    setDraftMessage(null);
    setServerDraft(null);
    setDraft(loadDraft(site.id));
    void load();
    void loadServerDraft();
  }, [load, loadServerDraft, site.id]);

  const onlineArtifacts = useMemo(
    () => payload?.runtime.artifacts.filter((artifact) => artifact.found).length ?? 0,
    [payload],
  );
  const requiredArtifacts = useMemo(
    () => payload?.runtime.artifacts.filter((artifact) => artifact.required).length ?? 0,
    [payload],
  );
  const requiredOnline = useMemo(
    () => payload?.runtime.artifacts.filter((artifact) => artifact.required && artifact.found).length ?? 0,
    [payload],
  );
  const missing = payload?.adsTxt.missing ?? [];

  function updateDraft<K extends keyof EmailDraft>(key: K, value: EmailDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
    setPreview(null);
    setDraftMessage(null);
  }

  function saveDraft(): void {
    window.localStorage.setItem(storageKey(site.id), JSON.stringify(draft));
    setDraftMessage('Draft saved in this browser for this site.');
  }

  async function saveServerDraft(): Promise<void> {
    setServerSaving(true);
    setError(null);
    setDraftMessage(null);
    try {
      const savedDraft = await persistMonitoringEmailDraft(site.id, draft);
      setServerDraft(savedDraft);
      setDraft(savedDraft.settings);
      window.localStorage.setItem(storageKey(site.id), JSON.stringify(savedDraft.settings));
      setDraftMessage(`Draft saved to Tessera${savedDraft.updatedAt ? ` · ${formatTime(savedDraft.updatedAt)}` : ''}. No email was sent.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Email draft could not be saved to Tessera.');
    } finally {
      setServerSaving(false);
    }
  }

  function clearDraft(): void {
    window.localStorage.removeItem(storageKey(site.id));
    setDraft(EMPTY_DRAFT);
    setPreview(null);
    setDraftMessage(serverDraft?.saved ? 'Browser form cleared. The saved Tessera draft remains until you save the empty form.' : 'Browser draft cleared.');
  }

  async function generatePreview(): Promise<void> {
    if (!payload) return;
    setPreviewing(true);
    setError(null);
    setDraftMessage(null);
    try {
      const data = await requestEmailPreviewData(site.id);
      const missingEntries = uniqueEntries(payload.adsTxt.missing ?? []);
      const expectedEntries = uniqueEntries(data.expected);
      const missingText = groupedEntries(missingEntries) || 'None';
      const baseVariables: Record<string, string> = {
        publisher_name: data.site.publisherName || '',
        site_name: data.site.name,
        domain: data.site.domain,
        ads_txt_url: data.live.finalUrl || data.site.adsTxtUrl,
        status: adsTxtLabel(payload.adsTxt),
        checked_at: formatTime(payload.checkedAt),
        missing_count: String(payload.adsTxt.requiredMissingCount ?? missingEntries.length),
        missing_entries: missingText,
        current_version: payload.runtime.expectedVersion ?? '',
        manifest_version: payload.runtime.manifestVersion ?? '',
        sender_name: draft.senderName,
        attachment_name: '',
      };
      const attachmentName = safeFileName(renderTemplate(draft.attachmentNameTemplate || '{{domain}}-ads.txt', baseVariables));
      const variables = { ...baseVariables, attachment_name: attachmentName };

      let attachmentContent = '';
      const warnings: string[] = [];
      if (draft.attachmentMode === 'missing-only') {
        attachmentContent = groupedEntries(missingEntries);
      } else if (draft.attachmentMode === 'expected-only') {
        attachmentContent = groupedEntries(expectedEntries);
      } else if (data.live.error) {
        warnings.push(`Full corrected ads.txt could not be created: ${data.live.error}`);
        attachmentContent = groupedEntries(expectedEntries);
      } else {
        attachmentContent = correctedAdsTxt(data.live.content, missingEntries);
      }
      if (attachmentContent && !attachmentContent.endsWith('\n')) attachmentContent += '\n';
      if (!draft.subjectTemplate.trim()) warnings.push('Subject template is empty.');
      if (!draft.bodyTemplate.trim()) warnings.push('Email body template is empty.');
      if (!draft.to.trim()) warnings.push('Recipient list is empty.');

      setPreview({
        subject: renderTemplate(draft.subjectTemplate, variables),
        body: renderTemplate(draft.bodyTemplate, variables),
        bodyFormat: draft.bodyFormat,
        attachmentName,
        attachmentContent,
        variables,
        warnings,
      });
      setDraftMessage('Preview generated. No email was sent and current form values were not saved automatically.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Email preview could not be generated.');
    } finally {
      setPreviewing(false);
    }
  }

  async function copyPreviewPart(part: 'subject' | 'body'): Promise<void> {
    if (!preview) return;
    try {
      await copyText(part === 'subject' ? preview.subject : preview.body);
      setCopied(part);
      window.setTimeout(() => setCopied(null), 1800);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : 'Preview could not be copied.');
    }
  }

  return (
    <section className="monitor-readonly-page">
      <div className="monitor-readonly-heading">
        <div>
          <span className="panel-kicker">Runtime, R2, ads.txt and email preview</span>
          <h2>Monitoring</h2>
          <p>Runtime checks remain read-only. Email templates can be previewed, saved per site, sent through the connected Gmail account and evaluated against staged notification rules.</p>
        </div>
        <button className="button primary" disabled={loading} onClick={() => void load()} type="button">
          {loading ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {error ? <div className="form-error monitor-readonly-message">{error}</div> : null}
      {draftMessage ? <div className="release-success monitor-readonly-message">✓ {draftMessage}</div> : null}
      {loading && !payload ? <div className="config-loading">Checking production artifacts and ads.txt…</div> : null}

      {payload ? (
        <>
          <div className="monitor-readonly-summary">
            <article className={`monitor-summary-card ${payload.overall}`}>
              <span>Overall status</span>
              <strong>{overallLabel(payload.overall)}</strong>
              <small>{formatTime(payload.checkedAt)}</small>
            </article>
            <article className="monitor-summary-card">
              <span>Production version</span>
              <strong>{payload.runtime.expectedVersion ?? '—'}</strong>
              <small>Manifest: {payload.runtime.manifestVersion ?? '—'}</small>
            </article>
            <article className="monitor-summary-card">
              <span>Required artifacts</span>
              <strong>{payload.runtime.published ? `${requiredOnline}/${requiredArtifacts}` : '—'}</strong>
              <small>{onlineArtifacts} total files found</small>
            </article>
            <article className="monitor-summary-card">
              <span>Ads.txt</span>
              <strong>{adsTxtLabel(payload.adsTxt)}</strong>
              <small>HTTP {payload.adsTxt.httpStatus ?? '—'}</small>
            </article>
          </div>

          <div className="monitor-readonly-grid">
            <article className="monitor-readonly-card">
              <div className="monitor-readonly-card-heading">
                <div>
                  <span className="panel-kicker">R2 current channel</span>
                  <h3>Production artifacts</h3>
                </div>
                <span className={`monitor-readonly-pill ${payload.runtime.versionMatches ? 'healthy' : payload.runtime.versionMatches === false ? 'error' : 'neutral'}`}>
                  {payload.runtime.versionMatches ? 'VERSION MATCH' : payload.runtime.versionMatches === false ? 'VERSION MISMATCH' : 'NO VERSION'}
                </span>
              </div>

              <div className="monitor-runtime-facts">
                <div><span>Release ID</span><code>{payload.runtime.currentReleaseId ?? '—'}</code></div>
                <div><span>Demand mode</span><strong>{payload.runtime.demandMode}</strong></div>
                <div><span>Published</span><strong>{payload.runtime.published ? 'Yes' : 'No'}</strong></div>
              </div>

              <div className="monitor-artifact-list">
                {payload.runtime.artifacts.map((artifact) => (
                  <div key={artifact.fileName}>
                    <span className={`monitor-dot ${artifact.found ? 'healthy' : artifact.required ? 'error' : 'warning'}`} />
                    <div>
                      <code>{artifact.fileName}</code>
                      <small>{artifact.required ? 'required' : 'optional'} · {formatTime(artifact.uploadedAt)}</small>
                    </div>
                    <strong>{artifact.found ? formatBytes(artifact.size) : 'Missing'}</strong>
                    <a href={artifact.url} rel="noreferrer" target="_blank">Open</a>
                  </div>
                ))}
                {!payload.runtime.artifacts.length ? <p>No production release artifacts are available to check.</p> : null}
              </div>
            </article>

            <article className="monitor-readonly-card">
              <div className="monitor-readonly-card-heading">
                <div>
                  <span className="panel-kicker">Publisher file</span>
                  <h3>Ads.txt status</h3>
                </div>
                <span className={`monitor-readonly-pill ${payload.adsTxt.status === 'ok' ? 'healthy' : payload.adsTxt.status === 'missing' || payload.adsTxt.status === 'fetch-error' ? 'error' : 'warning'}`}>
                  {payload.adsTxt.status ?? 'UNKNOWN'}
                </span>
              </div>

              <div className="monitor-runtime-facts">
                <div><span>Expected</span><strong>{payload.adsTxt.requirementCount ?? 0}</strong></div>
                <div><span>Found</span><strong>{payload.adsTxt.foundCount ?? 0}</strong></div>
                <div><span>Missing</span><strong>{payload.adsTxt.requiredMissingCount ?? 0}</strong></div>
                <div><span>Invalid live lines</span><strong>{payload.adsTxt.invalidLineCount ?? 0}</strong></div>
                <div><span>Live duplicates</span><strong>{payload.adsTxt.duplicateLineCount ?? 0}</strong></div>
                <div><span>Checked</span><strong>{formatTime(payload.adsTxt.fetchedAt)}</strong></div>
              </div>

              <div className="monitor-ads-url">
                <span>Live URL</span>
                <a href={payload.adsTxt.finalUrl || payload.adsTxt.url || payload.site.adsTxtUrl} rel="noreferrer" target="_blank">
                  {payload.adsTxt.finalUrl || payload.adsTxt.url || payload.site.adsTxtUrl}
                </a>
              </div>

              {missing.length ? (
                <div className="monitor-missing-list">
                  {missing.map((item, index) => (
                    <div key={`${item.sourceLabel ?? 'entry'}-${item.entry ?? index}`}>
                      <strong>{item.sourceLabel || 'Missing entry'}</strong>
                      <code>{item.entry || 'Entry unavailable'}</code>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="monitor-healthy-copy">
                  {payload.adsTxt.status === 'ok' ? 'No required ads.txt entries are missing.' : payload.adsTxt.message || 'No missing entries were returned.'}
                </p>
              )}
            </article>
          </div>

          {payload.messages.length ? (
            <article className="monitor-readonly-card monitor-findings">
              <div className="monitor-readonly-card-heading">
                <div><span className="panel-kicker">Current check</span><h3>Findings</h3></div>
              </div>
              {payload.messages.map((message) => <div key={message}>{message}</div>)}
            </article>
          ) : null}

          <GmailConnectionPanel onConnectionChange={(connected, email) => { setGmailConnected(connected); setGmailEmail(email); }} />

          <article className="monitor-readonly-card monitor-email-builder">
            <div className="monitor-readonly-card-heading">
              <div>
                <span className="panel-kicker">Per-site template workflow</span>
                <h3>Ads.txt email template</h3>
              </div>
              <div className="monitor-email-statuses">
                <span className={`monitor-readonly-pill ${serverDraft?.saved ? 'healthy' : 'warning'}`}>
                  {serverDraft?.saved ? 'SAVED TO TESSERA' : 'NOT SAVED TO TESSERA'}
                </span>
                <span className={`monitor-readonly-pill ${gmailConnected ? 'healthy' : 'warning'}`}>
                  {gmailConnected ? 'GMAIL READY' : 'GMAIL DISCONNECTED'}
                </span>
              </div>
            </div>
            <p className="monitor-email-intro">Write the exact subject and message you want. You can keep a browser draft, save the template per site in Tessera, and generate a safe preview plus a downloadable ads.txt attachment.</p>

            <div className="monitor-email-form-grid">
              <label><span>Sender name</span><input onChange={(event) => updateDraft('senderName', event.target.value)} placeholder="Tessera Ads.txt" value={draft.senderName} /></label>
              <label><span>Sender account</span><input disabled value={gmailEmail ?? 'Connect Gmail above'} /></label>
              <label><span>Reply-To</span><input onChange={(event) => updateDraft('replyTo', event.target.value)} placeholder="adops@example.com" type="email" value={draft.replyTo} /></label>
              <label><span>Body format</span><select onChange={(event) => updateDraft('bodyFormat', event.target.value as BodyFormat)} value={draft.bodyFormat}><option value="plain">Plain text</option><option value="html">HTML</option></select></label>
              <label className="monitor-span-2"><span>To</span><textarea onChange={(event) => updateDraft('to', event.target.value)} placeholder="publisher@example.com\nprogrammer@example.com" value={draft.to} /></label>
              <label className="monitor-span-2"><span>CC</span><textarea onChange={(event) => updateDraft('cc', event.target.value)} placeholder="optional@example.com" value={draft.cc} /></label>
              <label className="monitor-span-4"><span>Subject template</span><input onChange={(event) => updateDraft('subjectTemplate', event.target.value)} placeholder="Write your own subject and use variables such as {{domain}}" value={draft.subjectTemplate} /></label>
              <label className="monitor-span-4"><span>Email body template</span><textarea className="monitor-body-template" onChange={(event) => updateDraft('bodyTemplate', event.target.value)} placeholder="Write the complete email here. Nothing is predefined." value={draft.bodyTemplate} /></label>
              <label><span>Attachment mode</span><select onChange={(event) => updateDraft('attachmentMode', event.target.value as AttachmentMode)} value={draft.attachmentMode}><option value="full-corrected">Full corrected ads.txt</option><option value="missing-only">Missing entries only</option><option value="expected-only">Tessera expected entries</option></select></label>
              <label className="monitor-span-3"><span>Attachment filename</span><input onChange={(event) => updateDraft('attachmentNameTemplate', event.target.value)} placeholder="{{domain}}-ads.txt" value={draft.attachmentNameTemplate} /></label>
            </div>

            <div className="monitor-template-variables">
              <span>Available template variables</span>
              <div>{TEMPLATE_VARIABLES.map((variable) => <code key={variable}>{variable}</code>)}</div>
            </div>

            <div className="monitor-email-actions">
              <button className="button secondary" onClick={saveDraft} type="button">Save browser draft</button>
              <button className="button secondary" disabled={serverSaving} onClick={() => void saveServerDraft()} type="button">{serverSaving ? 'Saving…' : 'Save to Tessera'}</button>
              <button className="button secondary" onClick={clearDraft} type="button">Clear form</button>
              <button className="button primary" disabled={previewing} onClick={() => void generatePreview()} type="button">{previewing ? 'Generating…' : 'Preview email + attachment'}</button>
            </div>

            {preview ? (
              <div className="monitor-preview-area">
                {preview.warnings.length ? <div className="monitor-preview-warnings">{preview.warnings.map((warning) => <div key={warning}>{warning}</div>)}</div> : null}
                <div className="monitor-preview-meta">
                  <div><span>From</span><strong>{draft.senderName || '—'}{gmailEmail ? ` <${gmailEmail}>` : ''}</strong></div>
                  <div><span>To</span><strong>{draft.to || '—'}</strong></div>
                  <div><span>CC</span><strong>{draft.cc || '—'}</strong></div>
                  <div><span>Reply-To</span><strong>{draft.replyTo || '—'}</strong></div>
                  <div><span>Attachment</span><strong>{preview.attachmentName}</strong></div>
                  <div><span>Attachment size</span><strong>{formatBytes(new Blob([preview.attachmentContent]).size)}</strong></div>
                </div>

                <div className="monitor-preview-grid">
                  <section>
                    <div className="monitor-preview-heading"><span>Rendered subject</span><button onClick={() => void copyPreviewPart('subject')} type="button">{copied === 'subject' ? '✓ Copied' : 'Copy'}</button></div>
                    <pre>{preview.subject || '—'}</pre>
                  </section>
                  <section>
                    <div className="monitor-preview-heading"><span>Rendered body</span><button onClick={() => void copyPreviewPart('body')} type="button">{copied === 'body' ? '✓ Copied' : 'Copy'}</button></div>
                    {preview.bodyFormat === 'html' ? <iframe sandbox="" srcDoc={preview.body} title="Email HTML preview" /> : <pre>{preview.body || '—'}</pre>}
                  </section>
                  <section className="monitor-span-2">
                    <div className="monitor-preview-heading"><span>Attachment preview</span><button onClick={() => triggerTextDownload(preview.attachmentContent, preview.attachmentName)} type="button">Download .txt</button></div>
                    <pre>{preview.attachmentContent || 'The generated attachment is empty.'}</pre>
                  </section>
                </div>
              </div>
            ) : null}
            <MonitoringEmailSendTest
              attachmentContent={preview?.attachmentContent ?? ''}
              attachmentName={preview?.attachmentName ?? ''}
              body={preview?.body ?? ''}
              bodyFormat={preview?.bodyFormat ?? 'plain'}
              cc={draft.cc}
              gmailConnected={gmailConnected}
              previewReady={Boolean(preview)}
              replyTo={draft.replyTo}
              senderName={draft.senderName}
              siteId={site.id}
              subject={preview?.subject ?? ''}
              to={draft.to}
            />
          </article>

          <MonitoringNotificationRules
            gmailConnected={gmailConnected}
            siteId={site.id}
            templateSaved={Boolean(serverDraft?.saved)}
          />

          <div className="monitor-readonly-note">
            <strong>Safe staged rollout:</strong> runtime monitoring remains read-only. Gmail test sends and manual rule evaluation are explicit actions; the scheduler is still disabled on this preview branch and no release or R2 object is modified.
          </div>
        </>
      ) : null}
    </section>
  );
}
