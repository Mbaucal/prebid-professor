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

/** Refresh settings `key` inherits: its parent scopes merged as the script merges them (Default, then the group). */
export function inheritedRefresh(state: RuleState, types: UnitTypes, key: string): JsonRecord {
  return chainRefresh(state, types, key, true);
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
