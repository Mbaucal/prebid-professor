/** Describe the selected compiler input, not the editable UI defaults. No writes. */
export function refreshSummary(input, units, runtime) {
  const warnings = [];
  if (!input) return {units: [], warnings};
  const rules = input.core.adUnitRules;
  const blocked = [];
  const rows = units.map(unit => {
    const group = unit.type === 'ATF' ? '__ATF__' : '__BTF__';
    const scopes = [rules.__DEFAULT__, rules[group], rules[unit.code]].filter(Boolean);
    let refresh = {enabled: true, minSeconds: 30, minViewPct: 50};
    let timeout = unit.type === 'ATF' ? input.core.atfTimeout : input.core.btfTimeout;
    for (const scope of scopes) {refresh = {...refresh, ...scope.refresh};if (scope.timeout !== undefined) timeout = scope.timeout;}
    const result = (label, detail, enabled) => ({code: unit.code, label, detail, enabled, timeout});
    if (!unit.enabled || unit.type === 'DRAFT') return result('Disabled', 'This ad unit is disabled or a draft.', false);
    if (input.overlay?.code === unit.code) return result('Disabled', 'TakeOver uses its own display frequency.', false);
    if (input.outstream?.disabledRefreshCodes?.includes(unit.code)) return result('Disabled', 'Automatic refresh is disabled for this video-enabled position.', false);
    if (!refresh.enabled) return result('Disabled', 'Disabled by the resolved refresh rule.', false);
    if (input.options.sticky.bottomAdUnitId === unit.code) return result('Sticky timer', 'Uses the selected script’s separate Sticky refresh timer.', true);
    if (input.core.globalRefresh.enabled === false) {
      blocked.push(unit.code);
      return result('Disabled', 'The selected script’s global refresh switch is off; this position’s enabled refresh rule is not applied.', false);
    }
    const schedule = refresh.schedule;
    const seconds = schedule?.mode === 'fixed' ? schedule.fixedSeconds : refresh.minSeconds;
    const label = schedule?.mode === 'sequence' ? 'Sequence schedule' : schedule?.mode === 'percentage' ? 'Growing interval' : `${seconds || 30}s · ${refresh.minViewPct}%`;
    return result(label, 'Resolved from the selected script’s Default, group and ad unit settings.', true);
  });
  if (blocked.length) warnings.push(`Refresh is disabled by this script’s global switch for: ${blocked.join(', ')}. Enable Default refresh in Refresh schedules and disable the groups or positions that should not refresh, or choose a script version that supports independent position rules.`);
  // Version-pin capabilities are a frozen schema; the newly registered source
  // implements this behavior without changing historical descriptor validation.
  const hasWallClockGap = runtime?.capabilities?.includes('refresh-wall-clock-gap')
    || ((runtime?.runtimeId ?? runtime?.id) === 'tessera-3.16.1'
      && (runtime?.runtimeVersion ?? runtime?.version) === '3.16.1');
  if (!hasWallClockGap) {
    const gaps = Object.entries(rules).filter(([, rule]) => Number(rule?.refresh?.minGapSeconds) > 0).map(([key]) => key);
    if (gaps.length) warnings.push(`Minimum wall-clock gap is saved for: ${gaps.join(', ')}, but this script version does not enforce it. Choose a script version with wall-clock gap support before relying on this setting.`);
  }
  return {units: rows, warnings};
}
