import { previewInput as referenceInput } from '../runtime/preview-snapshot.mjs';
import { readPositions, normalizeLazy } from './position-settings.mjs';

export function previewInput(snapshot, descriptor, timestamp, takeOver = {enabled:false}) {
  const saved = JSON.parse(snapshot.config.config_json);
  const positions = readPositions(saved, snapshot.units);
  if(Object.keys(positions).length&&saved.runtimeControls?.takeOver?.enabled)throw Error('Move the legacy TakeOver into Ad positions before generating.');
  const code = Object.keys(positions)[0];
  const row = snapshot.units.find(u=>u.code===code);
  const overlay = row?.enabled === 1 ? positions[code] : null;
  if (overlay && saved.runtimeControls?.sticky?.bottomAdUnitId === code) throw Error('TakeOver and bottom Sticky must use different positions.');
  // Validate all units, maps and bidder overrides with the unchanged reference
  // adapter first. Only lazy is handled by this version's additional compiler.
  const copy = structuredClone(snapshot);
  const config = JSON.parse(copy.config.config_json);
  const lazyRules = {}, rawLazy = {};
  function extract(key, rule) {
    if (Object.hasOwn(rule,'lazy')) {
      const value=rule.lazy;
      if(value!==null&&(!value||typeof value!=='object'||Array.isArray(value)))throw Error('Unsupported lazy-load rule.');
      rawLazy[key]=value===null?null:{...(rawLazy[key]??{}),...value};
    }
    delete rule.lazy;
    return rule;
  }
  copy.rules = copy.rules.map(r=>({...r,rule_json:JSON.stringify(extract(r.rule_key,JSON.parse(r.rule_json)))}));
  for (const [key,rule] of Object.entries(config.advancedUnitRules??{})) extract(key,rule);
  for(const [key,value] of Object.entries(rawLazy))lazyRules[key]=normalizeLazy(value);
  if(overlay&&lazyRules[code]?.enabled)throw Error('TakeOver opens once after consent; lazy rules apply to in-page positions.');
  copy.config.config_json = JSON.stringify(config);
  const input = referenceInput(copy,descriptor,timestamp,takeOver);
  input.lazyRules = lazyRules;
  input.overlay = null;
  if (overlay) {
    const unit = input.core.explicitUnits.find(u=>u.id===code);
    const maps = input.core.sizeMapsRaw[unit.sizeMapName];
    // A modal has one creative viewport. Empty rows disable it; one concrete
    // size per breakpoint keeps the auction, GAM slot and closing UI aligned.
    if (maps.some(r=>r.sizes.length>1 || r.sizes.some(s=>s==='fluid' || s[0]<2 || s[1]<2))) throw Error('TakeOver size maps need one numeric size per width, or an empty row to turn it off.');
    input.overlay = {code,unit,...overlay,maps};
    const mobile=maps.find(r=>r.sizes.length)?.sizes[0]??[300,250];
    input.options.takeOver = {enabled:true,adUnitCode:code,desktopMinWidth:overlay.desktopMinWidth,
      desktopSize:mobile,mobileSize:mobile,autoCloseDesktopSec:overlay.desktopSeconds,autoCloseMobileSec:overlay.mobileSeconds,
      showCountdown:overlay.countdown,codelessAdUnitPath:`${snapshot.site.gam_path}Interstitial`};
  } else if (code) input.options.takeOver={enabled:false};
  return input;
}
