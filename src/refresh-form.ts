import type { RebaseGate } from './edit-rebase';

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
    minViewPct: ruleKey === '__ATF__' ? 60 : 50,
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

/** What the shown form was built from: its values and the row version a save of it is checked against. */
export type Baseline = { form: FormState; rowId: string | null; updatedAt: string | null };

/** The form for a scope from one listing read (advanced records and Unit rules rows). */
export function baselineFor(
  ruleKey: string,
  unitType: string | null | undefined,
  advancedRules: Record<string, AdvancedRule>,
  rows: Record<string, MirroredRow>,
): Baseline {
  const row = rows[ruleKey];
  const parents = parentRecords(ruleKey, unitType, advancedRules, rows).map((scope) => scope.record);
  return { form: formFromRecords(ruleKey, ownRecord(ruleKey, advancedRules, rows), parents), rowId: row?.id ?? null, updatedAt: row?.updatedAt ?? null };
}

const REFRESH_FIELDS: Array<keyof FormState> = ['refreshEnabled', 'mode', 'fixedSeconds', 'firstSeconds', 'nextSeconds', 'growthPercent',
  'maxSeconds', 'sequenceText', 'minViewPct', 'exitViewPct', 'accumulateViewTime', 'minGapSeconds', 'maxRefreshes', 'requirePreviousViewable', 'checkEveryMs'];

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

/** True when a save would store nothing for this scope: every section is inherited and unchanged. */
export function storesNothing(form: FormState): boolean {
  return !form.ownTimeout && !form.ownCmpTimeout && !form.ownRefresh;
}

/** The PUT body without its version fields: only the sections this scope stores. */
export function requestBody(form: FormState): Record<string, unknown> {
  return {
    ...(form.ownTimeout ? { timeout: Number(form.timeout) } : {}),
    ...(form.ownCmpTimeout ? { cmpTimeout: Number(form.cmpTimeout) } : {}),
    ...(form.ownRefresh
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
              fixedSeconds: Number(form.fixedSeconds),
              firstSeconds: Number(form.firstSeconds),
              nextSeconds: Number(form.nextSeconds),
              growthPercent: Number(form.growthPercent),
              maxSeconds: Number(form.maxSeconds),
              sequenceSeconds: parseSequence(form.sequenceText),
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
// refresh fields take effect only while refresh is enabled, and interval fields only under
// the strategy that uses them.
export const FORM_GATES: Array<RebaseGate<FormState>> = [
  { gate: 'ownTimeout', fields: ['timeout'], storedOnlyWhenUsed: true },
  { gate: 'ownCmpTimeout', fields: ['cmpTimeout'], storedOnlyWhenUsed: true },
  { gate: 'ownRefresh', fields: REFRESH_FIELDS, storedOnlyWhenUsed: true },
  {
    gate: 'refreshEnabled',
    fields: REFRESH_FIELDS.filter((field) => field !== 'refreshEnabled'),
  },
  {
    gate: 'mode',
    fields: ['fixedSeconds', 'firstSeconds', 'nextSeconds', 'growthPercent', 'maxSeconds', 'sequenceText'],
    uses: (mode, field) => MODE_FIELDS[mode as RefreshMode]?.includes(field) ?? false,
  },
];

export function fieldText(key: keyof FormState, value: FormState[keyof FormState]): string {
  if (OWN_FLAGS.includes(key)) return value ? 'set for this scope' : 'inherited';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (key === 'mode') return MODE_LABELS[value as RefreshMode] ?? String(value);
  return `${value}${FIELD_UNITS[key] ?? ''}`;
}
