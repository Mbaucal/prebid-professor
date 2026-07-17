import { useCallback, useEffect, useState } from 'react';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
};

type ModePayload = {
  ok: true;
  prebidMode: {
    enabled: boolean;
    mode: 'gam-prebid' | 'gam-adx-only';
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await requestJson<ModePayload>(
        `/api/publishers/${encodeURIComponent(publisherId)}/prebid-mode`,
      );
      setPayload(next);
      setSelected(next.prebidMode.enabled);
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
          body: JSON.stringify({ enabled: selected }),
        },
      );
      setPayload(next);
      setSelected(next.prebidMode.enabled);
      setMessage(
        next.prebidMode.enabled
          ? 'Prebid is enabled. Releases require a valid current Prebid.js build.'
          : 'AdX-only mode is enabled. Bidder, override and User ID settings remain saved but are omitted from releases.',
      );
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Demand mode could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  const dirty = payload ? selected !== payload.prebidMode.enabled : false;
  const build = payload?.savedState.currentPrebidBuild;

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
      {loading ? <div className="config-loading">Loading demand mode from D1…</div> : null}

      {!loading ? (
        <>
          <div className="prebid-mode-options" role="radiogroup" aria-label="Demand mode">
            <label className={selected ? 'selected' : ''}>
              <input
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
                checked={!selected}
                name="prebid-mode"
                onChange={() => setSelected(false)}
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
            <button className="button secondary" disabled={saving || !dirty} onClick={() => {
              if (payload) setSelected(payload.prebidMode.enabled);
            }} type="button">
              Reset
            </button>
            <button className="button primary" disabled={saving || !dirty} onClick={() => void save()} type="button">
              {saving ? 'Saving…' : selected ? 'Enable Prebid for this site' : 'Use AdX-only mode'}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
