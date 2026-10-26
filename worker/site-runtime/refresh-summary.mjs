import {mergeRefresh, intervalText, scopeName, positionIntervalMismatches} from '../refresh-inheritance.ts';

const parseRule = value => {try {return typeof value === 'string' ? JSON.parse(value) : value;} catch {return {};}};
/** Describe the selected compiler input, not the editable UI defaults. No writes.
 * `basicRules` are the saved Unit rules rows, used to explain intervals the script does not use. */
export function refreshSummary(input, units, runtime, basicRules = []) {
  const warnings = [];
  if (!input) return {units: [], warnings};
  const rules = input.core.adUnitRules;
  const blocked = [];
  const selected = ([id, version]) => (runtime?.runtimeId ?? runtime?.id) === id && (runtime?.runtimeVersion ?? runtime?.version) === version;
  // 3.16.2 checks a position without its own saved percentage against the
  // script's inherited threshold (Default refresh, else ATF refresh, else 50%).
  const inheritedViewPct = selected(['tessera-3.16.2', '3.16.2']) ? Number(input.core.globalRefresh.minViewPct ?? 50) : null;
  const inheritedNote = input.core.globalRefresh.minViewPct == null ? `its default ${inheritedViewPct}%`
    : `the ${inheritedViewPct}% saved in the ${rules.__DEFAULT__?.refresh != null ? 'Default' : 'ATF'} refresh rule`;
  const notes = {};
  const rows = units.map(unit => {
    const group = unit.type === 'ATF' ? '__ATF__' : '__BTF__';
    const scopes = [rules.__DEFAULT__, rules[group], rules[unit.code]].filter(Boolean);
    // Deep merge like the generated scheduler: an inherited schedule is not dropped by a child override.
    const refresh = mergeRefresh({enabled: true, minSeconds: 30, minViewPct: 50}, ...scopes.map(scope => scope.refresh));
    let timeout = unit.type === 'ATF' ? input.core.atfTimeout : input.core.btfTimeout;
    for (const scope of scopes) if (scope.timeout !== undefined) timeout = scope.timeout;
    const result = (label, detail, enabled) => ({code: unit.code, label, detail, enabled, timeout});
    if (!unit.enabled || unit.type === 'DRAFT') return result('Disabled', 'This ad unit is disabled or a draft.', false);
    if (input.overlay?.code === unit.code) return result('Disabled', 'TakeOver uses its own display frequency.', false);
    if (input.outstream?.disabledRefreshCodes?.includes(unit.code)) return result('Disabled', 'Automatic refresh is disabled for this video-enabled position.', false);
    if (!refresh.enabled) return result('Disabled', 'Disabled by the resolved refresh rule.', false);
    // Same whole-rule merge as the generated getAdUnitRuntimeRule, without the editor baseline.
    const own = mergeRefresh(...scopes).refresh?.minViewPct;
    const viewPct = inheritedViewPct == null ? refresh.minViewPct : own == null ? inheritedViewPct : Number(own);
    if (inheritedViewPct != null && own == null) notes[unit.code] = ` No in-view percentage is saved for this position in Default, group or ad unit settings, so the script checks ${inheritedNote} at refresh time.`;
    if (input.options.sticky.bottomAdUnitId === unit.code) {
      // 3.16.2 also applies the percentage to a filled Sticky (an empty one keeps retrying).
      if (inheritedViewPct == null) return result('Sticky timer', 'Uses the selected script’s separate Sticky refresh timer.', true);
      return result(`Sticky timer · ${viewPct}%`, `Uses the selected script’s separate Sticky refresh timer. A filled Sticky refreshes only while at least ${viewPct}% of it is in view.${notes[unit.code] ?? ''}`, true);
    }
    if (input.core.globalRefresh.enabled === false) {
      blocked.push(unit.code);
      return result('Disabled', 'The selected script’s global refresh switch is off; this position’s enabled refresh rule is not applied.', false);
    }
    const schedule = refresh.schedule;
    // 3.16.2 applies the percentage to every content schedule, so it is shown for all of them.
    const shown = inheritedViewPct == null ? '' : ` · ${viewPct}%`;
    const label = schedule?.mode === 'sequence' ? `Sequence schedule${shown}` : schedule?.mode === 'percentage' ? `Growing interval${shown}` : `${intervalText(refresh)} · ${viewPct}%`;
    return result(label, `Resolved from the selected script’s Default, group and ad unit settings.${notes[unit.code] ?? ''}`, true);
  });
  if (blocked.length) warnings.push(`Refresh is disabled by this script’s global switch for: ${blocked.join(', ')}. Enable Default refresh in Refresh schedules and disable the groups or positions that should not refresh, or choose a script version that supports independent position rules.`);
  // Version-pin capabilities are a frozen schema; the newly registered source
  // implements this behavior without changing historical descriptor validation.
  const hasWallClockGap = runtime?.capabilities?.includes('refresh-wall-clock-gap')
    || [['tessera-3.16.1', '3.16.1'], ['tessera-3.16.2', '3.16.2']].some(selected);
  if (!hasWallClockGap) {
    const gaps = Object.entries(rules).filter(([, rule]) => Number(rule?.refresh?.minGapSeconds) > 0).map(([key]) => key);
    if (gaps.length) warnings.push(`Minimum wall-clock gap is saved for: ${gaps.join(', ')}, but this script version does not enforce it. Choose a script version with wall-clock gap support before relying on this setting.`);
  }
  // An inherited Refresh schedule can replace a Unit rules interval: base-rule
  // group presets usually just follow the site schedule, while data saved before
  // exact intervals were kept can disagree. Only positions whose refresh the
  // script actually applies are checked; data is unchanged.
  const basic = Object.fromEntries(basicRules.map(row => [row.rule_key, parseRule(row.rule_json)]));
  const types = Object.fromEntries(units.map(unit => [unit.code, unit.type]));
  // Sticky follows inherited schedules from 3.16.1, the release that added wall-clock
  // gaps; older scripts time it from its own rule's minimum time instead.
  const applied = rows.filter(row => row.enabled && !(row.code === input.options.sticky.bottomAdUnitId && !hasWallClockGap)).map(row => row.code);
  const unused = positionIntervalMismatches(rules, basic, types, applied);
  for (const item of unused) {
    const row = rows.find(candidate => candidate.code === item.code);
    row.detail = `Uses ${item.source} (${item.used}); the ${item.savedSeconds}s interval saved for ${scopeName(item.key)} in Unit rules is not used.${notes[item.code] ?? ''}`;
  }
  // A position's own refresh override is an explicit choice, so a mismatch there is reported.
  const exact = unused.filter(item => item.key === item.code);
  const inherited = exact.some(item => item.source.startsWith('the inherited'));
  if (exact.length) warnings.push(`The refresh interval saved in Unit rules is not used for: ${exact.map(item => `${item.code} (${item.savedSeconds}s; the script uses ${item.source}: ${item.used})`).join(', ')}. ${inherited ? 'If the inherited schedule is intended, remove the refresh override from that rule in Unit rules. ' : ''}To use the saved interval, edit and save the rule in Unit rules, or set “Same every time” for it in Refresh schedules.`);
  return {units: rows, warnings};
}
