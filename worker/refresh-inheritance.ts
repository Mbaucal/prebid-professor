/**
 * Admin-side model of how every built-in script resolves a position's refresh
 * interval. The frozen scheduler (worker/runtime-compiler.ts,
 * advancedRefreshFunction) deep-merges Default -> ATF/BTF -> exact refresh
 * settings and then lets an inherited `schedule` win over `minSeconds`. A Unit
 * rules interval has no schedule of its own, so an inherited Refresh schedule
 * silently replaces it. Saved data is kept consistent here instead of changing
 * published script versions: an interval the operator chose gets its own
 * "Same every time" schedule, while an interval that only repeats what the
 * rule inherits (typically the "Create base rules" group presets) keeps
 * following the parent schedule. Pure functions; no storage access.
 */
type JsonRecord = Record<string, unknown>;
type RuleMap = Record<string, unknown>;
type UnitTypes = Record<string, string>;

export const DEFAULT_RULE_KEY = '__DEFAULT__';
const GROUP_KEYS = ['__ATF__', '__BTF__'];
// The scheduler stops at the per-slot cap; saved caps never exceed 1000.
const CHECKED_REFRESHES = 1001;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Same rules as the generated `_plainMerge`: objects merge, everything else is replaced. */
export function mergeRefresh(...values: unknown[]): JsonRecord {
  const out: JsonRecord = {};
  for (const value of values) {
    if (!isRecord(value)) continue;
    for (const [key, item] of Object.entries(value)) {
      out[key] = isRecord(item) && isRecord(out[key]) ? mergeRefresh(out[key], item) : item;
    }
  }
  return out;
}

/** Interval the generated scheduler uses after `completed` automatic refreshes. */
export function scheduledSeconds(refresh: JsonRecord, completed: number, fallback = 30): number {
  const schedule = isRecord(refresh.schedule) ? refresh.schedule : {};
  const mode = String(schedule.mode || 'fixed');
  let seconds = Number(refresh.minSeconds || fallback);
  if (mode === 'firstThenFixed') {
    seconds = completed > 0 ? Number(schedule.nextSeconds || seconds) : Number(schedule.firstSeconds || seconds);
  } else if (mode === 'percentage') {
    const first = Number(schedule.firstSeconds || seconds);
    const growth = Number(schedule.growthPercent || 0) / 100;
    // REFRESH_MAX_INTERVAL_SEC is 120 unless the Default schedule saves its own maximum.
    const max = Number(schedule.maxSeconds || 120);
    seconds = Math.min(max, Math.round(first * Math.pow(1 + growth, completed)));
  } else if (mode === 'sequence') {
    const sequence = Array.isArray(schedule.sequenceSeconds) ? schedule.sequenceSeconds : [];
    if (sequence.length) seconds = Number(sequence[Math.min(completed, sequence.length - 1)] || seconds);
  } else if (schedule.fixedSeconds) {
    seconds = Number(schedule.fixedSeconds || seconds);
  }
  return !seconds || seconds < 1 ? fallback : seconds;
}

/** True when every automatic refresh uses exactly `seconds`. */
export function followsFixedInterval(refresh: JsonRecord, seconds: number): boolean {
  for (let completed = 0; completed < CHECKED_REFRESHES; completed += 1) {
    if (scheduledSeconds(refresh, completed) !== seconds) return false;
  }
  return true;
}

/** Operator wording for the interval the script uses, e.g. "20s, then 45s". */
export function intervalText(refresh: JsonRecord): string {
  const schedule = isRecord(refresh.schedule) ? refresh.schedule : {};
  const first = scheduledSeconds(refresh, 0);
  if (followsFixedInterval(refresh, first)) return `${first}s`;
  if (schedule.mode === 'firstThenFixed') return `${first}s, then ${scheduledSeconds(refresh, 1)}s`;
  if (schedule.mode === 'percentage') {
    return `${first}s, then +${Number(schedule.growthPercent || 0)}% each, up to ${Number(schedule.maxSeconds || 120)}s`;
  }
  const values = [0, 1, 2, 3].map((completed) => scheduledSeconds(refresh, completed));
  while (values.length > 1 && values[values.length - 1] === values[values.length - 2]) values.pop();
  return `${values.map((seconds) => `${seconds}s`).join(', ')}…`;
}

