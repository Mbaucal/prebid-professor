import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PublisherAccount } from '../shared/types';

type Props = {
  publishers: PublisherAccount[];
};

type HealthPayload = {
  ok: boolean;
  service?: string;
  environment?: string;
  database?: string;
  storage?: string;
  auth?: string;
  externalDeploy?: {
    github?: string;
    callback?: string;
  };
  runtimeBuild?: string;
  workerEntrypoint?: string;
  timestamp?: string;
};

async function loadHealth(): Promise<HealthPayload> {
  const response = await fetch('/api/health', { cache: 'no-store' });
  const text = await response.text();
  let payload: (HealthPayload & { error?: string }) | null = null;
  try {
    payload = text ? JSON.parse(text) as HealthPayload & { error?: string } : null;
  } catch {
    throw new Error(text || `Health request failed with status ${response.status}.`);
  }
  if (!response.ok) throw new Error(payload?.error || `Health request failed with status ${response.status}.`);
  return payload as HealthPayload;
}

function statusClass(value: string | undefined): string {
  if (!value) return 'neutral';
  return /connected|configured|healthy|signed|ok/i.test(value) ? 'good' : /error|failed|not-bound/i.test(value) ? 'bad' : 'neutral';
}

function display(value: string | undefined): string {
  return value || 'Not reported';
}

function formatTime(value: string | undefined): string {
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

export default function SettingsPanel({ publishers }: Props) {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHealth(await loadHealth());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'System health could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const sites = publishers.flatMap((publisher) => publisher.sites);
    return {
      publishers: publishers.length,
      sites: sites.length,
      live: sites.filter((site) => site.status === 'live').length,
      staging: sites.filter((site) => site.status === 'staging').length,
      drafts: sites.filter((site) => site.status === 'draft').length,
    };
  }, [publishers]);

  return (
    <section className="global-page settings-page">
      <div className="global-page-heading">
        <div>
          <span className="panel-kicker">Control plane</span>
          <h2>Settings</h2>
          <p>System status, deployment readiness and operational defaults. Secret values are never exposed in the browser.</p>
        </div>
        <button className="button secondary" disabled={loading} onClick={() => void load()} type="button">
          {loading ? 'Checking…' : 'Refresh health'}
        </button>
      </div>

      {error ? <div className="form-error global-message">{error}</div> : null}

      <div className="global-stat-grid">
        <div><span>Publishers</span><strong>{counts.publishers}</strong></div>
        <div><span>Sites</span><strong>{counts.sites}</strong></div>
        <div><span>Live</span><strong>{counts.live}</strong></div>
        <div><span>Staging</span><strong>{counts.staging}</strong></div>
        <div><span>Draft</span><strong>{counts.drafts}</strong></div>
      </div>

      <div className="settings-grid">
        <article className="global-card settings-card">
          <div className="global-table-heading"><div><span className="panel-kicker">Runtime</span><h3>System health</h3></div></div>
          <div className="settings-facts">
            <div><span>Service</span><strong>{display(health?.service)}</strong></div>
            <div><span>Environment</span><strong>{display(health?.environment)}</strong></div>
            <div><span>Worker entrypoint</span><code>{display(health?.workerEntrypoint)}</code></div>
            <div><span>Runtime build</span><code>{display(health?.runtimeBuild)}</code></div>
            <div><span>Last health check</span><strong>{formatTime(health?.timestamp)}</strong></div>
          </div>
        </article>

        <article className="global-card settings-card">
          <div className="global-table-heading"><div><span className="panel-kicker">Bindings</span><h3>Connected services</h3></div></div>
          <div className="settings-status-list">
            <div><span>Database · D1</span><strong className={`settings-status ${statusClass(health?.database)}`}>{display(health?.database)}</strong></div>
            <div><span>Artifact storage · R2</span><strong className={`settings-status ${statusClass(health?.storage)}`}>{display(health?.storage)}</strong></div>
            <div><span>Authentication</span><strong className={`settings-status ${statusClass(health?.auth)}`}>{display(health?.auth)}</strong></div>
            <div><span>GitHub deployment</span><strong className={`settings-status ${statusClass(health?.externalDeploy?.github)}`}>{display(health?.externalDeploy?.github)}</strong></div>
            <div><span>Deployment callback</span><strong className={`settings-status ${statusClass(health?.externalDeploy?.callback)}`}>{display(health?.externalDeploy?.callback)}</strong></div>
          </div>
        </article>

        <article className="global-card settings-card">
          <div className="global-table-heading"><div><span className="panel-kicker">Storage policy</span><h3>Release retention</h3></div></div>
          <div className="settings-note-list">
            <div><strong>Production</strong><span>Protected from deletion while active.</span></div>
            <div><strong>Staging</strong><span>Protected while assigned to the staging channel.</span></div>
            <div><strong>Draft / failed / archived</strong><span>Can be removed manually from Release history to free R2 storage.</span></div>
            <div><strong>Automatic retention</strong><span>Not enabled yet. This will be added after monitoring and release-diff workflows.</span></div>
          </div>
        </article>

        <article className="global-card settings-card">
          <div className="global-table-heading"><div><span className="panel-kicker">Security</span><h3>Operational safeguards</h3></div></div>
          <div className="settings-note-list">
            <div><strong>Secrets</strong><span>Only configured / not configured status is exposed. Token values remain in Cloudflare and GitHub secrets.</span></div>
            <div><strong>Mutations</strong><span>State-changing API requests require an authenticated same-origin session.</span></div>
            <div><strong>Releases</strong><span>Generated release artifacts are immutable. Production publishing requires a staging step.</span></div>
            <div><strong>Contextual test</strong><span>No-CMP diagnostic releases remain blocked from production publishing.</span></div>
          </div>
        </article>
      </div>
    </section>
  );
}
