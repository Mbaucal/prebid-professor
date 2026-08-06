import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { PublisherAccount, Site } from '../shared/types';

type VersionMeta = {
  id: string;
  siteId: string;
  versionNumber: number;
  status: 'saved' | 'published' | 'superseded';
  checksum: string;
  rowCount: number;
  canonicalCount: number;
  repeatedRowCount: number;
  headingCount: number;
  lineCount: number;
  byteSize: number;
  note: string | null;
  createdBy: string;
  generatedAt: string;
  createdAt: string;
};

type VersionDetail = VersionMeta & {
  content: string;
  fileName: string;
};

type CurrentManagedFile = {
  checksum: string;
  rowCount: number;
  byteSize: number;
};

type VersionsResponse = {
  ok: true;
  siteId: string;
  totalVersions: number;
  versions: VersionMeta[];
  currentFile: CurrentManagedFile;
  currentVersion: VersionMeta | null;
};

type VersionResponse = {
  ok: true;
  created?: boolean;
  message?: string;
  version: VersionMeta | VersionDetail;
};

type ApiFailure = {
  error?: string;
  details?: unknown;
};

type ActiveSiteMarker = {
  publisherName: string;
  siteName: string;
  domain: string;
  signature: string;
};

const SITE_REFRESH_INTERVAL_MS = 5_000;
const MAX_NOTE_LENGTH = 160;

function normalizedText(value: string): string {
  return value.trim().toLowerCase();
}

function normalizedDomain(value: string): string {
  return normalizedText(value).replace(/^www\./, '');
}

function activeSiteMarkerFromPage(): ActiveSiteMarker | null {
  const topbar = document.querySelector<HTMLElement>('.workspace > .topbar');
  if (!topbar) return null;

  const siteName = topbar.querySelector<HTMLElement>('h1')?.textContent?.trim() ?? '';
  const eyebrow = topbar.querySelector<HTMLElement>('.eyebrow')?.textContent?.trim() ?? '';
  const eyebrowParts = eyebrow.split('/').map((part) => part.trim()).filter(Boolean);
  const publisherName = eyebrowParts.length >= 2 ? eyebrowParts[1] : '';
  const domain = Array.from(topbar.querySelectorAll<HTMLElement>('.publisher-meta > span'))
    .map((element) => element.textContent?.trim() ?? '')
    .find((value) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) ?? '';

  if (!siteName || !domain) return null;
  return {
    publisherName,
    siteName,
    domain,
    signature: [publisherName, siteName, domain].map(normalizedText).join('|'),
  };
}

