import {previewInput as previousInput} from '../runtime-3162/snapshot.mjs';
import {normalizeMappings, conditionalPlaceholders} from './conditional-settings.mjs';

/** New version only: preserve rule data separately from the frozen adapter. */
export function previewInput(snapshot, descriptor, timestamp, takeOver) {
  const copy = structuredClone(snapshot), config = JSON.parse(copy.config.config_json);
  const raw = Object.create(null);
  function extract(scope, rule) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw Error(`Invalid unit rule ${scope}.`);
    if (['__proto__', 'constructor', 'prototype'].includes(scope)) throw Error('Unsafe rule key.');
    if (Object.hasOwn(rule, 'conditionalMappings')) raw[scope] = rule.conditionalMappings;
    delete rule.conditionalMappings;
    return rule;
  }
  copy.rules = (copy.rules || []).map(row => ({...row, rule_json: JSON.stringify(extract(row.rule_key, JSON.parse(row.rule_json)))}));
  // Preserve the established basic/advanced precedence, including an explicit empty list.
  for (const [scope, rule] of Object.entries(config.advancedUnitRules || {})) extract(scope, rule);
  copy.config.config_json = JSON.stringify(config);
  const input = previousInput(copy, descriptor, timestamp, takeOver);
  const rules = Object.create(null);
  for (const [scope, mappings] of Object.entries(raw)) rules[scope] = normalizeMappings(mappings, scope, input.core.sizeMapsRaw);
  input.conditionalUnits = Object.create(null);
  for (const unit of input.core.explicitUnits) {
    const scopes = ['__DEFAULT__', unit.type === 'ATF' ? '__ATF__' : '__BTF__', unit.id];
    // UI order: descending priority, then default/group/exact and saved order.
    const list = scopes.flatMap(scope => rules[scope] || []).map((r, order) => ({...r, order}));
    list.sort((a,b) => b.priority-a.priority || a.order-b.order);
    if (!list.length) continue;
    if (unit.id === input.overlay?.code) throw Error(`${unit.id}: key-value rules currently support in-page Banner and Sticky positions. Keep TakeOver on its saved responsive map.`);
    if (input.outstream.disabledRefreshCodes.includes(unit.id)) throw Error(`${unit.id}: key-value map rules currently support Banner. Keep Outstream on its reviewed video size maps.`);
    const maps = [...new Set([unit.sizeMapName, ...list.map(r => r.sizeMapKey).filter(Boolean)])];
    input.conditionalUnits[unit.id] = {baseMap: unit.sizeMapName, maps, rules: list.map(({order,...r}) => r)};
  }
  input.conditionalCss = conditionalPlaceholders(input);
  return input;
}
