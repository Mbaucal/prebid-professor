import {hasRevenueSettings,requireRevenueRuntime as previousGuard} from '../runtime-318/settings-guard.mjs';
export {hasRevenueSettings};
export function requireRevenueRuntime(config,descriptor) {
  if (descriptor?.id === 'tessera-3.19.0' && descriptor.version === '3.19.0') return;
  previousGuard(config,descriptor);
}

export function requireCountryRules(snapshot, descriptor) {
  if (descriptor?.capabilities?.includes('country-rules')) return;
  const saved=JSON.parse(snapshot.config.config_json);
  const rules=new Map((snapshot.rules||[]).map(row=>[row.rule_key,JSON.parse(row.rule_json)?.conditionalMappings]));
  for(const [key,rule] of Object.entries(saved.advancedUnitRules||{}))if(rule&&Object.hasOwn(rule,'conditionalMappings'))rules.set(key,rule.conditionalMappings);
  for(const [scope,mappings] of rules)if(Array.isArray(mappings)&&mappings.some(m=>m?.enabled!==false&&(scope==='__INTERSTITIAL__'||m?.conditions?.some(c=>c?.key?.trim()==='geo_country')))) {
    throw Error('Country and Interstitial fallback rules require script 3.19.0. Select 3.19.0 in Script setup and save. Your saved rules are kept.');
  }
}