export function groupKeyForType(type: unknown): string {
  return String(type ?? 'BTF').toUpperCase() === 'ATF' ? '__ATF__' : '__BTF__';
}

/** Inheritance order the generated `getAdUnitRuntimeRule` applies to a rule key. */
export function ruleChain(ruleKey: string, unitType?: unknown): string[] {
  if (ruleKey === DEFAULT_RULE_KEY) return [DEFAULT_RULE_KEY];
  if (GROUP_KEYS.includes(ruleKey)) return [DEFAULT_RULE_KEY, ruleKey];
  return [DEFAULT_RULE_KEY, groupKeyForType(unitType), ruleKey];
}

export function scopeName(ruleKey: string): string {
  if (ruleKey === DEFAULT_RULE_KEY) return 'Default';
  if (ruleKey === '__ATF__') return 'ATF group';
  if (ruleKey === '__BTF__') return 'BTF group';
  return ruleKey;
}

function refreshOf(map: RuleMap, key: string): JsonRecord | undefined {
  const rule = map[key];
  return isRecord(rule) && isRecord(rule.refresh) ? rule.refresh : undefined;
}

/** A Unit rules refresh override that sets an active interval. */
function savedInterval(basic: RuleMap, key: string): number | null {
  const refresh = refreshOf(basic, key);
  const seconds = Number(refresh?.minSeconds);
  return refresh && refresh.enabled !== false && seconds > 0 ? seconds : null;
}

function isRuleTarget(key: string, types: UnitTypes): boolean {
  return key === DEFAULT_RULE_KEY || GROUP_KEYS.includes(key) || Object.hasOwn(types, key);
}

/** Rule keys whose inherited interval can change when `ruleKey` changes, parents first. */
function affectedKeys(ruleKey: string, basic: RuleMap, types: UnitTypes, includeSelf: boolean): string[] {
  const keys = Object.keys(basic).filter((key) => key !== ruleKey && isRuleTarget(key, types));
  const groups = ruleKey === DEFAULT_RULE_KEY ? keys.filter((key) => GROUP_KEYS.includes(key)) : [];
  const exact = keys.filter((key) => !GROUP_KEYS.includes(key) && key !== DEFAULT_RULE_KEY
    && (ruleKey === DEFAULT_RULE_KEY || (GROUP_KEYS.includes(ruleKey) && groupKeyForType(types[key]) === ruleKey)));
  return [...(includeSelf && isRuleTarget(ruleKey, types) ? [ruleKey] : []), ...groups, ...exact];
}

export type RuleState = { advanced: RuleMap; basic: RuleMap };

/** Merged refresh for `key` (Unit rules, then Refresh, per scope); `inheritedOnly` leaves the key's own settings out. */
function chainRefresh(state: RuleState, types: UnitTypes, key: string, inheritedOnly = false): JsonRecord {
  return mergeRefresh(...ruleChain(key, types[key])
    .filter((scope) => !inheritedOnly || scope !== key)
    .flatMap((scope) => [refreshOf(state.basic, scope), refreshOf(state.advanced, scope)]));
}

/** The selected script's runtime pin (or catalog descriptor); null when the site has none yet. */
export type SelectedRuntime = { runtimeId?: unknown; runtimeVersion?: unknown; id?: unknown; version?: unknown; capabilities?: unknown } | null | undefined;

