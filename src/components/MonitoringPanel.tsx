import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Site } from '../shared/types';

type Props = {
  site: Site;
};

type AttachmentMode = 'full-corrected' | 'missing-only' | 'expected-only';
type BodyFormat = 'plain' | 'html';
type MonitorSeverity = 'ok' | 'warning' | 'error' | 'not-configured';

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

type AdsTxtResult = {
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
  missing: AdsTxtResult[];
  optionalMissing: AdsTxtResult[];
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

type NotificationHistory = {
  id: string;
  kind: string;
  status: 'sent' | 'failed' | 'skipped';
  recipients: unknown[];
  subject: string | null;
  attachmentName: string | null;
  messageId: string | null;
  errorMessage: string | null;
  createdBy: string | null;
  createdAt: string;
};

type MonitoringPayload = {
  ok: true;
  site: {
    id: string;
    name: string;
    domain: string;
    publisherName: string | null;
    adsTxtUrl: string;
  };
  settings: MonitoringSettings;
  state: {
    lastCheckedAt: string | null;
    status: MonitoringStatus | Record<string, unknown>;
    lastNotifiedAt: string | null;
    lastRecoveryAt: string | null;
  } | null;
  history: NotificationHistory[];
  capabilities: {
    database: boolean;
    storage: boolean;
    email: boolean;
  };
  templateVariables: string[];
};

type PreviewPayload = {
  ok: true;
  status: MonitoringStatus;
  preview: {
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
  validationErrors: string[];
};

type ApiFailure = {
  error?: string;
  details?: unknown;
};

const EMPTY_SETTINGS: MonitoringSettings = {
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

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text();
  let payload: (T & ApiFailure) | null = null;
  try {
    payload = text ? JSON.parse(text) as T & ApiFailure : null;
  } catch {
    throw new Error(text || `Request failed with status ${response.status}.`);
  }
  if (!response.ok) {
    const details = payload?.details === undefined
      ? ''
      : typeof payload.details === 'string'
        ? ` ${payload.details}`
        : ` ${JSON.stringify(payload.details)}`;
    throw new Error(`${payload?.error || `Request failed with status ${response.status}.`}${details}`);
  }
  return payload as T;
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

function addresses(value: string): string[] {
  return Array.from(new Set(value.split(/[;,\n]+/).map((item) => item.trim().toLowerCase()).filter(Boolean)));
}

function addressText(value: string[]): string {
  return value.join('\n');
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

function severityLabel(value: MonitorSeverity): string {
  if (value === 'ok') return 'HEALTHY';
  if (value === 'warning') return 'WARNING';
  if (value === 'error') return 'ACTION REQUIRED';
  return 'NOT PUBLISHED';
}

function statusFromPayload(payload: MonitoringPayload | null): MonitoringStatus | null {
  const candidate = payload?.state?.status;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  if (!('severity' in candidate) || !('siteId' in candidate)) return null;
  return candidate as MonitoringStatus;
}

export default function MonitoringPanel({ site }: Props) {
  const [payload, setPayload] = useState<MonitoringPayload | null>(null);
  const [settings, setSettings] = useState<MonitoringSettings>(EMPTY_SETTINGS);
  const [status, setStatus] = useState<MonitoringStatus | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const endpoint = `/api/publishers/${encodeURIComponent(site.id)}/monitoring`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await requestJson<MonitoringPayload>(endpoint, { cache: 'no-store' });
      setPayload(next);
      setSettings(next.settings);
      setStatus(statusFromPayload(next));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Monitoring could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    setPayload(null);
    setStatus(null);
    setPreview(null);
    setSettings(EMPTY_SETTINGS);
    void load();
  }, [load]);

  const missingCount = status?.adsTxt?.requiredMissingCount ?? status?.adsTxt?.missing.length ?? 0;
  const healthyArtifacts = useMemo(
    () => status?.artifacts.filter((artifact) => artifact.found).length ?? 0,
    [status],
  );

  function updateEmail<K extends keyof MonitoringEmailSettings>(key: K, value: MonitoringEmailSettings[K]): void {
    setSettings((current) => ({ ...current, email: { ...current.email, [key]: value } }));
    setPreview(null);
  }

  async function saveSettings(): Promise<void> {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await requestJson<{ ok: true; settings: MonitoringSettings }>(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      setSettings(response.settings);
      setMessage('Monitoring settings saved.');
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Monitoring settings could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function runCheck(notify: boolean): Promise<void> {
    setChecking(true);
    setError(null);
    setMessage(null);
    try {
      const response = await requestJson<{
        ok: true;
        status: MonitoringStatus;
        notification: { sent?: boolean; skipped?: boolean; messageId?: string; error?: string } | null;
      }>(`${endpoint}/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notify }),
      });
      setStatus(response.status);
      if (notify) {
        if (response.notification?.sent) setMessage(`Monitoring check completed and email sent${response.notification.messageId ? ` · ${response.notification.messageId}` : ''}.`);
        else if (response.notification?.skipped) setMessage('Monitoring check completed. Notification rules skipped email sending.');
        else setMessage('Monitoring check completed, but no email was sent.');
      } else {
        setMessage('Monitoring check completed.');
      }
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Monitoring check failed.');
    } finally {
      setChecking(false);
    }
  }

  async function createPreview(): Promise<void> {
    setPreviewing(true);
    setError(null);
    setMessage(null);
    try {
      const response = await requestJson<PreviewPayload>(`${endpoint}/email-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      setPreview(response);
      setStatus(response.status);
      setMessage('Email preview generated from the current form values.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Email preview could not be generated.');
    } finally {
      setPreviewing(false);
    }
  }

  async function sendTest(): Promise<void> {
    setSending(true);
    setError(null);
    setMessage(null);
    try {
      const response = await requestJson<{ ok: true; messageId?: string; preview: PreviewPayload['preview']; status: MonitoringStatus }>(
        `${endpoint}/send-test`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ settings }),
        },
      );
      setStatus(response.status);
      setPreview({ ok: true, status: response.status, preview: response.preview, validationErrors: [] });
      setMessage(`Test email sent${response.messageId ? ` · ${response.messageId}` : ''}.`);
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Test email could not be sent.');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="monitoring-page">
      <div className="monitoring-heading">
        <div>
          <span className="panel-kicker">Runtime, CDN and ads.txt health</span>
          <h2>Monitoring</h2>
          <p>Check the current production channel, compare the live manifest version and optionally send custom ads.txt notification emails.</p>
        </div>
        <div className="monitoring-heading-actions">
          <button className="button secondary" disabled={checking || loading} onClick={() => void runCheck(false)} type="button">
            {checking ? 'Checking…' : 'Check now'}
          </button>
          <button className="button primary" disabled={checking || loading || !settings.email.enabled} onClick={() => void runCheck(true)} type="button">
            Check + notify
          </button>
        </div>
      </div>

      {error ? <div className="form-error monitoring-message">{error}</div> : null}
      {message ? <div className="release-success monitoring-message">✓ {message}</div> : null}
      {loading ? <div className="config-loading">Loading monitoring settings and last state…</div> : null}

      <div className="monitoring-summary-grid">
        <article className={`monitoring-summary-card ${status?.severity ?? 'not-configured'}`}>
          <span>Overall status</span>
          <strong>{status ? severityLabel(status.severity) : 'NOT CHECKED'}</strong>
          <small>{status ? formatTime(status.checkedAt) : 'Run the first check.'}</small>
        </article>
        <article className="monitoring-summary-card">
          <span>Production version</span>
          <strong>{status?.expectedVersion ?? site.currentVersion ?? '—'}</strong>
          <small>Manifest: {status?.manifestVersion ?? '—'}</small>
        </article>
        <article className="monitoring-summary-card">
          <span>Artifacts online</span>
          <strong>{status ? `${healthyArtifacts}/${status.artifacts.length}` : '—'}</strong>
          <small>{status?.versionMatches === false ? 'Version mismatch' : status?.versionMatches ? 'Version matches' : 'Not compared'}</small>
        </article>
        <article className="monitoring-summary-card">
          <span>Ads.txt</span>
          <strong>{status?.adsTxt?.status === 'ok' ? '✅ OK' : status?.adsTxt?.status === 'missing' ? `❌ ${missingCount} missing` : status?.adsTxt?.status ?? '—'}</strong>
          <small>HTTP {status?.adsTxt?.httpStatus ?? '—'}</small>
        </article>
      </div>

      {status ? (
        <div className="monitoring-health-grid">
          <article className="monitoring-card">
            <div className="monitoring-card-heading">
              <div><span className="panel-kicker">R2 current channel</span><h3>Release artifacts</h3></div>
              <span className={`monitoring-pill ${status.versionMatches ? 'ok' : status.versionMatches === false ? 'error' : 'neutral'}`}>
                {status.versionMatches ? 'VERSION MATCH' : status.versionMatches === false ? 'VERSION MISMATCH' : 'NO VERSION'}
              </span>
            </div>
            <div className="monitoring-artifact-list">
              {status.artifacts.map((artifact) => (
                <div key={artifact.fileName}>
                  <span className={artifact.found ? 'monitoring-dot ok' : artifact.required ? 'monitoring-dot error' : 'monitoring-dot warning'} />
                  <code>{artifact.fileName}</code>
                  <small>{artifact.required ? 'required' : 'optional'}</small>
                  <strong>{artifact.found ? formatBytes(artifact.size) : 'Missing'}</strong>
                </div>
              ))}
              {!status.artifacts.length ? <p>Runtime artifact checks are disabled.</p> : null}
            </div>
          </article>

          <article className="monitoring-card">
            <div className="monitoring-card-heading">
              <div><span className="panel-kicker">Publisher file</span><h3>Ads.txt result</h3></div>
              <span className={`monitoring-pill ${status.adsTxt?.status === 'ok' ? 'ok' : status.adsTxt?.status === 'missing' || status.adsTxt?.status === 'fetch-error' ? 'error' : 'warning'}`}>
                {status.adsTxt?.status ?? 'DISABLED'}
              </span>
            </div>
            {status.adsTxt ? (
              <>
                <div className="monitoring-facts">
                  <div><span>URL</span><code>{status.adsTxt.finalUrl || status.adsTxt.url}</code></div>
                  <div><span>Expected</span><strong>{status.adsTxt.requirementCount ?? 0}</strong></div>
                  <div><span>Found</span><strong>{status.adsTxt.foundCount ?? 0}</strong></div>
                  <div><span>Missing</span><strong>{status.adsTxt.requiredMissingCount ?? 0}</strong></div>
                  <div><span>Invalid live lines</span><strong>{status.adsTxt.invalidLineCount ?? 0}</strong></div>
                  <div><span>Live duplicates</span><strong>{status.adsTxt.duplicateLineCount ?? 0}</strong></div>
                </div>
                {status.adsTxt.missing.length ? (
                  <div className="monitoring-missing-list">
                    {status.adsTxt.missing.map((item) => (
                      <div key={`${item.sourceLabel}-${item.entry}`}><strong>❌ {item.sourceLabel}</strong><code>{item.entry}</code></div>
                    ))}
                  </div>
                ) : <p className="monitoring-ok-copy">No required ads.txt entries are missing.</p>}
              </>
            ) : <p>Ads.txt checks are disabled.</p>}
          </article>
        </div>
      ) : null}

      {status?.messages.length ? (
        <article className="monitoring-card monitoring-findings">
          <div className="monitoring-card-heading"><div><span className="panel-kicker">Current check</span><h3>Findings</h3></div></div>
          {status.messages.map((item) => <div key={item}>{item}</div>)}
        </article>
      ) : null}

      <article className="monitoring-card monitoring-settings-card">
        <div className="monitoring-card-heading">
          <div><span className="panel-kicker">Per-site configuration</span><h3>Monitoring schedule</h3></div>
          <span className={`monitoring-pill ${settings.enabled ? 'ok' : 'neutral'}`}>{settings.enabled ? 'ENABLED' : 'DISABLED'}</span>
        </div>
        <div className="monitoring-settings-grid compact">
          <label className="monitoring-checkbox"><input checked={settings.enabled} onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))} type="checkbox" /><span>Enable scheduled monitoring for this site</span></label>
          <label className="monitoring-checkbox"><input checked={settings.runtimeChecks} onChange={(event) => setSettings((current) => ({ ...current, runtimeChecks: event.target.checked }))} type="checkbox" /><span>Check current release artifacts and version</span></label>
          <label className="monitoring-checkbox"><input checked={settings.adsTxtChecks} onChange={(event) => setSettings((current) => ({ ...current, adsTxtChecks: event.target.checked }))} type="checkbox" /><span>Check ads.txt requirements</span></label>
          <label><span>Check interval</span><div className="monitoring-input-suffix"><input min={1} max={720} onChange={(event) => setSettings((current) => ({ ...current, checkIntervalHours: Number(event.target.value) || 1 }))} type="number" value={settings.checkIntervalHours} /><small>hours</small></div></label>
        </div>
      </article>

      <article className="monitoring-card monitoring-settings-card">
        <div className="monitoring-card-heading">
          <div><span className="panel-kicker">Optional outbound notification</span><h3>Ads.txt email</h3></div>
          <div className="monitoring-capability-group">
            <span className={`monitoring-pill ${payload?.capabilities.email ? 'ok' : 'warning'}`}>{payload?.capabilities.email ? 'EMAIL READY' : 'EMAIL BINDING MISSING'}</span>
            <label className="monitoring-switch"><input checked={settings.email.enabled} onChange={(event) => updateEmail('enabled', event.target.checked)} type="checkbox" /><span>Enabled</span></label>
          </div>
        </div>

        {!payload?.capabilities.email ? (
          <div className="monitoring-warning-copy">
            Templates, preview and attachment generation work now. Actual sending will become available after the Cloudflare <code>EMAIL</code> binding and sender domain are configured.
          </div>
        ) : null}

        <div className="monitoring-settings-grid">
          <label><span>Sender name</span><input onChange={(event) => updateEmail('senderName', event.target.value)} placeholder="Tessera Ads.txt Monitoring" value={settings.email.senderName} /></label>
          <label><span>Sender email</span><input onChange={(event) => updateEmail('senderEmail', event.target.value)} placeholder="alerts@your-domain.com" type="email" value={settings.email.senderEmail} /></label>
          <label><span>Reply-To</span><input onChange={(event) => updateEmail('replyTo', event.target.value)} placeholder="your@email.com" type="email" value={settings.email.replyTo} /></label>
          <label><span>Body format</span><select onChange={(event) => updateEmail('bodyFormat', event.target.value as BodyFormat)} value={settings.email.bodyFormat}><option value="plain">Plain text</option><option value="html">HTML</option></select></label>
          <label className="monitoring-span-2"><span>To · one per line or comma-separated</span><textarea onChange={(event) => updateEmail('to', addresses(event.target.value))} placeholder="publisher@example.com" rows={3} value={addressText(settings.email.to)} /></label>
          <label className="monitoring-span-2"><span>CC · optional</span><textarea onChange={(event) => updateEmail('cc', addresses(event.target.value))} placeholder="developer@example.com" rows={3} value={addressText(settings.email.cc)} /></label>
          <label className="monitoring-span-4"><span>Subject template</span><input onChange={(event) => updateEmail('subjectTemplate', event.target.value)} placeholder="Write your own subject with {{site_name}}, {{missing_count}}…" value={settings.email.subjectTemplate} /></label>
          <label className="monitoring-span-4"><span>Email body template</span><textarea onChange={(event) => updateEmail('bodyTemplate', event.target.value)} placeholder="Write the complete email here. Use the variables shown below." rows={12} value={settings.email.bodyTemplate} /></label>
        </div>

        <div className="monitoring-template-variables">
          <span>Available variables</span>
          <div>{(payload?.templateVariables ?? []).map((variable) => <code key={variable}>{`{{${variable}}}`}</code>)}</div>
        </div>

        <div className="monitoring-settings-grid attachment-grid">
          <label><span>Attachment content</span><select onChange={(event) => updateEmail('attachmentMode', event.target.value as AttachmentMode)} value={settings.email.attachmentMode}><option value="full-corrected">Full corrected ads.txt</option><option value="missing-only">Missing entries only</option><option value="expected-only">Tessera expected entries only</option></select></label>
          <label><span>Attachment filename template</span><input onChange={(event) => updateEmail('attachmentNameTemplate', event.target.value)} value={settings.email.attachmentNameTemplate} /></label>
          <label className="monitoring-checkbox"><input checked={settings.email.notifyOnChangeOnly} onChange={(event) => updateEmail('notifyOnChangeOnly', event.target.checked)} type="checkbox" /><span>Send when the missing list changes</span></label>
          <label><span>Repeat reminder after</span><div className="monitoring-input-suffix"><input min={1} max={8760} onChange={(event) => updateEmail('reminderHours', Number(event.target.value) || 1)} type="number" value={settings.email.reminderHours} /><small>hours</small></div></label>
          <label className="monitoring-checkbox"><input checked={settings.email.sendRecovery} onChange={(event) => updateEmail('sendRecovery', event.target.checked)} type="checkbox" /><span>Send recovery email when status becomes OK</span></label>
        </div>

        <div className="monitoring-action-row">
          <button className="button primary" disabled={saving} onClick={() => void saveSettings()} type="button">{saving ? 'Saving…' : 'Save monitoring settings'}</button>
          <button className="button secondary" disabled={previewing} onClick={() => void createPreview()} type="button">{previewing ? 'Generating…' : 'Preview email + attachment'}</button>
          <button className="button secondary" disabled={sending || !payload?.capabilities.email} onClick={() => void sendTest()} type="button">{sending ? 'Sending…' : 'Send test email'}</button>
        </div>
      </article>

      {preview ? (
        <article className="monitoring-card monitoring-preview-card">
          <div className="monitoring-card-heading">
            <div><span className="panel-kicker">Rendered from the current form</span><h3>Email preview</h3></div>
            <button className="button secondary compact" onClick={() => triggerTextDownload(preview.preview.attachmentContent, preview.preview.attachmentName)} type="button">Download attachment</button>
          </div>
          {preview.validationErrors.length ? (
            <div className="validation-list errors"><h4>Must fix before sending</h4>{preview.validationErrors.map((item) => <div key={item}><span>{item}</span></div>)}</div>
          ) : <div className="release-success">✓ Email fields are valid.</div>}
          <div className="monitoring-preview-meta">
            <div><span>To</span><code>{preview.preview.recipients.join(', ') || '—'}</code></div>
            <div><span>CC</span><code>{preview.preview.cc.join(', ') || '—'}</code></div>
            <div><span>Subject</span><strong>{preview.preview.subject || '—'}</strong></div>
            <div><span>Attachment</span><code>{preview.preview.attachmentName}</code></div>
          </div>
          <div className="monitoring-preview-grid">
            <section><span>Email body</span>{preview.preview.bodyFormat === 'html' ? <div className="monitoring-html-preview" dangerouslySetInnerHTML={{ __html: preview.preview.html || '' }} /> : <pre>{preview.preview.text}</pre>}</section>
            <section><span>Attachment preview</span><pre>{preview.preview.attachmentContent}</pre></section>
          </div>
        </article>
      ) : null}

      <article className="monitoring-card">
        <div className="monitoring-card-heading"><div><span className="panel-kicker">D1 audit trail</span><h3>Notification history</h3></div><span>{payload?.history.length ?? 0} event(s)</span></div>
        {payload?.history.length ? (
          <div className="monitoring-history-list">
            {payload.history.map((item) => (
              <div key={item.id}>
                <span className={`monitoring-dot ${item.status === 'sent' ? 'ok' : item.status === 'failed' ? 'error' : 'warning'}`} />
                <div><strong>{item.kind.toUpperCase()} · {item.status}</strong><span>{item.subject || item.errorMessage || 'No subject'}</span></div>
                <code>{item.attachmentName || '—'}</code>
                <small>{formatTime(item.createdAt)}</small>
              </div>
            ))}
          </div>
        ) : <div className="global-empty"><strong>No monitoring emails have been attempted.</strong></div>}
      </article>
    </section>
  );
}
