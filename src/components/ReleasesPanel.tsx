import { useCallback, useEffect, useMemo, useState } from 'react';
import ExternalDeploymentsPanel from './ExternalDeploymentsPanel';
import ReleaseDiffPanel from './ReleaseDiffPanel';
import ReleaseDeleteButton from './ReleaseDeleteButton';

type Props = {
  publisherId: string;
  siteName: string;
  onChanged?: () => void | Promise<void>;
};

type ValidationIssue = {
  code: string;
  message: string;
  area: string;
};

type ValidationPayload = {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  summary: Record<string, unknown>;
};

type ReleaseStatus = 'draft' | 'staging' | 'production' | 'archived' | 'failed';

type ReleaseUrls = {
  adsJs: string;
  adsMinJs: string;
  prebidJs: string;
  config: string;
  manifest: string;
  css: string;
  stickyCss: string;
  divCsv: string;
  implementation: string;
};

type Release = {
  id: string;
  publisherId: string;
  version: string;
  status: ReleaseStatus;
  configHash: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  publishedAt: string | null;
  manifest: Record<string, unknown> | null;
  urls: ReleaseUrls;
};

type Channels = {
  current: Record<string, string>;
  staging: Record<string, string>;
};

type ReleasesPayload = {
  ok: true;
  releases: Release[];
  channels: Channels;
};

type ReleasePayload = {
  ok: true;
  release: Release | null;
};

type ApiFailure = {
  ok?: false;
  error?: string;
  details?: unknown;
  errors?: ValidationIssue[];
  warnings?: ValidationIssue[];
  summary?: Record<string, unknown>;
};