/**
 * Whether the script is 3.16.1 or later: it sets MIN_SECONDS_BETWEEN_REFRESHES to the global
 * minimum time, which is then both its wall-clock gap and the interval of a position no scope
 * gives one, and its global switch is on while any position's own rule is (runtime-3161).
 * Older scripts set it to the global minimum wall-clock gap and switch with the global settings.
 */
export function usesGlobalMinSeconds(runtime: SelectedRuntime): boolean {
  if (!isRecord(runtime)) return false;
  const id = runtime.runtimeId ?? runtime.id;
  const version = runtime.runtimeVersion ?? runtime.version;
  return (Array.isArray(runtime.capabilities) && runtime.capabilities.includes('refresh-wall-clock-gap'))
    || [['tessera-3.16.1', '3.16.1'], ['tessera-3.16.2', '3.16.2']].some(([candidate, release]) => id === candidate && version === release);
}

/** Scope whose refresh settings the compiled globals come from (worker/runtime/preview-snapshot.mjs, worker/releases.ts): Default's, else the ATF group's. */
export function globalRefreshScope(state: RuleState): string | undefined {
  return [DEFAULT_RULE_KEY, '__ATF__'].find((key) => isRecord(mergeRefresh(state.basic[key], state.advanced[key]).refresh));
}

/** What decides the refresh values the script fills in: the selected script and the site's bottom Sticky ad unit. */
export type RefreshScript = { runtime?: SelectedRuntime; stickyAdUnit?: string | null };

/** First interval of the global schedule (DWELL_MIN_VIEW_SEC before its minimum-time fallback), or 0. */
function firstScheduledSeconds(global: JsonRecord): number {
  const schedule = isRecord(global.schedule) ? global.schedule : {};
  const first = Number(schedule.mode === 'fixed' ? schedule.fixedSeconds
    : schedule.mode === 'sequence' && Array.isArray(schedule.sequenceSeconds) ? schedule.sequenceSeconds[0] : schedule.firstSeconds);
  return Number.isFinite(first) && first > 0 ? first : 0;
}

/**
 * What the compiled globals (worker/runtime-compiler.ts, patchGlobalRefresh) give a refresh
 * value that no scope in a position's chain saves: Refresh enabled (REFRESH_ENABLED, the
 * global switch), the interval (MIN_SECONDS_BETWEEN_REFRESHES, else DWELL_MIN_VIEW_SEC), Enter
 * at (REFRESH_IN_VIEW_PCT), Exit at (REFRESH_EXIT_PCT) and Maximum refreshes (MAX_REFRESHES_PER_SLOT).
 */
export function refreshFallbacks(global: JsonRecord, globalMinSeconds: boolean): JsonRecord {
  const dwellSeconds = firstScheduledSeconds(global) || Number(global.minSeconds || 30) || 30;
  return {
    enabled: global.enabled !== false,
    minSeconds: globalMinSeconds ? Number(global.minSeconds) || 30 : Number(global.minGapSeconds ?? 0) || dwellSeconds,
    minViewPct: Number(global.minViewPct ?? 50),
    exitViewPct: Number(global.exitViewPct ?? 10),
    maxRefreshes: Number(global.maxRefreshes ?? 20),
  };
}

function scriptFallbacks(state: RuleState, scope: string, script: RefreshScript): { values: JsonRecord; fromGlobal: string[] } {
  const source = globalRefreshScope(state);
  const global = source !== undefined && source !== scope ? mergeRefresh(state.basic[source], state.advanced[source]).refresh as JsonRecord : {};
  const current = usesGlobalMinSeconds(script.runtime);
  // Older scripts time the bottom Sticky on its own: its own minimum time, else 30 s
  // (preview-snapshot `sticky.refreshSeconds`; the legacy path keeps the template's 30 s).
  const stickyTimer = !current && Boolean(script.stickyAdUnit) && scope === script.stickyAdUnit;
  const { enabled, ...values } = refreshFallbacks(global, current);
  if (stickyTimer) values.minSeconds = 30;
  // Before 3.16.1 a save of the scope the globals come from is also the global switch.
  const switches = !current && (scope === DEFAULT_RULE_KEY || (scope === '__ATF__' && source !== DEFAULT_RULE_KEY));
  const out = switches ? { enabled: source === undefined && isRecord(script.runtime) ? false : enabled, ...values } : values;
  const intervalSaved = current ? Number(global.minSeconds) > 0
    : Number(global.minGapSeconds) > 0 || firstScheduledSeconds(global) > 0 || Number(global.minSeconds) > 0;
  return {
    values: out,
    fromGlobal: Object.keys(out).filter((key) => key === 'minSeconds' ? !stickyTimer && intervalSaved : global[key] != null),
  };
}

