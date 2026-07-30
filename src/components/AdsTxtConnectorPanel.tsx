import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Site } from '../shared/types';

type VersionSummary = {
  id: string;
  versionNumber: number;
  checksum: string;
  lineCount: number;
  entryCount: number;
  status: string;
  createdBy: string | null;
  createdAt: string;
  publishedAt: string | null;
};

type ConnectorStatus = {
  ok: true;
  site: {
    id: string;
    name: string;
    domain: string;
  };
  sandbox: {
    mode: string;
    enabled: boolean;
    endpoint: string;
    lastTestedAt: string | null;
    lastTestStatus: string | null;
    lastVerifiedAt: string | null;
    lastVerificationStatus: string | null;
    lastVerifiedVersionId: string | null;
    updatedBy: string | null;
    updatedAt: string | null;
    warning: string;
  };
  requirements: {
    count: number;
  };
  preparedVersion: VersionSummary | null;
  currentPublication: VersionSummary | null;
  previousPublication: VersionSummary | null;
  mockState: {
    currentVersionId: string | null;
    previousVersionId: string | null;
    checksum: string | null;
    updatedAt: string;
    hasContent: boolean;
  } | null;
  versions: VersionSummary[];
};

type ActionResponse = {
  ok: true;
  action: {
    kind: string;
    message: string;
    latencyMs?: number;
    versionId?: string;
    checksum?: string;
    reused?: boolean;
  };
  status: ConnectorStatus;
};

type ApiFailure = {
  error?: string;
  details?: unknown;
};

type BusyAction = 'enable' | 'test' | 'prepare' | 'publish' | 'verify' | 'rollback' | null;

const SELECTED_SITE_KEY = 'tessera:ads-txt-connector-site';

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text();
  let payload: (T & ApiFailure) | null = null;
  try {
    payload = text ? JSON.parse(text) as T & ApiFailure : null;
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

function shortChecksum(value: string | null | undefined): string {
  return value ? `${value.slice(0, 12)}…` : '—';
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, '');
}

