import {validateAdUnitCode} from '../../shared/gam/ad-unit-code.mjs';
const scopes=new Set(['__DEFAULT__','__ATF__','__BTF__','__INTERSTITIAL__']);
const compiledInputs=new WeakMap();
const own=(value,key)=>value&&Object.hasOwn(value,key);
const renameKeys=(value,map)=>value&&typeof value==='object'&&!Array.isArray(value)
  ?Object.fromEntries(Object.entries(value).map(([key,child])=>[map.get(key)??key,child])):value;

/** Temporary, collision-free compiler identifiers never become saved/public IDs. */
export function encodeSnapshot(snapshot,takeOver) {
  const copy=structuredClone(snapshot),original=JSON.stringify([snapshot,takeOver]);
  let prefix='TesseraGamCode';while(original.includes(prefix))prefix+='X';
  const forward=new Map(),reverse=new Map(),seen=new Set();
  const config=JSON.parse(copy.config.config_json);
  function aliasCode(code) {
    if(typeof code!=='string'||forward.has(code))return;
    const alias=prefix+forward.size+'Z';forward.set(code,alias);reverse.set(alias,code);
  }
  for(const unit of copy.units??[]) {
    // Inactive saved rows are retained metadata, not emitted inventory. They
    // must not introduce a new Generate blocker merely by existing in a draft.
    if(unit.enabled===1&&unit.type!=='DRAFT') {
      const errors=validateAdUnitCode(unit.code);if(errors.length)throw Error(`${unit.code||'Ad unit'}: ${errors.join(' ')}`);
      if(seen.has(unit.code))throw Error(`Duplicate ad unit code: ${unit.code}.`);seen.add(unit.code);
    }
    aliasCode(unit.code);
  }
  // Legacy TakeOver is deliberately not a normal in-page inventory row.
  for(const legacy of [takeOver,config.runtimeControls?.takeOver])if(legacy&&own(legacy,'adUnitCode')) {
    if(legacy.enabled){const errors=validateAdUnitCode(legacy.adUnitCode);if(errors.length)throw Error(`TakeOver: ${errors.join(' ')}`);}
    aliasCode(legacy.adUnitCode);
  }
  const id=value=>forward.get(value)??value;
  const scope=value=>scopes.has(value)?value:id(value);
  copy.units=(copy.units??[]).map(unit=>({...unit,code:id(unit.code)}));
  copy.rules=(copy.rules??[]).map(row=>({...row,rule_key:scope(row.rule_key)}));
  copy.overrides=(copy.overrides??[]).map(row=>({...row,scope_key:['adunit','slot'].includes(row.scope_type)?id(row.scope_key):row.scope_key}));
  if(config.advancedUnitRules)config.advancedUnitRules=Object.fromEntries(Object.entries(config.advancedUnitRules).map(([key,value])=>[scope(key),value]));
  const runtime=config.runtimeControls??{};
  if(runtime.adPositions)runtime.adPositions=renameKeys(runtime.adPositions,forward);
  if(runtime.outstream?.units)runtime.outstream.units=renameKeys(runtime.outstream.units,forward);
  if(runtime.deals?.entries)runtime.deals.entries=runtime.deals.entries.map(entry=>({...entry,positions:entry.positions?.map(id)}));
  if(runtime.sticky)for(const key of ['bottomAdUnitId','topAdUnitId'])if(own(runtime.sticky,key))runtime.sticky[key]=id(runtime.sticky[key]);
  // Preserve the inherited conventional Sticky default while compiling aliases.
  if(!own(runtime.sticky,'bottomAdUnitId')&&(snapshot.units??[]).some(u=>u.code==='Sticky'&&u.enabled===1&&u.type!=='DRAFT')){
    runtime.sticky={...runtime.sticky,bottomAdUnitId:id('Sticky')};
  }
  if(runtime.takeOver?.adUnitCode)runtime.takeOver.adUnitCode=id(runtime.takeOver.adUnitCode);
  if(runtime.bidCache?.positionOverrides)runtime.bidCache.positionOverrides=renameKeys(runtime.bidCache.positionOverrides,forward);
  if(runtime.floors?.rules)runtime.floors.rules=renameKeys(runtime.floors.rules,forward);
  if(Object.keys(runtime).length)config.runtimeControls=runtime;
  copy.config.config_json=JSON.stringify(config);
  const legacy=structuredClone(takeOver);if(legacy?.adUnitCode)legacy.adUnitCode=id(legacy.adUnitCode);
  return {snapshot:copy,takeOver:legacy,forward,reverse,prefix};
}
export function decodeValue(value,reverse) {
  if(typeof value==='string')return reverse.get(value)??value;
  if(Array.isArray(value))return value.map(child=>decodeValue(child,reverse));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,child])=>[reverse.get(key)??key,decodeValue(child,reverse)]));
  return value;
}
export function rememberInput(publicInput,safeInput,identity) {compiledInputs.set(publicInput,{safeInput,identity});return publicInput;}
export function compilationInput(input) {
  const result=compiledInputs.get(input);if(!result)throw Error('GAM code compiler requires its validated snapshot input.');return result;
}
