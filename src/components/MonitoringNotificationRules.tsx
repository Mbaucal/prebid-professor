import { useCallback, useEffect, useRef, useState } from 'react';

type NotificationSettings = {
  enabled: boolean;
  notifyOnMissing: boolean;
  notifyOnChange: boolean;
  reminderEnabled: boolean;
  reminderHours: number;
  recoveryEnabled: boolean;
};

type NotificationState = {
  lastStatus: string | null;
  lastFingerprint: string | null;
  lastCheckedAt: string | null;
  lastNotifiedFingerprint: string | null;
  lastNotifiedAt: string | null;
  lastRecoveryAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
};

type LogEntry = {
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

type Bundle = {
  ok: true;
  settings: NotificationSettings;
  state: NotificationState;
  recent: LogEntry[];
  saved: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
  scheduler: 'daily-cron-06-utc';
};

type RunResult = {
  ok: true;
  sent: boolean;
  decision: string;
  reason: string;
  checkedAt: string;
  adsTxtStatus: string;
  missingCount: number;
  messageId?: string;
  from?: string;
  recipients?: string[];
  attachmentName?: string;
  state: NotificationState;
};

type FailurePayload = {
  error?: string;
  details?: unknown;
};

type Props = {
  siteId: string;
  gmailConnected: boolean;
  templateSaved: boolean;
};

function detailsText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

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
    const details = detailsText(payload?.details);
    throw new Error(`${payload?.error || `Request failed with status ${response.status}.`}${details ? ` ${details}` : ''}`);
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

function kindLabel(value: string): string {
  if (value === 'missing') return 'Missing alert';
  if (value === 'reminder') return 'Reminder';
  if (value === 'recovery') return 'Recovery';
  return 'Evaluation';
}

export default function MonitoringNotificationRules({ siteId, gmailConnected, templateSaved }: Props) {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const activeSiteId = useRef(siteId);
  const loadGeneration = useRef(0);
  const saveGeneration = useRef(0);
  const runGeneration = useRef(0);
  const confirmActionRef = useRef<HTMLButtonElement | null>(null);
  const confirmDialogRef = useRef<HTMLElement | null>(null);
  const confirmTriggerRef = useRef<HTMLButtonElement | null>(null);
  activeSiteId.current = siteId;

  const load = useCallback(async () => {
    const requestedSiteId = siteId;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const payload = await requestJson<Bundle>(
        `/api/publishers/${encodeURIComponent(requestedSiteId)}/monitoring/notification-settings?ts=${Date.now()}`,
        { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } },
      );
      if (activeSiteId.current !== requestedSiteId || loadGeneration.current !== generation) return;
      setBundle(payload);
      setSettings(payload.settings);
    } catch (loadError) {
      if (activeSiteId.current !== requestedSiteId || loadGeneration.current !== generation) return;
      setError(loadError instanceof Error ? loadError.message : 'Notification rules could not be loaded.');
    } finally {
      if (activeSiteId.current === requestedSiteId && loadGeneration.current === generation) setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    loadGeneration.current += 1;
    saveGeneration.current += 1;
    runGeneration.current += 1;
    setBundle(null);
    setSettings(null);
    setRunResult(null);
    setMessage(null);
    setError(null);
    setSaving(false);
    setRunning(false);
    setConfirmOpen(false);
    setLoading(true);
    void load();
  }, [load, siteId]);

  useEffect(() => {
    if (!confirmOpen) return undefined;

    const previousOverflow = document.body.style.overflow;
    const trigger = confirmTriggerRef.current;
    const backgroundElements = Array.from(document.querySelectorAll<HTMLElement>(
      '.sidebar, .topbar, .tabbar, .monitor-readonly-card',
    ));
    const previousInert = backgroundElements.map((element) => element.hasAttribute('inert'));

    document.body.style.overflow = 'hidden';
    backgroundElements.forEach((element) => element.setAttribute('inert', ''));
    window.requestAnimationFrame(() => confirmActionRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) {
        event.preventDefault();
        setConfirmOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = confirmDialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('hidden'));
      if (!focusable.length) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      backgroundElements.forEach((element, index) => {
        if (previousInert[index]) element.setAttribute('inert', '');
        else element.removeAttribute('inert');
      });
      document.removeEventListener('keydown', onKeyDown);
      window.requestAnimationFrame(() => trigger?.focus());
    };
  }, [confirmOpen, running]);


  function update<K extends keyof NotificationSettings>(key: K, value: NotificationSettings[K]): void {
    setSettings((current) => current ? { ...current, [key]: value } : current);
    setMessage(null);
    setRunResult(null);
  }

  async function save(): Promise<void> {
    if (!settings) return;
    const requestedSiteId = siteId;
    const generation = ++saveGeneration.current;
    const settingsToSave = settings;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload = await requestJson<{ ok: true; settings: NotificationSettings; updatedAt: string }>(
        `/api/publishers/${encodeURIComponent(requestedSiteId)}/monitoring/notification-settings`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ settings: settingsToSave }),
        },
      );
      if (activeSiteId.current !== requestedSiteId || saveGeneration.current !== generation) return;
      setSettings(payload.settings);
      setMessage(`Notification rules saved · ${formatTime(payload.updatedAt)}.`);
      await load();
    } catch (saveError) {
      if (activeSiteId.current !== requestedSiteId || saveGeneration.current !== generation) return;
      setError(saveError instanceof Error ? saveError.message : 'Notification rules could not be saved.');
    } finally {
      if (activeSiteId.current === requestedSiteId && saveGeneration.current === generation) setSaving(false);
    }
  }

  async function runNow(): Promise<void> {
    if (!settings?.enabled || !gmailConnected || !templateSaved || running) return;
    const requestedSiteId = siteId;
    const generation = ++runGeneration.current;
    setConfirmOpen(false);
    setRunning(true);
    setError(null);
    setMessage(null);
    setRunResult(null);
    try {
      const result = await requestJson<RunResult>(
        `/api/publishers/${encodeURIComponent(requestedSiteId)}/monitoring/notifications/run`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ mode: 'manual-preview' }),
        },
      );
      if (activeSiteId.current !== requestedSiteId || runGeneration.current !== generation) return;
      setRunResult(result);
      setMessage(result.sent
        ? `Gmail notification sent · ${result.messageId ?? 'message accepted'}.`
        : `No email sent: ${result.reason}`);
      await load();
    } catch (runError) {
      if (activeSiteId.current !== requestedSiteId || runGeneration.current !== generation) return;
      setError(runError instanceof Error ? runError.message : 'Notification evaluation failed.');
      await load();
    } finally {
      if (activeSiteId.current === requestedSiteId && runGeneration.current === generation) setRunning(false);
    }
  }

  const disabledReasons: string[] = [];
  if (!settings?.enabled) disabledReasons.push('Enable and save notification rules.');
  if (!gmailConnected) disabledReasons.push('Connect Gmail.');
  if (!templateSaved) disabledReasons.push('Save the email template to Tessera.');

  return (
    <>
      <article className="monitor-readonly-card monitor-notification-rules">
        <div className="monitor-readonly-card-heading">
          <div>
            <span className="panel-kicker">Ads.txt notification policy</span>
            <h3>Automatic notification rules</h3>
          </div>
          <div className="monitor-email-statuses">
            <span className={`monitor-readonly-pill ${settings?.enabled ? 'healthy' : 'warning'}`}>
              {settings?.enabled ? 'ENABLED' : 'DISABLED'}
            </span>
            <span className="monitor-readonly-pill healthy">CRON READY · 06:00 UTC</span>
          </div>
        </div>

        <p className="monitor-email-intro">
          The daily check is configured for 06:00 UTC and activates with the production deployment.
          Use Evaluate rules now for preview testing. Healthy checks are logged without sending email.
        </p>

        {loading && !settings ? <div className="config-loading">Loading notification rules…</div> : null}
        {error ? <div className="form-error monitor-readonly-message">{error}</div> : null}
        {message ? <div className="release-success monitor-readonly-message">✓ {message}</div> : null}

        {settings ? (
          <>
            <div className="monitor-rule-grid">
              <label className="monitor-rule-toggle">
                <input checked={settings.enabled} onChange={(event) => update('enabled', event.target.checked)} type="checkbox" />
                <span><strong>Enable ads.txt notifications</strong><small>Master switch for this site.</small></span>
              </label>
              <label className="monitor-rule-toggle">
                <input checked={settings.notifyOnMissing} onChange={(event) => update('notifyOnMissing', event.target.checked)} type="checkbox" />
                <span><strong>Notify when required entries are missing</strong><small>Sends the initial missing-entry alert.</small></span>
              </label>
              <label className="monitor-rule-toggle">
                <input checked={settings.notifyOnChange} onChange={(event) => update('notifyOnChange', event.target.checked)} type="checkbox" />
                <span><strong>Notify when the missing list changes</strong><small>Avoids repeating an unchanged alert.</small></span>
              </label>
              <label className="monitor-rule-toggle">
                <input checked={settings.reminderEnabled} onChange={(event) => update('reminderEnabled', event.target.checked)} type="checkbox" />
                <span><strong>Repeat unresolved reminders</strong><small>Uses the interval below when the list is unchanged.</small></span>
              </label>
              <label className="monitor-rule-number">
                <span>Reminder interval</span>
                <div><input min={1} max={720} onChange={(event) => update('reminderHours', Number(event.target.value))} type="number" value={settings.reminderHours} /><strong>hours</strong></div>
                <small>Allowed range: 1–720 hours.</small>
              </label>
            </div>

            <div className="monitor-notification-prerequisites">
              <div><span>Gmail</span><strong className={gmailConnected ? 'ok' : 'missing'}>{gmailConnected ? 'Connected' : 'Not connected'}</strong></div>
              <div><span>Saved template</span><strong className={templateSaved ? 'ok' : 'missing'}>{templateSaved ? 'Ready' : 'Not saved'}</strong></div>
              <div><span>Scheduler</span><strong>Daily · 06:00 UTC</strong></div>
            </div>

            <div className="monitor-email-actions">
              <button className="button secondary" disabled={saving} onClick={() => void save()} type="button">{saving ? 'Saving…' : 'Save notification rules'}</button>
              <button ref={confirmTriggerRef} className="button primary" disabled={Boolean(disabledReasons.length) || running} onClick={() => setConfirmOpen(true)} type="button">{running ? 'Evaluating…' : 'Evaluate rules now'}</button>
            </div>
            {disabledReasons.length ? <div className="monitor-test-send-note">{disabledReasons.join(' ')}</div> : null}
          </>
        ) : null}

        {bundle ? (
          <div className="monitor-notification-state">
            <div className="monitor-readonly-card-heading">
              <div><span className="panel-kicker">Decision memory</span><h4>Current state</h4></div>
            </div>
            <div className="monitor-runtime-facts">
              <div><span>Last status</span><strong>{bundle.state.lastStatus ?? '—'}</strong></div>
              <div><span>Last checked</span><strong>{formatTime(bundle.state.lastCheckedAt)}</strong></div>
              <div><span>Last notified</span><strong>{formatTime(bundle.state.lastNotifiedAt)}</strong></div>
            </div>
            {bundle.state.lastError ? <div className="form-error monitor-readonly-message">{bundle.state.lastError}</div> : null}
          </div>
        ) : null}

        {runResult ? (
          <div className={`monitor-run-result ${runResult.sent ? 'sent' : 'skipped'}`}>
            <strong>{runResult.sent ? 'Email sent' : 'No email needed'}</strong>
            <span>{runResult.reason}</span>
            <small>{runResult.adsTxtStatus} · {runResult.missingCount} missing · {formatTime(runResult.checkedAt)}</small>
          </div>
        ) : null}

        {bundle?.recent.length ? (
          <div className="monitor-notification-log">
            <div className="monitor-readonly-card-heading">
              <div><span className="panel-kicker">Recent evaluations</span><h4>Notification history</h4></div>
            </div>
            {bundle.recent.map((entry) => (
              <div key={entry.id}>
                <span className={`monitor-dot ${entry.status === 'sent' ? 'healthy' : entry.status === 'failed' ? 'error' : 'warning'}`} />
                <div><strong>{kindLabel(entry.kind)}</strong><small>{entry.errorMessage || entry.subject || String(entry.details.reason ?? '')}</small></div>
                <code>{entry.status}</code>
                <time>{formatTime(entry.createdAt)}</time>
              </div>
            ))}
          </div>
        ) : null}
      </article>

      {confirmOpen ? (
        <div
          className="monitor-confirm-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !running) setConfirmOpen(false);
          }}
          role="presentation"
        >
          <section
            aria-describedby="monitor-confirm-description"
            aria-labelledby="monitor-confirm-title"
            aria-modal="true"
            className="monitor-confirm-dialog"
            ref={confirmDialogRef}
            role="dialog"
          >
            <div className="monitor-confirm-icon" aria-hidden="true">✉</div>
            <div className="monitor-confirm-copy">
              <span className="panel-kicker">Manual notification check</span>
              <h3 id="monitor-confirm-title">Evaluate notification rules now?</h3>
              <p id="monitor-confirm-description">
                Tessera will check the current live ads.txt state against the saved rules for this site.
              </p>
            </div>
            <div className="monitor-confirm-warning">
              <strong>A real Gmail message may be sent</strong>
              <span>Email is sent only when a saved rule matches. The recipients from the saved template will be used.</span>
            </div>
            <div className="monitor-confirm-actions">
              <button className="button secondary" disabled={running} onClick={() => setConfirmOpen(false)} type="button">Cancel</button>
              <button ref={confirmActionRef} className="button primary" disabled={running} onClick={() => void runNow()} type="button">
                {running ? 'Evaluating…' : 'Evaluate rules'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
