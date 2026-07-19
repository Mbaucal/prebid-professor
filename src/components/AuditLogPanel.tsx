import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PublisherAccount } from '../shared/types';

type Props = {
  publishers: PublisherAccount[];
  onOpenSite: (publisherAccountId: string, siteId: string, tab: 'Overview') => void;
};

type AuditEntry = {
  id: string;
  actor: string | null;
  action: string;
  siteId: string | null;
  siteName: string | null;
  siteDomain: string | null;
  publisherAccountId: string | null;
  publisherAccountName: string | null;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

type AuditPayload = {
  ok: true;
  entries: AuditEntry[];
  limit: number;
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

function formatTime(value: string): string {
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

function actionLabel(value: string): string {
  return value
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function compactDetails(details: Record<string, unknown>): string {
  const entries = Object.entries(details).slice(0, 3);
  if (!entries.length) return '—';
  return entries.map(([key, value]) => {
    const display = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : Array.isArray(value)
        ? `${value.length} item${value.length === 1 ? '' : 's'}`
        : value && typeof value === 'object'
          ? 'object'
          : '—';
    return `${key}: ${display}`;
  }).join(' · ');
}

export default function AuditLogPanel({ publishers, onOpenSite }: Props) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [publisherFilter, setPublisherFilter] = useState('');
  const [siteFilter, setSiteFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');

  const sites = useMemo(
    () => publishers.flatMap((publisher) => publisher.sites.map((site) => ({
      publisherAccountId: publisher.id,
      publisherName: publisher.name,
      siteId: site.id,
      siteName: site.name,
    }))),
    [publishers],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await requestJson<AuditPayload>('/api/audit-log?limit=500');
      setEntries(payload.entries);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Audit log could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

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

  const actions = useMemo(
    () => Array.from(new Set(entries.map((entry) => entry.action))).sort((left, right) => left.localeCompare(right)),
    [entries],
  );
  const actors = useMemo(
    () => Array.from(new Set(entries.map((entry) => entry.actor).filter((value): value is string => Boolean(value)))).sort((left, right) => left.localeCompare(right)),
    [entries],
  );

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (publisherFilter && entry.publisherAccountId !== publisherFilter) return false;
      if (siteFilter && entry.siteId !== siteFilter) return false;
      if (actionFilter && entry.action !== actionFilter) return false;
      if (actorFilter && entry.actor !== actorFilter) return false;
      if (!needle) return true;
      return [
        entry.actor ?? '',
        entry.action,
        entry.siteName ?? '',
        entry.siteDomain ?? '',
        entry.publisherAccountName ?? '',
        entry.entityType ?? '',
        entry.entityId ?? '',
        JSON.stringify(entry.details),
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [actionFilter, actorFilter, entries, publisherFilter, query, siteFilter]);

  const today = new Date().toISOString().slice(0, 10);
  const counts = useMemo(() => ({
    all: entries.length,
    today: entries.filter((entry) => entry.createdAt.slice(0, 10) === today).length,
    actors: new Set(entries.map((entry) => entry.actor).filter(Boolean)).size,
    actions: new Set(entries.map((entry) => entry.action)).size,
    sites: new Set(entries.map((entry) => entry.siteId).filter(Boolean)).size,
  }), [entries, today]);

  return (
    <section className="global-page">
      <div className="global-page-heading">
        <div>
          <span className="panel-kicker">D1 activity history</span>
          <h2>Audit log</h2>
          <p>Review who changed configuration, releases, ads.txt requirements and operational settings.</p>
        </div>
        <button className="button secondary" disabled={loading} onClick={() => void load()} type="button">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error ? <div className="form-error global-message">{error}</div> : null}

      <div className="global-stat-grid">
        <div><span>Latest 500</span><strong>{counts.all}</strong></div>
        <div><span>Today</span><strong>{counts.today}</strong></div>
        <div><span>Actors</span><strong>{counts.actors}</strong></div>
        <div><span>Action types</span><strong>{counts.actions}</strong></div>
        <div><span>Sites touched</span><strong>{counts.sites}</strong></div>
      </div>

      <article className="global-card">
        <div className="global-filter-grid audit-filter-grid">
          <label>
            <span>Search</span>
            <input onChange={(event) => setQuery(event.target.value)} placeholder="Action, entity, site, details…" value={query} />
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
            <span>Action</span>
            <select onChange={(event) => setActionFilter(event.target.value)} value={actionFilter}>
              <option value="">All actions</option>
              {actions.map((action) => <option key={action} value={action}>{actionLabel(action)}</option>)}
            </select>
          </label>
          <label>
            <span>Actor</span>
            <select onChange={(event) => setActorFilter(event.target.value)} value={actorFilter}>
              <option value="">All actors</option>
              {actors.map((actor) => <option key={actor} value={actor}>{actor}</option>)}
            </select>
          </label>
        </div>
      </article>

      <article className="global-table-card">
        <div className="global-table-heading">
          <div><span className="panel-kicker">Results</span><h3>{filteredEntries.length} event{filteredEntries.length === 1 ? '' : 's'}</h3></div>
        </div>
        {loading ? (
          <div className="global-empty"><strong>Loading audit history…</strong></div>
        ) : filteredEntries.length ? (
          <div className="global-table-scroll">
            <table className="global-table audit-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Publisher / site</th>
                  <th>Entity</th>
                  <th>Details</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredEntries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatTime(entry.createdAt)}</td>
                    <td>{entry.actor || 'system'}</td>
                    <td><strong>{actionLabel(entry.action)}</strong><span><code>{entry.action}</code></span></td>
                    <td><strong>{entry.siteName || entry.siteId || 'Deleted / global'}</strong><span>{entry.publisherAccountName || entry.siteDomain || '—'}</span></td>
                    <td><strong>{entry.entityType || '—'}</strong><span><code>{entry.entityId || '—'}</code></span></td>
                    <td>
                      <span className="audit-detail-summary">{compactDetails(entry.details)}</span>
                      <details className="audit-details"><summary>Full JSON</summary><pre>{JSON.stringify(entry.details, null, 2)}</pre></details>
                    </td>
                    <td>{entry.siteId && entry.publisherAccountId ? <button className="button secondary compact" onClick={() => onOpenSite(entry.publisherAccountId!, entry.siteId!, 'Overview')} type="button">Open site</button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="global-empty"><strong>No audit events match the selected filters.</strong></div>
        )}
      </article>
    </section>
  );
}
