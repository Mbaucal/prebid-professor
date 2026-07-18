import { useCallback, useEffect, useMemo, useState } from 'react';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
};

type AdUnitReference = {
  code: string;
  type: string;
  enabled: boolean;
};

type BidderReference = {
  bidder: string;
  enabled: boolean;
};

type RuntimeControls = {
  sticky: {
    bottomAdUnitId: string | null;
    topAdUnitId: string | null;
    allowClosePortal: boolean;
  };
  floors: {
    enabled: boolean;
    currency: string;
    hardFloor: number;
    bidderFloors: Record<string, number>;
    rules: Record<string, number>;
  };
  output: {
    cleanComments: boolean;
  };
};

type RuntimeControlsPayload = {
  ok: true;
  controls: RuntimeControls;
  adUnits: AdUnitReference[];
  bidders: BidderReference[];
  floorRuleSchema: {
    delimiter: string;
    fields: string[];
    examples: string[];
  };
};

type FloorRuleRow = {
  id: string;
  key: string;
  value: string;
};

type FormState = {
  bottomAdUnitId: string;
  topAdUnitId: string;
  allowClosePortal: boolean;
  floorsEnabled: boolean;
  currency: string;
  hardFloor: string;
  bidderFloors: Record<string, string>;
  floorRules: FloorRuleRow[];
  cleanComments: boolean;
};

type ApiFailure = {
  error?: string;
  details?: unknown;
};

