import { useCallback, useEffect, useState } from 'react';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
};

type ModePayload = {
  ok: true;
  revision: string;
  bidCacheAvailable: boolean;
  /** Positions of this site that may reuse bids; overrides for other codes are not applied. */
  bidCachePositions: string[];
  /** The first script version that applies bid caching. */
  bidCacheRuntimeVersion: string;
  /** The version to select for bid caching, such as "3.24.0 (Preview)"; empty when none applies it with the saved options. */
  bidCacheScriptVersion: string;
  runtimeSupportsBidCache: boolean;
  namedScriptLibrary: boolean;
  /** Positions of the reviewed named-script inventory; empty when the site has no named-script library. */
  namedScriptPositions: string[];
  prebidMode: {
    enabled: boolean;
    mode: 'gam-prebid' | 'gam-adx-only';
    bidCache: {enabled: boolean; maxBidAgeSeconds: number; positionOverrides?:Record<string,boolean>};
  };
  savedState: {
    bidders: number;
    enabledBidders: number;
    overrides: number;
    currentPrebidBuild: {
      id: string;
      version: string;
      uploadedAt: string;
    } | null;
  };
  releaseBehavior: {
    requiresPrebidBuild: boolean;
    includesBidderAuctions: boolean;
    includesUserIdModules: boolean;
    implementationLoadsPrebidJs: boolean;
  };
};

type ErrorPayload = {
  error?: string;
  details?: unknown;
};

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text();
  let payload: (T & ErrorPayload) | null = null;
  try {
    payload = text ? (JSON.parse(text) as T & ErrorPayload) : null;
  } catch {
    throw new Error(text || `Request failed with status ${response.status}.`);
  }
  if (!response.ok) {
    const details = payload?.details ? ` ${JSON.stringify(payload.details)}` : '';
    throw new Error(`${payload?.error || `Request failed with status ${response.status}.`}${details}`);
  }
  return payload as T;
}

