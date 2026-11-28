const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
const OPERATORS = new Set(['equals', 'notEquals', 'contains', 'notContains', 'exists', 'notExists']);
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = message => { throw new Error(message); };

/** Validate the saved rule, never the publisher's future page values. */
export function normalizeMappings(value, scope, maps) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100) fail(`${scope}: use up to 100 key-value mappings.`);
  return value.flatMap((mapping, index) => {
    const label = `${scope}, mapping ${index + 1}`;
    if (!record(mapping) || typeof mapping.enabled !== 'boolean') fail(`${label}: Enabled must be on or off.`);
    // Disabled draft mappings cannot block generation or affect delivery.
    if (!mapping.enabled) return [];
    if (!Number.isInteger(mapping.priority) || mapping.priority < 0 || mapping.priority > 10000) fail(`${label}: priority must be 0–10000.`);
    if (!['all', 'any'].includes(mapping.match)) fail(`${label}: choose ALL or ANY conditions.`);
    if (!['inherit', 'enable', 'disable'].includes(mapping.slotAction)) fail(`${label}: invalid slot action.`);
    const map = mapping.sizeMapKey;
    if (map != null && (typeof map !== 'string' || BLOCKED.has(map) || !Object.hasOwn(maps, map))) fail(`${label}: selected size map does not exist.`);
    if (!map && mapping.slotAction === 'inherit') fail(`${label}: choose a size map or a slot action.`);
    if (!Array.isArray(mapping.conditions) || !mapping.conditions.length || mapping.conditions.length > 12) fail(`${label}: use 1–12 conditions.`);
    const conditions = mapping.conditions.map(condition => {
      if (!record(condition) || typeof condition.key !== 'string' || !condition.key.trim() || BLOCKED.has(condition.key.trim()) || !OPERATORS.has(condition.operator)) fail(`${label}: invalid key or operator.`);
      const needsValue = !['exists', 'notExists'].includes(condition.operator);
      if (needsValue && (typeof condition.value !== 'string' || !condition.value.trim())) fail(`${label}: enter a condition value.`);
      return {key: condition.key.trim(), operator: condition.operator, value: needsValue ? condition.value.trim() : ''};
    });
    return [{priority: mapping.priority, match: mapping.match, conditions, sizeMapKey: map || null, slotAction: mapping.slotAction}];
  });
}

export function conditionalPlaceholders(input) {
  const blocks = [];
  for (const [code, setting] of Object.entries(input.conditionalUnits)) {
    if (code === input.options.sticky.bottomAdUnitId) continue;
    const id = '#' + code.replace(/([^A-Za-z0-9_-])/g, '\\$1');
    blocks.push(`${id}[data-ad-rule-map="disabled"]{min-height:0;}`);
    setting.maps.forEach((name, index) => {
      const selector = `${id}[data-ad-rule-map="${index}"]`;
      blocks.push(`${selector}{min-height:0;}`);
      const widths = new Set();
      for (const row of input.core.sizeMapsRaw[name]) {
        const [width, height] = row.viewport;
        if (height !== 0 || widths.has(width)) fail(`${code}: map ${name} needs unique width breakpoints with minimum viewport height 0.`);
        widths.add(width);
        const minHeight = Math.max(0, ...row.sizes.filter(Array.isArray).map(s => s[1]));
        const rule = `${selector}{min-height:${minHeight}px;}`;
        blocks.push(width ? `@media(min-width:${width}px){${rule}}` : rule);
      }
    });
  }
  return blocks.join('\n');
}
