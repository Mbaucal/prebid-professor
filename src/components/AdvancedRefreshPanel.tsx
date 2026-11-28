import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import type { RebaseReview } from '../edit-rebase';
import {
  afterEdit, afterRefusal, atfGlobalRefresh, atfIsGlobalSource, baselineFromListing, defaultForm, formError, inheritedFrom, listingAfterSave, listingScript,
  parseSequence, refreshSources, requestBody, scopeName, storesNothing, withEdit,
  type AdvancedRule, type Baseline, type FormState, type Listing, type MirroredRow, type Saved,
} from '../refresh-form';
import type { RefreshScript } from '../../worker/refresh-inheritance';
import type { AdUnit } from '../shared/types';
import EditRebaseReview from './EditRebaseReview';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
};

/** The listing, with each position's ATF/BTF group from the same read: the parents its form inherits from. */
type AdvancedPayload = Listing & { ok: true };

type SavePayload = Saved & {
  ok: true;
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

// While Default stores no refresh settings, the script reads its global refresh values from the ATF group's.
const ATF_GLOBAL = 'the ATF group’s refresh settings, which the script uses globally while Default has none';

// "Exit at and Maximum refreshes come from …": the refresh values this form shows from the ATF group's settings.
function atfFills(fields: string[]): string {
  const list = fields.length > 1 ? `${fields.slice(0, -1).join(', ')} and ${fields[fields.length - 1]}` : fields[0];
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} ${fields.length > 1 ? 'come' : 'comes'} from ${ATF_GLOBAL}`;
}

// Where a section the scope does not store comes from, under its inputs: the parent scopes, closest first,
// and for refresh values none of them sets, the ATF group as the script's global source (`atfFields`).
function inheritedNote(ruleKey: string, sources: string[], change: string, atfFields: string[] = []): string {
  const from = sources.length
    ? `Inherited from ${sources.map(scopeName).join(' and ')}.${atfFields.length ? ` ${atfFills(atfFields)}.` : ''}`
    : atfFields.length
      ? `Not set ${ruleKey === '__DEFAULT__' ? 'for Default' : 'here, in Default or in the group'}. ${atfFills(atfFields)}; the script’s own setting applies to the rest.`
      : ruleKey === '__DEFAULT__'
        ? 'Not set for Default: the script’s own setting applies.'
        : 'Not set here, in Default or in the group: the script’s own setting applies.';
  return `${from} ${change}`;
}

// The ATF group while Default has no refresh settings: what else its refresh settings decide.
function atfSourceNote({ withSwitch, stickyApart }: { withSwitch: boolean; stickyApart: boolean }): string {
  // Before 3.16.1 the interval a BTF scope takes is the minimum wall-clock gap if one is saved, and this switch stops every
  // position but a BTF bottom Sticky, whose timer checks only its own rules. A saved Enter at of 0% falls back to this group's.
  const values = withSwitch
    ? `Enter at, Exit at and Maximum refreshes for BTF positions and the BTF group where they do not set them, and as their interval its minimum wall-clock gap when one is saved, otherwise its first interval${stickyApart ? ' (the bottom Sticky keeps its own timer)' : ''}. Turning Refresh enabled off here stops refresh for every position${stickyApart ? ' except the bottom Sticky' : ''}.`
    : 'first interval, Enter at, Exit at and Maximum refreshes for BTF positions and the BTF group where they do not set them.';
  return `While Default has no refresh settings, the script also uses this group’s ${values} This group’s other refresh settings apply only to ATF positions. A BTF position that saves Enter at 0% still waits for this group’s Enter at before its dwell timer counts.`;
}

const SAVES_IT = 'Changing it saves it for this scope; leaving it unchanged keeps it inherited.';
const SAVES_SECTION = 'Changing any refresh or dwell value saves all of them for this scope, as shown';

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(payload.error || `Request failed with status ${response.status}.`, response.status);
  return payload;
}

// The form and the version it is saved against both come from this one response.
async function loadAdvancedRules(publisherId: string): Promise<AdvancedPayload> {
  const payload = await requestJson<AdvancedPayload>(`/api/publishers/${encodeURIComponent(publisherId)}/unit-rules-advanced`);
  return { ...payload, unitRuleRows: payload.unitRuleRows ?? {}, unitTypes: payload.unitTypes ?? {} };
}

export default function AdvancedRefreshPanel({ publisherId, onChanged }: Props) {
  const [adUnits, setAdUnits] = useState<AdUnit[]>([]);
  const [rows, setRows] = useState<Record<string, MirroredRow>>({});
  const [advancedRules, setAdvancedRules] = useState<Record<string, AdvancedRule>>({});
  const [form, setForm] = useState<FormState>(() => defaultForm());
  const [unitTypes, setUnitTypes] = useState<Record<string, string>>({});
  // The selected script (and the bottom Sticky it may time on its own) decides what a refresh value no scope sets resolves to.
  const [script, setScript] = useState<RefreshScript>({ runtime: null, stickyAdUnit: null });
  const [loaded, setLoaded] = useState<Baseline>(() => ({ form: defaultForm(), rowId: null, updatedAt: null, unstored: [], inheritedRefresh: {}, carried: {} }));
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
      setUnitTypes(advancedPayload.unitTypes);
      setScript(listingScript(advancedPayload));
      const baseline = baselineFromListing(form.ruleKey, advancedPayload);
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
  const sources = useMemo(() => {
    const unitType = unitTypes[form.ruleKey] ?? null;
    const from = inheritedFrom(form.ruleKey, unitType, advancedRules, rows);
    return {
      ownTimeout: from.ownTimeout ? [from.ownTimeout] : [],
      ownCmpTimeout: from.ownCmpTimeout ? [from.ownCmpTimeout] : [],
      ownRefresh: refreshSources(form.ruleKey, unitType, advancedRules, rows),
      atfFields: atfGlobalRefresh(form.ruleKey, unitType, advancedRules, rows, script),
      atfSource: atfIsGlobalSource(form.ruleKey, advancedRules, rows, unitTypes, script),
    };
  }, [form.ruleKey, unitTypes, advancedRules, rows, script]);

  // An entered value makes its section this scope's own; untouched inherited sections are not
  // saved, and a section whose values are all put back shows as inherited again.
  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => afterEdit(withEdit(current, key, value), loaded));
    setSavedMessage(null);
  }

  function selectTarget(ruleKey: string) {
    const baseline = baselineFromListing(ruleKey, { advancedRules, unitRuleRows: rows, unitTypes, ...script });
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

    if (storesNothing(form)) {
      setRebaseNote(null);
      setError(`Nothing to save: ${form.ruleKey} inherits every setting shown here. Change a value to set it for this scope.`);
      return;
    }
    // Only sections changed here, or timeouts the scope stores, are sent and checked.
    const body = requestBody(form, loaded);
    if (!Object.keys(body).length) {
      setRebaseNote(null);
      setError(`Nothing to save: no value was changed for ${form.ruleKey}.`);
      return;
    }
    const invalid = formError(form, loaded);
    if (invalid) {
      setError(invalid);
      return;
    }
    // A review note after a 409 stays while a save stops at this check, so the values to
    // correct stay named.
    setRebaseNote(null);

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
            // An unchanged schedule or inherited timeout stays as saved.
            ...body,
          }),
        },
      );
      // The form now shows the scope as stored (its Unit rules row and Refresh record from this
      // save's response), and its next save is checked against the row version this save wrote,
      // taken from its own response rather than paired from a later list read. Positions that
      // kept their Unit rules interval in this save get their records from it too.
      const next = listingAfterSave({ advancedRules, unitRuleRows: rows, unitTypes, ...script }, submitted.ruleKey, saved);
      const stored = baselineFromListing(submitted.ruleKey, next);
      setForm(stored.form);
      setLoaded(stored);
      setAdvancedRules(next.advancedRules);
      setRows(next.unitRuleRows);
      setSavedMessage(savedScheduleText(submitted.ruleKey, saved.keptUnitRuleIntervals ?? [], saved.appliesToAdUnits));
      // Other scopes may have changed with this save (kept intervals); refresh them from one
      // consistent read. The baseline above stays: it is what this form was saved as.
      try {
        const latest = await loadAdvancedRules(publisherId);
        setAdvancedRules(latest.advancedRules);
        setRows(latest.unitRuleRows);
        setUnitTypes(latest.unitTypes);
        setScript(listingScript(latest));
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
          const [units, latest] = await Promise.all([api.listAdUnits(publisherId), loadAdvancedRules(publisherId)]);
          // The scope's parents come from the same read as its row, so a group change counts.
          const current = baselineFromListing(submitted.ruleKey, latest);
          setAdUnits(units);
          setAdvancedRules(latest.advancedRules);
          setRows(latest.unitRuleRows);
          setUnitTypes(latest.unitTypes);
          setScript(listingScript(latest));
          const outcome = afterRefusal(submitted, baseline, current);
          if (outcome.kind === 'rebased') {
            const key = submitted.ruleKey;
            setLoaded(outcome.next);
            setForm(outcome.form);
            setRebaseNote(outcome.unchanged && !outcome.invalid ? null : outcome.review);
            const changedElsewhere = {
              changed: `${key} was changed in another tab`,
              deleted: `The rule for ${key} was deleted in another tab`,
              parents: `The settings ${key} inherits were changed in another tab`,
            }[outcome.cause];
            const shown = outcome.cause === 'deleted' ? `what ${key} inherits` : 'the settings saved in the other tab';
            setError(!outcome.changed
              ? `${changedElsewhere}, so nothing was saved. You had not changed anything here, so the form now shows ${shown}.`
              : outcome.invalid
                ? `${changedElsewhere}, so nothing was saved. With the settings saved there, the values shown here no longer fit together: ${outcome.invalid} Correct them, then select Save ${key} again.`
                : outcome.unchanged
                ? `${changedElsewhere}, so nothing was saved. None of the values shown here changed: select Save ${key} again.`
                : `${changedElsewhere}, so nothing was saved. The form now shows the saved settings with your changes applied. Review them and select Save ${key} again.`);
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
          <h2>Advanced schedules</h2>
          <p>
            Configure a fixed cadence, a different first refresh, percentage backoff or an explicit sequence.
            View time can accumulate across viewport exits instead of restarting from zero.
          </p>
        </div>
        <span className="advanced-profile-note">Requires advanced generator profile for CMP/schedule modes</span>
      </div>

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
                {form.ownTimeout ? null : <small className="advanced-inherited-note">{inheritedNote(form.ruleKey, sources.ownTimeout, SAVES_IT)}</small>}
              </label>
              <label>
                <span>CMP wait timeout</span>
                <div className="number-with-unit"><input min="100" max="30000" onChange={(event) => update('cmpTimeout', Number(event.target.value))} type="number" value={form.cmpTimeout} /><b>ms</b></div>
                <small>Per-auction wrapper consent wait. The Prebid consent module itself remains globally configured.</small>
                {form.ownCmpTimeout ? null : <small className="advanced-inherited-note">{inheritedNote(form.ruleKey, sources.ownCmpTimeout, SAVES_IT)}</small>}
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

            {!form.ownRefresh ? (
              <p className="advanced-inherited-note">{inheritedNote(form.ruleKey, sources.ownRefresh, `${SAVES_SECTION}; leaving them unchanged keeps them inherited.`, sources.atfFields)}</p>
            ) : loaded.form.ownRefresh && loaded.unstored.length ? (
              // Stored in part (a Unit rules row holds only some refresh settings): the rest is filled from the parents or the script.
              <p className="advanced-inherited-note">{`This scope stores only some of these values${sources.atfFields.length ? `. ${atfFills(sources.atfFields)};` : ';'} ${sources.ownRefresh.length ? `the others are inherited from ${sources.ownRefresh.map(scopeName).join(' and ')}` : 'the others are the script’s own settings'}. ${SAVES_SECTION}.`}</p>
            ) : null}
            {sources.atfSource ? <p className="advanced-inherited-note">{atfSourceNote(sources.atfSource)}</p> : null}

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
