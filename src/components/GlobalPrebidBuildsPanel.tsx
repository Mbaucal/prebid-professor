import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PublisherAccount } from '../shared/types';

type Props = {
  publishers: PublisherAccount[];
  onOpenSite: (publisherAccountId: string, siteId: string, tab: 'Prebid.js') => void;
};

type BuildStatus = 'current' | 'archived' | 'invalid';

type StoredBuild = {
  id: string;
  publisherId: string;
  version: string;
  fileName: string;
  fileSize: number;
  modules: string[];
  status: BuildStatus;
  uploadedBy: string | null;
  uploadedAt: string;
  missingAdapters: string[];
  valid: boolean;
  downloadUrl: string;
  contentHash: string | null;
};

type BuildsPayload = {
  ok: true;
  requiredAdapters: string[];
  builds: StoredBuild[];
};

type GlobalBuild = StoredBuild & {
  publisherAccountId: string;
  publisherName: string;
  siteId: string;
  siteName: string;
  domain: string;
  requiredAdapters: string[];
};

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  const text = await response.text();
  let payload: (T & { error?: string; details?: unknown }) | null = null;
  try {
    payload = text ? JSON.parse(text) as T & { error?: string; details?: unknown } : null;
  } catch {
    throw new Error(text || `Request failed with status ${response.status}.`);
  }
  if (!response.ok) {
    const details = payload?.details ? ` ${JSON.stringify(payload.details)}` : '';
    throw new Error(`${payload?.error || `Request failed with status ${response.status}.`}${details}`);
  }
  return payload as T;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(value: string): string {
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

function statusLabel(status: BuildStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function GlobalPrebidBuildsPanel({ publishers, onOpenSite }: Props) {
  const [rows, setRows] = useState<GlobalBuild[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [publisherFilter, setPublisherFilter] = useState('');
  const [siteFilter, setSiteFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | BuildStatus>('');

  const sites = useMemo(
    () => publishers.flatMap((publisher) => publisher.sites.map((site) => ({
      publisherAccountId: publisher.id,
      publisherName: publisher.name,
      siteId: site.id,
      siteName: site.name,
      domain: site.domain,
    }))),
    [publishers],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const results = await Promise.allSettled(
      sites.map(async (site) => {
        const payload = await requestJson<BuildsPayload>(
          `/api/publishers/${encodeURIComponent(site.siteId)}/prebid-builds`,
        );
        return payload.builds.map((build) => ({ ...build, ...site, requiredAdapters: payload.requiredAdapters }));
      }),
    );
    const nextRows = results
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .sort((left, right) => Date.parse(right.uploadedAt) - Date.parse(left.uploadedAt));
    const failed = results.filter((result) => result.status === 'rejected').length;
    setRows(nextRows);
    if (failed) setError(`${failed} site${failed === 1 ? '' : 's'} could not load Prebid build history.`);
    setLoading(false);
  }, [sites]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredSites = useMemo(
    () => sites.filter((site) => !publisherFilter || site.publisherAccountId === publisherFilter),
    [publisherFilter, sites],
  );

  useEffect(() => {
    if (siteFilter && !filteredSites.some((site) => site.siteId === siteFilter)) setSiteFilter('');
  }, [filteredSites, siteFilter]);

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (publisherFilter && row.publisherAccountId !== publisherFilter) return false;
      if (siteFilter && row.siteId !== siteFilter) return false;
      if (statusFilter && row.status !== statusFilter) return false;
      if (!needle) return true;
      return [
        row.publisherName,
        row.siteName,
        row.domain,
        row.version,
        row.fileName,
        row.uploadedBy ?? '',
        ...row.modules,
        ...row.missingAdapters,
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [publisherFilter, query, rows, siteFilter, statusFilter]);

  const counts = useMemo(() => ({
    all: rows.length,
    current: rows.filter((row) => row.status === 'current').length,
    archived: rows.filter((row) => row.status === 'archived').length,
    invalid: rows.filter((row) => row.status === 'invalid' || !row.valid).length,
    modules: new Set(rows.flatMap((row) => row.modules)).size,
  }), [rows]);

  return (
    <section className="global-page">
      <div className="global-page-heading">
        <div>
          <span className="panel-kicker">Cross-site inventory</span>
          <h2>Prebid builds</h2>
          <p>Review every uploaded Prebid.js build, module manifest and adapter validation result.</p>
        </div>
        <button className="button secondary" disabled={loading} onClick={() => void load()} type="button">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error ? <div className="form-error global-message">{error}</div> : null}

      <div className="global-stat-grid">
        <div><span>Total builds</span><strong>{counts.all}</strong></div>
        <div><span>Current</span><strong>{counts.current}</strong></div>
        <div><span>Archived</span><strong>{counts.archived}</strong></div>
        <div><span>Invalid</span><strong>{counts.invalid}</strong></div>
        <div><span>Unique modules</span><strong>{counts.modules}</strong></div>
      </div>

      <article className="global-card">
        <div className="global-filter-grid">
          <label>
            <span>Search</span>
            <input onChange={(event) => setQuery(event.target.value)} placeholder="Version, module, site, uploader…" value={query} />
          </label>
          <label>
            <span>Publisher</span>
            <select onChange={(event) => setPublisherFilter(event.target.value)} value={publisherFilter}>
              <option value="">All publishers</option>
              {publishers.map((publisher) => <option key={publisher.id} value={publisher.id}>{publisher.name}</option>)}
            </select>
          </label>
          <label>
            <span>Site</span>
            <select onChange={(event) => setSiteFilter(event.target.value)} value={siteFilter}>
              <option value="">All sites</option>
              {filteredSites.map((site) => <option key={site.siteId} value={site.siteId}>{site.siteName}</option>)}
            </select>
          </label>
          <label>
            <span>Status</span>
            <select onChange={(event) => setStatusFilter(event.target.value as '' | BuildStatus)} value={statusFilter}>
              <option value="">All statuses</option>
              <option value="current">Current</option>
              <option value="archived">Archived</option>
              <option value="invalid">Invalid</option>
            </select>
          </label>
        </div>
      </article>

      <article className="global-table-card">
        <div className="global-table-heading">
          <div><span className="panel-kicker">Results</span><h3>{filteredRows.length} build{filteredRows.length === 1 ? '' : 's'}</h3></div>
        </div>
        {loading ? (
          <div className="global-empty"><strong>Loading Prebid build inventory…</strong></div>
        ) : filteredRows.length ? (
          <div className="global-table-scroll">
            <table className="global-table">
              <thead>
                <tr>
                  <th>Publisher / site</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>File</th>
                  <th>Modules</th>
                  <th>Missing adapters</th>
                  <th>Uploaded</th>
                  <th>By</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.id}>
                    <td><strong>{row.siteName}</strong><span>{row.publisherName} · {row.domain}</span></td>
                    <td><code>{row.version}</code></td>
                    <td><span className={`global-status ${row.status}`}>{statusLabel(row.status)}</span></td>
                    <td><strong>{row.fileName}</strong><span>{formatBytes(row.fileSize)}</span></td>
                    <td><strong>{row.modules.length}</strong><span>{row.modules.slice(0, 3).join(', ')}{row.modules.length > 3 ? '…' : ''}</span></td>
                    <td className={row.missingAdapters.length ? 'global-danger-text' : ''}>{row.missingAdapters.length ? row.missingAdapters.join(', ') : 'None'}</td>
                    <td>{formatTime(row.uploadedAt)}</td>
                    <td>{row.uploadedBy || '—'}</td>
                    <td><button className="button secondary compact" onClick={() => onOpenSite(row.publisherAccountId, row.siteId, 'Prebid.js')} type="button">Open site</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="global-empty"><strong>No builds match the selected filters.</strong></div>
        )}
      </article>
    </section>
  );
}
