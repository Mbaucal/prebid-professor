/** Read-only descriptions of the selected compiler's normalized loading input.
 * Keep this outside the versioned runtime: displaying settings must not change it.
 */
export function describeUnitLoading(input, unit) {
  const result = (label, detail, source) => ({ code: unit.code, label, detail, source });
  if (!unit.enabled || unit.type === 'DRAFT') {
    return result('Not requested', 'This ad unit is disabled or a draft.', 'Ad unit status');
  }
  if (input.overlay?.code === unit.code) {
    return result('TakeOver · after consent', 'Uses the TakeOver request and closing flow.', 'Display & loading');
  }

  // The compiler has already combined stored unit rules with Display & loading.
  // A null entry clears that scope's override; the broader scopes still apply.
  const group = unit.type === 'ATF' ? '__ATF__' : '__BTF__';
  let rule = null, source = '';
  for (const [key, label] of [['__DEFAULT__', 'Default rule'], [group, `${unit.type} group`], [unit.code, 'Ad unit override']]) {
    const value = input.lazyRules?.[key];
    if (value) { rule = { ...rule, ...value }; source = label; }
  }
  if (rule) {
    if (!rule.enabled) return result('Immediately after consent', 'Does not wait for scrolling to this position.', source);
    const render = rule.renderMarginPx === 0 ? 'on entry to the viewport' : `${rule.renderMarginPx}px before the viewport`;
    const fetch = input.options.enablePrebid
      ? `Bid prefetch: ${rule.fetchMarginPx}px before the viewport.`
      : 'Prebid is off; bid prefetch is not used.';
    return result('Lazy load', `GAM request: ${render}. ${fetch}`, source);
  }
  if (input.options.sticky.bottomAdUnitId === unit.code) {
    return result('Automatic · Sticky', 'Uses the selected script’s Sticky loading flow.', 'Sticky default');
  }
  return unit.type === 'ATF'
    ? result('Automatic · ATF', 'Loads after consent processing, without waiting for scrolling.', 'ATF default')
    : result('Automatic · BTF lazy load', 'Waits for the selected script’s BTF visibility threshold.', 'BTF default');
}

export function loadingSummary(input, units, pin, validationIssue) {
  const issue = !pin ? 'Save a script version in Script setup to see loading behavior.' : validationIssue;
  return {
    runtimeVersion: pin?.runtimeVersion ?? null,
    issue: issue ?? null,
    units: units.map(unit => {
      if (input) return describeUnitLoading(input, unit);
      return {
        code: unit.code,
        label: !unit.enabled || unit.type === 'DRAFT' ? 'Not requested' : pin ? 'Review script settings' : 'Script setup required',
        detail: issue ?? 'Loading behavior could not be resolved.',
        source: 'Not resolved',
      };
    }),
  };
}
