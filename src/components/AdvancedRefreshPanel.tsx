import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { AdUnit, UnitRule } from '../shared/types';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
};

type RefreshMode = 'fixed' | 'firstThenFixed' | 'percentage' | 'sequence';

type RefreshSchedule = {
  mode: RefreshMode;
  fixedSeconds: number;
  firstSeconds: number;
  nextSeconds: number;
  growthPercent: number;
  maxSeconds: number;
  sequenceSeconds: number[];
  repeatLast: boolean;
};

type AdvancedRefresh = {
  enabled: boolean;
  minSeconds: number;
  minViewPct: number;
  exitViewPct: number;
  accumulateViewTime: boolean;
  minGapSeconds: number;
  maxRefreshes: number;
  requirePreviousViewable: boolean;
  checkEveryMs: number;
  schedule: RefreshSchedule;
};

type AdvancedRule = {
  timeout?: number;
  cmpTimeout?: number;
  refresh?: Partial<AdvancedRefresh> & { schedule?: Partial<RefreshSchedule> };
};

type FormState = {
  ruleKey: string;
  timeout: number;
  cmpTimeout: number;
  refreshEnabled: boolean;
  mode: RefreshMode;
  fixedSeconds: number;
  firstSeconds: number;
  nextSeconds: number;
  growthPercent: number;
  maxSeconds: number;
  sequenceText: string;
  minViewPct: number;
  exitViewPct: number;
  accumulateViewTime: boolean;
  minGapSeconds: number;
  maxRefreshes: number;
  requirePreviousViewable: boolean;
  checkEveryMs: number;
};

const TARGETS = [
  { key: '__DEFAULT__', label: 'Default · all ad units' },
  { key: '__ATF__', label: 'ATF group' },
  { key: '__BTF__', label: 'BTF group' },
];

