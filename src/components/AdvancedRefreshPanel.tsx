import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { rebaseEdits, rebaseReview, type RebaseReview } from '../edit-rebase';
import {
  FIELD_LABELS, FORM_GATES, baselineFor, defaultForm, fieldText, inheritedFrom, parseSequence, requestBody, scopeName,
  storesNothing, withEdit,
  type AdvancedRule, type Baseline, type FormState, type MirroredRow,
} from '../refresh-form';
import type { AdUnit } from '../shared/types';
import EditRebaseReview from './EditRebaseReview';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
  onOpenUnitRules?: () => void;
};

type AdvancedPayload = { ok: true; advancedRules: Record<string, AdvancedRule>; unitRuleRows: Record<string, MirroredRow> };

type SavePayload = {
  ok: true;
  advancedRule: AdvancedRule;
  unitRule: MirroredRow;
  keptUnitRuleIntervals?: string[];
  appliesToAdUnits?: string[];
};

const TARGETS = [
  { key: '__DEFAULT__', label: 'Default · all ad units' },
  { key: '__ATF__', label: 'ATF group' },
  { key: '__BTF__', label: 'BTF group' },
];

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

function keptIntervalsText(keys: string[]): string {
  const names = keys.map((key) => key === '__DEFAULT__' ? 'Default' : key === '__ATF__' ? 'ATF group' : key === '__BTF__' ? 'BTF group' : key);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? 'keeps its' : 'keep their'} own interval from Unit rules.`;
}

function savedScheduleText(ruleKey: string, kept: string[], appliesTo?: string[]): string {
  if (!kept.length) return `Saved ${ruleKey}. The runtime profile will apply this schedule during release generation.`;
  // Every position below this scope keeps a more specific interval: say so instead of promising an effect.
  if (appliesTo && !appliesTo.length) return `Saved ${ruleKey}. This schedule currently applies to no ad unit. ${keptIntervalsText(kept)}`;
  return `Saved ${ruleKey}. The runtime profile will apply this schedule during release generation. ${keptIntervalsText(kept)}`;
}

// Where a section the scope does not store comes from, under its inputs.
function inheritedNote(ruleKey: string, source: string | null, what: string): string {
  const from = source
    ? `Inherited from ${scopeName(source)}.`
    : ruleKey === '__DEFAULT__'
      ? 'Not set for Default: the script’s own setting applies.'
      : 'Not set here, in Default or in the group: the script’s own setting applies.';
  return `${from} Changing ${what} saves it for this scope; leaving it unchanged keeps it inherited.`;
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(payload.error || `Request failed with status ${response.status}.`, response.status);
  return payload;
}

// The form and the version it is saved against both come from this one response.
async function loadAdvancedRules(publisherId: string): Promise<AdvancedPayload> {
  const payload = await requestJson<AdvancedPayload>(`/api/publishers/${encodeURIComponent(publisherId)}/unit-rules-advanced`);
  return { ...payload, unitRuleRows: payload.unitRuleRows ?? {} };
}

export default function AdvancedRefreshPanel({ publisherId, onChanged, onOpenUnitRules }: Props) {
  const [adUnits, setAdUnits] = useState<AdUnit[]>([]);
  const [rows, setRows] = useState<Record<string, MirroredRow>>({});
  const [advancedRules, setAdvancedRules] = useState<Record<string, AdvancedRule>>({});
  const [form, setForm] = useState<FormState>(() => defaultForm());
  const [loaded, setLoaded] = useState<Baseline>(() => ({ form: defaultForm(), rowId: null, updatedAt: null }));
  const unitTypeOf = (ruleKey: string, units: AdUnit[] = adUnits) => units.find((unit) => unit.code === ruleKey)?.type ?? null;
  const [rebaseNote, setRebaseNote] = useState<RebaseReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [units, advancedPayload] = await Promise.all([api.listAdUnits(publisherId), loadAdvancedRules(publisherId)]);
      setAdUnits(units);
      setRows(advancedPayload.unitRuleRows);
      setAdvancedRules(advancedPayload.advancedRules);
      const baseline = baselineFor(form.ruleKey, unitTypeOf(form.ruleKey, units), advancedPayload.advancedRules, advancedPayload.unitRuleRows);
      setForm(baseline.form);
      setLoaded(baseline);
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
  const sources = useMemo(
    () => inheritedFrom(form.ruleKey, adUnits.find((unit) => unit.code === form.ruleKey)?.type ?? null, advancedRules, rows),
    [form.ruleKey, adUnits, advancedRules, rows],
  );

  // An entered value makes its section this scope's own; untouched inherited sections are not saved.
  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => withEdit(current, key, value));
    setSavedMessage(null);
  }

  function selectTarget(ruleKey: string) {
    const baseline = baselineFor(ruleKey, unitTypeOf(ruleKey), advancedRules, rows);
    setForm(baseline.form);
    setLoaded(baseline);
    setSavedMessage(null);
    setError(null);
    setRebaseNote(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSavedMessage(null);
    setRebaseNote(null);

    if (storesNothing(form)) {
      setError(`Nothing to save: ${form.ruleKey} inherits every setting shown here. Change a value to set it for this scope.`);
      return;
    }
    if (form.ownRefresh && form.mode === 'sequence' && parseSequence(form.sequenceText).length === 0) {
      setError('Enter at least one sequence interval.');
      return;
    }
    if (form.ownRefresh && form.exitViewPct > form.minViewPct) {
      setError('Exit view % should be lower than or equal to entry view %.');
      return;
    }

    // What this form was built from: the scope's Unit rules row (id and version) goes with
    // the save, so a save from a tab opened before another tab's save is refused (409).
    const baseline = loaded;
    const submitted = form;

    setSaving(true);
    try {
      const saved = await requestJson<SavePayload>(
        `/api/publishers/${encodeURIComponent(publisherId)}/unit-rules-advanced/${encodeURIComponent(form.ruleKey)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedUpdatedAt: baseline.updatedAt,
            expectedUnitRuleId: baseline.rowId,
            // Only the sections this scope stores: an inherited timeout or schedule stays inherited.
            ...requestBody(submitted),
          }),
        },
      );
      // The form now shows the scope as stored (its Unit rules row and Refresh record from this
      // save's response), and its next save is checked against the row version this save wrote,
      // taken from its own response rather than paired from a later list read.
      const nextAdvanced = { ...advancedRules, [submitted.ruleKey]: saved.advancedRule };
      const nextRows = { ...rows, [submitted.ruleKey]: saved.unitRule };
      const stored = baselineFor(submitted.ruleKey, unitTypeOf(submitted.ruleKey), nextAdvanced, nextRows);
      setForm(stored.form);
      setLoaded(stored);
      setAdvancedRules(nextAdvanced);
      setRows(nextRows);
      setSavedMessage(savedScheduleText(submitted.ruleKey, saved.keptUnitRuleIntervals ?? [], saved.appliesToAdUnits));
      // Other scopes may have changed with this save (kept intervals); refresh them from one
      // consistent read. The baseline above stays: it is what this form was saved as.
      try {
        const latest = await loadAdvancedRules(publisherId);
        setAdvancedRules(latest.advancedRules);
        setRows(latest.unitRuleRows);
      } catch {
        // The save itself succeeded and this scope's baseline is set; other scopes refresh on the next load.
      }
      await onChanged?.();
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 409) {
        // Nothing was saved. Reload (form values and row version from one read) and show the
        // scope as saved now, with only the fields changed in this form applied, so saving
        // again cannot put back the other tab's values. The next save is checked against
        // the reloaded version, never the one this form was opened with.
        try {
          const latest = await loadAdvancedRules(publisherId);
          const current = baselineFor(submitted.ruleKey, unitTypeOf(submitted.ruleKey), latest.advancedRules, latest.unitRuleRows);
          setAdvancedRules(latest.advancedRules);
          setRows(latest.unitRuleRows);
          if (current.rowId !== baseline.rowId || current.updatedAt !== baseline.updatedAt) {
            setLoaded(current);
            if (baseline.rowId && !current.rowId) {
              // Deleted elsewhere: every entered value stays, and saving creates the rule again.
              setError(`The rule for ${submitted.ruleKey} was deleted in another tab, so nothing was saved. Your entries are kept: select Save ${submitted.ruleKey} to create it again.`);
              return;
            }
            const rebased = rebaseEdits(submitted, baseline.form, current.form, FORM_GATES);
            setForm(rebased.form);
            setRebaseNote(rebaseReview(rebased, current.form, (key) => FIELD_LABELS[key], fieldText));
            setError(rebased.changed.length
              ? `${submitted.ruleKey} was changed in another tab, so nothing was saved. The form now shows the saved settings with your changes applied. Review them and select Save ${submitted.ruleKey} again.`
              : `${submitted.ruleKey} was changed in another tab, so nothing was saved. You had not changed anything here, so the form now shows the settings saved in the other tab.`);
            return;
          }
        } catch {
          // Keep the refusal below; the operator can still reload.
        }
      }
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
          <h2>Refresh</h2>
          <p>
            Configure a fixed cadence, a different first refresh, percentage backoff or an explicit sequence.
            View time can accumulate across viewport exits instead of restarting from zero.
          </p>
        </div>
        {onOpenUnitRules ? <button className="button secondary" type="button" onClick={onOpenUnitRules}>Unit rules</button> : null}
      </div>
      <p className="config-section-note">Choose Default, a group or an individual ad unit below. Save your settings, then generate a new release to use them. Previously downloaded ZIPs keep their original settings.</p>

      {error ? <div className="form-error config-error">{error}</div> : null}
      {rebaseNote ? <EditRebaseReview review={rebaseNote} /> : null}
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
                <div className="number-with-unit"><input min="100" max="30000" onChange={(event) => update('timeout', Number(event.target.value))} type="number" value={form.timeout} /><b>ms</b></div>
                <small>Already supported by the frozen runtime per position.</small>
                {form.ownTimeout ? null : <small className="advanced-inherited-note">{inheritedNote(form.ruleKey, sources.ownTimeout, 'it')}</small>}
              </label>
              <label>
                <span>CMP wait timeout</span>
                <div className="number-with-unit"><input min="100" max="30000" onChange={(event) => update('cmpTimeout', Number(event.target.value))} type="number" value={form.cmpTimeout} /><b>ms</b></div>
                <small>Per-auction wrapper consent wait. The Prebid consent module itself remains globally configured.</small>
                {form.ownCmpTimeout ? null : <small className="advanced-inherited-note">{inheritedNote(form.ruleKey, sources.ownCmpTimeout, 'it')}</small>}
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

            {form.ownRefresh ? null : (
              <p className="advanced-inherited-note">{inheritedNote(form.ruleKey, sources.ownRefresh, 'any refresh or dwell value')}</p>
            )}

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
