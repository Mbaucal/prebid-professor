import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PublisherAccount } from '../shared/types';

type Props = {
  publishers: PublisherAccount[];
  onOpenSite: (publisherAccountId: string, siteId: string, tab: 'Releases') => void;
};

type ReleaseStatus = 'draft' | 'staging' | 'production' | 'archived' | 'failed';

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
};

type ReleasesPayload = {
  ok: true;
  releases: Release[];
};

type GlobalRelease = Release & {
  publisherAccountId: string;
  publisherName: string;
  siteId: string;
  siteName: string;
  domain: string;
};

const STATUS_OPTIONS: Array<{ value: '' | ReleaseStatus; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'production', label: 'Production' },
  { value: 'staging', label: 'Staging' },
  { value: 'draft', label: 'Draft' },
  { value: 'failed', label: 'Failed' },
  { value: 'archived', label: 'Archived' },
];

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

function nestedString(value: Record<string, unknown> | null, group: string, key: string): string {
  if (!value) return '—';
  const nested = value[group];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return '—';
  const candidate = (nested as Record<string, unknown>)[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate : '—';
}

function statusLabel(status: ReleaseStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function GlobalReleasesPanel({ publishers, onOpenSite }: Props) {
  const [rows, setRows] = useState<GlobalRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [publisherFilter, setPublisherFilter] = useState('');
  const [siteFilter, setSiteFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | ReleaseStatus>('');

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
        const payload = await requestJson<ReleasesPayload>(
          `/api/publishers/${encodeURIComponent(site.siteId)}/releases`,
        );
        return payload.releases.map((release) => ({ ...release, ...site }));
      }),
    );

    const nextRows = results
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    const failed = results.filter((result) => result.status === 'rejected').length;
    setRows(nextRows);
    if (failed) setError(`${failed} site${failed === 1 ? '' : 's'} could not load release history.`);
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
        row.createdBy ?? '',
        row.notes ?? '',
        nestedString(row.manifest, 'prebidBuild', 'version'),
        nestedString(row.manifest, 'generatorProfile', 'id'),
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [publisherFilter, query, rows, siteFilter, statusFilter]);

  const counts = useMemo(() => ({
    all: rows.length,
    production: rows.filter((row) => row.status === 'production').length,
    staging: rows.filter((row) => row.status === 'staging').length,
    draft: rows.filter((row) => row.status === 'draft').length,
    failed: rows.filter((row) => row.status === 'failed').length,
  }), [rows]);

  return (
    <section className="global-page">
      <div className="global-page-heading">
        <div>
          <span className="panel-kicker">All publishers and sites</span>
          <h2>Release inventory</h2>
          <p>Search every immutable release, then jump directly into the selected site workspace.</p>
        </div>
        <button className="button secondary" disabled={loading} onClick={() => void load()} type="button">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error ? <div className="form-error global-message">{error}</div> : null}

      <div className="global-stat-grid">
        <div><span>Total releases</span><strong>{counts.all}</strong></div>
        <div><span>Production</span><strong>{counts.production}</strong></div>
        <div><span>Staging</span><strong>{counts.staging}</strong></div>
        <div><span>Drafts</span><strong>{counts.draft}</strong></div>
        <div><span>Failed</span><strong>{counts.failed}</strong></div>
      </div>

      <article className="global-card">
        <div className="global-filter-grid">
          <label>
            <span>Search</span>
            <input onChange={(event) => setQuery(event.target.value)} placeholder="Version, site, user, profile…" value={query} />
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
            <select onChange={(event) => setStatusFilter(event.target.value as '' | ReleaseStatus)} value={statusFilter}>
              {STATUS_OPTIONS.map((option) => <option key={option.value || 'all'} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>
      </article>

      <article className="global-table-card">
        <div className="global-table-heading">
          <div><span className="panel-kicker">Results</span><h3>{filteredRows.length} release{filteredRows.length === 1 ? '' : 's'}</h3></div>
        </div>
        {loading ? (
          <div className="global-empty"><strong>Loading release inventory…</strong></div>
        ) : filteredRows.length ? (
          <div className="global-table-scroll">
            <table className="global-table">
              <thead>
                <tr>
                  <th>Publisher / site</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>By</th>
                  <th>Published</th>
                  <th>Prebid</th>
                  <th>Generator profile</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.id}>
                    <td><strong>{row.siteName}</strong><span>{row.publisherName} · {row.domain}</span></td>
                    <td><code>{row.version}</code></td>
                    <td><span className={`global-status ${row.status}`}>{statusLabel(row.status)}</span></td>
                    <td>{formatTime(row.createdAt)}</td>
                    <td>{row.createdBy || '—'}</td>
                    <td>{formatTime(row.publishedAt)}</td>
                    <td><code>{nestedString(row.manifest, 'prebidBuild', 'version')}</code></td>
                    <td><code>{nestedString(row.manifest, 'generatorProfile', 'id')}</code></td>
                    <td><button className="button secondary compact" onClick={() => onOpenSite(row.publisherAccountId, row.siteId, 'Releases')} type="button">Open site</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="global-empty"><strong>No releases match the selected filters.</strong></div>
        )}
      </article>
    </section>
  );
}