function formatTime(value: string | null): string {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('en', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function shortHash(value: string | null): string {
  if (!value) return '—';
  return value.length > 14 ? `${value.slice(0, 12)}…` : value;
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(text || `Request failed with status ${response.status}.`);
  }
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await readJson<T & ApiFailure>(response);
  if (!response.ok) {
    const details = payload.details ? ` ${JSON.stringify(payload.details)}` : '';
    throw new Error(`${payload.error || `Request failed with status ${response.status}.`}${details}`);
  }
  return payload;
}

async function loadValidation(publisherId: string): Promise<ValidationPayload> {
  const response = await fetch(`/api/publishers/${encodeURIComponent(publisherId)}/releases/validate`);
  const payload = await readJson<ValidationPayload & ApiFailure>(response);
  if (response.status === 422 && Array.isArray(payload.errors)) {
    return {
      ok: false,
      errors: payload.errors,
      warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
      summary: payload.summary ?? {},
    };
  }
  if (!response.ok) throw new Error(payload.error || `Validation failed with status ${response.status}.`);
  return payload;
}

function statusLabel(status: ReleaseStatus): string {
  if (status === 'production') return 'PRODUCTION';
  if (status === 'staging') return 'STAGING';
  if (status === 'draft') return 'DRAFT';
  if (status === 'failed') return 'FAILED';
  return 'ARCHIVED';
}

export default function ReleasesPanel({ publisherId, siteName, onChanged }: Props) {
  const [validation, setValidation] = useState<ValidationPayload | null>(null);
  const [releases, setReleases] = useState<Release[]>([]);
  const [channels, setChannels] = useState<Channels | null>(null);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [validating, setValidating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [busyReleaseId, setBusyReleaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [releasePayload, validationPayload] = await Promise.all([
        requestJson<ReleasesPayload>(`/api/publishers/${encodeURIComponent(publisherId)}/releases`),
        loadValidation(publisherId),
      ]);
      setReleases(releasePayload.releases);
      setChannels(releasePayload.channels);
      setValidation(validationPayload);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Release workspace could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [publisherId]);

  useEffect(() => {
    void load();
  }, [load]);

  const production = useMemo(
    () => releases.find((release) => release.status === 'production') ?? null,
    [releases],
  );
  const staging = useMemo(
    () => releases.find((release) => release.status === 'staging') ?? null,
    [releases],
  );

  async function runValidation() {
    setValidating(true);
    setError(null);
    setSuccess(null);
    try {
      const payload = await loadValidation(publisherId);
      setValidation(payload);
      setSuccess(payload.ok ? 'Configuration is ready for release generation.' : null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Validation failed.');
    } finally {
      setValidating(false);
    }
  }

  async function generate() {
    setGenerating(true);
    setError(null);
    setSuccess(null);
    try {
      const payload = await requestJson<ReleasePayload>(
        `/api/publishers/${encodeURIComponent(publisherId)}/releases/generate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ notes: notes.trim() }),
        },
      );
      setNotes('');
      setSuccess(payload.release ? `Generated draft ${payload.release.version}.` : 'Draft release generated.');
      await load();
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Release generation failed.');
    } finally {
      setGenerating(false);
    }
  }

  async function promote(release: Release, action: 'staging' | 'production' | 'rollback') {
    if (action === 'production' || action === 'rollback') {
      const verb = action === 'rollback' ? 'ROLLBACK' : 'PUBLISH';
      const confirmation = window.prompt(
        `${verb} ${release.version} to the public current channel?\n\nType the exact version to continue.`,
      );
      if (confirmation !== release.version) return;
    } else if (!window.confirm(`Publish ${release.version} to the staging channel?`)) {
      return;
    }

    setBusyReleaseId(release.id);
    setError(null);
    setSuccess(null);
    try {
      await requestJson<ReleasePayload>(
        `/api/publishers/${encodeURIComponent(publisherId)}/releases/${encodeURIComponent(release.id)}/${action}`,
        { method: 'POST' },
      );
      setSuccess(
        action === 'staging'
          ? `Published ${release.version} to staging.`
          : action === 'rollback'
            ? `Rolled production back to ${release.version}.`
            : `Published ${release.version} to production.`,
      );
      await load();
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Release promotion failed.');
    } finally {
      setBusyReleaseId(null);
    }
  }

  async function copyUrl(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setError('Clipboard access was blocked.');
    }
  }

  return (
    <section className="releases-page">
      <div className="release-toolbar">
        <div>
          <span className="panel-kicker">Validate, generate, stage, publish and roll back</span>
          <h2>Releases</h2>
          <p>
            Every release is immutable and keeps its generator profile, Prebid build, configuration snapshot,
            hashes and exported implementation files.
          </p>
        </div>
        <div className="release-toolbar-actions">
          <button className="button secondary" disabled={validating || loading} onClick={() => void runValidation()} type="button">
            {validating ? 'Validating…' : 'Validate now'}
          </button>
          <button className="button primary" disabled={generating || !validation?.ok} onClick={() => void generate()} type="button">
            {generating ? 'Generating…' : 'Generate draft'}
          </button>
        </div>
      </div>

      {error ? <div className="form-error config-error">{error}</div> : null}
      {success ? <div className="release-success">✓ {success}</div> : null}
      {loading ? <div className="config-loading">Loading release state from D1 and R2…</div> : null}

      <div className="release-top-grid">
        <article className={`release-panel validation-panel ${validation?.ok ? 'ready' : 'blocked'}`}>
          <div className="release-panel-heading">
            <div>
              <span className="panel-kicker">Preflight</span>
              <h3>{validation?.ok ? 'Ready to generate' : 'Release is blocked'}</h3>
            </div>
            <span className={`release-state ${validation?.ok ? 'ready' : 'blocked'}`}>
              {validation?.ok ? 'READY' : `${validation?.errors.length ?? 0} ERROR(S)`}
            </span>
          </div>

          <div className="validation-summary-grid">
            {Object.entries(validation?.summary ?? {}).map(([key, value]) => (
              <div key={key}>
                <span>{key}</span>
                <code>{Array.isArray(value) ? value.join(', ') || '—' : String(value ?? '—')}</code>
              </div>
            ))}
          </div>

          {validation?.errors.length ? (
            <div className="validation-list errors">
              <h4>Must fix</h4>
              {validation.errors.map((item) => (
                <div key={`${item.code}-${item.message}`}><b>{item.area}</b><span>{item.message}</span></div>
              ))}
            </div>
          ) : null}

          {validation?.warnings.length ? (
            <div className="validation-list warnings">
              <h4>Warnings</h4>
              {validation.warnings.map((item) => (
                <div key={`${item.code}-${item.message}`}><b>{item.area}</b><span>{item.message}</span></div>
              ))}
            </div>
          ) : null}

          <label className="release-notes-field">
            <span>Release notes</span>
            <textarea
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Example: Billboard 20s → 30s accumulated-view refresh test"
              rows={3}
              value={notes}
            />
          </label>
        </article>

        <article className="release-panel channel-panel">
          <div className="release-panel-heading">
            <div><span className="panel-kicker">Public CDN</span><h3>Current channels</h3></div>
          </div>

          <div className="channel-status-grid">
            <div><span>Production</span><strong>{production?.version ?? 'Not published'}</strong><small>{formatTime(production?.publishedAt ?? null)}</small></div>
            <div><span>Staging</span><strong>{staging?.version ?? 'Not published'}</strong><small>{formatTime(staging?.publishedAt ?? null)}</small></div>
          </div>

          {channels ? (
            <div className="channel-url-groups">
              {(['current', 'staging'] as const).map((channel) => (
                <section key={channel}>
                  <h4>{channel}</h4>
                  {['ads.min.js', 'prebid.js', 'manifest.json', 'min-height.css', 'sticky.css'].map((fileName) => {
                    const url = channels[channel][fileName];
                    return (
                      <div className="channel-url-row" key={`${channel}-${fileName}`}>
                        <code>{fileName}</code>
                        <button disabled={!url} onClick={() => url && void copyUrl(url, `${channel}-${fileName}`)} type="button">
                          {copied === `${channel}-${fileName}` ? '✓' : 'Copy'}
                        </button>
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          ) : null}
        </article>
      </div>

      <ExternalDeploymentsPanel publisherId={publisherId} releases={releases} />

      <ReleaseDiffPanel releases={releases} siteName={siteName} />

      <div className="release-history-heading">
        <div><span className="panel-kicker">R2 + D1 history</span><h3>{siteName} releases</h3></div>
        <span>{releases.length} release(s)</span>
      </div>

      <div className="release-list">
        {releases.map((release) => {
          const isBusy = busyReleaseId === release.id;
          const isProduction = release.status === 'production';
          const canPublishProduction = release.status === 'staging';
          const canRollback = release.status === 'archived';
          return (
            <article className={`release-card ${release.status}`} key={release.id}>
              <div className="release-card-main">
                <div className="release-version-block">
                  <span className={`release-status ${release.status}`}>{statusLabel(release.status)}</span>
                  <h3>v {release.version}</h3>
                  <p>{release.notes || 'No release notes.'}</p>
                </div>
                <div className="release-metadata">
                  <div><span>Created</span><strong>{formatTime(release.createdAt)}</strong></div>
                  <div><span>By</span><strong>{release.createdBy ?? 'system'}</strong></div>
                  <div><span>Config hash</span><code title={release.configHash ?? ''}>{shortHash(release.configHash)}</code></div>
                  <div><span>Published</span><strong>{formatTime(release.publishedAt)}</strong></div>
                </div>
              </div>

              <div className="release-artifacts">
                {Object.entries(release.urls).map(([key, url]) => (
                  <a href={url} key={key} rel="noreferrer" target="_blank">{key}</a>
                ))}
              </div>

              <div className="release-actions">
                <button disabled={isBusy || isProduction} onClick={() => void promote(release, 'staging')} type="button">
                  {isBusy ? 'Working…' : 'Publish staging'}
                </button>
                <button className="production-action" disabled={isBusy || !canPublishProduction} onClick={() => void promote(release, 'production')} type="button">
                  Publish production
                </button>
                <button className="rollback-action" disabled={isBusy || !canRollback} onClick={() => void promote(release, 'rollback')} type="button">
                  Rollback to this
                </button>
                <ReleaseDeleteButton
                  disabled={isBusy}
                  onDeleted={async (message) => {
                    await load();
                    setSuccess(message);
                    await onChanged?.();
                  }}
                  onError={(message) => setError(message || null)}
                  publisherId={publisherId}
                  release={release}
                />
              </div>
            </article>
          );
        })}

        {!loading && releases.length === 0 ? (
          <div className="release-empty">
            <h3>No releases yet</h3>
            <p>Fix all validation errors, then generate the first immutable draft.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
