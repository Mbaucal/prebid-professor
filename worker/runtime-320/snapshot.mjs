import {previewInput as previousInput} from '../runtime-3162/snapshot.mjs';
import {COUNTRY_ENDPOINTS} from '../runtime-318/snapshot.mjs';
import {countryMappings, INTERSTITIAL_SCOPE} from '../runtime-319/snapshot.mjs';
import {normalizeSizeMaps, placeholderStyles} from './size-maps.mjs';

/** Adapt a private copy; historical sources and the stored settings stay exact. */
export function previewInput(snapshot, descriptor, timestamp, takeOver, countryTarget = 'main') {
  if (!Object.hasOwn(COUNTRY_ENDPOINTS, countryTarget)) throw Error('Unknown country service target.');
  const copy = structuredClone(snapshot), saved = JSON.parse(copy.config.config_json);
  const raw = Object.create(null);
  let fallback = {};
  function extract(scope, rule) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw Error(`Invalid unit rule ${scope}.`);
    if (['__proto__', 'constructor', 'prototype'].includes(scope)) throw Error('Unsafe rule key.');
    if (Object.hasOwn(rule, 'conditionalMappings')) raw[scope] = rule.conditionalMappings;
    delete rule.conditionalMappings;
    return rule;
  }
  copy.rules = (copy.rules || []).filter(row => {
    if (row.rule_key !== INTERSTITIAL_SCOPE) return true;
    fallback = JSON.parse(row.rule_json); return false;
  }).map(row => ({...row, rule_json: JSON.stringify(extract(row.rule_key, JSON.parse(row.rule_json)))}));
  if (saved.advancedUnitRules?.[INTERSTITIAL_SCOPE]) {
    fallback = {...fallback, ...saved.advancedUnitRules[INTERSTITIAL_SCOPE]};
    delete saved.advancedUnitRules[INTERSTITIAL_SCOPE];
  }
  // Match existing basic/advanced precedence, including an explicit empty list.
  for (const [scope, rule] of Object.entries(saved.advancedUnitRules || {})) extract(scope, rule);
  copy.config.config_json = JSON.stringify(saved);
  const inactive = new Set((copy.units || []).filter(unit => (unit.enabled !== 1 || unit.type === 'DRAFT') && /^[A-Za-z][A-Za-z0-9_:-]*$/.test(unit.code) && !['__proto__', 'constructor', 'prototype'].includes(unit.code)).map(unit => unit.code));
  copy.overrides = (copy.overrides || []).filter(row => row.scope_type !== 'adunit' || !inactive.has(row.scope_key) || ['__proto__', 'constructor', 'prototype'].includes(row.bidder));
  const input = previousInput(copy, descriptor, timestamp, takeOver);
  const rules = Object.create(null);
  for (const [scope, mappings] of Object.entries(raw)) rules[scope] = countryMappings(mappings, scope, input.core.sizeMapsRaw);
  input.conditionalUnits = Object.create(null);
  for (const unit of input.core.explicitUnits) {
    const scopes = ['__DEFAULT__', unit.type === 'ATF' ? '__ATF__' : '__BTF__', unit.id];
    const list = scopes.flatMap(scope => rules[scope] || []).map((rule, order) => ({...rule, order}));
    list.sort((a, b) => b.priority - a.priority || a.order - b.order);
    if (!list.length) continue;
    if (unit.id === input.overlay?.code) throw Error(`${unit.id}: key-value rules currently support in-page Banner and Sticky positions. Keep TakeOver on its saved responsive map.`);
    if (input.outstream.disabledRefreshCodes.includes(unit.id)) throw Error(`${unit.id}: key-value map rules currently support Banner. Keep Outstream on its reviewed video size maps.`);
    const maps = [...new Set([unit.sizeMapName, ...list.map(rule => rule.sizeMapKey).filter(Boolean)])];
    const normalized = list.map(({order, ...rule}) => rule);
    input.conditionalUnits[unit.id] = {baseMap: unit.sizeMapName, maps, rules: normalized,
      usesGeo: normalized.some(rule => rule.conditions.some(condition => condition.key === 'geo_country'))};
  }
  if (['timeout', 'lazy', 'refresh'].some(key => fallback[key] != null)) throw Error('Interstitial fallback supports conditional slot actions only.');
  const fallbackRules = countryMappings(fallback.conditionalMappings, 'Interstitial fallback', input.core.sizeMapsRaw);
  if (fallbackRules.some(rule => rule.sizeMapKey)) throw Error('Interstitial fallback uses Google responsive sizes. Choose a slot action without a size map.');
  fallbackRules.sort((a, b) => b.priority - a.priority);
  input.interstitialRules = {rules: fallbackRules, usesGeo: fallbackRules.some(rule => rule.conditions.some(condition => condition.key === 'geo_country'))};
  input.countrySignal = {version: 1, endpoint: COUNTRY_ENDPOINTS[countryTarget], timeoutMs: 1500,
    scope: 'document', blocking: false, storage: 'memory', targetingKey: 'geo_country', rulesVersion: 1};
  normalizeSizeMaps(input);
  input.conditionalCss = placeholderStyles(input);
  return input;
}
