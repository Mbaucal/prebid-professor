import { normalizeBidderAccount } from '../../shared/bidder-accounts/settings.mjs';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { versionChoice } from '../site-workspace/runtime-labels';
import DealsPanel from './DealsPanel';
import type {
  AdUnit,
  Bidder,
  BidderOverride,
  BidderOverrideScope,
  JsonObject,
} from '../shared/types';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
};

type BidderMode = 'create' | 'edit' | 'duplicate';
type OverrideMode = 'create' | 'edit' | 'duplicate';

type BidderFormState = {
  bidder: string;
  baseAdapter: string;
  displayName: string;
  schainMode: 'inherit' | 'custom' | 'none';
  schainText: string;
  paramsText: string;
  enabled: boolean;
  copyOverrides: boolean;
};

type OverrideFormState = {
  scopeType: BidderOverrideScope;
  scopeKey: string;
  paramsText: string;
  enabled: boolean;
};

const emptyBidderForm: BidderFormState = {
  bidder: '',
  baseAdapter: '',
  displayName: '',
  schainMode: 'inherit',
  schainText: JSON.stringify({ver:'1.0',complete:1,nodes:[]}, null, 2),
  paramsText: '{}',
  enabled: true,
  copyOverrides: true,
};

const emptyOverrideForm: OverrideFormState = {
  scopeType: 'adunit',
  scopeKey: '',
  paramsText: '{}',
  enabled: true,
};

const idKeys = [
  'mid',
  'inv',
  'mname',
  'networkId',
  'siteId',
  'zoneId',
  'unit',
  'delDomain',
  'publisherId',
  'adSlot',
  'placementId',
  'pageId',
  'pid',
  'supplyType',
  'assetKey',
  'adUnitId',
  'accountId',
  'region',
  'partner',
  'pubId',
];

function requestErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (!(error instanceof ApiError) || error.status >= 500) return error.message;
  const details = typeof error.details === 'string' ? error.details : Array.isArray(error.details) ? error.details.filter((item): item is string => typeof item === 'string').join(' · ') : '';
  return details ? `${error.message} ${details}` : error.message;
}

