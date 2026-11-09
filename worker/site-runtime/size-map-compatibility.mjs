/** Admin preflight only: preserve historical compiler inputs and saved maps. */
export function assertSizeMapCompatibility(snapshot, descriptor) {
  const config = JSON.parse(snapshot.config.config_json);
  const supportsHeight = descriptor?.capabilities?.includes('viewport-height-size-maps');
  const maps = new Map((snapshot.maps ?? []).map(row => [row.name, row.map_json]));
  const rules = new Map((snapshot.rules ?? []).map(row => [row.rule_key, JSON.parse(row.rule_json)]));
  for (const [scope, advanced] of Object.entries(config.advancedUnitRules ?? {})) {
    rules.set(scope, {...rules.get(scope), ...advanced});
  }
  const takeoverCodes = new Set(Object.keys(config.runtimeControls?.adPositions ?? {}));
  const issues = [];
  for (const unit of snapshot.units ?? []) {
    if (unit.enabled !== 1 || unit.type === 'DRAFT') continue;
    const responsiveVideo = config.enablePrebid === true
      && config.runtimeControls?.outstream?.units?.[unit.code]?.playerSizing === 'size-map'
      && config.runtimeControls.outstream.units[unit.code].format !== 'banner';
    if (supportsHeight && !responsiveVideo) continue;
    // TakeOver has always used both viewport dimensions; keep that supported path.
    if (takeoverCodes.has(unit.code) && !responsiveVideo) continue;
    const names = new Set([...maps.keys()].filter(name => name === unit.size_map_key || name.endsWith('_' + unit.size_map_key)));
    for (const scope of ['__DEFAULT__', unit.type === 'ATF' ? '__ATF__' : '__BTF__', unit.code]) {
      const mappings = rules.get(scope)?.conditionalMappings;
      if (!Array.isArray(mappings)) continue;
      for (const mapping of mappings) {
        if (mapping?.enabled === true && mapping.sizeMapKey) names.add(mapping.sizeMapKey);
      }
    }
    for (const name of names) {
      let rows;
      try { rows = JSON.parse(maps.get(name)); } catch { continue; }
      if (!Array.isArray(rows)) continue;
      rows.forEach((row, index) => {
        const viewport = row?.minViewPort ?? row?.viewport;
        if (!Array.isArray(viewport) || !Number.isInteger(viewport[1]) || viewport[1] <= 0) return;
        issues.push(`${unit.code}: map ${name}, row ${index + 1} requires browser height ${viewport[1]}px${responsiveVideo ? ' (responsive Outstream supports width conditions only)' : ''}`);
      });
    }
  }
  if (!issues.length) return;
  const shown = issues.slice(0, 12);
  if (issues.length > shown.length) shown.push(`${issues.length - shown.length} more affected rows`);
  throw new Error(`Script ${descriptor?.version ?? 'selected'} cannot use these viewport-height conditions: ${shown.join('; ')}. Browser viewport height is not reserved ad height. Reserved CSS height is derived from Sizes. For Banner or Sticky, select script 3.20.0 or later with viewport-height support. If a height condition was unintended, explicitly set it to 0 in Size maps. Responsive Outstream still requires width-only maps. Your saved values are kept.`);
}