/**
 * Refresh values a scope gets from the selected script where neither the scope nor its parents
 * save them: those the compiled globals give (refreshFallbacks) from Default's refresh, or the
 * ATF group's while Default has none, so on such a site a BTF scope shows and keeps the ATF
 * interval and percentages it runs with. A scope that is itself that source gets the compiler
 * defaults: what it saves is its own, and what it leaves out falls back to them. Before 3.16.1
 * a save of that source (Default, or the ATF group while Default has none) is also the global
 * switch, so the scope shows the switch as it is: the ATF group's for Default, or off in a
 * built-in script when neither scope saves refresh settings; and the bottom Sticky keeps the
 * 30 s its separate timer uses. Without a selection the site uses the legacy Generate path
 * (worker/releases.ts), which resolves like 3.16.0 but leaves the switch on then.
 */
export function scriptRefreshDefaults(state: RuleState, scope: string, script: RefreshScript = {}): JsonRecord {
  return scriptFallbacks(state, scope, script).values;
}

/** Which of those values come from the saved global refresh settings; the others are compiler defaults. */
export function globalRefreshValues(state: RuleState, scope: string, script: RefreshScript = {}): string[] {
  return scriptFallbacks(state, scope, script).fromGlobal;
}

/**
 * Refresh settings `key` inherits: what the selected script fills in (scriptRefreshDefaults),
 * then its parent scopes merged as the script merges them (Default, then the group).
 */
export function inheritedRefresh(state: RuleState, types: UnitTypes, key: string, script: RefreshScript = {}): JsonRecord {
  return mergeRefresh(scriptRefreshDefaults(state, key, script), chainRefresh(state, types, key, true));
}

/**
 * Whether a shadowed Unit rules interval is an operator choice that must stay in
 * effect. Group (ATF/BTF) rules are the inheritance layer and are usually the
 * "Create base rules" presets, so a group interval counts only when the operator
 * set or changed it, or when it differed from what Default gave. An exact
 * position's refresh override is opt-in in the editor, so it always counts.
 */
function isChosenInterval(key: string, ruleKey: string, seconds: number, before: RuleState, types: UnitTypes): boolean {
  const group = GROUP_KEYS.includes(key);
  // Saved in Unit rules: a position's interval always; a group interval when this save set or changed it.
  if (key === ruleKey) return !group || savedInterval(before.basic, key) !== seconds;
  // A parent changed: only an interval that was in effect before this save is kept.
  if (!followsFixedInterval(chainRefresh(before, types, key), seconds)) return false;
  // A group interval that only repeated what Default gave was inheriting; it follows the parent.
  return !group || !followsFixedInterval(chainRefresh(before, types, key, true), seconds);
}

/**
 * After `ruleKey` was saved (in Unit rules when `savedRule`, otherwise a
 * Refresh schedules save or a Unit rules delete), give each chosen Unit rules
 * interval its own fixed schedule when an inherited Refresh schedule would
 * otherwise replace it, so the generated script uses the interval that Unit
 * rules and Refresh schedules show. Rules with their own Refresh schedule stay
 * owned by Refresh schedules; rules that already resolve to their interval stay
 * byte-for-byte unchanged; intervals that only repeat an inherited value keep
 * following the parent. `followInherited` (base-rule presets) leaves the saved
 * rule itself following any inherited schedule. Mutates `advanced`; returns the
 * keys given their own schedule.
 */