function prettyJson(value: JsonObject): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseObjectJson(value: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || '{}');
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object, not an array or primitive.`);
  }

  return parsed as JsonObject;
}

function isEmptyObject(value: JsonObject): boolean {
  return Object.keys(value ?? {}).length === 0;
}

function extractIds(value: JsonObject): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  idKeys.forEach((key) => {
    const item = value?.[key];
    if (item !== undefined && item !== null && item !== '') {
      result.push([key, String(item)]);
    }
  });
  return result;
}

function nextBidderCopyName(value: string): string {
  return `${value.replace(/_copy(?:_\d+)?$/, '')}_copy`;
}

function nextScopeKey(override: BidderOverride, adUnits: AdUnit[]): string {
  if (override.scopeType === 'device') {
    if (override.scopeKey === 'desktop') return 'mobile';
    if (override.scopeKey === 'mobile') return 'tablet';
    return 'desktop';
  }
  if (override.scopeType === 'slot') return override.scopeKey === 'ATF' ? 'BTF' : 'ATF';

  const currentIndex = adUnits.findIndex((unit) => unit.code === override.scopeKey);
  if (currentIndex >= 0 && adUnits[currentIndex + 1]) return adUnits[currentIndex + 1].code;
  return `${override.scopeKey}_2`;
}

function scopeOptions(scopeType: BidderOverrideScope, adUnits: AdUnit[]): string[] {
  if (scopeType === 'slot') return ['ATF', 'BTF'];
  if (scopeType === 'device') return ['desktop', 'mobile', 'tablet'];
  return adUnits.map((unit) => unit.code);
}

function IdChips({ params }: { params: JsonObject }) {
  const ids = extractIds(params);
  if (!ids.length) return <span className="muted-copy">No recognized IDs in this object.</span>;

  return (
    <div className="bidder-id-list">
      {ids.map(([key, value]) => (
        <span className="bidder-id-chip" key={`${key}-${value}`}>
          <b>{key}</b>: {value}
        </span>
      ))}
    </div>
  );
}

export default function BiddersPanel({ publisherId, onChanged }: Props) {
  const currentSite = useRef(publisherId); currentSite.current = publisherId;
  const loadSequence = useRef(0);
  const [bidders, setBidders] = useState<Bidder[]>([]);
  // Script versions that apply bidder accounts with the site's other saved options, from the server.
  const [accountScripts, setAccountScripts] = useState<string[]>([]);
  const [adUnits, setAdUnits] = useState<AdUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [bidderMode, setBidderMode] = useState<BidderMode | null>(null);
  const [bidderSource, setBidderSource] = useState<Bidder | null>(null);
  const [bidderForm, setBidderForm] = useState<BidderFormState>(emptyBidderForm);
  const [bidderFormError, setBidderFormError] = useState<string | null>(null);

  const [overrideMode, setOverrideMode] = useState<OverrideMode | null>(null);
  const [overrideBidder, setOverrideBidder] = useState<Bidder | null>(null);
  const [overrideSource, setOverrideSource] = useState<BidderOverride | null>(null);
  const [overrideForm, setOverrideForm] = useState<OverrideFormState>(emptyOverrideForm);
  const [overrideFormError, setOverrideFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const [bidderItems, unitItems] = await Promise.all([
        api.loadBidders(publisherId),
        api.listAdUnits(publisherId),
      ]);
      if (sequence !== loadSequence.current || currentSite.current !== publisherId) return;
      setBidders(bidderItems.bidders);
      setAccountScripts(bidderItems.accountScriptVersions);
      setAdUnits(unitItems);
      setError(null);
    } catch (requestError) {
      if (sequence === loadSequence.current && currentSite.current === publisherId) setError(requestErrorMessage(requestError, 'Could not load bidders.'));
    } finally {
      if (sequence === loadSequence.current && currentSite.current === publisherId) setLoading(false);
    }
  }, [publisherId]);

  useEffect(() => {
    setBidders([]); setAccountScripts([]); setAdUnits([]); setBidderMode(null); setOverrideMode(null); setSubmitting(false);
    void load();
    return () => { loadSequence.current++; };
  }, [load]);

  const summary = useMemo(
    () => ({
      total: bidders.length,
      enabled: bidders.filter((bidder) => bidder.enabled).length,
      overrides: bidders.reduce((sum, bidder) => sum + bidder.overrides.length, 0),
      overrideOnly: bidders.filter(
        (bidder) => isEmptyObject(bidder.params) && bidder.overrides.length > 0,
      ).length,
    }),
    [bidders],
  );

  function openCreateBidder() {
    setBidderMode('create');
    setBidderSource(null);
    setBidderForm(emptyBidderForm);
    setBidderFormError(null);
  }

  function openEditBidder(bidder: Bidder) {
    setBidderMode('edit');
    setBidderSource(bidder);
    setBidderForm({
      bidder: bidder.bidder,
      baseAdapter: bidder.baseAdapter ?? bidder.bidder,
      displayName: bidder.displayName ?? '',
      schainMode: bidder.schain?.mode ?? 'inherit',
      schainText: bidder.schain?.config ? JSON.stringify(bidder.schain.config, null, 2) : emptyBidderForm.schainText,
      paramsText: prettyJson(bidder.params),
      enabled: bidder.enabled,
      copyOverrides: true,
    });
    setBidderFormError(null);
  }

  function openDuplicateBidder(bidder: Bidder) {
    setBidderMode('duplicate');
    setBidderSource(bidder);
    setBidderForm({
      bidder: nextBidderCopyName(bidder.bidder),
      baseAdapter: bidder.baseAdapter ?? bidder.bidder,
      displayName: bidder.displayName ? bidder.displayName + ' copy' : '',
      schainMode: bidder.schain?.mode ?? 'inherit',
      schainText: bidder.schain?.config ? JSON.stringify(bidder.schain.config, null, 2) : emptyBidderForm.schainText,
      paramsText: prettyJson(bidder.params),
      enabled: bidder.enabled,
      copyOverrides: true,
    });
    setBidderFormError(null);
  }

  function closeBidderForm() {
    if (submitting) return;
    setBidderMode(null);
    setBidderSource(null);
    setBidderFormError(null);
  }

  function openCreateOverride(bidder: Bidder) {
    setOverrideMode('create');
    setOverrideBidder(bidder);
    setOverrideSource(null);
    setOverrideForm({
      ...emptyOverrideForm,
      scopeType: adUnits.length ? 'adunit' : 'device',
      scopeKey: adUnits[0]?.code ?? 'desktop',
    });
    setOverrideFormError(null);
  }

  function openEditOverride(bidder: Bidder, override: BidderOverride) {
    setOverrideMode('edit');
    setOverrideBidder(bidder);
    setOverrideSource(override);
    setOverrideForm({
      scopeType: override.scopeType,
      scopeKey: override.scopeKey,
      paramsText: prettyJson(override.params),
      enabled: override.enabled,
    });
    setOverrideFormError(null);
  }

  function openDuplicateOverride(bidder: Bidder, override: BidderOverride) {
    setOverrideMode('duplicate');
    setOverrideBidder(bidder);
    setOverrideSource(override);
    setOverrideForm({
      scopeType: override.scopeType,
      scopeKey: nextScopeKey(override, adUnits),
      paramsText: prettyJson(override.params),
      enabled: override.enabled,
    });
    setOverrideFormError(null);
  }

  function closeOverrideForm() {
    if (submitting) return;
    setOverrideMode(null);
    setOverrideBidder(null);
    setOverrideSource(null);
    setOverrideFormError(null);
  }

  async function submitBidder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBidderFormError(null);

    const bidderName = bidderForm.bidder.trim().toLowerCase();
    if (!bidderName) {
      setBidderFormError('Bidder code is required.');
      return;
    }

    let params: JsonObject;
    let account;
    try {
      account = normalizeBidderAccount({ baseAdapter: bidderForm.baseAdapter.trim() || bidderName, displayName: bidderForm.displayName, schain: {mode: bidderForm.schainMode, ...(bidderForm.schainMode === 'custom' || bidderForm.schainText.trim() !== emptyBidderForm.schainText.trim() ? {config: parseObjectJson(bidderForm.schainText, 'Custom SChain draft (select Custom SChain to correct it, or discard the draft)')} : {})} }, {bidder: bidderName});
      params = parseObjectJson(bidderForm.paramsText, 'Base params');
    } catch (formError) {
      setBidderFormError(formError instanceof Error ? formError.message : String(formError));
      return;
    }

    setSubmitting(true);
    try {
      if (bidderMode === 'duplicate' && bidderSource) {
        await api.duplicateBidder(publisherId, bidderSource.id, {
          ...account,
          bidder: bidderName,
          enabled: bidderForm.enabled,
          copyOverrides: bidderForm.copyOverrides,
        });
      } else if (bidderMode === 'edit' && bidderSource) {
        await api.updateBidder(publisherId, bidderSource.id, {
          ...account,
          expectedUpdatedAt: bidderSource.updatedAt,
          bidder: bidderName,
          params,
          enabled: bidderForm.enabled,
        });
      } else {
        await api.createBidder(publisherId, {
          ...account,
          bidder: bidderName,
          params,
          enabled: bidderForm.enabled,
        });
      }

      if (currentSite.current !== publisherId) return;
      await load();
      await onChanged?.();
      setBidderMode(null); setBidderSource(null); setBidderFormError(null);
    } catch (requestError) {
      if (currentSite.current === publisherId) setBidderFormError(requestErrorMessage(requestError, 'Bidder operation failed.'));
    } finally {
      if (currentSite.current === publisherId) setSubmitting(false);
    }
  }

  async function submitOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOverrideFormError(null);
    if (!overrideBidder) return;

    if (!overrideForm.scopeKey.trim()) {
      setOverrideFormError('Scope key is required.');
      return;
    }

    let params: JsonObject;
    try {
      params = parseObjectJson(overrideForm.paramsText, 'Override params');
    } catch (formError) {
      setOverrideFormError(formError instanceof Error ? formError.message : String(formError));
      return;
    }

    setSubmitting(true);
    try {
      if (overrideMode === 'duplicate' && overrideSource) {
        await api.duplicateBidderOverride(publisherId, overrideSource.id, {
          scopeType: overrideForm.scopeType,
          scopeKey: overrideForm.scopeKey.trim(),
          enabled: overrideForm.enabled,
        });
      } else if (overrideMode === 'edit' && overrideSource) {
        await api.updateBidderOverride(publisherId, overrideSource.id, {
          scopeType: overrideForm.scopeType,
          scopeKey: overrideForm.scopeKey.trim(),
          params,
          enabled: overrideForm.enabled,
        });
      } else {
        await api.createBidderOverride(publisherId, overrideBidder.id, {
          scopeType: overrideForm.scopeType,
          scopeKey: overrideForm.scopeKey.trim(),
          params,
          enabled: overrideForm.enabled,
        });
      }

      if (currentSite.current !== publisherId) return;
      await load();
      await onChanged?.();
      setOverrideMode(null); setOverrideBidder(null); setOverrideSource(null); setOverrideFormError(null);
    } catch (requestError) {
      if (currentSite.current === publisherId) setOverrideFormError(requestErrorMessage(requestError, 'Override operation failed.'));
    } finally {
      if (currentSite.current === publisherId) setSubmitting(false);
    }
  }

  async function removeBidder(bidder: Bidder) {
    const confirmed = window.confirm(
      `Delete ${bidder.bidder}? All ${bidder.overrides.length} connected override(s) will also be removed.`,
    );
    if (!confirmed) return;

    try {
      await api.deleteBidder(publisherId, bidder.id);
      if (currentSite.current !== publisherId) return;
      await load();
      await onChanged?.();
    } catch (requestError) {
      if (currentSite.current === publisherId) setError(requestErrorMessage(requestError, 'Could not delete bidder.'));
    }
  }

  async function removeOverride(override: BidderOverride) {
    const confirmed = window.confirm(
      `Delete ${override.bidder} ${override.scopeType} override "${override.scopeKey}"?`,
    );
    if (!confirmed) return;

    try {
      await api.deleteBidderOverride(publisherId, override.id);
      if (currentSite.current !== publisherId) return;
      await load();
      await onChanged?.();
    } catch (requestError) {
      if (currentSite.current === publisherId) setError(requestErrorMessage(requestError, 'Could not delete override.'));
    }
  }

  const currentScopeOptions = scopeOptions(overrideForm.scopeType, adUnits);

  return (
    <>
      <DealsPanel publisherId={publisherId} onChanged={onChanged}/>
      <section className="config-page bidders-page">
        <div className="config-toolbar">
          <div>
            <span className="panel-kicker">Demand configuration</span>
            <h2>Bidders & overrides</h2>
            <p>
              Base params may be empty when a bidder is configured through slot, device or exact ad-unit overrides.
            </p>
          </div>
          <button className="button primary" onClick={openCreateBidder} type="button">
            ＋ New bidder
          </button>
        </div>

        <div className="bidder-summary">
          <div><strong>{summary.total}</strong><span>Total bidders</span></div>
          <div><strong>{summary.enabled}</strong><span>Enabled</span></div>
          <div><strong>{summary.overrides}</strong><span>Overrides</span></div>
          <div><strong>{summary.overrideOnly}</strong><span>Override-only</span></div>
        </div>

        {error ? <div className="form-error config-error" role="alert">{error} <button className="button secondary" onClick={() => void load()} disabled={loading} type="button">Reload bidders</button></div> : null}
        {loading ? <div className="config-loading">Loading bidders from D1…</div> : null}

        <div className="bidder-grid">
          {bidders.map((bidder) => {
            const baseEmpty = isEmptyObject(bidder.params);
            const validViaOverride = baseEmpty && bidder.overrides.length > 0;
            const missing = baseEmpty && bidder.overrides.length === 0;

            return (
              <article className={`bidder-card${bidder.enabled ? '' : ' disabled'}`} key={bidder.id}>
                <div className="bidder-card-heading">
                  <div>
                    <code>{bidder.bidder}</code>
                    {bidder.displayName ? <strong>{bidder.displayName}</strong> : null}
                    <span>Adapter: {bidder.baseAdapter ?? bidder.bidder} · SChain: {bidder.schain?.mode === 'none' ? 'No upstream chain' : bidder.schain?.mode === 'custom' ? 'Custom' : 'Site chain'}</span>
                    <span>{bidder.overrides.length} override(s)</span>
                  </div>
                  <div className="bidder-status-stack">
                    <span className={bidder.enabled ? 'unit-state enabled' : 'unit-state'}>
                      {bidder.enabled ? 'enabled' : 'disabled'}
                    </span>
                    <span className={missing ? 'config-health missing' : 'config-health ok'}>
                      {missing ? 'Missing params' : validViaOverride ? 'OK via override' : 'Global params'}
                    </span>
                  </div>
                </div>

                <div className="bidder-base-block">
                  <div className="bidder-block-title">Base params</div>
                  <IdChips params={bidder.params} />
                  <details>
                    <summary>View JSON</summary>
                    <pre>{prettyJson(bidder.params)}</pre>
                  </details>
                </div>

                <div className="bidder-overrides-heading">
                  <div>
                    <strong>Overrides</strong>
                    <span>slot · device · adunit</span>
                  </div>
                  <button onClick={() => openCreateOverride(bidder)} type="button">＋ Add override</button>
                </div>

                <div className="override-list">
                  {bidder.overrides.map((override) => (
                    <div className={`override-card${override.enabled ? '' : ' disabled'}`} key={override.id}>
                      <div className="override-heading">
                        <div>
                          <span className={`scope-badge ${override.scopeType}`}>{override.scopeType}</span>
                          <code>{override.scopeKey}</code>
                        </div>
                        <span className={override.enabled ? 'mini-state enabled' : 'mini-state'}>
                          {override.enabled ? 'on' : 'off'}
                        </span>
                      </div>
                      <IdChips params={override.params} />
                      <details>
                        <summary>View JSON</summary>
                        <pre>{prettyJson(override.params)}</pre>
                      </details>
                      <div className="override-actions">
                        <button onClick={() => openEditOverride(bidder, override)} type="button">Edit</button>
                        <button onClick={() => openDuplicateOverride(bidder, override)} type="button">Duplicate</button>
                        <button className="danger-link" onClick={() => void removeOverride(override)} type="button">
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}

                  {!bidder.overrides.length ? (
                    <button className="empty-override" onClick={() => openCreateOverride(bidder)} type="button">
                      ＋ Add first override
                    </button>
                  ) : null}
                </div>

                <div className="ad-unit-actions bidder-actions">
                  <button onClick={() => openEditBidder(bidder)} type="button">Edit bidder</button>
                  <button onClick={() => openDuplicateBidder(bidder)} type="button">Duplicate</button>
                  <button className="danger-link" onClick={() => void removeBidder(bidder)} type="button">
                    Delete
                  </button>
                </div>
              </article>
            );
          })}

          {!loading && !bidders.length ? (
            <button className="empty-bidder-card" onClick={openCreateBidder} type="button">
              <strong>＋ Add first bidder</strong>
              <span>Configure global params or add override-only integrations such as Ogury and RichAudience.</span>
            </button>
          ) : null}
        </div>
      </section>

      {bidderMode ? (
        <div className="modal-backdrop" onMouseDown={closeBidderForm} role="presentation">
          <section
            aria-labelledby="bidder-form-title"
            aria-modal="true"
            className="modal-card bidder-modal"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-heading">
              <div>
                <span className="panel-kicker">Bidder workflow</span>
                <h2 id="bidder-form-title">
                  {bidderMode === 'create'
                    ? 'Create bidder'
                    : bidderMode === 'duplicate'
                      ? `Duplicate ${bidderSource?.bidder ?? 'bidder'}`
                      : `Edit ${bidderSource?.bidder ?? 'bidder'}`}
                </h2>
              </div>
              <button className="icon-button" onClick={closeBidderForm} type="button">×</button>
            </div>

            <form className="publisher-form" onSubmit={submitBidder}>
              <label>
                <span>Bidder code</span>
                <input
                  autoFocus
                  onChange={(event) =>
                    setBidderForm((current) => ({ ...current, bidder: event.target.value.toLowerCase() }))
                  }
                  placeholder="openx"
                  value={bidderForm.bidder}
                />
                <small>Exact account code used in auctions and GAM targeting. For another Adform account, use a distinct code such as adf_agency.</small>
              </label>


              <div className="form-grid-two">
                <label><span>Base adapter</span><input aria-label="Base adapter" value={bidderForm.baseAdapter} placeholder={bidderForm.bidder || 'adf'} onChange={event => setBidderForm(current => ({...current, baseAdapter: event.target.value.toLowerCase()}))}/><small>Original Prebid adapter code, for example adf. Leave blank to use the bidder code above. Different codes register this account as an alias.</small></label>
                <label><span>Account name</span><input aria-label="Account name" maxLength={100} value={bidderForm.displayName} placeholder="Agency account" onChange={event => setBidderForm(current => ({...current, displayName: event.target.value}))}/><small>Internal label only.</small></label>
              </div>
              <label><span>Account SChain</span><select aria-label="Account SChain" value={bidderForm.schainMode} onChange={event => setBidderForm(current => ({...current, schainMode:event.target.value as BidderFormState['schainMode']}))}>
                <option value="inherit">Use site SChain</option><option value="custom">Custom SChain</option><option value="none">No upstream SChain (direct publisher path)</option>
              </select><small>{bidderForm.schainMode === 'none' ? 'The wrapper adds no site or intermediary node for this account. The exchange may build its own downstream chain. Use this only when that is the actual selling path.' : bidderForm.schainMode === 'custom' ? 'This complete account-specific configuration replaces the site chain for this account. Use the verified seller IDs in payment order.' : 'This account receives the saved site chain.'}</small></label>
              {bidderForm.schainText.trim() !== emptyBidderForm.schainText.trim() ? <div className="form-options"><p>Custom values are kept when you choose another SChain mode. Invalid custom drafts must be corrected or discarded before saving.</p><button className="button secondary" type="button" disabled={submitting} onClick={() => setBidderForm(current => ({...current, schainText:emptyBidderForm.schainText}))}>Discard custom draft</button></div> : null}
              {bidderForm.schainMode === 'custom' ? <label><span>Custom SChain JSON</span><textarea className="json-textarea" aria-label="Custom SChain JSON" spellCheck={false} value={bidderForm.schainText} onChange={event => setBidderForm(current => ({...current, schainText:event.target.value}))}/><small>Version, completeness and ordered seller nodes. Include only the verified selling path for this account.</small></label> : null}
              <p className="muted-copy">{accountScripts.length ? `Aliases and account-specific SChain require script ${versionChoice(accountScripts)}. Save the account, then explicitly select ${accountScripts.length > 1 ? 'one of these versions' : 'that version'} in Script setup and generate a new package.` : 'Aliases and account-specific SChain require a script version that applies bidder accounts with your other saved options.'} Existing scripts keep their saved settings.</p>

              {bidderMode !== 'duplicate' ? (
                <label>
                  <span>Base params JSON</span>
                  <textarea
                    className="json-textarea"
                    onChange={(event) =>
                      setBidderForm((current) => ({ ...current, paramsText: event.target.value }))
                    }
                    spellCheck={false}
                    value={bidderForm.paramsText}
                  />
                  <small>Use an object such as {`{"siteId":123}`}. Empty object is allowed when overrides exist.</small>
                </label>
              ) : (
                <div className="form-options">
                  <label className="check-row">
                    <input
                      checked={bidderForm.copyOverrides}
                      onChange={(event) =>
                        setBidderForm((current) => ({ ...current, copyOverrides: event.target.checked }))
                      }
                      type="checkbox"
                    />
                    <span>Copy all slot, device and ad-unit overrides</span>
                  </label>
                  <p>Base params and the selected SChain settings are copied. The base adapter must be present in the uploaded Prebid build; the new account alias is registered by {accountScripts.length ? `script ${versionChoice(accountScripts)}` : 'a script version that applies bidder accounts'}. Review partner IDs before enabling this account.</p>
                </div>
              )}

              <label className="check-row standalone-check">
                <input
                  checked={bidderForm.enabled}
                  onChange={(event) =>
                    setBidderForm((current) => ({ ...current, enabled: event.target.checked }))
                  }
                  type="checkbox"
                />
                <span>Enabled</span>
              </label>

              {bidderFormError ? <div className="form-error" role="alert">{bidderFormError}{bidderMode === 'edit' && bidderSource ? <button className="button secondary" type="button" disabled={submitting} onClick={async () => {
                setSubmitting(true);
                try { const saved = (await api.listBidders(publisherId)).find(row => row.id === bidderSource.id); if (currentSite.current !== publisherId) return; if (!saved) throw new Error('This account no longer exists. Close this form and reload bidders.'); openEditBidder(saved); }
                catch (reloadError) { if (currentSite.current === publisherId) setBidderFormError(requestErrorMessage(reloadError, 'Could not reload this account.')); }
                finally { if (currentSite.current === publisherId) setSubmitting(false); }
              }}>Reload saved account (discard edits)</button> : null}</div> : null}

              <div className="modal-actions">
                <button className="button secondary" disabled={submitting} onClick={closeBidderForm} type="button">
                  Cancel
                </button>
                <button className="button primary" disabled={submitting} type="submit">
                  {submitting
                    ? 'Saving…'
                    : bidderMode === 'duplicate'
                      ? 'Duplicate bidder'
                      : bidderMode === 'edit'
                        ? 'Save bidder'
                        : 'Create bidder'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {overrideMode && overrideBidder ? (
        <div className="modal-backdrop" onMouseDown={closeOverrideForm} role="presentation">
          <section
            aria-labelledby="override-form-title"
            aria-modal="true"
            className="modal-card bidder-modal"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-heading">
              <div>
                <span className="panel-kicker">{overrideBidder.bidder} override</span>
                <h2 id="override-form-title">
                  {overrideMode === 'create'
                    ? 'Create override'
                    : overrideMode === 'duplicate'
                      ? `Duplicate ${overrideSource?.scopeKey ?? 'override'}`
                      : `Edit ${overrideSource?.scopeKey ?? 'override'}`}
                </h2>
              </div>
              <button className="icon-button" onClick={closeOverrideForm} type="button">×</button>
            </div>

            <form className="publisher-form" onSubmit={submitOverride}>
              <div className="form-grid-two">
                <label>
                  <span>Scope type</span>
                  <select
                    onChange={(event) => {
                      const scopeType = event.target.value as BidderOverrideScope;
                      const options = scopeOptions(scopeType, adUnits);
                      setOverrideForm((current) => ({
                        ...current,
                        scopeType,
                        scopeKey: options[0] ?? '',
                      }));
                    }}
                    value={overrideForm.scopeType}
                  >
                    <option value="slot">slot</option>
                    <option value="device">device</option>
                    <option value="adunit">adunit</option>
                  </select>
                </label>

                <label>
                  <span>Scope key</span>
                  <input
                    list="override-scope-options"
                    onChange={(event) =>
                      setOverrideForm((current) => ({ ...current, scopeKey: event.target.value }))
                    }
                    placeholder={overrideForm.scopeType === 'adunit' ? 'Billboard' : 'desktop'}
                    value={overrideForm.scopeKey}
                  />
                  <datalist id="override-scope-options">
                    {currentScopeOptions.map((item) => <option key={item} value={item} />)}
                  </datalist>
                </label>
              </div>

              {overrideMode !== 'duplicate' ? (
                <label>
                  <span>Override params JSON</span>
                  <textarea
                    className="json-textarea"
                    onChange={(event) =>
                      setOverrideForm((current) => ({ ...current, paramsText: event.target.value }))
                    }
                    spellCheck={false}
                    value={overrideForm.paramsText}
                  />
                </label>
              ) : (
                <div className="form-options">
                  <p>Params are copied exactly from the source override. Change the scope to target another device, group or ad unit.</p>
                </div>
              )}

              <label className="check-row standalone-check">
                <input
                  checked={overrideForm.enabled}
                  onChange={(event) =>
                    setOverrideForm((current) => ({ ...current, enabled: event.target.checked }))
                  }
                  type="checkbox"
                />
                <span>Enabled</span>
              </label>

              {overrideFormError ? <div className="form-error">{overrideFormError}</div> : null}

              <div className="modal-actions">
                <button className="button secondary" disabled={submitting} onClick={closeOverrideForm} type="button">
                  Cancel
                </button>
                <button className="button primary" disabled={submitting} type="submit">
                  {submitting
                    ? 'Saving…'
                    : overrideMode === 'duplicate'
                      ? 'Duplicate override'
                      : overrideMode === 'edit'
                        ? 'Save override'
                        : 'Create override'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  );
}
