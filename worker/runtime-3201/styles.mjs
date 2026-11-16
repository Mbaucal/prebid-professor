/** New version only: GPT prioritizes viewport width, then viewport height. */
const ascending = (a, b) => a.viewport[0] - b.viewport[0] || a.viewport[1] - b.viewport[1];
import {escapeCssId as cssId} from '../../shared/gam/ad-unit-code.mjs';

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
