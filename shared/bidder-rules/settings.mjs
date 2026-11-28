import {normalizeCountry} from '../geo-country.mjs';
import {validateAdUnitCode} from '../gam/ad-unit-code.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(Error(message), {status:422}); };
function keys(value, allowed, label) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${label}: use the displayed fields only.`);
}
function text(value, label, max=100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label}: enter 1–${max} characters.`);
  return value;
}
export function defaultBidderRules() { return {schemaVersion:1,enabled:false,rules:[]}; }

/** Validate saved policy, never a future visitor's country or page value. */
export function normalizeBidderRules(value = defaultBidderRules()) {
  keys(value,['schemaVersion','enabled','rules'],'Bidder rules');
  if (value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') fail('Unsupported bidder rule settings version.');
  if (!Array.isArray(value.rules) || value.rules.length > 200) fail('Use at most 200 bidder rules.');
  const ids = new Set(), defaults = new Set(), scopes = new Map();
  const rules = value.rules.map(row => {
    keys(row,['id','name','enabled','bidder','positions','countries','devices'],'Bidder rule');
    const id=text(row.id,'Rule ID',80),name=text(row.name,'Rule name',100),bidder=text(row.bidder,'Bidder code');
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) fail('Each rule needs a unique identifier.');
    ids.add(id);
    if (!/^[A-Za-z0-9_-]+$/.test(bidder)) fail('Use an exact configured bidder or alias code.');
    if (typeof row.enabled !== 'boolean') fail(`${name}: choose whether this rule is enabled.`);
    if (!Array.isArray(row.positions) || row.positions.length > 500) fail(`${name}: choose at most 500 positions.`);
    const positions=[...new Set(row.positions.map(code => {
      const errors=validateAdUnitCode(code); if(errors.length)fail(`${name}: ${errors.join(' ')}`); return code;
    }))];
    keys(row.countries,['mode','values','unknown'],`${name} countries`);
    if (!['all','include','exclude'].includes(row.countries.mode) || !['allow','skip'].includes(row.countries.unknown)) fail(`${name}: choose a country policy and unknown-country action.`);
    if (!Array.isArray(row.countries.values) || row.countries.values.length > 250) fail(`${name}: enter country codes separated by commas.`);
    const countries=[...new Set(row.countries.values.map(code => {
      const normalized=typeof code==='string'?normalizeCountry(code.trim().toUpperCase()):null;
      if(!normalized)fail(`${name}: ${typeof code==='string'&&code.length<=16?code:'Value'} is not a supported two-letter country code.`);
      return normalized;
    }))].sort();
    if(row.countries.mode!=='all'&&!countries.length)fail(`${name}: select at least one country, or choose All countries.`);
    if (!Array.isArray(row.devices) || !row.devices.length || row.devices.some(device=>!['mobile','tablet','desktop'].includes(device))) fail(`${name}: choose at least one device layout.`);
    const devices=['mobile','tablet','desktop'].filter(device=>row.devices.includes(device));
    if(row.enabled){
      if(!positions.length){if(defaults.has(bidder))fail(`${bidder}: use only one enabled rule for All positions.`);defaults.add(bidder);}
      else {const seen=scopes.get(bidder)||new Set();for(const code of positions){if(seen.has(code))fail(`${bidder}: position ${code} is in two enabled rules. Combine them or disable one.`);seen.add(code);}scopes.set(bidder,seen);}
    }
    return {id,name,enabled:row.enabled,bidder,positions,countries:{mode:row.countries.mode,values:countries,unknown:row.countries.unknown},devices};
  });
  return {schemaVersion:1,enabled:value.enabled,rules};
}

/** Shared by the saved-settings simulator and emitted browser runtime. ES2015, self-contained. */
export function evaluateBidderRule(settings, context) {
  var width=context.width, device=typeof width==='number'&&isFinite(width)&&width>0?(width<768?'mobile':width<1024?'tablet':'desktop'):'unknown';
  var country=typeof context.country==='string'&&/^[A-Z]{2}$/.test(context.country)?context.country:null;
  var policy=null, fallback=null;
  function result(allowed,reason){return {allowed:allowed,reason:reason,ruleId:policy?policy.id:null,ruleName:policy?policy.name:null,device:device,country:country};}
  if(!settings||!settings.enabled)return result(true,'disabled');
  (settings.rules||[]).some(function(rule){
    if(!rule.enabled||rule.bidder!==context.bidder)return false;
    if(!rule.positions.length)fallback=rule;
    else if(rule.positions.indexOf(context.code)!==-1){policy=rule;return true;}
    return false;
  });
  policy=policy||fallback;
  if(!policy)return result(true,'no-rule');
  if(device==='unknown'&&policy.devices.length!==3)return result(false,'layout-unknown');
  if(device!=='unknown'&&policy.devices.indexOf(device)===-1)return result(false,'layout-excluded');
  if(policy.countries.mode==='all')return result(true,'allowed');
  if(!country)return result(policy.countries.unknown==='allow',policy.countries.unknown==='allow'?'country-unknown-allowed':'country-unknown-skipped');
  var listed=policy.countries.values.indexOf(country)!==-1;
  return result(policy.countries.mode==='include'?listed:!listed,(policy.countries.mode==='include'?listed:!listed)?'allowed':'country-excluded');
}

export function requireBidderRulesRuntime(config, descriptor) {
  if(config?.enablePrebid===true&&config?.runtimeControls?.bidderRules?.enabled===true&&!descriptor?.capabilities?.includes('bidder-rules'))fail('Bidder rules require script 3.22.0 or later. Select a compatible script or turn off bidder rules. Your saved rules are kept.');
}
export function bidderRulesInput(snapshot) {
  const config=JSON.parse(snapshot.config.config_json),settings=normalizeBidderRules(config.runtimeControls?.bidderRules);
  return {...settings,enabled:config.enablePrebid===true&&settings.enabled};
}
