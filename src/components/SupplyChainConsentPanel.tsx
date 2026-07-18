import { useCallback, useEffect, useMemo, useState } from 'react';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
};

type SchainNode = {
  id: string;
  asi: string;
  sid: string;
  hp: '0' | '1';
  rid: string;
  name: string;
  domain: string;
};

type Payload = {
  ok: true;
  integrations: {
    schain: {
      configured: boolean;
      enabled: boolean;
      version: string;
      complete: 0 | 1;
      nodes: Array<{
        asi: string;
        sid: string;
        hp: 0 | 1;
        rid?: string;
        name?: string;
        domain?: string;
      }>;
    };
    consent: {
      mode: 'cmp' | 'contextual-test';
    };
  };
  inheritedFromTemplate: boolean;
  consentGuard: {
    contextualTestIsStagingOnly: boolean;
    contextualTestDisablesDeviceAccess: boolean;
    contextualTestDisablesUserSync: boolean;
  };
};

type FormState = {
  schainEnabled: boolean;
  version: string;
  complete: '0' | '1';
  nodes: SchainNode[];
  consentMode: 'cmp' | 'contextual-test';
};

type ApiFailure = { error?: string; details?: unknown };

function rowId(): string {
  return `schain-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text();
  let payload: (T & ApiFailure) | null = null;
  try {
    payload = text ? (JSON.parse(text) as T & ApiFailure) : null;
  } catch {
    throw new Error(text || `Request failed with status ${response.status}.`);
  }
  if (!response.ok) {
    const details = payload?.details ? ` ${JSON.stringify(payload.details)}` : '';
    throw new Error(`${payload?.error || `Request failed with status ${response.status}.`}${details}`);
  }
  return payload as T;
}

function formFromPayload(payload: Payload): FormState {
  return {
    schainEnabled: payload.integrations.schain.enabled,
    version: payload.integrations.schain.version,
    complete: String(payload.integrations.schain.complete) as '0' | '1',
    nodes: payload.integrations.schain.nodes.map((node) => ({
      id: rowId(),
      asi: node.asi,
      sid: node.sid,
      hp: String(node.hp) as '0' | '1',
      rid: node.rid ?? '',
      name: node.name ?? '',
      domain: node.domain ?? '',
    })),
    consentMode: payload.integrations.consent.mode,
  };
}

function emptyNode(): SchainNode {
  return { id: rowId(), asi: '', sid: '', hp: '1', rid: '', name: '', domain: '' };
}

export default function SupplyChainConsentPanel({ publisherId, onChanged }: Props) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await requestJson<Payload>(
        `/api/publishers/${encodeURIComponent(publisherId)}/runtime-integrations`,
      );
      setPayload(next);
      setForm(formFromPayload(next));
    } catch (requestError) {
      setPayload(null);
      setForm(null);
      setError(requestError instanceof Error ? requestError.message : 'Supply-chain settings could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [publisherId]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeNodes = useMemo(
    () => form?.nodes.filter((node) => node.asi.trim() || node.sid.trim()) ?? [],
    [form],
  );

  function updateNode(id: string, patch: Partial<SchainNode>): void {
    setForm((current) => current ? {
      ...current,
      nodes: current.nodes.map((node) => node.id === id ? { ...node, ...patch } : node),
    } : current);
  }

  async function save(): Promise<void> {
    if (!form) return;
    setSaving(true);
    setError(null);
    setMessage(null);

    if (form.schainEnabled && activeNodes.length === 0) {
      setSaving(false);
      setError('Add at least one SChain node or disable SChain.');
      return;
    }

    try {
      const next = await requestJson<Payload>(
        `/api/publishers/${encodeURIComponent(publisherId)}/runtime-integrations`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            schain: {
              enabled: form.schainEnabled,
              version: form.version.trim(),
              complete: Number(form.complete),
              nodes: activeNodes.map((node) => ({
                asi: node.asi.trim().toLowerCase(),
                sid: node.sid.trim(),
                hp: Number(node.hp),
                ...(node.rid.trim() ? { rid: node.rid.trim() } : {}),
                ...(node.name.trim() ? { name: node.name.trim() } : {}),
                ...(node.domain.trim() ? { domain: node.domain.trim().toLowerCase() } : {}),
              })),
            },
            consent: {
              mode: form.consentMode,
            },
          }),
        },
      );
      setPayload(next);
      setForm(formFromPayload(next));
      setMessage('Supply-chain and consent settings saved. Generate a new release to apply them.');
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Supply-chain settings could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="config-loading">Loading supply-chain and consent settings…</div>;

  if (!payload || !form) {
    return (
      <section className="supply-consent-page">
        <div className="supply-consent-heading">
          <div><span className="panel-kicker">OpenRTB and privacy testing</span><h2>Supply chain & consent</h2></div>
        </div>
        <div className="form-error config-error">{error || 'Supply-chain settings could not be loaded.'}</div>
        <button className="button secondary" onClick={() => void load()} type="button">Retry</button>
      </section>
    );
  }

  return (
    <section className="supply-consent-page">
      <div className="supply-consent-heading">
        <div>
          <span className="panel-kicker">OpenRTB and privacy testing</span>
          <h2>Supply chain & consent</h2>
          <p>Manage the site-level SupplyChain object and a staging-only contextual test mode for sites without a CMP.</p>
        </div>
        <button className="button secondary" onClick={() => void load()} type="button">Refresh</button>
      </div>

      {error ? <div className="form-error config-error">{error}</div> : null}
      {message ? <div className="supply-consent-success">✓ {message}</div> : null}
      {payload.inheritedFromTemplate && !payload.integrations.schain.configured ? (
        <div className="supply-consent-info">
          The values below were read from the selected generator template. Save this page once to make SChain fully controlled by the dashboard.
        </div>
      ) : null}

      <article className="supply-consent-card">
        <div className="supply-consent-card-heading">
          <div>
            <span className="panel-kicker">OpenRTB SupplyChain</span>
            <h3>SChain configuration</h3>
            <p>ASI identifies the advertising system, SID identifies the seller account and HP indicates whether the node participates in payment.</p>
          </div>
          <label className="supply-consent-switch">
            <input
              checked={form.schainEnabled}
              onChange={(event) => setForm((current) => current ? { ...current, schainEnabled: event.target.checked } : current)}
              type="checkbox"
            />
            <span>{form.schainEnabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        </div>

        <div className="supply-consent-basics">
          <label>
            <span>Version</span>
            <input
              onChange={(event) => setForm((current) => current ? { ...current, version: event.target.value } : current)}
              placeholder="1.0"
              value={form.version}
            />
          </label>
          <label>
            <span>Complete</span>
            <select
              onChange={(event) => setForm((current) => current ? { ...current, complete: event.target.value as '0' | '1' } : current)}
              value={form.complete}
            >
              <option value="1">1 · complete chain</option>
              <option value="0">0 · chain may be incomplete</option>
            </select>
          </label>
          <div className="supply-consent-summary">
            <strong>{activeNodes.length} node(s)</strong>
            <span>Nodes are sent through <code>ortb2.source.schain</code>.</span>
          </div>
        </div>

        <div className="schain-table-heading">
          <div><h4>Nodes</h4><p>ASI, SID and HP are the required fields.</p></div>
          <button
            className="button secondary"
            onClick={() => setForm((current) => current ? { ...current, nodes: [...current.nodes, emptyNode()] } : current)}
            type="button"
          >
            ＋ Node
          </button>
        </div>

        <div className="schain-node-list">
          {form.nodes.map((node, index) => (
            <div className="schain-node" key={node.id}>
              <div className="schain-node-number">{index + 1}</div>
              <label>
                <span>ASI</span>
                <input onChange={(event) => updateNode(node.id, { asi: event.target.value })} placeholder="seller.example" value={node.asi} />
              </label>
              <label>
                <span>SID</span>
                <input onChange={(event) => updateNode(node.id, { sid: event.target.value })} placeholder="seller-account-id" value={node.sid} />
              </label>
              <label>
                <span>HP</span>
                <select onChange={(event) => updateNode(node.id, { hp: event.target.value as '0' | '1' })} value={node.hp}>
                  <option value="1">1</option>
                  <option value="0">0</option>
                </select>
              </label>
              <label>
                <span>RID · optional</span>
                <input onChange={(event) => updateNode(node.id, { rid: event.target.value })} value={node.rid} />
              </label>
              <label>
                <span>Name · optional</span>
                <input onChange={(event) => updateNode(node.id, { name: event.target.value })} value={node.name} />
              </label>
              <label>
                <span>Domain · optional</span>
                <input onChange={(event) => updateNode(node.id, { domain: event.target.value })} value={node.domain} />
              </label>
              <button
                aria-label={`Remove SChain node ${index + 1}`}
                className="schain-remove"
                onClick={() => setForm((current) => current ? { ...current, nodes: current.nodes.filter((candidate) => candidate.id !== node.id) } : current)}
                type="button"
              >
                ×
              </button>
            </div>
          ))}
          {!form.nodes.length ? <div className="supply-consent-empty">No SChain nodes. Add a node or leave SChain disabled.</div> : null}
        </div>
      </article>

      <article className="supply-consent-card consent-test-card">
        <div className="supply-consent-card-heading">
          <div>
            <span className="panel-kicker">Consent behavior</span>
            <h3>CMP mode</h3>
            <p>Standard mode uses the CMP. Contextual test mode is only for controlled staging diagnostics.</p>
          </div>
        </div>

        <div className="consent-mode-options">
          <label className={form.consentMode === 'cmp' ? 'selected' : ''}>
            <input
              checked={form.consentMode === 'cmp'}
              name="consent-mode"
              onChange={() => setForm((current) => current ? { ...current, consentMode: 'cmp' } : current)}
              type="radio"
            />
            <span>
              <strong>Standard CMP</strong>
              <small>Wait for the configured CMP and keep the existing consent-management flow.</small>
            </span>
          </label>
          <label className={`contextual-test ${form.consentMode === 'contextual-test' ? 'selected' : ''}`}>
            <input
              checked={form.consentMode === 'contextual-test'}
              name="consent-mode"
              onChange={() => setForm((current) => current ? { ...current, consentMode: 'contextual-test' } : current)}
              type="radio"
            />
            <span>
              <strong>Contextual test without CMP</strong>
              <small>Bypasses the CMP wait, disables Prebid device access and user sync, and forces non-personalized GPT behavior.</small>
            </span>
          </label>
        </div>

        {form.consentMode === 'contextual-test' ? (
          <div className="consent-test-warning">
            <strong>Testing only · staging channel</strong>
            <span>This mode cannot be published to production. It helps confirm that Prebid can make contextual requests when a CMP is absent; bidder policies can still limit demand.</span>
          </div>
        ) : null}
      </article>

      <div className="supply-consent-actions">
        <button className="button secondary" disabled={saving} onClick={() => void load()} type="button">Reset</button>
        <button className="button primary" disabled={saving} onClick={() => void save()} type="button">
          {saving ? 'Saving…' : 'Save supply & consent'}
        </button>
      </div>
    </section>
  );
}