function defaultForm(ruleKey = '__DEFAULT__'): FormState {
  return {
    ruleKey,
    timeout: ruleKey === '__ATF__' ? 2200 : 2500,
    cmpTimeout: 1500,
    refreshEnabled: true,
    mode: 'fixed',
    fixedSeconds: 30,
    firstSeconds: 20,
    nextSeconds: 30,
    growthPercent: 20,
    maxSeconds: 120,
    sequenceText: '20, 30',
    minViewPct: ruleKey === '__ATF__' ? 60 : 50,
    exitViewPct: 10,
    accumulateViewTime: true,
    minGapSeconds: 0,
    maxRefreshes: 20,
    requirePreviousViewable: false,
    checkEveryMs: 5000,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown, fallback: number): number {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : fallback;
}

function parseSequence(value: string): number[] {
  return value
    .split(/[;,\s]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function formFromRule(ruleKey: string, rule: AdvancedRule | undefined): FormState {
  const base = defaultForm(ruleKey);
  if (!rule) return base;
  const refresh = asRecord(rule.refresh);
  const schedule = asRecord(refresh.schedule);
  const legacySeconds = numberValue(refresh.minSeconds, base.fixedSeconds);
  const sequence = Array.isArray(schedule.sequenceSeconds)
    ? schedule.sequenceSeconds.map((item) => Number(item)).filter((item) => Number.isFinite(item))
    : [base.firstSeconds, base.nextSeconds];

  return {
    ruleKey,
    timeout: numberValue(rule.timeout, base.timeout),
    cmpTimeout: numberValue(rule.cmpTimeout, base.cmpTimeout),
    refreshEnabled: typeof refresh.enabled === 'boolean' ? refresh.enabled : base.refreshEnabled,
    mode: ['fixed', 'firstThenFixed', 'percentage', 'sequence'].includes(String(schedule.mode))
      ? (String(schedule.mode) as RefreshMode)
      : 'fixed',
    fixedSeconds: numberValue(schedule.fixedSeconds, legacySeconds),
    firstSeconds: numberValue(schedule.firstSeconds, legacySeconds),
    nextSeconds: numberValue(schedule.nextSeconds, legacySeconds),
    growthPercent: numberValue(schedule.growthPercent, base.growthPercent),
    maxSeconds: numberValue(schedule.maxSeconds, base.maxSeconds),
    sequenceText: sequence.length ? sequence.join(', ') : base.sequenceText,
    minViewPct: numberValue(refresh.minViewPct, base.minViewPct),
    exitViewPct: numberValue(refresh.exitViewPct, base.exitViewPct),
    accumulateViewTime:
      typeof refresh.accumulateViewTime === 'boolean'
        ? refresh.accumulateViewTime
        : base.accumulateViewTime,
    minGapSeconds: numberValue(refresh.minGapSeconds, base.minGapSeconds),
    maxRefreshes: numberValue(refresh.maxRefreshes, base.maxRefreshes),
    requirePreviousViewable:
      typeof refresh.requirePreviousViewable === 'boolean'
        ? refresh.requirePreviousViewable
        : base.requirePreviousViewable,
    checkEveryMs: numberValue(refresh.checkEveryMs, base.checkEveryMs),
  };
}

function schedulePreview(form: FormState, count = 7): number[] {
  const values: number[] = [];
  const sequence = parseSequence(form.sequenceText);
  for (let index = 0; index < count; index += 1) {
    if (form.mode === 'fixed') values.push(form.fixedSeconds);
    else if (form.mode === 'firstThenFixed') values.push(index === 0 ? form.firstSeconds : form.nextSeconds);
    else if (form.mode === 'percentage') {
      const seconds = form.firstSeconds * Math.pow(1 + form.growthPercent / 100, index);
      values.push(Math.min(form.maxSeconds, Math.round(seconds)));
    } else {
      values.push(sequence[index] ?? sequence[sequence.length - 1] ?? form.fixedSeconds);
    }
  }
  return values;
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed with status ${response.status}.`);
  return payload;
}

export default function AdvancedRefreshPanel({ publisherId, onChanged }: Props) {
  const [adUnits, setAdUnits] = useState<AdUnit[]>([]);
  const [rules, setRules] = useState<UnitRule[]>([]);
  const [form, setForm] = useState<FormState>(() => defaultForm());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [units, unitRules] = await Promise.all([
        api.listAdUnits(publisherId),
        api.listUnitRules(publisherId),
      ]);
      setAdUnits(units);
      setRules(unitRules);
      const selected = unitRules.find((rule) => rule.ruleKey === form.ruleKey);
      setForm(formFromRule(form.ruleKey, selected?.rule as AdvancedRule | undefined));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Advanced schedules could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [publisherId, form.ruleKey]);

  useEffect(() => {
    void load();
  }, [publisherId]); // selection changes are handled locally

  const targets = useMemo(
    () => [...TARGETS, ...adUnits.map((unit) => ({ key: unit.code, label: `${unit.code} · ${unit.type}` }))],
    [adUnits],
  );

  const preview = useMemo(() => schedulePreview(form), [form]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setSavedMessage(null);
  }

  function selectTarget(ruleKey: string) {
    const rule = rules.find((item) => item.ruleKey === ruleKey);
    setForm(formFromRule(ruleKey, rule?.rule as AdvancedRule | undefined));
    setSavedMessage(null);
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSavedMessage(null);

    const sequence = parseSequence(form.sequenceText);
    if (form.mode === 'sequence' && sequence.length === 0) {
      setError('Enter at least one sequence interval.');
      return;
    }
    if (form.exitViewPct > form.minViewPct) {
      setError('Exit view % should be lower than or equal to entry view %.');
      return;
    }

    setSaving(true);
    try {
      await requestJson(
        `/api/publishers/${encodeURIComponent(publisherId)}/unit-rules-advanced/${encodeURIComponent(form.ruleKey)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            timeout: Number(form.timeout),
            cmpTimeout: Number(form.cmpTimeout),
            refresh: {
              enabled: form.refreshEnabled,
              minViewPct: Number(form.minViewPct),
              exitViewPct: Number(form.exitViewPct),
              accumulateViewTime: form.accumulateViewTime,
              minGapSeconds: Number(form.minGapSeconds),
              maxRefreshes: Number(form.maxRefreshes),
              requirePreviousViewable: form.requirePreviousViewable,
              checkEveryMs: Number(form.checkEveryMs),
              schedule: {
                mode: form.mode,
                fixedSeconds: Number(form.fixedSeconds),
                firstSeconds: Number(form.firstSeconds),
                nextSeconds: Number(form.nextSeconds),
                growthPercent: Number(form.growthPercent),
                maxSeconds: Number(form.maxSeconds),
                sequenceSeconds: sequence,
              },
            },
          }),
        },
      );
      const unitRules = await api.listUnitRules(publisherId);
      setRules(unitRules);
      setSavedMessage(`Saved ${form.ruleKey}. The runtime profile will apply this schedule during release generation.`);
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Advanced schedule could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="advanced-refresh-page">
      <div className="config-toolbar advanced-refresh-toolbar">
        <div>
          <span className="panel-kicker">Per-scope auction, CMP and accumulated view-time control</span>
          <h2>Advanced schedules</h2>
          <p>
            Configure a fixed cadence, a different first refresh, percentage backoff or an explicit sequence.
            View time can accumulate across viewport exits instead of restarting from zero.
          </p>
        </div>
        <span className="advanced-profile-note">Requires advanced generator profile for CMP/schedule modes</span>
      </div>

      {error ? <div className="form-error config-error">{error}</div> : null}
      {savedMessage ? <div className="advanced-save-message">✓ {savedMessage}</div> : null}
      {loading ? <div className="config-loading">Loading rules…</div> : null}

      <div className="advanced-refresh-layout">
        <aside className="advanced-target-list">
          <span className="panel-kicker">Rule target</span>
          {targets.map((target) => (
            <button
              className={form.ruleKey === target.key ? 'active' : ''}
              key={target.key}
              onClick={() => selectTarget(target.key)}
              type="button"
            >
              <strong>{target.label}</strong>
              <code>{target.key}</code>
            </button>
          ))}
        </aside>

        <form className="advanced-refresh-form" onSubmit={submit}>
          <article className="advanced-rule-card">
            <div className="advanced-card-heading">
              <div>
                <span className="panel-kicker">Auction gate</span>
                <h3>Timeouts for {form.ruleKey}</h3>
              </div>
            </div>
            <div className="advanced-field-grid two">
              <label>
                <span>Prebid auction timeout</span>
                <div className="number-with-unit"><input min="100" max="60000" onChange={(event) => update('timeout', Number(event.target.value))} type="number" value={form.timeout} /><b>ms</b></div>
                <small>Already supported by the frozen runtime per position.</small>
              </label>
              <label>
                <span>CMP wait timeout</span>
                <div className="number-with-unit"><input min="100" max="30000" onChange={(event) => update('cmpTimeout', Number(event.target.value))} type="number" value={form.cmpTimeout} /><b>ms</b></div>
                <small>Per-auction wrapper consent wait. The Prebid consent module itself remains globally configured.</small>
              </label>
            </div>
          </article>

          <article className="advanced-rule-card">
            <div className="advanced-card-heading">
              <div>
                <span className="panel-kicker">Refresh cadence</span>
                <h3>Interval strategy</h3>
              </div>
              <label className="advanced-toggle"><input checked={form.refreshEnabled} onChange={(event) => update('refreshEnabled', event.target.checked)} type="checkbox" /><span>Refresh enabled</span></label>
            </div>

            <div className="schedule-mode-grid">
              <label className={form.mode === 'fixed' ? 'selected' : ''}>
                <input checked={form.mode === 'fixed'} onChange={() => update('mode', 'fixed')} type="radio" />
                <b>Same every time</b><span>30s, 30s, 30s…</span>
              </label>
              <label className={form.mode === 'firstThenFixed' ? 'selected' : ''}>
                <input checked={form.mode === 'firstThenFixed'} onChange={() => update('mode', 'firstThenFixed')} type="radio" />
                <b>First, then fixed</b><span>20s, then 30s…</span>
              </label>
              <label className={form.mode === 'percentage' ? 'selected' : ''}>
                <input checked={form.mode === 'percentage'} onChange={() => update('mode', 'percentage')} type="radio" />
                <b>Percentage increase</b><span>20s, +20%, capped</span>
              </label>
              <label className={form.mode === 'sequence' ? 'selected' : ''}>
                <input checked={form.mode === 'sequence'} onChange={() => update('mode', 'sequence')} type="radio" />
                <b>Explicit sequence</b><span>20, 30, 45, 60…</span>
              </label>
            </div>

            <div className="advanced-field-grid schedule-fields">
              {form.mode === 'fixed' ? (
                <label><span>Every refresh</span><div className="number-with-unit"><input min="5" max="3600" onChange={(event) => update('fixedSeconds', Number(event.target.value))} type="number" value={form.fixedSeconds} /><b>sec</b></div></label>
              ) : null}
              {form.mode === 'firstThenFixed' ? (
                <>
                  <label><span>First refresh</span><div className="number-with-unit"><input min="5" max="3600" onChange={(event) => update('firstSeconds', Number(event.target.value))} type="number" value={form.firstSeconds} /><b>sec</b></div></label>
                  <label><span>Second and every next</span><div className="number-with-unit"><input min="5" max="3600" onChange={(event) => update('nextSeconds', Number(event.target.value))} type="number" value={form.nextSeconds} /><b>sec</b></div></label>
                </>
              ) : null}
              {form.mode === 'percentage' ? (
                <>
                  <label><span>First refresh</span><div className="number-with-unit"><input min="5" max="3600" onChange={(event) => update('firstSeconds', Number(event.target.value))} type="number" value={form.firstSeconds} /><b>sec</b></div></label>
                  <label><span>Increase each next</span><div className="number-with-unit"><input min="0" max="500" step="0.1" onChange={(event) => update('growthPercent', Number(event.target.value))} type="number" value={form.growthPercent} /><b>%</b></div></label>
                  <label><span>Maximum interval</span><div className="number-with-unit"><input min="5" max="7200" onChange={(event) => update('maxSeconds', Number(event.target.value))} type="number" value={form.maxSeconds} /><b>sec</b></div></label>
                </>
              ) : null}
              {form.mode === 'sequence' ? (
                <label className="sequence-field"><span>Intervals, in seconds</span><input onChange={(event) => update('sequenceText', event.target.value)} placeholder="20, 30, 30, 45" value={form.sequenceText} /><small>After the last value, the final interval repeats.</small></label>
              ) : null}
            </div>

            <div className="schedule-preview">
              <span>Next seven accumulated in-view targets</span>
              <div>{preview.map((seconds, index) => <code key={`${seconds}-${index}`}>{index + 1}: {seconds}s</code>)}</div>
            </div>
          </article>

          <article className="advanced-rule-card">
            <div className="advanced-card-heading"><div><span className="panel-kicker">Viewability and safety</span><h3>Dwell behavior</h3></div></div>
            <div className="advanced-field-grid four">
              <label><span>Enter at</span><div className="number-with-unit"><input min="0" max="100" onChange={(event) => update('minViewPct', Number(event.target.value))} type="number" value={form.minViewPct} /><b>%</b></div></label>
              <label><span>Exit at</span><div className="number-with-unit"><input min="0" max="100" onChange={(event) => update('exitViewPct', Number(event.target.value))} type="number" value={form.exitViewPct} /><b>%</b></div></label>
              <label><span>Minimum wall-clock gap</span><div className="number-with-unit"><input min="0" max="3600" onChange={(event) => update('minGapSeconds', Number(event.target.value))} type="number" value={form.minGapSeconds} /><b>sec</b></div></label>
              <label><span>Maximum refreshes</span><input min="0" max="1000" onChange={(event) => update('maxRefreshes', Number(event.target.value))} type="number" value={form.maxRefreshes} /></label>
              <label><span>Guard check interval</span><div className="number-with-unit"><input min="250" max="60000" onChange={(event) => update('checkEveryMs', Number(event.target.value))} type="number" value={form.checkEveryMs} /><b>ms</b></div></label>
            </div>

            <div className="advanced-options">
              <label><input checked={form.accumulateViewTime} onChange={(event) => update('accumulateViewTime', event.target.checked)} type="checkbox" /><span><b>Accumulate view time</b><small>Leaving the viewport pauses the countdown. Returning continues from the remaining seconds instead of restarting.</small></span></label>
              <label><input checked={form.requirePreviousViewable} onChange={(event) => update('requirePreviousViewable', event.target.checked)} type="checkbox" /><span><b>Require previous ad to be viewable</b><small>Leave disabled when blank/no-fill slots should get another auction opportunity.</small></span></label>
            </div>
          </article>

          <div className="advanced-form-actions">
            <button className="button primary" disabled={saving} type="submit">{saving ? 'Saving…' : `Save ${form.ruleKey}`}</button>
          </div>
        </form>
      </div>
    </section>
  );
}
