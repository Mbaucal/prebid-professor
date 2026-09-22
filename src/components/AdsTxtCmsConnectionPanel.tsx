import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { PublisherAccount, Site } from '../shared/types';

type Connection = {
  configured: boolean;
  endpointUrl: string;
  method: 'POST' | 'PUT';
  authType: 'none' | 'bearer' | 'api_key';
  authHeader: string;
  credentialSet: boolean;
  enabled: boolean;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type ConnectionResponse = {
  ok: true;
  message?: string;
  connection: Connection;
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

type PendingMutation = 'save' | 'remove';

const SITE_REFRESH_INTERVAL_MS = 5_000;
const pendingMutations = new Map<string, PendingMutation>();
const pendingMutationListeners = new Set<() => void>();

function notifyPendingMutationListeners(): void {
  pendingMutationListeners.forEach((listener) => listener());
}

function beginPendingMutation(siteId: string, operation: PendingMutation): boolean {
  if (pendingMutations.has(siteId)) return false;
  pendingMutations.set(siteId, operation);
  notifyPendingMutationListeners();
  return true;
}

function finishPendingMutation(siteId: string, operation: PendingMutation): void {
  if (pendingMutations.get(siteId) !== operation) return;
  pendingMutations.delete(siteId);
  notifyPendingMutationListeners();
}

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

function defaultConnection(): Connection {
  return {
    configured: false,
    endpointUrl: '',
    method: 'PUT',
    authType: 'bearer',
    authHeader: 'Authorization',
    credentialSet: false,
    enabled: false,
    updatedBy: null,
    createdAt: null,
    updatedAt: null,
  };
}

export default function AdsTxtCmsConnectionPanel() {
  const [site, setSite] = useState<Site | null>(null);
  const [connection, setConnection] = useState<Connection>(defaultConnection());
  const [endpointUrl, setEndpointUrl] = useState('');
  const [method, setMethod] = useState<'POST' | 'PUT'>('PUT');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'api_key'>('bearer');
  const [authHeader, setAuthHeader] = useState('Authorization');
  const [credential, setCredential] = useState('');
  const [loading, setLoading] = useState(true);
  const [pendingMutation, setPendingMutation] = useState<PendingMutation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeSiteIdRef = useRef('');
  const currentSiteRef = useRef<Site | null>(null);
  const lastMarkerSignatureRef = useRef('');
  const siteEpochRef = useRef(0);
  const detectionGeneration = useRef(0);
  const loadGeneration = useRef(0);

  const loadForSite = useCallback(async (currentSite: Site): Promise<void> => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    setMessage(null);
    setCredential('');

    try {
      const payload = await requestJson<ConnectionResponse>(
        `/api/publishers/${encodeURIComponent(currentSite.id)}/ads-txt/cms-connection?ts=${Date.now()}`,
        { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } },
      );
      if (activeSiteIdRef.current !== currentSite.id || loadGeneration.current !== generation) return;
      setConnection(payload.connection);
      setEndpointUrl(payload.connection.endpointUrl);
      setMethod(payload.connection.method);
      setAuthType(payload.connection.authType);
      setAuthHeader(
        payload.connection.authHeader
        || (payload.connection.authType === 'api_key' ? 'X-API-Key' : 'Authorization'),
      );
      setCredential('');
    } catch (loadError) {
      if (activeSiteIdRef.current !== currentSite.id || loadGeneration.current !== generation) return;
      setConnection(defaultConnection());
      setEndpointUrl('');
      setMethod('PUT');
      setAuthType('bearer');
      setAuthHeader('Authorization');
      setError(loadError instanceof Error ? loadError.message : 'CMS connection could not be loaded.');
    } finally {
      if (activeSiteIdRef.current === currentSite.id && loadGeneration.current === generation) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const syncPending = (): void => {
      setPendingMutation(site ? pendingMutations.get(site.id) ?? null : null);
    };
    pendingMutationListeners.add(syncPending);
    syncPending();
    return () => {
      pendingMutationListeners.delete(syncPending);
    };
  }, [site]);

  useEffect(() => {
    let disposed = false;
    let observer: MutationObserver | null = null;
    let intervalId = 0;
    let debounceId = 0;

    const invalidateIdentity = (marker: ActiveSiteMarker): void => {
      lastMarkerSignatureRef.current = marker.signature;
      activeSiteIdRef.current = '';
      currentSiteRef.current = null;
      siteEpochRef.current += 1;
      loadGeneration.current += 1;
      setSite(null);
      setConnection(defaultConnection());
      setEndpointUrl('');
      setMethod('PUT');
      setAuthType('bearer');
      setAuthHeader('Authorization');
      setCredential('');
      setMessage(null);
      setError(null);
      setLoading(true);
    };

    const detectSite = async (forceRefresh = false): Promise<void> => {
      if (disposed || !document.querySelector('.ads-txt-page')) return;
      const markerBefore = activeSiteMarkerFromPage();
      if (!markerBefore) return;

      const markerChanged = markerBefore.signature !== lastMarkerSignatureRef.current;
      if (markerChanged) invalidateIdentity(markerBefore);
      if (!forceRefresh && !markerChanged && activeSiteIdRef.current) return;

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
          setError('The selected site could not be identified from the current publisher hierarchy.');
          return;
        }

        lastMarkerSignatureRef.current = markerAfter.signature;
        currentSiteRef.current = currentSite;
        setSite(currentSite);
        if (currentSite.id === activeSiteIdRef.current) return;

        activeSiteIdRef.current = currentSite.id;
        siteEpochRef.current += 1;
        loadGeneration.current += 1;
        setConnection(defaultConnection());
        setEndpointUrl('');
        setMethod('PUT');
        setAuthType('bearer');
        setAuthHeader('Authorization');
        setCredential('');
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

  const saving = pendingMutation === 'save';
  const removing = pendingMutation === 'remove';
  const readyToSave = useMemo(() => {
    if (!site || !endpointUrl.trim() || pendingMutation || loading) return false;
    if (authType === 'none') return true;
    return Boolean(authHeader.trim() && credential.trim());
  }, [authHeader, authType, credential, endpointUrl, loading, pendingMutation, site]);

  function changeAuthType(value: 'none' | 'bearer' | 'api_key'): void {
    setAuthType(value);
    setCredential('');
    if (value === 'bearer') setAuthHeader('Authorization');
    if (value === 'api_key') setAuthHeader('X-API-Key');
    if (value === 'none') setAuthHeader('');
  }

  async function save(): Promise<void> {
    if (!site || !readyToSave) return;
    const requestedSite = site;
    const requestedEpoch = siteEpochRef.current;
    if (!beginPendingMutation(requestedSite.id, 'save')) {
      setError('Another CMS connection change is already in progress for this site.');
      return;
    }

    loadGeneration.current += 1;
    setError(null);
    setMessage(null);

    try {
      const payload = await requestJson<ConnectionResponse>(
        `/api/publishers/${encodeURIComponent(requestedSite.id)}/ads-txt/cms-connection`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            endpointUrl: endpointUrl.trim(),
            method,
            authType,
            authHeader: authHeader.trim(),
            ...(authType !== 'none' ? { credential: credential.trim() } : {}),
            enabled: true,
          }),
        },
      );
      if (activeSiteIdRef.current !== requestedSite.id || siteEpochRef.current !== requestedEpoch) return;
      setConnection(payload.connection);
      setCredential('');
      setMessage('CMS connection saved.');
    } catch (saveError) {
      if (activeSiteIdRef.current !== requestedSite.id || siteEpochRef.current !== requestedEpoch) return;
      setError(saveError instanceof Error ? saveError.message : 'CMS connection could not be saved.');
    } finally {
      finishPendingMutation(requestedSite.id, 'save');
      if (activeSiteIdRef.current === requestedSite.id && siteEpochRef.current !== requestedEpoch) {
        void loadForSite(currentSiteRef.current ?? requestedSite);
      }
    }
  }

  async function remove(): Promise<void> {
    if (!site || !connection.configured || pendingMutation) return;
    const requestedSite = site;
    const requestedEpoch = siteEpochRef.current;
    if (!beginPendingMutation(requestedSite.id, 'remove')) {
      setError('Another CMS connection change is already in progress for this site.');
      return;
    }

    loadGeneration.current += 1;
    setError(null);
    setMessage(null);

    try {
      await requestJson<{ ok: true; deleted: boolean }>(
        `/api/publishers/${encodeURIComponent(requestedSite.id)}/ads-txt/cms-connection`,
        { method: 'DELETE', credentials: 'same-origin', headers: { accept: 'application/json' } },
      );
      if (activeSiteIdRef.current !== requestedSite.id || siteEpochRef.current !== requestedEpoch) return;
      const empty = defaultConnection();
      setConnection(empty);
      setEndpointUrl('');
      setMethod('PUT');
      setAuthType('bearer');
      setAuthHeader('Authorization');
      setCredential('');
      setMessage('CMS connection removed.');
    } catch (removeError) {
      if (activeSiteIdRef.current !== requestedSite.id || siteEpochRef.current !== requestedEpoch) return;
      setError(removeError instanceof Error ? removeError.message : 'CMS connection could not be removed.');
    } finally {
      finishPendingMutation(requestedSite.id, 'remove');
      if (activeSiteIdRef.current === requestedSite.id && siteEpochRef.current !== requestedEpoch) {
        void loadForSite(currentSiteRef.current ?? requestedSite);
      }
    }
  }

  return (
    <article className="ads-txt-cms-card">
      <div className="ads-txt-cms-heading">
        <div>
          <span className="panel-kicker">CMS / API publishing</span>
          <h2>CMS connection</h2>
          <p>Enter the endpoint details supplied by the publisher developer.</p>
        </div>
        <span className={`ads-txt-cms-status ${connection.configured ? 'ready' : 'empty'}`}>
          {connection.configured ? 'DETAILS SAVED' : 'NOT CONFIGURED'}
        </span>
      </div>

      {site ? (
        <div className="ads-txt-cms-site">
          <span>Current site</span>
          <strong>{site.name}</strong>
          <small>{site.domain} · ID: {site.id}</small>
        </div>
      ) : null}

      {loading ? <div className="config-loading">Loading CMS connection…</div> : null}
      {error ? <div className="form-error ads-txt-cms-message">{error}</div> : null}
      {message ? <div className="release-success ads-txt-cms-message">✓ {message}</div> : null}

      {!loading && site ? (
        <div className="ads-txt-cms-form">
          <label className="ads-txt-cms-endpoint">
            <span>Endpoint URL</span>
            <input
              onChange={(event) => setEndpointUrl(event.target.value)}
              placeholder="https://cms.example.com/api/ads-txt"
              type="url"
              value={endpointUrl}
            />
            <small>The URL supplied by the publisher developer.</small>
          </label>

          <label>
            <span>Method</span>
            <select onChange={(event) => setMethod(event.target.value as 'POST' | 'PUT')} value={method}>
              <option value="PUT">PUT</option>
              <option value="POST">POST</option>
            </select>
          </label>

          <label>
            <span>Authorization</span>
            <select
              onChange={(event) => changeAuthType(event.target.value as 'none' | 'bearer' | 'api_key')}
              value={authType}
            >
              <option value="bearer">Bearer token</option>
              <option value="api_key">API key</option>
              <option value="none">No authorization</option>
            </select>
          </label>

          {authType !== 'none' ? (
            <>
              <label>
                <span>Header name</span>
                <input
                  onChange={(event) => setAuthHeader(event.target.value)}
                  placeholder={authType === 'bearer' ? 'Authorization' : 'X-API-Key'}
                  value={authHeader}
                />
              </label>

              <label className="ads-txt-cms-credential">
                <span>{authType === 'bearer' ? 'Bearer token' : 'API key'}</span>
                <input
                  autoComplete="new-password"
                  onChange={(event) => setCredential(event.target.value)}
                  placeholder={connection.configured
                    ? 'Enter it again to save changes'
                    : 'Paste the credential here'}
                  type="password"
                  value={credential}
                />
                <small>
                  The saved credential is never displayed. Enter it again whenever you save changes.
                </small>
              </label>
            </>
          ) : null}

          <div className="ads-txt-cms-actions">
            <button className="button primary" disabled={!readyToSave} onClick={() => void save()} type="button">
              {saving ? 'Saving…' : connection.configured ? 'Save changes' : 'Save connection'}
            </button>
            {connection.configured ? (
              <button className="button danger" disabled={Boolean(pendingMutation)} onClick={() => void remove()} type="button">
                {removing ? 'Removing…' : 'Remove connection'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="ads-txt-cms-note">
        <strong>Saving these settings does not publish anything.</strong>
        <span>The endpoint will be used only after the real publishing workflow is activated and tested.</span>
      </div>
    </article>
  );
}