export default function PrebidModePanel({ publisherId, onChanged }: Props) {
  const [payload, setPayload] = useState<ModePayload | null>(null);
  const [selected, setSelected] = useState<boolean>(true);
  const [cacheEnabled, setCacheEnabled] = useState(false);
  const [maxAge, setMaxAge] = useState('60');
  const [dropUnused, setDropUnused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const next = await requestJson<ModePayload>(
        `/api/publishers/${encodeURIComponent(publisherId)}/prebid-mode`,
      );
      setPayload(next);
      setSelected(next.prebidMode.enabled);
      setCacheEnabled(next.prebidMode.bidCache.enabled);
      setMaxAge(String(next.prebidMode.bidCache.maxBidAgeSeconds));
      setDropUnused(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Demand mode could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [publisherId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const next = await requestJson<ModePayload>(
        `/api/publishers/${encodeURIComponent(publisherId)}/prebid-mode`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: selected, revision: payload!.revision, bidCache: {
            enabled: cacheEnabled, maxBidAgeSeconds: Number(maxAge),
            ...(Object.keys(savedOverrides).length ? { positionOverrides: savedOverrides } : {}),
          } }),
        },
      );
      setPayload(next);
      setSelected(next.prebidMode.enabled);
      setCacheEnabled(next.prebidMode.bidCache.enabled);
      setMaxAge(String(next.prebidMode.bidCache.maxBidAgeSeconds));
      setDropUnused(false);
      const cacheSaved = next.prebidMode.bidCache.enabled || Object.values(next.prebidMode.bidCache.positionOverrides ?? {}).some(Boolean);
      setMessage(
        !next.prebidMode.enabled
          ? 'AdX-only mode is enabled. Bidder, override and User ID settings remain saved but are omitted from releases.'
          : cacheSaved && !next.runtimeSupportsBidCache
            ? next.namedScriptLibrary
              ? `Prebid settings saved. New named scripts use them; select a compatible script in Script setup before you generate packages.`
              : `Prebid settings saved. Select a compatible script in Script setup before you generate; your bid cache settings are kept.`
            : 'Prebid settings saved. Generate a new script version to use these settings.',
      );
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Demand mode could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  const dirty = payload ? dropUnused || selected !== payload.prebidMode.enabled || cacheEnabled !== payload.prebidMode.bidCache.enabled || Number(maxAge) !== payload.prebidMode.bidCache.maxBidAgeSeconds : false;
  const validAge = Number.isInteger(Number(maxAge)) && Number(maxAge) >= 1 && Number(maxAge) <= 300;
  function reset() { if (payload) { setSelected(payload.prebidMode.enabled); setCacheEnabled(payload.prebidMode.bidCache.enabled); setMaxAge(String(payload.prebidMode.bidCache.maxBidAgeSeconds)); setDropUnused(false); } }
  const build = payload?.savedState.currentPrebidBuild;
  const positionOverrides=payload?.prebidMode.bidCache.positionOverrides??{};
  // Overrides for codes that are no longer eligible positions are kept but not applied.
  const applied=Object.entries(positionOverrides).filter(([code])=>payload?.bidCachePositions.includes(code));
  const unused=Object.entries(positionOverrides).filter(([code])=>!payload?.bidCachePositions.includes(code));
  const savedOverrides=dropUnused?Object.fromEntries(applied):positionOverrides;
  const hasCache=cacheEnabled||applied.some(([,on])=>on);
  const cacheScript=payload?.bidCacheScriptVersion?`script ${payload.bidCacheScriptVersion}`:'a compatible script';
  // Saved settings that would reuse bids (the site default, or a position override on).
  const savedCache=!!payload&&(payload.prebidMode.bidCache.enabled||Object.values(positionOverrides).some(Boolean));

  return (
    <section className="prebid-mode-page">
      <div className="config-toolbar">
        <div>
          <span className="panel-kicker">Demand architecture</span>
          <h2>Choose how this site requests ads</h2>
          <p>
            The choice is saved per site. Turning Prebid off never deletes bidder params, overrides, User ID modules or
            uploaded Prebid builds.
          </p>
        </div>
        <span className={selected ? 'prebid-mode-pill enabled' : 'prebid-mode-pill adx-only'}>
          {selected ? 'GAM + PREBID' : 'GAM / ADX ONLY'}
        </span>
      </div>

      {error ? <div className="form-error config-error">{error}</div> : null}
      {message ? <div className="prebid-mode-message">✓ {message}</div> : null}
      {loading ? <div className="config-loading">Loading Prebid settings…</div> : null}
      {!loading && error ? <button className="button secondary" type="button" disabled={saving} onClick={() => void load()}>Reload Prebid settings</button> : null}

      {!loading && payload ? (
        <>
          <div className="prebid-mode-options" role="radiogroup" aria-label="Demand mode">
            <label className={selected ? 'selected' : ''}>
              <input
                disabled={saving}
                checked={selected}
                name="prebid-mode"
                onChange={() => setSelected(true)}
                type="radio"
              />
              <div>
                <span className="panel-kicker">Header bidding</span>
                <h3>Google Ad Manager / AdX + Prebid</h3>
                <p>Generate bidder auctions, bidder targeting, User ID configuration and the Prebid.js implementation tag.</p>
                <ul>
                  <li>A current Prebid.js build is required.</li>
                  <li>Only checked / enabled bidders enter generated auctions.</li>
                  <li>Required bidder and User ID modules are validated before release.</li>
                </ul>
              </div>
            </label>

            <label className={!selected ? 'selected adx-only' : 'adx-only'}>
              <input
                disabled={saving}
                checked={!selected}
                name="prebid-mode"
                onChange={() => { setSelected(false); if (!validAge) setMaxAge(String(payload.prebidMode.bidCache.maxBidAgeSeconds)); }}
                type="radio"
              />
              <div>
                <span className="panel-kicker">No header bidding</span>
                <h3>Google Ad Manager / AdX only</h3>
                <p>Generate the same GPT slots, responsive maps, lazy loading and refresh logic without a Prebid auction.</p>
                <ul>
                  <li>No current Prebid.js build is required.</li>
                  <li>Generated ads.js sets ENABLE_PREBID to false.</li>
                  <li>The implementation export omits the Prebid.js script tag.</li>
                  <li>Saved bidder and User ID settings remain available for later reactivation.</li>
                </ul>
              </div>
            </label>
          </div>

          {selected ? <fieldset className="prebid-cache-settings" disabled={saving}>
            <legend>Bid caching</legend>
            <label className="prebid-cache-toggle">
              <input type="checkbox" checked={cacheEnabled} onChange={e => { setCacheEnabled(e.target.checked); if (!e.target.checked && !validAge) setMaxAge(String(payload.prebidMode.bidCache.maxBidAgeSeconds)); }} />
              Reuse valid, unused bids
            </label>
            <p>Site default: {cacheEnabled ? 'new auctions with valid, unused cached bids also allowed.' : 'current auction only.'} Each refresh starts a new auction.</p>
            {applied.length?<p>Position overrides: {applied.map(([code,on])=>`${code}: ${on?'On':'Off'}`).join(' · ')}. Change these under Ad units → Bid cache.</p>:null}
            {unused.length&&!dropUnused?<div className="prebid-cache-unused">
              <p>Not applied: {unused.map(([code,on])=>`${code}: ${on?'On':'Off'}`).join(' · ')}. No ad unit with {unused.length===1?'this code':'these codes'} can reuse bids now.</p>
              <button className="button secondary" type="button" onClick={() => setDropUnused(true)}>Remove unused overrides</button>
            </div>:null}
            {unused.length&&dropUnused?<p>{unused.length===1?'The unused override is':'Unused overrides are'} removed when you save.</p>:null}
            {hasCache ? <label className="prebid-cache-age">Maximum bid age (seconds)
              <input aria-label="Maximum bid age (seconds)" type="number" min={1} max={300} step={1} required value={maxAge} onChange={e => setMaxAge(e.target.value)} />
              <span>A bid may expire sooner according to its original TTL.</span>
              {!validAge ? <span role="alert">Enter a whole number from 1 to 300.</span> : null}
            </label> : null}
            <p>{payload.runtimeSupportsBidCache ? 'Applies to new packages generated with the selected script.' : savedCache ? `Select ${cacheScript} in Script setup to apply bid caching.${dirty ? '' : ' Your setting is saved.'}` : `Bid caching needs ${cacheScript}.`}{payload.namedScriptLibrary ? ' New named scripts in Releases → Scripts and A/B tests use it too; saved scripts and tests keep their own settings.' : ''}</p>
          </fieldset> : <p>Bid caching is inactive while Prebid is off. Its saved settings are kept.</p>}

          <div className="prebid-mode-state-grid">
            <div><strong>{payload?.savedState.bidders ?? 0}</strong><span>Saved bidders</span></div>
            <div><strong>{payload?.savedState.enabledBidders ?? 0}</strong><span>Bidder checkboxes on</span></div>
            <div><strong>{payload?.savedState.overrides ?? 0}</strong><span>Saved overrides</span></div>
            <div>
              <strong>{build?.version ?? 'None'}</strong>
              <span>Current Prebid build</span>
            </div>
          </div>

          {!selected && (payload?.savedState.bidders ?? 0) > 0 ? (
            <div className="prebid-mode-preserved">
              <strong>Configuration preserved</strong>
              <span>
                {payload?.savedState.bidders ?? 0} bidder(s) and {payload?.savedState.overrides ?? 0} override(s) remain in D1,
                but the AdX-only release compiler ignores them.
              </span>
            </div>
          ) : null}

          <div className="prebid-mode-actions">
            <button className="button secondary" disabled={saving || !dirty} onClick={reset} type="button">
              Reset
            </button>
            <button className="button primary" disabled={saving || !dirty || !validAge} onClick={() => void save()} type="button">
              {saving ? 'Saving…' : 'Save Prebid settings'}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
