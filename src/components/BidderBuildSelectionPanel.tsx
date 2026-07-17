import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Bidder } from '../shared/types';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
};

export default function BidderBuildSelectionPanel({ publisherId, onChanged }: Props) {
  const [bidders, setBidders] = useState<Bidder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyBidderId, setBusyBidderId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const items = await api.listBidders(publisherId);
      setBidders(items.sort((a, b) => a.bidder.localeCompare(b.bidder)));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Bidder build selection could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [publisherId]);

  useEffect(() => {
    void load();
  }, [load]);

  const includedCount = useMemo(() => bidders.filter((bidder) => bidder.enabled).length, [bidders]);
  const excludedCount = bidders.length - includedCount;

  async function toggleBidder(bidder: Bidder) {
    const nextEnabled = !bidder.enabled;
    setBusyBidderId(bidder.id);
    setError(null);
    setMessage(null);

    try {
      await api.updateBidder(publisherId, bidder.id, { enabled: nextEnabled });
      setBidders((current) =>
        current.map((item) => (item.id === bidder.id ? { ...item, enabled: nextEnabled } : item)),
      );
      setMessage(
        nextEnabled
          ? `${bidder.bidder} will be included in the next generated ads.js.`
          : `${bidder.bidder} is saved, but excluded from the next generated ads.js.`,
      );
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Bidder build selection could not be changed.');
    } finally {
      setBusyBidderId(null);
    }
  }

  async function setAll(enabled: boolean) {
    const changed = bidders.filter((bidder) => bidder.enabled !== enabled);
    if (!changed.length) return;

    if (!enabled) {
      const confirmed = window.confirm(
        'Exclude all bidders from the next generated ads.js? Their params and overrides will remain saved.',
      );
      if (!confirmed) return;
    }

    setBulkBusy(true);
    setError(null);
    setMessage(null);
    try {
      await Promise.all(
        changed.map((bidder) => api.updateBidder(publisherId, bidder.id, { enabled })),
      );
      setBidders((current) => current.map((bidder) => ({ ...bidder, enabled })));
      setMessage(
        enabled
          ? 'All saved bidders will be included in the next generated ads.js.'
          : 'All bidders remain saved, but are excluded from the next generated ads.js.',
      );
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Bulk bidder selection failed.');
      await load();
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <section className="bidder-build-selection">
      <div className="bidder-build-selection-heading">
        <div>
          <span className="panel-kicker">Release composition</span>
          <h2>Choose bidders for generated ads.js</h2>
          <p>
            Turning a bidder off does not delete it. Base params, IDs and every override remain saved in D1, while the
            bidder is omitted from generated auctions and no longer required in the next Prebid.js build.
          </p>
        </div>
        <div className="bidder-build-selection-actions">
          <button disabled={loading || bulkBusy || !bidders.length} onClick={() => void setAll(true)} type="button">
            Include all
          </button>
          <button
            className="exclude"
            disabled={loading || bulkBusy || !bidders.length}
            onClick={() => void setAll(false)}
            type="button"
          >
            Exclude all
          </button>
        </div>
      </div>

      <div className="bidder-build-selection-summary">
        <div><strong>{bidders.length}</strong><span>Saved bidders</span></div>
        <div><strong>{includedCount}</strong><span>Included in build</span></div>
        <div><strong>{excludedCount}</strong><span>Saved only</span></div>
      </div>

      {error ? <div className="form-error config-error">{error}</div> : null}
      {message ? <div className="bidder-build-selection-message">✓ {message}</div> : null}
      {loading ? <div className="config-loading">Loading bidder build selection…</div> : null}

      {!loading ? (
        <div className="bidder-build-checklist">
          {bidders.map((bidder) => {
            const busy = bulkBusy || busyBidderId === bidder.id;
            return (
              <label className={bidder.enabled ? 'included' : 'excluded'} key={bidder.id}>
                <input
                  checked={bidder.enabled}
                  disabled={busy}
                  onChange={() => void toggleBidder(bidder)}
                  type="checkbox"
                />
                <span className="bidder-build-name">{bidder.bidder}</span>
                <span className="bidder-build-overrides">{bidder.overrides.length} override(s)</span>
                <strong>{busy ? 'Saving…' : bidder.enabled ? 'IN GENERATED ADS.JS' : 'SAVED · EXCLUDED'}</strong>
              </label>
            );
          })}

          {!bidders.length ? (
            <div className="bidder-build-empty">No bidders are saved on this site yet.</div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