function suggestedActiveSite(sites: Site[]): Site | null {
  const input = document.querySelector<HTMLInputElement>('.ads-txt-url-row input');
  const value = input?.value.trim() ?? '';
  if (!value) return null;
  try {
    const hostname = normalizeHost(new URL(value).hostname);
    const matches = sites.filter((site) => normalizeHost(site.domain) === hostname);
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}

export default function AdsTxtConnectorPanel() {
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState('');
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [loadingSites, setLoadingSites] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadingSites(true);
    void api.listPublisherAccounts()
      .then((accounts) => {
        if (!active) return;
        const allSites = accounts.flatMap((account) => account.sites);
        setSites(allSites);
        const stored = window.sessionStorage.getItem(SELECTED_SITE_KEY) ?? '';
        const storedSite = allSites.find((site) => site.id === stored) ?? null;
        const suggested = suggestedActiveSite(allSites);
        const next = suggested ?? storedSite ?? allSites[0] ?? null;
        setSelectedSiteId(next?.id ?? '');
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : 'Sites could not be loaded.');
      })
      .finally(() => {
        if (active) setLoadingSites(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedSiteId) {
      setStatus(null);
      return;
    }
    window.sessionStorage.setItem(SELECTED_SITE_KEY, selectedSiteId);
    let active = true;
    setLoadingStatus(true);
    setMessage(null);
    setError(null);
    setCopied(false);
    void requestJson<ConnectorStatus>(
      `/api/publishers/${encodeURIComponent(selectedSiteId)}/ads-txt/connector?ts=${Date.now()}`,
      { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } },
    )
      .then((payload) => {
        if (active) setStatus(payload);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setStatus(null);
        setError(loadError instanceof Error ? loadError.message : 'Connector status could not be loaded.');
      })
      .finally(() => {
        if (active) setLoadingStatus(false);
      });
    return () => {
      active = false;
    };
  }, [selectedSiteId]);

  const selectedSite = useMemo(
    () => sites.find((site) => site.id === selectedSiteId) ?? null,
    [selectedSiteId, sites],
  );

  const tested = status?.sandbox.lastTestStatus === 'ok';
  const verified = status?.sandbox.lastVerificationStatus === 'ok'
    && status.sandbox.lastVerifiedVersionId === status.currentPublication?.id;

  const steps = [
    {
      number: 1,
      title: 'Enable test connector',
      description: 'Creates a sandbox connection for the selected site. It never touches the publisher website.',
      complete: Boolean(status?.sandbox.enabled),
    },
    {
      number: 2,
      title: 'Test connection',
      description: 'Confirms that Tessera can reach and use the mock CMS endpoint.',
      complete: Boolean(tested),
    },
    {
      number: 3,
      title: 'Prepare ads.txt version',
      description: 'Builds a complete version from the saved requirements and calculates a SHA-256 checksum.',
      complete: Boolean(status?.preparedVersion || status?.currentPublication),
    },
    {
      number: 4,
      title: 'Publish to sandbox',
      description: 'Sends the approved version to the test endpoint only. The live ads.txt remains unchanged.',
      complete: Boolean(status?.currentPublication),
    },
    {
      number: 5,
      title: 'Verify publication',
      description: 'Checks that the endpoint contains exactly the version Tessera published.',
      complete: Boolean(verified),
    },
  ];
  const firstIncomplete = steps.find((step) => !step.complete)?.number ?? 6;

  async function runAction(action: Exclude<BusyAction, null>, body: Record<string, unknown> = {}): Promise<void> {
    if (!selectedSiteId || busy) return;
    setBusy(action);
    setMessage(null);
    setError(null);
    setCopied(false);
    try {
      const result = await requestJson<ActionResponse>(
        `/api/publishers/${encodeURIComponent(selectedSiteId)}/ads-txt/connector/${action === 'enable' ? 'enable-mock' : action}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        },
      );
      setStatus(result.status);
      setMessage(result.action.message);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Connector action failed.');
    } finally {
      setBusy(null);
    }
  }

  async function copyEndpoint(): Promise<void> {
    if (!status?.sandbox.endpoint) return;
    try {
      await navigator.clipboard.writeText(status.sandbox.endpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('The endpoint could not be copied. Select and copy it manually.');
    }
  }

  return (
    <article className="ads-txt-connector-card">
      <div className="ads-txt-connector-heading">
        <div>
          <span className="panel-kicker">CMS / API publishing</span>
          <h2>Test connector</h2>
          <p>Learn and test the complete publishing workflow before asking a publisher to build a real CMS endpoint.</p>
        </div>
        <span className="ads-txt-connector-pill">SANDBOX · NO LIVE CHANGES</span>
      </div>

      <div className="ads-txt-connector-safety">
        <strong>This is a safe simulation</strong>
        <span>Publish, verify and rollback actions below affect only a Tessera mock endpoint. They cannot change the public ads.txt file on the publisher domain.</span>
      </div>

      <div className="ads-txt-connector-site-row">
        <label>
          <span>Site used for this test</span>
          <select
            disabled={loadingSites || Boolean(busy)}
            onChange={(event) => setSelectedSiteId(event.target.value)}
            value={selectedSiteId}
          >
            <option value="">Select site</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>{site.name} · {site.domain} · ID: {site.id}</option>
            ))}
          </select>
          <small>Every action is tied to this immutable Site ID. Confirm the selected site before continuing.</small>
        </label>
        <div className="ads-txt-connector-site-summary">
          <span>Selected</span>
          <strong>{selectedSite?.name ?? 'No site selected'}</strong>
          <small>{selectedSite ? `${selectedSite.domain} · ${selectedSite.id}` : 'Choose a site above.'}</small>
        </div>
      </div>

      {error ? <div className="form-error ads-txt-connector-message">{error}</div> : null}
      {message ? <div className="release-success ads-txt-connector-message">✓ {message}</div> : null}
      {loadingStatus ? <div className="config-loading">Loading connector status…</div> : null}

      {status ? (
        <>
          <section className="ads-txt-connector-endpoint">
            <div>
              <span className="panel-kicker">Mock publisher endpoint</span>
              <h3>{status.sandbox.enabled ? 'Ready for testing' : 'Not enabled yet'}</h3>
              <p>This URL represents the endpoint a publisher CMS would expose later.</p>
            </div>
            <div className="ads-txt-connector-endpoint-value">
              <code>{status.sandbox.endpoint}</code>
              <button className="button secondary" onClick={() => void copyEndpoint()} type="button">{copied ? 'Copied' : 'Copy URL'}</button>
              <a className="button secondary" href={status.sandbox.endpoint} rel="noreferrer" target="_blank">Open</a>
            </div>
          </section>

          <section className="ads-txt-connector-steps" aria-label="Connector setup steps">
            {steps.map((step) => (
              <div
                className={`ads-txt-connector-step${step.complete ? ' complete' : step.number === firstIncomplete ? ' current' : ''}`}
                key={step.number}
              >
                <span>{step.complete ? '✓' : step.number}</span>
                <div>
                  <strong>{step.title}</strong>
                  <small>{step.description}</small>
                </div>
              </div>
            ))}
          </section>

          <section className="ads-txt-connector-actions">
            <div>
              <span>Saved requirements</span>
              <strong>{status.requirements.count}</strong>
              <small>These rows will be used to build the test version.</small>
            </div>
            <button
              className="button secondary"
              disabled={status.sandbox.enabled || Boolean(busy)}
              onClick={() => void runAction('enable')}
              type="button"
            >
              {busy === 'enable' ? 'Enabling…' : status.sandbox.enabled ? 'Test connector enabled' : '1. Enable test connector'}
            </button>
            <button
              className="button secondary"
              disabled={!status.sandbox.enabled || Boolean(busy)}
              onClick={() => void runAction('test')}
              type="button"
            >
              {busy === 'test' ? 'Testing…' : '2. Test connection'}
            </button>
            <button
              className="button secondary"
              disabled={!tested || status.requirements.count === 0 || Boolean(busy)}
              onClick={() => void runAction('prepare')}
              type="button"
            >
              {busy === 'prepare' ? 'Preparing…' : '3. Prepare version'}
            </button>
            <button
              className="button primary"
              disabled={!status.preparedVersion || Boolean(busy)}
              onClick={() => void runAction('publish', { versionId: status.preparedVersion?.id })}
              type="button"
            >
              {busy === 'publish' ? 'Publishing…' : '4. Publish to sandbox'}
            </button>
            <button
              className="button secondary"
              disabled={!status.currentPublication || Boolean(busy)}
              onClick={() => void runAction('verify')}
              type="button"
            >
              {busy === 'verify' ? 'Verifying…' : '5. Verify publication'}
            </button>
            <button
              className="button danger"
              disabled={!status.previousPublication || Boolean(busy)}
              onClick={() => void runAction('rollback')}
              type="button"
            >
              {busy === 'rollback' ? 'Rolling back…' : 'Rollback previous version'}
            </button>
          </section>

          <section className="ads-txt-connector-facts">
            <div>
              <span>Connection test</span>
              <strong className={tested ? 'ok' : ''}>{tested ? 'Passed' : 'Not completed'}</strong>
              <small>{formatTime(status.sandbox.lastTestedAt)}</small>
            </div>
            <div>
              <span>Prepared version</span>
              <strong>{status.preparedVersion ? `v${status.preparedVersion.versionNumber}` : '—'}</strong>
              <small>{status.preparedVersion ? `${status.preparedVersion.entryCount} entries · ${shortChecksum(status.preparedVersion.checksum)}` : 'Prepare a version after testing the connection.'}</small>
            </div>
            <div>
              <span>Sandbox publication</span>
              <strong>{status.currentPublication ? `v${status.currentPublication.versionNumber}` : '—'}</strong>
              <small>{status.currentPublication ? formatTime(status.mockState?.updatedAt) : 'Nothing has been published to the mock endpoint.'}</small>
            </div>
            <div>
              <span>Verification</span>
              <strong className={verified ? 'ok' : status.sandbox.lastVerificationStatus === 'failed' ? 'error' : ''}>
                {verified ? 'Verified' : status.sandbox.lastVerificationStatus === 'failed' ? 'Failed' : 'Pending'}
              </strong>
              <small>{formatTime(status.sandbox.lastVerifiedAt)}</small>
            </div>
          </section>

          <details className="ads-txt-connector-explainer" open>
            <summary>What is happening in this test?</summary>
            <div className="ads-txt-connector-explainer-grid">
              <div>
                <strong>Prepare</strong>
                <p>Tessera creates one complete ads.txt version from the requirements saved in the platform. It also calculates a checksum, which works like a fingerprint for the file.</p>
              </div>
              <div>
                <strong>Publish</strong>
                <p>The complete file is sent to the mock endpoint above. This simulates the request that will later be sent to a publisher CMS.</p>
              </div>
              <div>
                <strong>Verify</strong>
                <p>Tessera checks that the endpoint contains exactly the published version. A matching checksum confirms that no line was changed or lost.</p>
              </div>
              <div>
                <strong>Rollback</strong>
                <p>If a newer version causes a problem, Tessera restores the previous published version and asks for verification again.</p>
              </div>
            </div>
          </details>

          <details className="ads-txt-connector-explainer">
            <summary>What will we ask from a real publisher?</summary>
            <div className="ads-txt-connector-publisher-list">
              <p>The publisher technical team will receive a short integration specification. They need to provide:</p>
              <ol>
                <li>A staging and production API endpoint dedicated only to ads.txt.</li>
                <li>Restricted authentication, such as a Bearer token or HMAC signature.</li>
                <li>Permission for the endpoint to read and replace only the ads.txt resource.</li>
                <li>A JSON response containing the accepted version ID and checksum.</li>
                <li>Information about caching, cache purge and rollback.</li>
                <li>Confirmation that another CMS job will not overwrite Tessera's publication.</li>
              </ol>
              <p>No access to the complete website, CMS admin panel or server is required.</p>
            </div>
          </details>

          <section className="ads-txt-connector-versions">
            <div className="ads-txt-card-heading">
              <div><span className="panel-kicker">Sandbox history</span><h3>Prepared and published versions</h3></div>
            </div>
            {status.versions.length ? (
              <div className="ads-txt-connector-version-list">
                {status.versions.map((version) => (
                  <div key={version.id}>
                    <div>
                      <strong>Version {version.versionNumber}</strong>
                      <small>{version.entryCount} entries · {version.lineCount} lines</small>
                    </div>
                    <code>{shortChecksum(version.checksum)}</code>
                    <span className={`ads-txt-connector-version-status ${version.status}`}>{version.status}</span>
                    <time>{formatTime(version.publishedAt || version.createdAt)}</time>
                  </div>
                ))}
              </div>
            ) : (
              <div className="ads-txt-empty"><strong>No sandbox versions yet</strong><span>Complete the first three steps to prepare one.</span></div>
            )}
          </section>
        </>
      ) : null}
    </article>
  );
}
