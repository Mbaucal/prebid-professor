import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Site } from '../shared/types';

type Props = {
  site: Site;
};

type OverallStatus = 'healthy' | 'warning' | 'error' | 'not-published';

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

type FailurePayload = {
  error?: string;
  details?: unknown;
};

async function requestStatus(siteId: string): Promise<MonitoringPayload> {
  const response = await fetch(
    `/api/publishers/${encodeURIComponent(siteId)}/monitoring/status?ts=${Date.now()}`,
    {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    },
  );
  const text = await response.text();
  let payload: (MonitoringPayload & FailurePayload) | null = null;
  try {
    payload = text ? JSON.parse(text) as MonitoringPayload & FailurePayload : null;
  } catch {
    throw new Error(text || `Monitoring request failed with status ${response.status}.`);
  }
  if (!response.ok || !payload?.ok) {
    const details = payload?.details === undefined
      ? ''
      : typeof payload.details === 'string'
        ? ` ${payload.details}`
        : ` ${JSON.stringify(payload.details)}`;
    throw new Error(`${payload?.error || `Monitoring request failed with status ${response.status}.`}${details}`);
  }
  return payload;
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

export default function MonitoringReadonlyPanel({ site }: Props) {
  const [payload, setPayload] = useState<MonitoringPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    setPayload(null);
    void load();
  }, [load]);

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

  return (
    <section className="monitor-readonly-page">
      <div className="monitor-readonly-heading">
        <div>
          <span className="panel-kicker">Runtime, R2 and ads.txt</span>
          <h2>Monitoring</h2>
          <p>This first monitoring version is read-only. It does not modify D1, releases, R2 artifacts or email settings.</p>
        </div>
        <button className="button primary" disabled={loading} onClick={() => void load()} type="button">
          {loading ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {error ? <div className="form-error monitor-readonly-message">{error}</div> : null}
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

          <div className="monitor-readonly-note">
            <strong>Read-only safety:</strong> this screen only reads the current D1 site record, R2 channel objects and the public ads.txt URL.
          </div>
        </>
      ) : null}
    </section>
  );
}
