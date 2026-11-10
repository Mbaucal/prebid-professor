/** New version only: GPT prioritizes viewport width, then viewport height. */
const ascending = (a, b) => a.viewport[0] - b.viewport[0] || a.viewport[1] - b.viewport[1];
const cssId = code => '#' + code.replace(/([^A-Za-z0-9_-])/g, '\\$1');

export function normalizeSizeMaps(input) {
  const added = [];
  const names = Object.keys(input.core.sizeMapsRaw), reachable = new Set();
  for (const unit of input.core.explicitUnits) {
    reachable.add(unit.sizeMapName);
    for (const name of names) if (name.endsWith('_' + unit.sizeMapName)) reachable.add(name);
    for (const name of input.conditionalUnits[unit.id]?.maps || []) reachable.add(name);
  }
  for (const [name, rows] of Object.entries(input.core.sizeMapsRaw)) {
    const seen = new Set();
    for (const row of rows) {
      const key = row.viewport.join('x');
      if (reachable.has(name) && seen.has(key)) throw Error(`Size map ${name} has duplicate viewport ${key}. Keep one row for each width and height pair.`);
      seen.add(key);
    }
    // A map's minimum viewport is a real lower bound, not permission to use
    // the union from defineSlot/adUnit.sizes when no row fits.
    if (!seen.has('0x0')) {
      rows.push({viewport: [0, 0], sizes: []});
      added.push(name);
    }
    rows.sort(ascending);
  }
  input.sizeMapNormalization = {emptyBaselineAdded: added};
  input.viewportMapNames = Object.keys(input.core.sizeMapsRaw);
}

function rulesFor(selector, rows) {
  const blocks = [`${selector}{min-height:0;}`];
  for (const row of [...rows].sort(ascending)) {
    const [width, height] = row.viewport;
    const reserved = Math.max(0, ...row.sizes.filter(Array.isArray).map(size => size[1]));
    const rule = `${selector}{min-height:${reserved}px;}`;
    const query = [width ? `(min-width:${width}px)` : '', height ? `(min-height:${height}px)` : ''].filter(Boolean).join(' and ');
    blocks.push(query ? `@media${query}{${rule}}` : rule);
  }
  return blocks;
}

/** CSS and runtime use the same map, row priority and explicit empty fallback. */
export function placeholderStyles(input) {
  const blocks = ['/* Responsive reserved height from fixed Sizes; not a creative height limit. Sticky and TakeOver are excluded. */'];
  for (const unit of input.core.explicitUnits) {
    if ([input.options.sticky.bottomAdUnitId, input.overlay?.code].includes(unit.id)) continue;
    const selector = cssId(unit.id), base = unit.sizeMapName;
    // Keep the saved base reservation before the script knows page/category/GEO.
    blocks.push(...rulesFor(selector, input.core.sizeMapsRaw[base]));
    const conditional = input.conditionalUnits[unit.id];
    const possible = new Set([base, ...(conditional?.maps || []), ...input.viewportMapNames.filter(name => name.endsWith('_' + base))]);
    for (const name of possible) {
      const index = input.viewportMapNames.indexOf(name);
      blocks.push(...rulesFor(`${selector}[data-ad-size-map="${index}"]`, input.core.sizeMapsRaw[name]));
    }
    // Same specificity and last: an explicit disabled decision clears even a
    // previously tagged reservation. GEO pending leaves the base untouched.
    blocks.push(`${selector}[data-ad-rule-map="disabled"]{min-height:0;}`);
  }
  return blocks.join('\n') + '\n';
}