export function keepUnitRuleIntervals(
  advanced: RuleMap,
  basic: RuleMap,
  types: UnitTypes,
  ruleKey: string,
  { savedRule, followInherited = false, before }: { savedRule: boolean; followInherited?: boolean; before: RuleState },
): string[] {
  const kept: string[] = [];
  for (const key of affectedKeys(ruleKey, basic, types, savedRule && !followInherited)) {
    const seconds = savedInterval(basic, key);
    const current = refreshOf(advanced, key);
    if (seconds === null || isRecord(current?.schedule)) continue;
    if (followsFixedInterval(chainRefresh({ advanced, basic }, types, key), seconds)) continue;
    if (!isChosenInterval(key, ruleKey, seconds, before, types)) continue;
    // Refresh schedules shows this record and re-sends every field on save, so a new
    // record starts from the rule's own timeout (not the form default) and its refresh
    // settings (below). Unit rules saves no CMP timeout.
    const rule = basic[key];
    advanced[key] = {
      ...(isRecord(rule) && Object.hasOwn(rule, 'timeout') ? { timeout: rule.timeout } : {}),
      ...(isRecord(advanced[key]) ? advanced[key] : {}),
      refresh: {
        ...(current ?? {}),
        ...refreshOf(basic, key),
        schedule: { mode: 'fixed', fixedSeconds: seconds, firstSeconds: seconds, nextSeconds: seconds },
      },
    };
    kept.push(key);
  }
  return kept;
}

/** Scope whose Refresh schedule a position follows: the most specific one that has a schedule. */
export function scheduleSource(state: RuleState, types: UnitTypes, code: string): string | undefined {
  return [...ruleChain(code, types[code])].reverse()
    .find((scope) => isRecord(mergeRefresh(refreshOf(state.basic, scope), refreshOf(state.advanced, scope)).schedule));
}

export type IntervalMismatch = { code: string; key: string; savedSeconds: number; used: string; source: string };

/**
 * Read-only check of saved data against the generated scheduler, per position.
 * `rules` are the compiled (Unit rules + Refresh schedules) rules, `basic` the
 * Unit rules rows and `codes` the positions whose interval the script applies.
 * For each position the Unit rules interval is the one its most specific Unit
 * rules refresh override shows. A schedule set in Refresh schedules for that
 * scope (other than "Same every time") or a more specific one is the operator's
 * choice there and is not reported.
 */
export function positionIntervalMismatches(
  rules: RuleMap,
  basic: RuleMap,
  types: UnitTypes,
  codes: string[],
): IntervalMismatch[] {
  const mismatches: IntervalMismatch[] = [];
  for (const code of codes) {
    const chain = ruleChain(code, types[code]);
    const key = [...chain].reverse().find((scope) => isRecord(refreshOf(basic, scope)));
    const seconds = key === undefined ? null : savedInterval(basic, key);
    if (key === undefined || seconds === null) continue;
    const effective = mergeRefresh(...chain.map((scope) => refreshOf(rules, scope)));
    if (effective.enabled === false || followsFixedInterval(effective, seconds)) continue;
    const scheduled = [...chain].reverse().find((scope) => isRecord(refreshOf(rules, scope)?.schedule));
    if (scheduled !== undefined && chain.indexOf(scheduled) >= chain.indexOf(key)) {
      const own = refreshOf(rules, scheduled)?.schedule as JsonRecord;
      if (scheduled !== key || own.mode !== 'fixed') continue;
    }
    mismatches.push({
      code,
      key,
      savedSeconds: seconds,
      used: intervalText(effective),
      source: scheduled === undefined || scheduled === key ? 'its Refresh schedule' : `the inherited ${scopeName(scheduled)} schedule`,
    });
  }
  return mismatches;
}