function randomId(): string {
  return `rule-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
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

function formFromPayload(payload: RuntimeControlsPayload): FormState {
  return {
    bottomAdUnitId: payload.controls.sticky.bottomAdUnitId ?? '',
    topAdUnitId: payload.controls.sticky.topAdUnitId ?? '',
    allowClosePortal: payload.controls.sticky.allowClosePortal,
    floorsEnabled: payload.controls.floors.enabled,
    currency: payload.controls.floors.currency,
    hardFloor: String(payload.controls.floors.hardFloor),
    bidderFloors: Object.fromEntries(
      Object.entries(payload.controls.floors.bidderFloors).map(([bidder, floor]) => [bidder, String(floor)]),
    ),
    floorRules: Object.entries(payload.controls.floors.rules).map(([key, value]) => ({
      id: randomId(),
      key,
      value: String(value),
    })),
    cleanComments: payload.controls.output.cleanComments,
  };
}

function numberMap(input: Record<string, string>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(input)) {
    if (!rawValue.trim()) continue;
    const value = Number(rawValue);
    if (Number.isFinite(value) && value >= 0) output[key] = value;
  }
  return output;
}

export default function RuntimeControlsPanel({ publisherId, onChanged }: Props) {
  const [payload, setPayload] = useState<RuntimeControlsPayload | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await requestJson<RuntimeControlsPayload>(
        `/api/publishers/${encodeURIComponent(publisherId)}/runtime-controls`,
      );
      setPayload(next);
      setForm(formFromPayload(next));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Runtime controls could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [publisherId]);

  useEffect(() => {
    void load();
  }, [load]);

  const orderedBidders = useMemo(
    () => [...(payload?.bidders ?? [])].sort((a, b) => a.bidder.localeCompare(b.bidder)),
    [payload],
  );

  async function save(): Promise<void> {
    if (!form) return;
    setSaving(true);
    setError(null);
    setMessage(null);

    const rules: Record<string, number> = {};
    for (const row of form.floorRules) {
      const key = row.key.trim();
      if (!key || !row.value.trim()) continue;
      const value = Number(row.value);
      if (!Number.isFinite(value) || value < 0) {
        setSaving(false);
        setError(`Floor rule "${key || 'unnamed'}" must have a non-negative numeric value.`);
        return;
      }
      rules[key] = value;
    }

    try {
      const next = await requestJson<RuntimeControlsPayload>(
        `/api/publishers/${encodeURIComponent(publisherId)}/runtime-controls`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sticky: {
              bottomAdUnitId: form.bottomAdUnitId || null,
              topAdUnitId: form.topAdUnitId || null,
              allowClosePortal: form.allowClosePortal,
            },
            floors: {
              enabled: form.floorsEnabled,
              currency: form.currency.trim().toUpperCase(),
              hardFloor: Number(form.hardFloor),
              bidderFloors: numberMap(form.bidderFloors),
              rules,
            },
            output: {
              cleanComments: form.cleanComments,
            },
          }),
        },
      );
      setPayload(next);
      setForm(formFromPayload(next));
      setMessage('Runtime controls saved. The next generated release will use these values.');
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Runtime controls could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  if (loading || !form || !payload) {
    return <div className="config-loading">Loading runtime controls…</div>;
  }

  return (
    <section className="runtime-controls-page">
      <div className="runtime-controls-heading">
        <div>
          <span className="panel-kicker">Reusable runtime behavior</span>
          <h2>Runtime controls</h2>
          <p>Choose sticky ad units, control Prebid floors and keep generated artifacts free of legacy publisher comments.</p>
        </div>
        <button className="button secondary" onClick={() => void load()} type="button">Refresh</button>
      </div>

      {error ? <div className="form-error config-error">{error}</div> : null}
      {message ? <div className="runtime-controls-message">{message}</div> : null}

      <div className="runtime-controls-grid">
        <article className="runtime-controls-card">
          <div className="runtime-controls-card-heading">
            <div>
              <span className="panel-kicker">Sticky ads</span>
              <h3>Reusable sticky positions</h3>
            </div>
          </div>

          <div className="runtime-controls-fields two-columns">
            <label>
              <span>Bottom sticky ad unit</span>
              <select
                onChange={(event) => setForm((current) => current ? { ...current, bottomAdUnitId: event.target.value } : current)}
                value={form.bottomAdUnitId}
              >
                <option value="">Disabled</option>
                {payload.adUnits.map((unit) => (
                  <option key={unit.code} value={unit.code}>
                    {unit.code}{unit.enabled ? '' : ' · disabled'}
                  </option>
                ))}
              </select>
              <small>The selected ad unit gets the generic bottom-sticky host, close button and refresh behavior.</small>
            </label>

            <label>
              <span>Top sticky ad unit</span>
              <select
                onChange={(event) => setForm((current) => current ? { ...current, topAdUnitId: event.target.value } : current)}
                value={form.topAdUnitId}
              >
                <option value="">Disabled</option>
                {payload.adUnits.map((unit) => (
                  <option key={unit.code} value={unit.code}>
                    {unit.code}{unit.enabled ? '' : ' · disabled'}
                  </option>
                ))}
              </select>
              <small>Leave empty unless a future publisher explicitly uses a top sticky position.</small>
            </label>
          </div>

          <label className="runtime-controls-check">
            <input
              checked={form.allowClosePortal}
              onChange={(event) => setForm((current) => current ? { ...current, allowClosePortal: event.target.checked } : current)}
              type="checkbox"
            />
            <span>
              <strong>Allow close-button portal fallback</strong>
              <small>Move the close button outside the ad container only when the publisher layout clips it.</small>
            </span>
          </label>
        </article>

        <article className="runtime-controls-card">
          <div className="runtime-controls-card-heading">
            <div>
              <span className="panel-kicker">Generated output</span>
              <h3>Clean release source</h3>
            </div>
          </div>

          <label className="runtime-controls-check">
            <input
              checked={form.cleanComments}
              onChange={(event) => setForm((current) => current ? { ...current, cleanComments: event.target.checked } : current)}
              type="checkbox"
            />
            <span>
              <strong>Remove legacy comments</strong>
              <small>Generated ads.js keeps one English release header and removes publisher-specific or non-English comments.</small>
            </span>
          </label>

          <div className="runtime-output-preview">
            <code>Prebid Professor generated runtime</code>
            <span>Site, release and generator profile metadata remain visible at the top of the file.</span>
          </div>
        </article>
      </div>

      <article className="runtime-controls-card runtime-controls-floors">
        <div className="runtime-controls-card-heading">
          <div>
            <span className="panel-kicker">Prebid price floors</span>
            <h3>Floor configuration</h3>
            <p>A blank bidder floor inherits the global floor. Saved rules use the Prebid schema shown below.</p>
          </div>
          <label className="runtime-controls-switch">
            <input
              checked={form.floorsEnabled}
              onChange={(event) => setForm((current) => current ? { ...current, floorsEnabled: event.target.checked } : current)}
              type="checkbox"
            />
            <span>{form.floorsEnabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        </div>

        <div className="runtime-controls-fields floor-basics">
          <label>
            <span>Ad server currency</span>
            <input
              maxLength={3}
              onChange={(event) => setForm((current) => current ? { ...current, currency: event.target.value.toUpperCase() } : current)}
              value={form.currency}
            />
          </label>
          <label>
            <span>Global hard floor</span>
            <input
              min="0"
              onChange={(event) => setForm((current) => current ? { ...current, hardFloor: event.target.value } : current)}
              step="0.01"
              type="number"
              value={form.hardFloor}
            />
          </label>
          <div className="runtime-controls-floor-note">
            <strong>{form.floorsEnabled ? `${form.hardFloor || '0'} ${form.currency || 'EUR'}` : 'No floor enforcement'}</strong>
            <span>The Prebid build must include <code>priceFloors</code> while floors are enabled.</span>
          </div>
        </div>

        <div className="runtime-controls-subsection">
          <div className="runtime-controls-subheading">
            <div>
              <h4>Per-bidder floors</h4>
              <p>Use an override only when one bidder needs a different minimum CPM.</p>
            </div>
          </div>
          <div className="runtime-bidder-floor-grid">
            {orderedBidders.length ? orderedBidders.map((bidder) => (
              <label key={bidder.bidder}>
                <span>{bidder.bidder}{bidder.enabled ? '' : ' · saved, excluded'}</span>
                <input
                  min="0"
                  onChange={(event) => setForm((current) => current ? {
                    ...current,
                    bidderFloors: { ...current.bidderFloors, [bidder.bidder]: event.target.value },
                  } : current)}
                  placeholder="Inherit global"
                  step="0.01"
                  type="number"
                  value={form.bidderFloors[bidder.bidder] ?? ''}
                />
              </label>
            )) : <p className="runtime-controls-empty">No saved bidders.</p>}
          </div>
        </div>

        <div className="runtime-controls-subsection">
          <div className="runtime-controls-subheading">
            <div>
              <h4>Advanced floor rules</h4>
              <p>Fields: {payload.floorRuleSchema.fields.join(' | ')}</p>
            </div>
            <button
              className="button secondary"
              onClick={() => setForm((current) => current ? {
                ...current,
                floorRules: [...current.floorRules, { id: randomId(), key: '', value: '' }],
              } : current)}
              type="button"
            >
              ＋ Rule
            </button>
          </div>

          <div className="runtime-floor-rules">
            {form.floorRules.map((row) => (
              <div className="runtime-floor-rule-row" key={row.id}>
                <input
                  onChange={(event) => setForm((current) => current ? {
                    ...current,
                    floorRules: current.floorRules.map((candidate) => candidate.id === row.id
                      ? { ...candidate, key: event.target.value }
                      : candidate),
                  } : current)}
                  placeholder={payload.floorRuleSchema.examples[0]}
                  value={row.key}
                />
                <input
                  min="0"
                  onChange={(event) => setForm((current) => current ? {
                    ...current,
                    floorRules: current.floorRules.map((candidate) => candidate.id === row.id
                      ? { ...candidate, value: event.target.value }
                      : candidate),
                  } : current)}
                  placeholder="0.08"
                  step="0.01"
                  type="number"
                  value={row.value}
                />
                <button
                  aria-label="Remove floor rule"
                  onClick={() => setForm((current) => current ? {
                    ...current,
                    floorRules: current.floorRules.filter((candidate) => candidate.id !== row.id),
                  } : current)}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
            {!form.floorRules.length ? (
              <div className="runtime-controls-empty">
                No custom floor rules. The global floor applies to all banner traffic.
              </div>
            ) : null}
          </div>

          <div className="runtime-floor-examples">
            {payload.floorRuleSchema.examples.map((example) => <code key={example}>{example}</code>)}
          </div>
        </div>
      </article>

      <div className="runtime-controls-actions">
        <button className="button secondary" disabled={saving} onClick={() => void load()} type="button">Reset</button>
        <button className="button primary" disabled={saving} onClick={() => void save()} type="button">
          {saving ? 'Saving…' : 'Save runtime controls'}
        </button>
      </div>
    </section>
  );
}
