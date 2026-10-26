import { carriedEdits, rebaseEdits, rebaseReview, rebasedBaseline, type RebaseGate, type RebaseReview } from './edit-rebase';

// The Refresh schedules form: how a scope's saved settings fill it, what a save sends, and
// how a refused save names and compares its fields. Kept apart from the panel so tests use
// it as is.

export type RefreshMode = 'fixed' | 'firstThenFixed' | 'percentage' | 'sequence';

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

export type AdvancedRule = {
  timeout?: number | null;
  cmpTimeout?: number | null;
  refresh?: (Partial<AdvancedRefresh> & { schedule?: Partial<RefreshSchedule> }) | null;
};

/** The scope's Unit rules row, read together with the advanced records (same D1 batch). */
export type MirroredRow = { id: string; ruleKey: string; updatedAt: string; rule: AdvancedRule };

export type FormState = {
  ruleKey: string;
  /** This scope stores its own timeout; otherwise the form shows the inherited one and a save leaves it inherited. */
  ownTimeout: boolean;
  timeout: number;
  ownCmpTimeout: boolean;
  cmpTimeout: number;
  /** This scope stores its own refresh settings (all of them, once any is changed here). */
  ownRefresh: boolean;
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

type OwnFlag = 'ownTimeout' | 'ownCmpTimeout' | 'ownRefresh';

export const DEFAULT_KEY = '__DEFAULT__';
const GROUP_KEYS = ['__ATF__', '__BTF__'];

export function defaultForm(ruleKey = DEFAULT_KEY): FormState {
  return {
    ruleKey,
    ownTimeout: false,
    timeout: ruleKey === '__ATF__' ? 2200 : 2500,
    ownCmpTimeout: false,
    cmpTimeout: 1500,
    ownRefresh: false,
    refreshEnabled: true,
    mode: 'fixed',
    fixedSeconds: 30,
    firstSeconds: 20,
    nextSeconds: 30,
    growthPercent: 20,
    maxSeconds: 120,
    sequenceText: '20, 30',
    // What a script checks when no scope saves a percentage (REFRESH_IN_VIEW_PCT).
    minViewPct: 50,
    exitViewPct: 10,
    accumulateViewTime: true,
    minGapSeconds: 0,
    maxRefreshes: 20,
    requirePreviousViewable: false,
    checkEveryMs: 5000,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function numberValue(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : fallback;
}

const isSet = (value: unknown) => value !== undefined && value !== null;

export function parseSequence(value: string): number[] {
  return value
    .split(/[;,\s]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);
}

/** Same merge as the generated script and the preview: objects merge, anything else (null too) replaces. */
function merge(...values: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const value of values) {
    if (!isRecord(value)) continue;
    for (const [key, item] of Object.entries(value)) {
      out[key] = isRecord(item) ? merge(asRecord(out[key]), item) : item;
    }
  }
  return out;
}

/** What a scope stores itself: its Unit rules row with its Refresh record on top, as the script merges them. */
export function ownRecord(ruleKey: string, advancedRules: Record<string, AdvancedRule>, rows: Record<string, MirroredRow>): AdvancedRule {
  return merge(rows[ruleKey]?.rule, advancedRules[ruleKey]) as AdvancedRule;
}

/** The scopes a scope inherits from, outermost first, as the script resolves them: Default, then the position's ATF/BTF group. */
export function parentScopes(ruleKey: string, unitType?: string | null): string[] {
  if (ruleKey === DEFAULT_KEY) return [];
  if (GROUP_KEYS.includes(ruleKey)) return [DEFAULT_KEY];
  return [DEFAULT_KEY, String(unitType ?? 'BTF').toUpperCase() === 'ATF' ? '__ATF__' : '__BTF__'];
}

export function scopeName(ruleKey: string): string {
  if (ruleKey === DEFAULT_KEY) return 'Default';
  if (ruleKey === '__ATF__') return 'the ATF group';
  if (ruleKey === '__BTF__') return 'the BTF group';
  return ruleKey;
}

/** For each section this scope does not store: the closest parent scope that does, or null when none does. */
export type InheritedFrom = Record<OwnFlag, string | null>;

type Scope = { key: string; record: AdvancedRule };

function parentRecords(ruleKey: string, unitType: string | null | undefined, advancedRules: Record<string, AdvancedRule>, rows: Record<string, MirroredRow>): Scope[] {
  return parentScopes(ruleKey, unitType).map((key) => ({ key, record: ownRecord(key, advancedRules, rows) }));
}

function closest(parents: Scope[], has: (record: AdvancedRule) => boolean): string | null {
  return [...parents].reverse().find((scope) => has(scope.record))?.key ?? null;
}

/** Every parent scope that stores refresh settings, closest first: each inherited refresh value comes from the closest one that sets it. */
export function refreshSources(ruleKey: string, unitType: string | null | undefined, advancedRules: Record<string, AdvancedRule>, rows: Record<string, MirroredRow>): string[] {
  return parentRecords(ruleKey, unitType, advancedRules, rows).filter((scope) => isRecord(scope.record.refresh)).map((scope) => scope.key).reverse();
}

export function inheritedFrom(ruleKey: string, unitType: string | null | undefined, advancedRules: Record<string, AdvancedRule>, rows: Record<string, MirroredRow>): InheritedFrom {
  const parents = parentRecords(ruleKey, unitType, advancedRules, rows);
  return {
    ownTimeout: closest(parents, (record) => isSet(record.timeout)),
    ownCmpTimeout: closest(parents, (record) => isSet(record.cmpTimeout)),
    ownRefresh: closest(parents, (record) => isRecord(record.refresh)),
  };
}

/**
 * The form for a scope. A section the scope stores shows its own values (refresh settings it
 * leaves out are filled from its parents, as the script merges them); a section it does not
 * store shows what it inherits, and a save leaves it inherited until a value there is changed.
 */
export function formFromRecords(ruleKey: string, own: AdvancedRule, parents: AdvancedRule[]): FormState {
  const base = defaultForm(ruleKey);
  const chain = [...parents, own];
  const last = (field: 'timeout' | 'cmpTimeout') => [...chain].reverse().map((record) => record[field]).find(isSet);
  const refresh = merge(...chain.map((record) => record.refresh));
  const schedule = asRecord(refresh.schedule);
  const legacySeconds = numberValue(refresh.minSeconds, base.fixedSeconds);
  const sequence = Array.isArray(schedule.sequenceSeconds)
    ? schedule.sequenceSeconds.map((item) => Number(item)).filter((item) => Number.isFinite(item))
    : [base.firstSeconds, base.nextSeconds];

  return {
    ruleKey,
    ownTimeout: isSet(own.timeout),
    timeout: numberValue(last('timeout'), base.timeout),
    ownCmpTimeout: isSet(own.cmpTimeout),
    cmpTimeout: numberValue(last('cmpTimeout'), base.cmpTimeout),
    ownRefresh: isRecord(own.refresh),
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

/**
 * What the shown form was built from: its values, the row version a save of it is checked
 * against, the refresh values the scope shows without storing them (filled from its parents),
 * the parents' refresh settings those values came from, and the values earlier rebases of
 * this form carried as entered here (see rebasedBaseline).
 */
export type Baseline = {
  form: FormState;
  rowId: string | null;
  updatedAt: string | null;
  unstored: Array<keyof FormState>;
  inheritedRefresh: Record<string, unknown>;
  carried: Partial<FormState>;
};

const REFRESH_FIELDS: Array<keyof FormState> = ['refreshEnabled', 'mode', 'fixedSeconds', 'firstSeconds', 'nextSeconds', 'growthPercent',
  'maxSeconds', 'sequenceText', 'minViewPct', 'exitViewPct', 'accumulateViewTime', 'minGapSeconds', 'maxRefreshes', 'requirePreviousViewable', 'checkEveryMs'];
const SCHEDULE_FIELDS: Array<keyof FormState> = ['mode', 'fixedSeconds', 'firstSeconds', 'nextSeconds', 'growthPercent', 'maxSeconds', 'sequenceText'];
const REFRESH_KEYS: Partial<Record<keyof FormState, string>> = {
  refreshEnabled: 'enabled', minViewPct: 'minViewPct', exitViewPct: 'exitViewPct', accumulateViewTime: 'accumulateViewTime',
  minGapSeconds: 'minGapSeconds', maxRefreshes: 'maxRefreshes', requirePreviousViewable: 'requirePreviousViewable', checkEveryMs: 'checkEveryMs',
};

/**
 * Refresh values a scope shows but does not store: all of them when it stores no refresh
 * settings, otherwise those its own record leaves out (a Unit rules row holds only some). The
 * interval strategy counts as stored with a schedule of its own, or with a Unit rules interval
 * that no inherited schedule replaces.
 */
function unstoredRefresh(own: AdvancedRule, parents: AdvancedRule[]): Array<keyof FormState> {
  if (!isRecord(own.refresh)) return [...REFRESH_FIELDS];
  const refresh = own.refresh as Record<string, unknown>;
  const inheritedSchedule = isRecord(merge(...parents.map((record) => record.refresh)).schedule);
  const ownSchedule = isRecord(refresh.schedule) || (isSet(refresh.minSeconds) && !inheritedSchedule);
  return REFRESH_FIELDS.filter((field) => SCHEDULE_FIELDS.includes(field) ? !ownSchedule : !isSet(refresh[REFRESH_KEYS[field] as string]));
}

/** The form for a scope from one listing read (advanced records and Unit rules rows). */
export function baselineFor(
  ruleKey: string,
  unitType: string | null | undefined,
  advancedRules: Record<string, AdvancedRule>,
  rows: Record<string, MirroredRow>,
): Baseline {
  const row = rows[ruleKey];
  const own = ownRecord(ruleKey, advancedRules, rows);
  const parents = parentRecords(ruleKey, unitType, advancedRules, rows).map((scope) => scope.record);
  return {
    form: formFromRecords(ruleKey, own, parents),
    rowId: row?.id ?? null,
    updatedAt: row?.updatedAt ?? null,
    unstored: unstoredRefresh(own, parents),
    inheritedRefresh: merge(...parents.map((record) => record.refresh)),
    carried: {},
  };
}

/** One listing read: the advanced records, the Unit rules rows and each position's ATF/BTF group (same D1 batch). */
export type Listing = {
  advancedRules: Record<string, AdvancedRule>;
  unitRuleRows: Record<string, MirroredRow>;
  unitTypes: Record<string, string>;
};

/** What a save of a scope returns: its record and Unit rules row as written, and the records of positions that kept their Unit rules interval in it. */
export type Saved = { advancedRule: AdvancedRule; unitRule: MirroredRow; keptAdvancedRules?: Record<string, AdvancedRule> };

/**
 * The listing after a save of `ruleKey`, from that save's response: the scope's record and
 * row, and the records of positions that kept their interval, so a position selected before
 * a fresh read lands never shows as following the new schedule.
 */
export function listingAfterSave(listing: Listing, ruleKey: string, saved: Saved): Listing {
  return {
    ...listing,
    advancedRules: { ...listing.advancedRules, ...saved.keptAdvancedRules, [ruleKey]: saved.advancedRule },
    unitRuleRows: { ...listing.unitRuleRows, [ruleKey]: saved.unitRule },
  };
}

/** The form for a scope from one listing read, with the parents its group has in that read. */
export function baselineFromListing(ruleKey: string, listing: Listing): Baseline {
  return baselineFor(ruleKey, listing.unitTypes[ruleKey] ?? null, listing.advancedRules, listing.unitRuleRows);
}

/** The section switch a field belongs to: changing the field makes the section this scope's own. */
function sectionOf(key: keyof FormState): OwnFlag | null {
  if (key === 'timeout') return 'ownTimeout';
  if (key === 'cmpTimeout') return 'ownCmpTimeout';
  return REFRESH_FIELDS.includes(key) ? 'ownRefresh' : null;
}

/** The form after a value is entered: its section is now stored for this scope. */
export function withEdit<K extends keyof FormState>(form: FormState, key: K, value: FormState[K]): FormState {
  const section = sectionOf(key);
  return { ...form, [key]: value, ...(section ? { [section]: true } : {}) };
}

// The values of each section.
const SECTIONS: Record<OwnFlag, Array<keyof FormState>> = {
  ownTimeout: ['timeout'],
  ownCmpTimeout: ['cmpTimeout'],
  ownRefresh: REFRESH_FIELDS,
};

/**
 * Whether a save sends this section: it is kept for this scope, and the scope already stores
 * it (a timeout) or one of the values it shows differs from the loaded form or still holds the
 * value a rebase carried. A value typed and put back changes nothing, so the section stays as
 * saved or inherited; so does a strategy tried and put back, or intervals retyped with other
 * spacing.
 */
function sends(form: FormState, loaded: Baseline, flag: OwnFlag): boolean {
  if (!form[flag]) return false;
  if (flag !== 'ownRefresh' && loaded.form[flag]) return true;
  return SECTIONS[flag].some((key) => shown(form, key)
    && (!sameValue(key, form[key], loaded.form[key]) || (key in loaded.carried && sameValue(key, form[key], loaded.carried[key]))));
}

/** Whether the form shows a field: the interval fields of other strategies are hidden. */
function shown(form: FormState, key: keyof FormState): boolean {
  return !SCHEDULE_FIELDS.includes(key) || key === 'mode' || MODE_FIELDS[form.mode].includes(key);
}

/** Values that save the same: intervals are compared as the sequence they save, not as typed. */
function sameValue(key: keyof FormState, left: unknown, right: unknown): boolean {
  return key === 'sequenceText'
    ? JSON.stringify(parseSequence(String(left))) === JSON.stringify(parseSequence(String(right)))
    : left === right;
}

const OWN = Object.keys(SECTIONS) as OwnFlag[];

/** `form` with a section's switch and values taken from `from`. */
function withSection(form: FormState, flag: OwnFlag, from: FormState): FormState {
  const out = { ...form } as Record<string, unknown>;
  for (const key of [flag, ...SECTIONS[flag]]) out[key] = from[key];
  return out as FormState;
}

/**
 * The form as a save of it counts: a section the save does not send shows what was loaded, so
 * typing a value and putting it back is no edit. In a refresh section that is sent, an interval
 * of a strategy the form does not show holds what was loaded, as the save sends it, and
 * intervals that save the same as loaded (or as a rebase carried them) keep that text, so
 * neither is taken for an entry.
 */
function asSent(form: FormState, loaded: Baseline): FormState {
  const out = OWN.reduce((out, flag) => (sends(form, loaded, flag) ? out : withSection(out, flag, loaded.form)), form);
  if (!sends(form, loaded, 'ownRefresh')) return out;
  return SCHEDULE_FIELDS.reduce((values, key) => {
    if (!shown(form, key)) return { ...values, [key]: loaded.form[key] };
    if (key in loaded.carried && sameValue(key, form[key], loaded.carried[key])) return { ...values, [key]: loaded.carried[key] };
    return sameValue(key, form[key], loaded.form[key]) ? { ...values, [key]: loaded.form[key] } : values;
  }, out);
}

/**
 * The form after a value is entered (see withEdit). A section the scope does not store that a
 * save would no longer send (a value typed and put back) shows the inherited values the tab
 * loaded, which its saves are compared and checked with, so the form never shows as this
 * scope's own a section a save leaves inherited.
 */
export function afterEdit(form: FormState, loaded: Baseline): FormState {
  return OWN.reduce((out, flag) => {
    if (!form[flag] || loaded.form[flag] || sends(form, loaded, flag)) return out;
    const back = withSection(out, flag, loaded.form);
    // Intervals that save the same keep the text typed, such as the comma on the way from
    // "20, 40" to "20, 40, 80".
    return flag === 'ownRefresh' && shown(form, 'sequenceText') ? { ...back, sequenceText: form.sequenceText } : back;
  }, form);
}

/** Whether a save sends the refresh section. */
export function sendsRefresh(form: FormState, loaded: Baseline): boolean {
  return sends(form, loaded, 'ownRefresh');
}

/** Why the form cannot be saved, or null. Only refresh values a save sends are checked. */
export function formError(form: FormState, loaded: Baseline): string | null {
  if (!sendsRefresh(form, loaded)) return null;
  if (form.mode === 'sequence' && parseSequence(form.sequenceText).length === 0) return 'Enter at least one sequence interval.';
  if (form.exitViewPct > form.minViewPct) return 'Exit view % should be lower than or equal to entry view %.';
  return null;
}

/** True when this scope would store nothing: every section shown is inherited. */
export function storesNothing(form: FormState): boolean {
  return !form.ownTimeout && !form.ownCmpTimeout && !form.ownRefresh;
}

/**
 * The PUT body without its version fields: the timeouts this scope stores or that were changed
 * here, and its refresh settings only when one of them was changed here, so an unchanged
 * section (stored in part, or inherited) stays exactly as saved. The refresh section is sent
 * whole, with the values it shows and, for strategies it does not show, the intervals it
 * loaded; when some are filled from the parent scopes, the parents'
 * settings go with it, so a save built on an older read of them is refused.
 */
export function requestBody(form: FormState, loaded: Baseline): Record<string, unknown> {
  const refresh = sends(form, loaded, 'ownRefresh');
  // Intervals of a strategy the form does not show are saved as loaded, not as last typed.
  const schedule = (key: keyof FormState) => (shown(form, key) ? form[key] : loaded.form[key]);
  return {
    ...(sends(form, loaded, 'ownTimeout') ? { timeout: Number(form.timeout) } : {}),
    ...(sends(form, loaded, 'ownCmpTimeout') ? { cmpTimeout: Number(form.cmpTimeout) } : {}),
    ...(refresh && loaded.unstored.length ? { expectedInheritedRefresh: loaded.inheritedRefresh } : {}),
    ...(refresh
      ? {
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
              fixedSeconds: Number(schedule('fixedSeconds')),
              firstSeconds: Number(schedule('firstSeconds')),
              nextSeconds: Number(schedule('nextSeconds')),
              growthPercent: Number(schedule('growthPercent')),
              maxSeconds: Number(schedule('maxSeconds')),
              sequenceSeconds: parseSequence(String(schedule('sequenceText'))),
            },
          },
        }
      : {}),
  };
}

// How a field is named and shown when a refused save lists what both tabs changed. A
// section switch shares its section's name: "set for this scope" or "inherited".
export const FIELD_LABELS: Record<keyof FormState, string> = {
  ruleKey: 'Rule target',
  ownTimeout: 'Prebid auction timeout',
  timeout: 'Prebid auction timeout',
  ownCmpTimeout: 'CMP wait timeout',
  cmpTimeout: 'CMP wait timeout',
  ownRefresh: 'Refresh settings',
  refreshEnabled: 'Refresh enabled',
  mode: 'Interval strategy',
  fixedSeconds: 'Every refresh',
  firstSeconds: 'First refresh',
  nextSeconds: 'Second and every next',
  growthPercent: 'Increase each next',
  maxSeconds: 'Maximum interval',
  sequenceText: 'Intervals, in seconds',
  minViewPct: 'Enter at',
  exitViewPct: 'Exit at',
  accumulateViewTime: 'Accumulate view time',
  minGapSeconds: 'Minimum wall-clock gap',
  maxRefreshes: 'Maximum refreshes',
  requirePreviousViewable: 'Require previous ad to be viewable',
  checkEveryMs: 'Guard check interval',
};
const FIELD_UNITS: Partial<Record<keyof FormState, string>> = {
  timeout: ' ms', cmpTimeout: ' ms', fixedSeconds: ' sec', firstSeconds: ' sec', nextSeconds: ' sec', growthPercent: '%',
  maxSeconds: ' sec', minViewPct: '%', exitViewPct: '%', minGapSeconds: ' sec', checkEveryMs: ' ms',
};
const MODE_LABELS: Record<RefreshMode, string> = {
  fixed: 'Same every time', firstThenFixed: 'First, then fixed', percentage: 'Percentage increase', sequence: 'Explicit sequence',
};
const OWN_FLAGS: Array<keyof FormState> = ['ownTimeout', 'ownCmpTimeout', 'ownRefresh'];

// The interval fields each strategy uses; the others stay stored but have no effect.
const MODE_FIELDS: Record<RefreshMode, Array<keyof FormState>> = {
  fixed: ['fixedSeconds'],
  firstThenFixed: ['firstSeconds', 'nextSeconds'],
  percentage: ['firstSeconds', 'growthPercent', 'maxSeconds'],
  sequence: ['sequenceText'],
};
// A section this scope does not store holds inherited values (a save stores nothing for it);
// refresh fields take effect only while refresh is enabled, but stay editable and saved while
// it is off; interval fields take effect, and are shown, only under the strategy that uses them.
export const FORM_GATES: Array<RebaseGate<FormState>> = [
  { gate: 'ownTimeout', fields: ['timeout'], storedOnlyWhenUsed: true, inheritsWhenUnused: true },
  { gate: 'ownCmpTimeout', fields: ['cmpTimeout'], storedOnlyWhenUsed: true, inheritsWhenUnused: true },
  { gate: 'ownRefresh', fields: REFRESH_FIELDS, storedOnlyWhenUsed: true, inheritsWhenUnused: true },
  {
    gate: 'refreshEnabled',
    fields: REFRESH_FIELDS.filter((field) => field !== 'refreshEnabled'),
    editableWhenUnused: true,
  },
  {
    gate: 'mode',
    fields: ['fixedSeconds', 'firstSeconds', 'nextSeconds', 'growthPercent', 'maxSeconds', 'sequenceText'],
    uses: (mode, field) => MODE_FIELDS[mode as RefreshMode]?.includes(field) ?? false,
    hiddenWhenUnused: true,
  },
];

export function fieldText(key: keyof FormState, value: FormState[keyof FormState]): string {
  if (OWN_FLAGS.includes(key)) return value ? 'set for this scope' : 'inherited';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (key === 'mode') return MODE_LABELS[value as RefreshMode] ?? String(value);
  return `${value}${FIELD_UNITS[key] ?? ''}`;
}

/** The Refresh tab after a 409, compared with a fresh listing read of the scope. */
export type Refusal =
  /** Nothing this tab read changed: the server's message stands. */
  | { kind: 'unexplained' }
  /**
   * The saved settings with only this form's changes applied, the note it shows, and what the
   * next refused save is compared with. `cause`: the scope's rule was changed or deleted, or
   * only settings it inherits changed. `changed`: this form changed something. `unchanged`:
   * every value the form shows is as its save counted it (a hidden interval, typed here or saved
   * by the other tab, or intervals spaced differently are no difference) and nothing conflicts,
   * so there is nothing to review.
   * `invalid`: why the rebased values cannot be saved together, such as this form's Exit at
   * above an Enter at changed in the other tab.
   */
  | {
      kind: 'rebased';
      form: FormState;
      review: RebaseReview;
      next: Baseline;
      cause: 'changed' | 'deleted' | 'parents';
      changed: boolean;
      unchanged: boolean;
      invalid: string | null;
    };

/**
 * Rebase a refused save onto `current` (the scope from a fresh listing read) when its row or
 * the settings it inherits changed since `baseline`, also when the row was deleted: only the
 * values this form changed are applied, and a section the save did not send is no edit. A
 * field this form did not change shows what the scope stores or inherits now, also in a section
 * this form keeps as its own against the other save. The next refused save carries the same
 * values again.
 */
export function afterRefusal(submitted: FormState, baseline: Baseline, current: Baseline): Refusal {
  const rowChanged = current.rowId !== baseline.rowId || current.updatedAt !== baseline.updatedAt;
  const parentsChanged = JSON.stringify(current.inheritedRefresh) !== JSON.stringify(baseline.inheritedRefresh);
  if (!rowChanged && !parentsChanged) return { kind: 'unexplained' };
  const sent = asSent(submitted, baseline);
  // An entry the form no longer shows (an interval of a strategy given up) is no longer carried.
  const carriedBefore = Object.fromEntries(Object.entries(baseline.carried)
    .filter(([key]) => shown(sent, key as keyof FormState))) as Partial<FormState>;
  const rebased = rebaseEdits(sent, baseline.form, current.form, FORM_GATES, {
    unstored: { loaded: baseline.unstored, saved: current.unstored },
    carried: carriedBefore,
    equal: sameValue,
  });
  const kept = rebased.kept ?? [];
  const review = rebaseReview(rebased, current.form, (key) => FIELD_LABELS[key], fieldText);
  // A section switch is never an entry of its own: it follows the values entered under it
  // (withEdit), as a save does (sends).
  const carried = carriedEdits(rebased);
  for (const flag of OWN) delete carried[flag];
  const next = {
    ...current,
    form: rebasedBaseline(rebased, current.form),
    unstored: current.unstored.filter((field) => !kept.includes(field)),
    carried,
  };
  return {
    kind: 'rebased',
    form: rebased.form,
    review,
    next,
    cause: baseline.rowId && !current.rowId ? 'deleted' : rowChanged ? 'changed' : 'parents',
    changed: rebased.changed.length > 0,
    // Compared with the form as its save counted (asSent), on the values the form shows: a hidden
    // interval (typed here or saved by the other tab) or respaced text is no difference.
    unchanged: !review.conflicts.length && (Object.keys(sent) as Array<keyof FormState>)
      .every((key) => !shown(sent, key) || sameValue(key, rebased.form[key], sent[key])),
    invalid: formError(rebased.form, next),
  };
}
