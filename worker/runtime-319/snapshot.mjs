import {previewInput as previousInput} from '../runtime-318/snapshot.mjs';
import {normalizeMappings} from '../runtime-317/conditional-settings.mjs';
import {normalizeCountry} from '../../shared/geo-country.mjs';

export const INTERSTITIAL_SCOPE = '__INTERSTITIAL__';
export function countryMappings(mappings, scope, maps) {
  const rules = normalizeMappings(mappings, scope, maps);
  for (const rule of rules) for (const condition of rule.conditions) {
    if (condition.key !== 'geo_country') continue;
    if (!['equals','notEquals','exists','notExists'].includes(condition.operator)) throw Error(`${scope}: country conditions use equals, does not equal, exists or does not exist.`);
    if (['equals','notEquals'].includes(condition.operator)) {
      const country = normalizeCountry(condition.value.toUpperCase());
      if (!country) throw Error(`${scope}: enter a two-letter country code such as RS or DE.`);
      condition.value = country;
    }
  }
  return rules;
}
export function previewInput(snapshot, descriptor, timestamp, takeOver, countryTarget = 'main') {
  const copy = structuredClone(snapshot), saved = JSON.parse(copy.config.config_json);
  let fallback = {};
  copy.rules = (copy.rules || []).filter(row => {
    if (row.rule_key !== INTERSTITIAL_SCOPE) return true;
    fallback = JSON.parse(row.rule_json); return false;
  });
  if (saved.advancedUnitRules?.[INTERSTITIAL_SCOPE]) {
    fallback = {...fallback, ...saved.advancedUnitRules[INTERSTITIAL_SCOPE]};
    delete saved.advancedUnitRules[INTERSTITIAL_SCOPE];
  }
  copy.config.config_json = JSON.stringify(saved);
  const input = previousInput(copy, descriptor, timestamp, takeOver, countryTarget);
  for (const [code, setting] of Object.entries(input.conditionalUnits)) {
    // The inherited adapter has validated maps, scopes and priority order already.
    setting.rules = countryMappings(setting.rules.map(r=>({...r,enabled:true})), code, input.core.sizeMapsRaw);
    setting.usesGeo = setting.rules.some(r=>r.conditions.some(c=>c.key==='geo_country'));
  }
  if (['timeout','lazy','refresh'].some(key=>fallback[key]!=null)) throw Error('Interstitial fallback supports conditional slot actions only.');
  const rules = countryMappings(fallback.conditionalMappings, 'Interstitial fallback', input.core.sizeMapsRaw);
  if (rules.some(rule=>rule.sizeMapKey)) throw Error('Interstitial fallback uses Google responsive sizes. Choose a slot action without a size map.');
  rules.sort((a,b)=>b.priority-a.priority);
  input.interstitialRules = {rules, usesGeo:rules.some(r=>r.conditions.some(c=>c.key==='geo_country'))};
  input.countrySignal = {...input.countrySignal, targetingKey:'geo_country', rulesVersion:1};
  return input;
}
