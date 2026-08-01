import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Site } from '../shared/types';

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

function normalizedHost(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, '');
}

function activeSiteFromPage(sites: Site[]): Site | null {
  const urlInput = document.querySelector<HTMLInputElement>('.ads-txt-url-row input');
  const adsTxtUrl = urlInput?.value.trim() ?? '';
  if (adsTxtUrl) {
    try {
      const host = normalizedHost(new URL(adsTxtUrl).hostname);
      const match = sites.find((site) => normalizedHost(site.domain) === host);
      if (match) return match;
    } catch {
      // Fall through to the selected sidebar item.
    }
  }

  const activeName = document.querySelector('.site-link.active span')?.textContent?.trim() ?? '';
  if (!activeName) return null;
  const matches = sites.filter((site) => site.name === activeName);
  return matches.length === 1 ? matches[0] : null;
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

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    void api.listPublisherAccounts()
      .then(async (accounts) => {
        const sites = accounts.flatMap((account) => account.sites);
        const currentSite = activeSiteFromPage(sites);
        if (!currentSite) throw new Error('The active site could not be identified. Refresh the page and try again.');
        const payload = await requestJson<ConnectionResponse>(
          `/api/publishers/${encodeURIComponent(currentSite.id)}/ads-txt/cms-connection?ts=${Date.now()}`,
          { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } },
        );
        if (!active) return;
        setSite(currentSite);
        setConnection(payload.connection);
        setEndpointUrl(payload.connection.endpointUrl);
        setMethod(payload.connection.method);
        setAuthType(payload.connection.authType);
        setAuthHeader(payload.connection.authHeader || (payload.connection.authType === 'api_key' ? 'X-API-Key' : 'Authorization'));
        setCredential('');
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'CMS connection could not be loaded.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const readyToSave = useMemo(() => {
    if (!site || !endpointUrl.trim() || saving || removing) return false;
    if (authType === 'none') return true;
    return Boolean(credential.trim() || connection.credentialSet);
  }, [authType, connection.credentialSet, credential, endpointUrl, removing, saving, site]);

  function changeAuthType(value: 'none' | 'bearer' | 'api_key'): void {
    setAuthType(value);
    if (value === 'bearer') setAuthHeader('Authorization');
    if (value === 'api_key') setAuthHeader('X-API-Key');
    if (value === 'none') setAuthHeader('');
  }

  async function save(): Promise<void> {
    if (!site || !readyToSave) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload = await requestJson<ConnectionResponse>(
        `/api/publishers/${encodeURIComponent(site.id)}/ads-txt/cms-connection`,
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
      setConnection(payload.connection);
      setCredential('');
      setMessage('CMS connection saved.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'CMS connection could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (!site || !connection.configured || removing) return;
    setRemoving(true);
    setError(null);
    setMessage(null);
    try {
      await requestJson<{ ok: true; deleted: boolean }>(
        `/api/publishers/${encodeURIComponent(site.id)}/ads-txt/cms-connection`,
        { method: 'DELETE', credentials: 'same-origin', headers: { accept: 'application/json' } },
      );
      const empty = defaultConnection();
      setConnection(empty);
      setEndpointUrl('');
      setMethod('PUT');
      setAuthType('bearer');
      setAuthHeader('Authorization');
      setCredential('');
      setMessage('CMS connection removed.');
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'CMS connection could not be removed.');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <article className="ads-txt-cms-card">
      <div className="ads-txt-cms-heading">
        <div>
          <span className="panel-kicker">CMS / API publishing</span>
          <h2>CMS connection</h2>
          <p>When the publisher developer sends the endpoint details, enter them here.</p>
        </div>
        <span className={`ads-txt-cms-status ${connection.configured ? 'ready' : 'empty'}`}>
          {connection.configured ? 'CONNECTED DETAILS SAVED' : 'NOT CONFIGURED'}
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
                  placeholder={connection.credentialSet ? 'Saved securely — leave blank to keep it' : 'Paste the credential here'}
                  type="password"
                  value={credential}
                />
                <small>{connection.credentialSet ? 'A credential is already saved. Enter a new value only when replacing it.' : 'The credential is encrypted before it is stored.'}</small>
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
        <strong>Nothing is published when you save these settings.</strong>
        <span>This only stores the connection. Publishing will be enabled after we receive and test a real publisher endpoint.</span>
      </div>
    </article>
  );
}
