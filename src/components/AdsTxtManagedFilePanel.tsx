import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { PublisherAccount, Site } from '../shared/types';

type ManagedFile = {
  siteId: string;
  adsTxtUrl: string;
  fileName: string;
  content: string;
  generatedAt: string;
  rowCount: number;
  canonicalCount: number;
  repeatedRowCount: number;
  headingCount: number;
  lineCount: number;
  byteSize: number;
  checksum: string;
};

type ManagedFileResponse = {
  ok: true;
  file: ManagedFile;
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
      second: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export default function AdsTxtManagedFilePanel() {
  const [site, setSite] = useState<Site | null>(null);
  const [file, setFile] = useState<ManagedFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeSiteIdRef = useRef('');
  const markerSignatureRef = useRef('');
  const detectionGeneration = useRef(0);
  const loadGeneration = useRef(0);

  const loadForSite = useCallback(async (
    currentSite: Site,
    mode: 'initial' | 'refresh' = 'initial',
  ): Promise<void> => {
    const generation = ++loadGeneration.current;
    if (mode === 'initial') setLoading(true);
    else setRefreshing(true);
    setError(null);
    setMessage(null);

    try {
      const payload = await requestJson<ManagedFileResponse>(
        `/api/publishers/${encodeURIComponent(currentSite.id)}/ads-txt/managed-file?ts=${Date.now()}`,
        {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        },
      );
      if (activeSiteIdRef.current !== currentSite.id || loadGeneration.current !== generation) return;
      setFile(payload.file);
    } catch (loadError) {
      if (activeSiteIdRef.current !== currentSite.id || loadGeneration.current !== generation) return;
      setFile(null);
      setError(loadError instanceof Error ? loadError.message : 'Managed ads.txt file could not be generated.');
    } finally {
      if (activeSiteIdRef.current === currentSite.id && loadGeneration.current === generation) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let observer: MutationObserver | null = null;
    let intervalId = 0;
    let debounceId = 0;

    const detectSite = async (force = false): Promise<void> => {
      if (disposed || !document.querySelector('.ads-txt-page')) return;
      const markerBefore = activeSiteMarkerFromPage();
      if (!markerBefore) return;
      const changed = markerBefore.signature !== markerSignatureRef.current;
      if (!force && !changed && activeSiteIdRef.current) return;

      const generation = ++detectionGeneration.current;
      try {
        const accounts = await api.listPublisherAccounts();
        if (disposed || detectionGeneration.current !== generation) return;
        const markerAfter = activeSiteMarkerFromPage();
        if (!markerAfter) return;
        if (markerAfter.signature !== markerBefore.signature) {
          window.clearTimeout(debounceId);
          debounceId = window.setTimeout(() => void detectSite(true), 50);
          return;
        }

        const currentSite = resolveSite(accounts, markerAfter);
        if (!currentSite) {
          setLoading(false);
          setError('The selected site could not be identified.');
          return;
        }

        markerSignatureRef.current = markerAfter.signature;
        setSite(currentSite);
        if (currentSite.id === activeSiteIdRef.current) return;

        activeSiteIdRef.current = currentSite.id;
        loadGeneration.current += 1;
        setFile(null);
        setPreviewOpen(false);
        setCopied(false);
        setMessage(null);
        setError(null);
        void loadForSite(currentSite);
      } catch (siteError) {
        if (disposed || detectionGeneration.current !== generation) return;
        setLoading(false);
        setError(siteError instanceof Error ? siteError.message : 'Sites could not be loaded.');
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

  async function copyFile(): Promise<void> {
    if (!file?.content) return;
    setError(null);
    try {
      await copyText(file.content);
      setCopied(true);
      setMessage('Managed ads.txt copied to the clipboard.');
      window.setTimeout(() => setCopied(false), 1_800);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : 'Clipboard access was blocked.');
    }
  }

  function downloadFile(): void {
    if (!file?.content) return;
    const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.fileName || 'ads.txt';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setMessage('Managed ads.txt downloaded.');
  }

  return (
    <article className="ads-txt-managed-file-card">
      <div className="ads-txt-managed-file-heading">
        <div>
          <span className="panel-kicker">Managed ads.txt file</span>
          <h2>Preview, copy or download</h2>
          <p>This file is generated from the rows saved in Tessera. It does not change the live website.</p>
        </div>
        <span className="ads-txt-managed-file-badge">DRAFT · NO LIVE CHANGES</span>
      </div>

      {site ? (
        <div className="ads-txt-managed-file-site">
          <span>Current site</span>
          <strong>{site.name}</strong>
          <small>{site.domain} · ID: {site.id}</small>
        </div>
      ) : null}

      {loading ? <div className="config-loading">Generating managed ads.txt…</div> : null}
      {error ? <div className="form-error ads-txt-managed-file-message">{error}</div> : null}
      {message ? <div className="ads-txt-success ads-txt-managed-file-message">✓ {message}</div> : null}

      {!loading && file ? (
        <>
          <div className="ads-txt-managed-file-facts">
            <div><span>Saved rows</span><strong>{file.rowCount}</strong></div>
            <div><span>Unique records</span><strong>{file.canonicalCount}</strong></div>
            <div><span>Repeated rows</span><strong>{file.repeatedRowCount}</strong></div>
            <div><span>File size</span><strong>{formatBytes(file.byteSize)}</strong></div>
          </div>

          <div className="ads-txt-managed-file-actions">
            <button
              className="button secondary"
              disabled={refreshing || !site}
              onClick={() => site && void loadForSite(site, 'refresh')}
              type="button"
            >
              {refreshing ? 'Refreshing…' : 'Refresh file'}
            </button>
            <button
              className="button secondary"
              disabled={!file.content}
              onClick={() => void copyFile()}
              type="button"
            >
              {copied ? '✓ Copied' : 'Copy file'}
            </button>
            <button
              className="button primary"
              disabled={!file.content}
              onClick={downloadFile}
              type="button"
            >
              Download ads.txt
            </button>
          </div>

          <button
            aria-expanded={previewOpen}
            className="ads-txt-managed-file-toggle"
            disabled={!file.content}
            onClick={() => setPreviewOpen((current) => !current)}
            type="button"
          >
            <span>{previewOpen ? 'Hide file preview' : 'Show file preview'}</span>
            <small>{file.lineCount} generated lines · {formatTime(file.generatedAt)}</small>
            <strong>{previewOpen ? '⌃' : '⌄'}</strong>
          </button>

          {previewOpen ? (
            <pre className="ads-txt-managed-file-preview">{file.content}</pre>
          ) : null}

          {!file.content ? (
            <div className="ads-txt-empty">
              <strong>No managed rows</strong>
              <span>Add or import ads.txt requirements before copying or downloading the file.</span>
            </div>
          ) : null}
        </>
      ) : null}
    </article>
  );
}
