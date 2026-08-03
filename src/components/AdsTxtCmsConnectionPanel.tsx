import { useEffect, useMemo, useRef, useState } from 'react';
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

const SITE_DETECTION_INTERVAL_MS = 750;

function activeSiteFromPage(accounts: PublisherAccount[]): Site | null {
  const activeButton = document.querySelector<HTMLButtonElement>(
    '.publisher-tree-group .publisher-site-list .site-link.active:not(.add-site-link)',
  );
  const activeGroup = activeButton?.closest<HTMLElement>('.publisher-tree-group') ?? null;
  if (!activeButton || !activeGroup) return null;

  const groups = Array.from(document.querySelectorAll<HTMLElement>('.publisher-tree-group'));
  const accountIndex = groups.indexOf(activeGroup);
  if (accountIndex < 0) return null;

  const siteButtons = Array.from(activeGroup.querySelectorAll<HTMLButtonElement>(
    '.publisher-site-list .site-link:not(.add-site-link)',
  ));
  const siteIndex = siteButtons.indexOf(activeButton);
  if (siteIndex < 0) return null;

  return accounts[accountIndex]?.sites[siteIndex] ?? null;
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
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accountsRef = useRef<PublisherAccount[]>([]);
  const activeSiteIdRef = useRef('');
  const loadGeneration = useRef(0);
  const saveGeneration = useRef(0);
  const removeGeneration = useRef(0);

  useEffect(() => {
    let disposed = false;
    let observer: MutationObserver | null = null;
    let intervalId = 0;

    const applyPayload = (currentSite: Site, payload: ConnectionResponse): void => {
      if (disposed || activeSiteIdRef.current !== currentSite.id) return;
      setConnection(payload.connection);
      setEndpointUrl(payload.connection.endpointUrl);
      setMethod(payload.connection.method);
      setAuthType(payload.connection.authType);
      setAuthHeader(
        payload.connection.authHeader
        || (payload.connection.authType === 'api_key' ? 'X-API-Key' : 'Authorization'),
      );
      setCredential('');
    };

    const loadForSite = async (currentSite: Site): Promise<void> => {
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
        if (disposed || activeSiteIdRef.current !== currentSite.id || loadGeneration.current !== generation) return;
        applyPayload(currentSite, payload);
      } catch (loadError) {
        if (disposed || activeSiteIdRef.current !== currentSite.id || loadGeneration.current !== generation) return;
        setConnection(defaultConnection());
        setEndpointUrl('');
        setMethod('PUT');
        setAuthType('bearer');
        setAuthHeader('Authorization');
        setError(loadError instanceof Error ? loadError.message : 'CMS connection could not be loaded.');
      } finally {
        if (!disposed && activeSiteIdRef.current === currentSite.id && loadGeneration.current === generation) {
          setLoading(false);
        }
      }
    };

    const detectSite = (): void => {
      if (disposed || !accountsRef.current.length || !document.querySelector('.ads-txt-page')) return;
      const currentSite = activeSiteFromPage(accountsRef.current);
      if (!currentSite || currentSite.id === activeSiteIdRef.current) return;

      activeSiteIdRef.current = currentSite.id;
      loadGeneration.current += 1;
      saveGeneration.current += 1;
      removeGeneration.current += 1;
      setSite(currentSite);
      setConnection(defaultConnection());
      setEndpointUrl('');
      setMethod('PUT');
      setAuthType('bearer');
      setAuthHeader('Authorization');
      setCredential('');
      setSaving(false);
      setRemoving(false);
      void loadForSite(currentSite);
    };

    void api.listPublisherAccounts()
      .then((accounts) => {
        if (disposed) return;
        accountsRef.current = accounts;
        detectSite();
      })
      .catch((loadError: unknown) => {
        if (!disposed) {
          setLoading(false);
          setError(loadError instanceof Error ? loadError.message : 'Sites could not be loaded.');
        }
      });

    const root = document.getElementById('root');
    observer = new MutationObserver(detectSite);
    if (root) {
      observer.observe(root, {
        attributes: true,
        attributeFilter: ['class'],
        childList: true,
        subtree: true,
      });
    }
    intervalId = window.setInterval(detectSite, SITE_DETECTION_INTERVAL_MS);

    return () => {
      disposed = true;
      loadGeneration.current += 1;
      saveGeneration.current += 1;
      removeGeneration.current += 1;
      observer?.disconnect();
      window.clearInterval(intervalId);
    };
  }, []);

  const credentialRequired = authType !== 'none'
    && (!connection.credentialSet || connection.authType !== authType);

  const readyToSave = useMemo(() => {
    if (!site || !endpointUrl.trim() || saving || removing || loading) return false;
    if (authType === 'none') return true;
    if (!authHeader.trim()) return false;
    return !credentialRequired || Boolean(credential.trim());
  }, [authHeader, authType, credential, credentialRequired, endpointUrl, loading, removing, saving, site]);

  function changeAuthType(value: 'none' | 'bearer' | 'api_key'): void {
    setAuthType(value);
    setCredential('');
    if (value === 'bearer') setAuthHeader('Authorization');
    if (value === 'api_key') setAuthHeader('X-API-Key');
    if (value === 'none') setAuthHeader('');
  }

  async function save(): Promise<void> {
    if (!site || !readyToSave) return;
    const requestedSiteId = site.id;
    const generation = ++saveGeneration.current;
    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const payload = await requestJson<ConnectionResponse>(
        `/api/publishers/${encodeURIComponent(requestedSiteId)}/ads-txt/cms-connection`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            endpointUrl: endpointUrl.trim(),
            method,
            authType,
            authHeader: authHeader.trim(),
            ...(credential.trim() ? { credential: credential.trim() } : {}),
            enabled: true,
          }),
        },
      );
      if (activeSiteIdRef.current !== requestedSiteId || saveGeneration.current !== generation) return;
      setConnection(payload.connection);
      setCredential('');
      setMessage('CMS connection saved.');
    } catch (saveError) {
      if (activeSiteIdRef.current !== requestedSiteId || saveGeneration.current !== generation) return;
      setError(saveError instanceof Error ? saveError.message : 'CMS connection could not be saved.');
    } finally {
      if (saveGeneration.current === generation) setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (!site || !connection.configured || removing) return;
    const requestedSiteId = site.id;
    const generation = ++removeGeneration.current;
    setRemoving(true);
    setError(null);
    setMessage(null);

    try {
      await requestJson<{ ok: true; deleted: boolean }>(
        `/api/publishers/${encodeURIComponent(requestedSiteId)}/ads-txt/cms-connection`,
        { method: 'DELETE', credentials: 'same-origin', headers: { accept: 'application/json' } },
      );
      if (activeSiteIdRef.current !== requestedSiteId || removeGeneration.current !== generation) return;
      const empty = defaultConnection();
      setConnection(empty);
      setEndpointUrl('');
      setMethod('PUT');
      setAuthType('bearer');
      setAuthHeader('Authorization');
      setCredential('');
      setMessage('CMS connection removed.');
    } catch (removeError) {
      if (activeSiteIdRef.current !== requestedSiteId || removeGeneration.current !== generation) return;
      setError(removeError instanceof Error ? removeError.message : 'CMS connection could not be removed.');
    } finally {
      if (removeGeneration.current === generation) setRemoving(false);
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
              placeholder="https://cms.publisher.com/api/ads-txt"
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
                  placeholder={connection.credentialSet && connection.authType === authType
                    ? 'Saved securely — leave blank to keep it'
                    : 'Paste the credential here'}
                  type="password"
                  value={credential}
                />
                <small>
                  {connection.credentialSet && connection.authType === authType
                    ? 'Enter a new value only when replacing the saved credential.'
                    : 'The credential is encrypted before it is stored.'}
                </small>
              </label>
            </>
          ) : null}

          <div className="ads-txt-cms-actions">
            <button className="button primary" disabled={!readyToSave} onClick={() => void save()} type="button">
              {saving ? 'Saving…' : connection.configured ? 'Save changes' : 'Save connection'}
            </button>
            {connection.configured ? (
              <button className="button danger" disabled={removing || saving} onClick={() => void remove()} type="button">
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
