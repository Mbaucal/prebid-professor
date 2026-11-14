import {normalizeOutstream as normalizeV2,outstreamContext} from './settings-v2.mjs';
export {outstreamContext};
export {hasEnabledOutstream} from './settings.mjs';
const fail=message=>{throw Object.assign(Error(message),{status:422});};
const sizingFail=message=>{throw Object.assign(Error(message),{status:422,outstreamSizing:true});};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const same=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===2&&b.length===2&&a.every((n,i)=>n===b[i]);
export const eligiblePlayerSize=size=>Array.isArray(size)&&size.length===2&&size.every(n=>Number.isInteger(n)&&n>=144&&n<=1920);

/** The assigned map, including page-type variants, is the only source of dimensions. */
export function playerSizeMaps(code,context) {
  const unit=context.units.find(row=>row.code===code),base=unit?.size_map_key;
  if(!base)sizingFail(`${code}: assign a size map in Site and ad positions before configuring Outstream.`);
  const maps=(context.maps??[]).filter(map=>map.name===base||map.name.endsWith('_'+base));
  if(!maps.some(map=>map.name===base))sizingFail(`${code}: the assigned size map ${base} is missing.`);
  return maps.map(map=>{
    let rows;try{rows=JSON.parse(map.map_json);}catch{rows=null;}
    if(!Array.isArray(rows)||!rows.length)sizingFail(`${code}: repair size map ${map.name} before configuring Outstream.`);
    const keys=new Set();
    return {name:map.name,rows:rows.map(row=>{
      const viewport=row.minViewPort??row.viewport;
      if(!Array.isArray(viewport)||viewport.length!==2||!viewport.every(n=>Number.isInteger(n)&&n>=0)||!Array.isArray(row.sizes))sizingFail(`${code}: repair size map ${map.name} before configuring Outstream.`);
      if(viewport[1]!==0)sizingFail(`${code}: responsive Outstream currently supports width breakpoints only. Set minimum height to 0 in size map ${map.name} before using map-based video sizes.`);
      const key=map.name+'@'+viewport.join('x');
      if(keys.has(key))sizingFail(`${code}: size map ${map.name} has a duplicate breakpoint.`);keys.add(key);
      const sizes=row.sizes.filter(eligiblePlayerSize).filter((size,i,all)=>all.findIndex(other=>same(size,other))===i).map(size=>size.slice());
      return {key,viewport:viewport.slice(),disabled:row.sizes.length===0,sizes};
    }).sort((a,b)=>a.viewport[0]-b.viewport[0]||a.viewport[1]-b.viewport[1])};
  });
}
function resolveMaps(code,raw,context) {
  if(!record(raw.playerSizes))sizingFail(`${code}: reload the size-map choices before saving Outstream.`);
  const maps=playerSizeMaps(code,context),used=new Set(),choices={};
  let enabled=0;
  const resolved=maps.map(map=>({name:map.name,rows:map.rows.map(row=>{
    const label=`${code}: ${map.name}, minimum width ${row.viewport[0]}px`;
    if(row.disabled)return {viewport:row.viewport,playerSize:null};
    enabled++;
    if(!row.sizes.length)sizingFail(`${label} has no supported video size. Add a numeric size with width and height between 144 and 1920px to that map; banner-only sizes such as 728×90 and fluid cannot size this player.`);
    const selected=raw.playerSizes[row.key];
    if(selected!==undefined){
      if(!row.sizes.some(size=>same(size,selected)))sizingFail(`${label}: the saved video size is no longer in this map. Reopen Formats and choose an available size.`);
      used.add(row.key);
    }
    if(row.sizes.length>1&&!selected)sizingFail(`${label}: choose one of the available video sizes in Formats.`);
    const size=selected??row.sizes[0];
    if(row.sizes.length>1)choices[row.key]=size.slice();
    return {viewport:row.viewport,playerSize:size.slice()};
  })}));
  if(!enabled)sizingFail(`${code}: enable at least one size-map breakpoint before configuring Outstream.`);
  if(Object.keys(raw.playerSizes).some(key=>!used.has(key)))sizingFail(`${code}: size-map breakpoints changed. Reopen Formats and review the video size choices.`);
  return {resolved,choices};
}

/** New mode is opt-in; existing fixed playerSize settings retain preview.2 behavior. */
export function normalizeOutstream(value={schemaVersion:1,units:{}},context,{allowUnresolvedSizing=false}={}) {
  if(!record(value)||Object.keys(value).some(key=>!['schemaVersion','units'].includes(key))||value.schemaVersion!==1||!record(value.units))fail('Unsupported outstream settings version.');
  const units={};
  for(const [code,raw] of Object.entries(value.units)) {
    if(raw?.playerSizing!=='size-map'||raw.format==='banner') {
      Object.assign(units,normalizeV2({schemaVersion:1,units:{[code]:raw}},context).units);continue;
    }
    if(Object.keys(raw).some(key=>!['format','playerSizing','playerSizes','minDuration','maxDuration','playbackMethod','placement','plcmt','partner','cacheUrl'].includes(key)))fail(`${code}: use the displayed format settings only.`);
    const {playerSizing,playerSizes,...common}=raw;
    const unit=context.units.find(row=>row.code===code);
    // Reuse the frozen partner/display/consent-independent intent checks; this
    // temporary context is never persisted and does not alter any banner map.
    const normalized=normalizeV2({schemaVersion:1,units:{[code]:{...common,playerSize:[300,250]}}},{...context,
      maps:[{name:unit?.size_map_key,map_json:JSON.stringify([{viewport:[0,0],sizes:[[300,250]]}])}]}).units[code];
    const {playerSize,...rest}=normalized;
    let choices;
    try{choices=resolveMaps(code,raw,context).choices;}
    catch(error){
      if(!allowUnresolvedSizing||!error.outstreamSizing)throw error;
      // Draft editing may retain unresolved choices, never generate with them.
      // Non-sizing constraints above are checked for every unit regardless.
      choices=raw.playerSizes;
    }
    units[code]={...rest,playerSizing:'size-map',playerSizes:choices};
  }
  return {schemaVersion:1,units};
}
/** Display-only repair instructions; does not authorize a save or generation. */
export function outstreamSizingReview(value,context) {
  const issues=[];
  for(const [code,raw] of Object.entries(value?.units??{}))if(raw?.playerSizing==='size-map'&&raw.format!=='banner'){
    try{resolveMaps(code,raw,context);}catch(error){if(!error.outstreamSizing)throw error;issues.push({code,message:error.message});}
  }
  return issues;
}
export function buildOutstreamInput(snapshot) {
  const config=JSON.parse(snapshot.config.config_json);
  if(config.enablePrebid!==true)return {units:{},disabledRefreshCodes:[],cacheUrl:null};
  const context=outstreamContext(snapshot),normalized=normalizeOutstream(config.runtimeControls?.outstream,context);
  const units=Object.fromEntries(Object.entries(normalized.units).map(([code,settings])=>[code,settings.playerSizing==='size-map'
    ?{...settings,playerSizeMaps:resolveMaps(code,settings,context).resolved}:settings]));
  return {units,disabledRefreshCodes:Object.keys(units),cacheUrl:Object.values(units)[0]?.cacheUrl??null};
}