function resolveSite(accounts: PublisherAccount[], marker: ActiveSiteMarker): Site | null {
  const allSites = accounts.flatMap((account) => account.sites);
  const domainMatches = allSites.filter(
    (candidate) => normalizedDomain(candidate.domain) === normalizedDomain(marker.domain),
  );
  if (domainMatches.length === 1) return domainMatches[0];

  const publisherMatches = accounts.filter(
    (account) => normalizedText(account.name) === normalizedText(marker.publisherName),
  );
  const namedMatches = publisherMatches.flatMap((account) => account.sites).filter(
    (candidate) => normalizedText(candidate.name) === normalizedText(marker.siteName),
  );
  if (namedMatches.length === 1) return namedMatches[0];

  const globalNameMatches = allSites.filter(
    (candidate) => normalizedText(candidate.name) === normalizedText(marker.siteName),
  );
  return globalNameMatches.length === 1 ? globalNameMatches[0] : null;
}

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

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(value < 10_240 ? 1 : 0)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(2)} MB`;
}

function formatTime(value: string): string {
  try {
    return new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function shortChecksum(value: string): string {
  return value.replace(/^sha256:/, '').slice(0, 12);
}

export default function AdsTxtVersionsPanel() {
  const [site, setSite] = useState<Site | null>(null);
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [versionCount, setVersionCount] = useState(0);
  const [currentFile, setCurrentFile] = useState<CurrentManagedFile | null>(null);
  const [currentVersion, setCurrentVersion] = useState<VersionMeta | null>(null);
  const [details, setDetails] = useState<Record<string, VersionDetail>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeSiteIdRef = useRef('');
  const markerSignatureRef = useRef('');
  const detectionGeneration = useRef(0);
  const loadGeneration = useRef(0);

  const matchingVersion = currentVersion;

  const loadForSite = useCallback(async (currentSite: Site): Promise<void> => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const payload = await requestJson<VersionsResponse>(
        `/api/publishers/${encodeURIComponent(currentSite.id)}/ads-txt/versions?ts=${Date.now()}`,
        { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } },
      );
      if (activeSiteIdRef.current !== currentSite.id || loadGeneration.current !== generation) return;
      setVersions(payload.versions);
      setVersionCount(payload.totalVersions);
      setCurrentFile(payload.currentFile);
      setCurrentVersion(payload.currentVersion);
    } catch (loadError) {
      if (activeSiteIdRef.current !== currentSite.id || loadGeneration.current !== generation) return;
      setVersions([]);
      setVersionCount(0);
      setCurrentFile(null);
      setCurrentVersion(null);
      setError(loadError instanceof Error ? loadError.message : 'Ads.txt versions could not be loaded.');
    } finally {
      if (activeSiteIdRef.current === currentSite.id && loadGeneration.current === generation) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let observer: MutationObserver | null = null;
    let intervalId = 0;
    let debounceId = 0;

    const clearResolvedSite = (errorMessage: string): void => {
      activeSiteIdRef.current = '';
      loadGeneration.current += 1;
      setSite(null);
      setVersions([]);
      setVersionCount(0);
      setCurrentFile(null);
      setCurrentVersion(null);
      setDetails({});
      setPreviewId(null);
      setHistoryOpen(false);
      setSaving(false);
      setActionId(null);
      setNote('');
      setMessage(null);
      setLoading(false);
      setError(errorMessage);
    };

    const detectSite = async (force = false): Promise<void> => {
      if (disposed || !document.querySelector('.ads-txt-page')) return;
      const markerBefore = activeSiteMarkerFromPage();
      if (!markerBefore) {
        markerSignatureRef.current = '';
        clearResolvedSite('The selected site could not be identified.');
        return;
      }

      const changed = markerBefore.signature !== markerSignatureRef.current;
      if (changed) {
        markerSignatureRef.current = markerBefore.signature;
        activeSiteIdRef.current = '';
        loadGeneration.current += 1;
        setSite(null);
        setVersions([]);
        setVersionCount(0);
        setCurrentFile(null);
        setCurrentVersion(null);
        setDetails({});
        setPreviewId(null);
        setHistoryOpen(false);
        setSaving(false);
        setActionId(null);
        setNote('');
        setMessage(null);
        setError(null);
        setLoading(true);
      }
      if (!force && !changed && activeSiteIdRef.current) return;

      const generation = ++detectionGeneration.current;
      try {
        const accounts = await api.listPublisherAccounts();
        if (disposed || detectionGeneration.current !== generation) return;
        const markerAfter = activeSiteMarkerFromPage();
        if (!markerAfter) {
          markerSignatureRef.current = '';
          clearResolvedSite('The selected site could not be identified.');
          return;
        }
        if (markerAfter.signature !== markerBefore.signature) {
          window.clearTimeout(debounceId);
          debounceId = window.setTimeout(() => void detectSite(true), 50);
          return;
        }

        const currentSite = resolveSite(accounts, markerAfter);
        if (!currentSite) {
          markerSignatureRef.current = markerAfter.signature;
          clearResolvedSite('The selected site could not be identified.');
          return;
        }

        markerSignatureRef.current = markerAfter.signature;
        setSite(currentSite);
        if (currentSite.id === activeSiteIdRef.current) return;

        activeSiteIdRef.current = currentSite.id;
        loadGeneration.current += 1;
        setVersions([]);
        setVersionCount(0);
        setCurrentFile(null);
        setCurrentVersion(null);
        setDetails({});
        setPreviewId(null);
        setHistoryOpen(false);
        setSaving(false);
        setActionId(null);
        setNote('');
        setMessage(null);
        setError(null);
        void loadForSite(currentSite);
      } catch (siteError) {
        if (disposed || detectionGeneration.current !== generation) return;
        clearResolvedSite(siteError instanceof Error ? siteError.message : 'Sites could not be loaded.');
      }
    };

    const scheduleDetection = (): void => {
      window.clearTimeout(debounceId);
      debounceId = window.setTimeout(() => void detectSite(false), 50);
    };

    const root = document.getElementById('root');
    observer = new MutationObserver(scheduleDetection);
    if (root) {
      observer.observe(root, {
        attributes: true,
        attributeFilter: ['class'],
        childList: true,
        subtree: true,
      });
    }
    intervalId = window.setInterval(() => void detectSite(true), SITE_REFRESH_INTERVAL_MS);
    void detectSite(true);

    return () => {
      disposed = true;
      detectionGeneration.current += 1;
      loadGeneration.current += 1;
      observer?.disconnect();
      window.clearInterval(intervalId);
      window.clearTimeout(debounceId);
    };
  }, [loadForSite]);

  async function saveCurrentVersion(): Promise<void> {
    if (!site || saving || !currentFile?.rowCount || matchingVersion) return;
    const requestedSite = site;
    const requestedSiteId = requestedSite.id;
    const reviewedChecksum = currentFile.checksum;
    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const payload = await requestJson<VersionResponse>(
        `/api/publishers/${encodeURIComponent(requestedSiteId)}/ads-txt/versions`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            note: note.trim(),
            expectedChecksum: reviewedChecksum,
          }),
        },
      );
      if (activeSiteIdRef.current !== requestedSiteId) return;
      setNote('');
      await loadForSite(requestedSite);
      if (activeSiteIdRef.current !== requestedSiteId) return;
      setMessage(payload.message || `Version ${payload.version.versionNumber} saved.`);
      setHistoryOpen(true);
    } catch (saveError) {
      if (activeSiteIdRef.current !== requestedSiteId) return;
      setError(saveError instanceof Error ? saveError.message : 'The ads.txt version could not be saved.');
    } finally {
      if (activeSiteIdRef.current === requestedSiteId) setSaving(false);
    }
  }

  async function loadVersionDetail(version: VersionMeta): Promise<VersionDetail | null> {
    const cached = details[version.id];
    if (cached) return cached;
    if (!site || actionId) return null;

    const requestedSiteId = site.id;
    setActionId(version.id);
    setError(null);
    try {
      const payload = await requestJson<VersionResponse>(
        `/api/publishers/${encodeURIComponent(requestedSiteId)}/ads-txt/versions/${encodeURIComponent(version.id)}`,
        { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } },
      );
      if (activeSiteIdRef.current !== requestedSiteId) return null;
      const detail = payload.version as VersionDetail;
      setDetails((current) => ({ ...current, [version.id]: detail }));
      return detail;
    } catch (detailError) {
      if (activeSiteIdRef.current === requestedSiteId) {
        setError(detailError instanceof Error ? detailError.message : 'The saved version could not be loaded.');
      }
      return null;
    } finally {
      if (activeSiteIdRef.current === requestedSiteId) setActionId(null);
    }
  }

  async function togglePreview(version: VersionMeta): Promise<void> {
    if (previewId === version.id) {
      setPreviewId(null);
      return;
    }
    const detail = await loadVersionDetail(version);
    if (detail) setPreviewId(version.id);
  }

  async function copyVersion(version: VersionMeta): Promise<void> {
    const detail = await loadVersionDetail(version);
    if (!detail) return;
    try {
      await copyText(detail.content);
      setMessage(`Version ${version.versionNumber} copied to the clipboard.`);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : 'Clipboard access was blocked.');
    }
  }

  async function downloadVersion(version: VersionMeta): Promise<void> {
    const detail = await loadVersionDetail(version);
    if (!detail) return;
    const blob = new Blob([detail.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = detail.fileName || `ads-v${version.versionNumber}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setMessage(`Version ${version.versionNumber} downloaded.`);
  }

  const badgeText = !currentFile?.rowCount
    ? 'NO MANAGED FILE'
    : matchingVersion
      ? `CURRENT DRAFT = V${matchingVersion.versionNumber}`
      : versionCount
        ? 'UNSAVED CHANGES'
        : 'NO SAVED VERSIONS';

  const historySummary = versionCount > versions.length
    ? `Showing ${versions.length} of ${versionCount} saved versions`
    : `${versionCount} saved version${versionCount === 1 ? '' : 's'}`;

  return (
    <article className="ads-txt-versions-card">
      <div className="ads-txt-versions-heading">
        <div>
          <span className="panel-kicker">Ads.txt versions</span>
          <h2>Save a fixed copy before publishing</h2>
          <p>Versions protect the exact file you reviewed. Saving a version does not change the live website.</p>
        </div>
        <span className={`ads-txt-versions-badge ${matchingVersion ? 'saved' : 'pending'}`}>{badgeText}</span>
      </div>

      {site ? (
        <div className="ads-txt-versions-site">
          <span>Current site</span>
          <strong>{site.name}</strong>
          <small>{site.domain} · ID: {site.id}</small>
        </div>
      ) : null}

      {loading ? <div className="config-loading">Loading ads.txt versions…</div> : null}
      {error ? <div className="form-error ads-txt-versions-message">{error}</div> : null}
      {message ? <div className="ads-txt-success ads-txt-versions-message">✓ {message}</div> : null}

      {!loading && site ? (
        <>
          <div className="ads-txt-version-create">
            <label>
              <span>Version note (optional)</span>
              <input
                maxLength={MAX_NOTE_LENGTH}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Example: Added Equativ and removed an old reseller"
                value={note}
              />
              <small>{note.length}/{MAX_NOTE_LENGTH} characters</small>
            </label>
            <div className="ads-txt-version-create-actions">
              <button
                className="button secondary"
                disabled={saving || loading || Boolean(actionId)}
                onClick={() => void loadForSite(site)}
                type="button"
              >
                Refresh status
              </button>
              <button
                className="button primary"
                disabled={saving || !currentFile?.rowCount || Boolean(matchingVersion)}
                onClick={() => void saveCurrentVersion()}
                type="button"
              >
                {saving
                  ? 'Saving version…'
                  : matchingVersion
                    ? `Already saved as v${matchingVersion.versionNumber}`
                    : 'Save current version'}
              </button>
            </div>
          </div>

          <div className="ads-txt-versions-facts">
            <div><span>Saved versions</span><strong>{versionCount}</strong></div>
            <div><span>Current rows</span><strong>{currentFile?.rowCount ?? 0}</strong></div>
            <div><span>Current size</span><strong>{formatBytes(currentFile?.byteSize ?? 0)}</strong></div>
            <div><span>Current checksum</span><strong>{currentFile ? shortChecksum(currentFile.checksum) : '—'}</strong></div>
          </div>

          <button
            aria-controls="ads-txt-version-history"
            aria-expanded={historyOpen}
            className="ads-txt-versions-toggle"
            disabled={!versions.length}
            onClick={() => setHistoryOpen((current) => !current)}
            type="button"
          >
            <span>{historyOpen ? 'Hide version history' : 'Show version history'}</span>
            <small>{historySummary}</small>
            <strong>{historyOpen ? '⌃' : '⌄'}</strong>
          </button>

          {historyOpen ? (
            <div className="ads-txt-version-list" id="ads-txt-version-history">
              {versions.map((version) => {
                const detail = details[version.id];
                const previewOpen = previewId === version.id;
                return (
                  <section className="ads-txt-version-row" key={version.id}>
                    <div className="ads-txt-version-row-heading">
                      <div>
                        <strong>Version {version.versionNumber}</strong>
                        <span>{formatTime(version.createdAt)} · {version.createdBy}</span>
                      </div>
                      <span className="ads-txt-version-status">{version.status}</span>
                    </div>
                    {version.note ? <p>{version.note}</p> : null}
                    <div className="ads-txt-version-row-facts">
                      <span>{version.rowCount} rows</span>
                      <span>{version.repeatedRowCount} repeated</span>
                      <span>{formatBytes(version.byteSize)}</span>
                      <span>sha256 {shortChecksum(version.checksum)}</span>
                    </div>
                    <div className="ads-txt-version-row-actions">
                      <button
                        className="button secondary"
                        disabled={Boolean(actionId)}
                        onClick={() => void togglePreview(version)}
                        type="button"
                      >
                        {actionId === version.id ? 'Loading…' : previewOpen ? 'Hide preview' : 'Preview'}
                      </button>
                      <button
                        className="button secondary"
                        disabled={Boolean(actionId)}
                        onClick={() => void copyVersion(version)}
                        type="button"
                      >
                        Copy
                      </button>
                      <button
                        className="button secondary"
                        disabled={Boolean(actionId)}
                        onClick={() => void downloadVersion(version)}
                        type="button"
                      >
                        Download
                      </button>
                    </div>
                    {previewOpen && detail ? (
                      <pre className="ads-txt-version-preview">{detail.content}</pre>
                    ) : null}
                  </section>
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}
    </article>
  );
}
