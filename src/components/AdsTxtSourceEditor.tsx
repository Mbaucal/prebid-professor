import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Site } from '../shared/types';

type SourceLineKind = 'blank' | 'comment' | 'record' | 'other';

type SourceLine = {
  index: number;
  lineNumber: number;
  text: string;
  kind: SourceLineKind;
};

type SourceVersion = {
  id: string;
  revision: number;
  changeType: string;
  summary: string;
  actor: string | null;
  createdAt: string;
};

type SourceDocument = {
  sourceUrl: string;
  revision: number;
  dirty: boolean;
  syncedAt: string | null;
  updatedAt: string;
  updatedBy: string | null;
  content: string;
  bytes: number;
  lineCount: number;
  nonEmptyLineCount: number;
  lines: SourceLine[];
  versions: SourceVersion[];
};

type SourcePayload = {
  ok: true;
  initialized: boolean;
  site: {
    id: string;
    name: string;
    domain: string;
    adsTxtUrl: string;
  };
  document: SourceDocument | null;
};

type FailurePayload = {
  error?: string;
  details?: unknown;
};

type Props = {
  site: Site;
  requestedSearch?: {
    query: string;
    requestId: number;
  };
};

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

function formatTime(value: string | null | undefined): string {
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

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function downloadText(content: string, fileName: string): void {
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

function kindLabel(kind: SourceLineKind): string {
  if (kind === 'blank') return 'BLANK';
  if (kind === 'comment') return 'COMMENT';
  if (kind === 'record') return 'RECORD';
  return 'OTHER';
}

export default function AdsTxtSourceEditor({ site, requestedSearch }: Props) {
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState('');
  const [newLineText, setNewLineText] = useState('');
  const activeSiteId = useRef(site.id);
  activeSiteId.current = site.id;

  const load = useCallback(async () => {
    const requestedSiteId = site.id;
    setLoading(true);
    setError(null);
    try {
      const next = await requestJson<SourcePayload>(
        `/api/publishers/${encodeURIComponent(requestedSiteId)}/ads-txt/source?ts=${Date.now()}`,
        { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } },
      );
      if (activeSiteId.current !== requestedSiteId) return;
      setPayload(next);
    } catch (loadError) {
      if (activeSiteId.current !== requestedSiteId) return;
      setError(loadError instanceof Error ? loadError.message : 'Managed ads.txt source could not be loaded.');
    } finally {
      if (activeSiteId.current === requestedSiteId) setLoading(false);
    }
  }, [site.id]);

  useEffect(() => {
    setPayload(null);
    setSearch('');
    setEditingIndex(null);
    setEditingText('');
    setNewLineText('');
    setMessage(null);
    setError(null);
    void load();
  }, [load, site.id]);

  useEffect(() => {
    if (!requestedSearch?.query) return;
    setSearch(requestedSearch.query);
    window.requestAnimationFrame(() => {
      document.getElementById('ads-txt-source-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [requestedSearch?.query, requestedSearch?.requestId]);

  const filteredLines = useMemo(() => {
    const lines = payload?.document?.lines ?? [];
    const query = search.trim().toLowerCase();
    if (!query) return lines;
    return lines.filter((line) => line.text.toLowerCase().includes(query));
  }, [payload, search]);

  async function syncFromLive(): Promise<void> {
    const requestedSiteId = site.id;
    const force = Boolean(payload?.document?.dirty);
    if (force && !window.confirm('Replace the current Tessera draft with the latest live ads.txt?\n\nAll unpublished draft changes will be discarded.')) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await requestJson<SourcePayload>(
        `/api/publishers/${encodeURIComponent(requestedSiteId)}/ads-txt/source/sync`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ force }),
        },
      );
      if (activeSiteId.current !== requestedSiteId) return;
      setPayload(next);
      setEditingIndex(null);
      setMessage('Managed working copy synced from the live ads.txt file.');
    } catch (syncError) {
      if (activeSiteId.current !== requestedSiteId) return;
      setError(syncError instanceof Error ? syncError.message : 'The live ads.txt file could not be synced.');
    } finally {
      if (activeSiteId.current === requestedSiteId) setBusy(false);
    }
  }

  async function mutate(
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body: Record<string, unknown>,
    successMessage: string,
  ): Promise<void> {
    const requestedSiteId = site.id;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await requestJson<SourcePayload>(
        `/api/publishers/${encodeURIComponent(requestedSiteId)}/ads-txt/source${path}`,
        {
          method,
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (activeSiteId.current !== requestedSiteId) return;
      setPayload(next);
      setEditingIndex(null);
      setEditingText('');
      setMessage(successMessage);
    } catch (mutationError) {
      if (activeSiteId.current !== requestedSiteId) return;
      setError(mutationError instanceof Error ? mutationError.message : 'The ads.txt draft could not be updated.');
    } finally {
      if (activeSiteId.current === requestedSiteId) setBusy(false);
    }
  }

  function startEdit(line: SourceLine): void {
    setEditingIndex(line.index);
    setEditingText(line.text);
    setError(null);
    setMessage(null);
  }

  async function saveEdit(): Promise<void> {
    if (!payload?.document || editingIndex === null) return;
    await mutate(
      `/lines/${editingIndex}`,
      'PATCH',
      { revision: payload.document.revision, text: editingText },
      `Physical line ${editingIndex + 1} updated in the Tessera draft.`,
    );
  }

  async function deleteLine(line: SourceLine): Promise<void> {
    if (!payload?.document) return;
    const description = line.text.trim() || 'blank line';
    if (!window.confirm(`Delete physical line ${line.lineNumber} from the Tessera draft?\n\n${description}`)) return;
    await mutate(
      `/lines/${line.index}`,
      'DELETE',
      { revision: payload.document.revision },
      `Physical line ${line.lineNumber} deleted from the Tessera draft.`,
    );
  }

  async function addLine(text: string): Promise<void> {
    if (!payload?.document) return;
    await mutate(
      '/lines',
      'POST',
      { revision: payload.document.revision, text },
      text ? 'New physical line added at the end of the Tessera draft.' : 'Blank physical line added at the end of the Tessera draft.',
    );
    setNewLineText('');
  }

  async function resetDraft(): Promise<void> {
    if (!payload?.document?.dirty) return;
    if (!window.confirm('Discard all Tessera draft changes and return to the last synced live version?')) return;
    await mutate(
      '/reset',
      'POST',
      { revision: payload.document.revision },
      'Draft reset to the most recently synced live ads.txt version.',
    );
  }

  async function copyDraft(): Promise<void> {
    if (!payload?.document) return;
    try {
      await navigator.clipboard.writeText(payload.document.content);
      setMessage('Complete managed ads.txt draft copied to the clipboard.');
      setError(null);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : 'The ads.txt draft could not be copied.');
    }
  }

  if (loading && !payload) {
    return <div className="config-loading">Loading managed ads.txt working copy…</div>;
  }

  const document = payload?.document ?? null;

  return (
    <article className="ads-source-card" id="ads-txt-source-editor">
      <div className="ads-source-heading">
        <div>
          <span className="panel-kicker">Editable working copy</span>
          <h3>Managed ads.txt source</h3>
          <p>Every physical line is preserved separately, including comments and repeated occurrences.</p>
        </div>
        <div className="ads-source-heading-actions">
          <span className={`ads-source-state ${document?.dirty ? 'dirty' : 'clean'}`}>
            {document ? (document.dirty ? 'UNPUBLISHED CHANGES' : 'SYNCED COPY') : 'NOT INITIALIZED'}
          </span>
          <button className="button secondary" disabled={busy} onClick={() => void syncFromLive()} type="button">
            {busy ? 'Working…' : document ? 'Sync from live' : 'Create from live ads.txt'}
          </button>
        </div>
      </div>

      <div className="ads-source-safety-note">
        <strong>Draft/export only:</strong> Edit and Delete change the Tessera working copy. They do not update the publisher’s live <code>/ads.txt</code> until a CMS publishing connector is added.
      </div>

      {error ? <div className="form-error ads-txt-message">{error}</div> : null}
      {message ? <div className="ads-txt-success ads-txt-message">✓ {message}</div> : null}

      {!document ? (
        <div className="ads-source-empty">
          <strong>No managed working copy yet</strong>
          <span>Tessera can fetch the complete live file automatically. No manual full-file upload is required.</span>
          <button className="button primary" disabled={busy} onClick={() => void syncFromLive()} type="button">Create working copy</button>
        </div>
      ) : (
        <>
          <div className="ads-source-facts">
            <div><span>Physical lines</span><strong>{document.lineCount}</strong></div>
            <div><span>Non-empty lines</span><strong>{document.nonEmptyLineCount}</strong></div>
            <div><span>Draft size</span><strong>{formatBytes(document.bytes)}</strong></div>
            <div><span>Revision</span><strong>{document.revision}</strong></div>
            <div><span>Last synced</span><strong>{formatTime(document.syncedAt)}</strong></div>
          </div>

          <div className="ads-source-actions">
            <button className="button secondary" disabled={busy || !document.dirty} onClick={() => void resetDraft()} type="button">Discard draft changes</button>
            <button className="button secondary" disabled={busy} onClick={() => void copyDraft()} type="button">Copy complete ads.txt</button>
            <button className="button primary" disabled={busy} onClick={() => downloadText(document.content, `${site.domain}-ads.txt`)} type="button">Download new ads.txt</button>
          </div>

          <div className="ads-source-search-row">
            <input
              aria-label="Search physical ads.txt source lines"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search every physical line, including comments such as #Smaato…"
              type="search"
              value={search}
            />
            {search ? <button className="button secondary" onClick={() => setSearch('')} type="button">Clear</button> : null}
          </div>

          <div className="ads-source-result-heading">
            <div>
              <span className="panel-kicker">Physical source rows</span>
              <h4>{filteredLines.length}{search.trim() ? ` of ${document.lineCount}` : ''} line{filteredLines.length === 1 ? '' : 's'}</h4>
            </div>
            <small>Each result has independent Edit and Delete actions.</small>
          </div>

          {filteredLines.length ? (
            <div className="ads-source-line-list">
              {filteredLines.map((line) => (
                <div className={`ads-source-line ${line.kind}`} key={`${document.revision}-${line.index}`}>
                  <div className="ads-source-line-number">{line.lineNumber}</div>
                  <div className="ads-source-line-main">
                    <div className="ads-source-line-meta">
                      <span>{kindLabel(line.kind)}</span>
                      {line.text.includes('#') && !line.text.trim().startsWith('#') ? <em>INLINE COMMENT</em> : null}
                    </div>
                    {editingIndex === line.index ? (
                      <textarea
                        autoFocus
                        onChange={(event) => setEditingText(event.target.value.replace(/[\r\n]/g, ''))}
                        rows={2}
                        value={editingText}
                      />
                    ) : (
                      <code>{line.text || 'Blank line'}</code>
                    )}
                  </div>
                  <div className="ads-source-line-actions">
                    {editingIndex === line.index ? (
                      <>
                        <button className="button primary" disabled={busy} onClick={() => void saveEdit()} type="button">Save</button>
                        <button className="button secondary" disabled={busy} onClick={() => { setEditingIndex(null); setEditingText(''); }} type="button">Cancel</button>
                      </>
                    ) : (
                      <>
                        <button className="button secondary" disabled={busy} onClick={() => startEdit(line)} type="button">Edit</button>
                        <button className="button danger subtle" disabled={busy} onClick={() => void deleteLine(line)} type="button">Delete</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="ads-source-empty compact"><strong>No matching physical lines</strong><span>Try a domain, seller ID, or inline comment.</span></div>
          )}

          <div className="ads-source-add-row">
            <input
              onChange={(event) => setNewLineText(event.target.value.replace(/[\r\n]/g, ''))}
              placeholder="New physical line to add at the end…"
              value={newLineText}
            />
            <button className="button secondary" disabled={busy} onClick={() => void addLine(newLineText)} type="button">Add line</button>
            <button className="button secondary" disabled={busy} onClick={() => void addLine('')} type="button">Add blank line</button>
          </div>

          <details className="ads-source-preview">
            <summary>Preview complete generated ads.txt</summary>
            <pre>{document.content || 'The draft is empty.'}</pre>
          </details>

          {document.versions.length ? (
            <details className="ads-source-history">
              <summary>Recent draft history</summary>
              <div>
                {document.versions.map((version) => (
                  <div key={version.id}>
                    <strong>Revision {version.revision}</strong>
                    <span>{version.summary || version.changeType}</span>
                    <time>{formatTime(version.createdAt)}</time>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </>
      )}
    </article>
  );
}
