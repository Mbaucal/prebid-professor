/** TEST candidate configuration, never publisher setup or a publishing endpoint.
 * Only test-site is writable; arbitrary site IDs, source, integrations and Prebid
 * uploads are not part of this contract. No fetching, SQL, or code execution here.
 */
import { digest } from '../runtime/preview-snapshot.mjs';
import { WorkspaceError, TEST_SITE } from './boundary.mjs';
import { normalizeTakeOver, savedTakeOver } from './takeover-settings.mjs';
import { readPositions, normalizeOverlay, normalizeLazy } from '../runtime-next/position-settings.mjs';
const forbidden = new Set(['__proto__','prototype','constructor']);
const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const markerKey = 'testSiteDraft';
const fail = (message,status=422) => { throw new WorkspaceError(status,message); };
function record(value,keys,label) {
  if (!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) fail(`${label} must be an object.`);
  const actual=Object.keys(value);
  if (actual.length!==keys.length || actual.some((key)=>!keys.includes(key))) fail(`Unexpected ${label} fields.`);
  for(const key of actual) if(!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')) fail(`Invalid ${label} field.`);
}
function text(value,max,label) { if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))fail(`Check ${label}.`);return value.trim(); }
function identifier(value,label) { if(typeof value!=='string'||!namePattern.test(value)||forbidden.has(value.toLowerCase()))fail(`Use a unique letter, number, dash or underscore ${label}.`);return value; }
function array(value,max,label,min=1) { if(!Array.isArray(value)||value.length<min||value.length>max)fail(`${label}: use ${min}–${max} rows.`);return value; }
export function normalizeDraftSite(site) {
  record(site,['name','domain','gamPath'],'site');
  const name=text(site.name,120,'site name');
  const domain=text(site.domain,253,'domain').toLowerCase();
  const labels=domain.split('.');
  if(labels.length<2||labels.some((l)=>!l.length||l.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(l))||!/[a-z]/.test(labels.at(-1)))fail('Enter a domain only, without https://, a port or a path.');
  const raw=text(site.gamPath,512,'GAM path');
  const gamPath='/'+raw.replace(/^\/+|\/+$/g,'')+'/';
  if(!/^\/[0-9]{1,20}\/(?:[A-Za-z0-9_.-]{1,100}\/)+$/.test(gamPath)||gamPath.split('/').some((v)=>v==='.'||v==='..'))fail('Use the complete GAM path, for example /123/site/.');
  return {name,domain,gamPath};
}
export function assertWorkspaceSiteScope(saved) {
  let config;try{config=JSON.parse(saved?.config?.config_json);}catch{fail('Saved TEST configuration needs review.',409);}
  if(saved?.site?.id!==TEST_SITE || !config || typeof config!=='object' || Array.isArray(config)
    || typeof config.enablePrebid!=='boolean' || !Array.isArray(saved.bidders) || !Array.isArray(saved.overrides))fail('Only the isolated TEST draft is supported.',409);
  const withPrebid=config.enablePrebid||saved.bidders.length||saved.overrides.length||(saved.prebidBuilds||[]).length;
  if(withPrebid && (config.testPrebidDraft?.schemaVersion!==1||config.testPrebidDraft?.candidateOnly!==true||!config.builtinRuntimeSelection?.runtime))fail('Save Prebid settings through the TEST editor first.',409);
  if((saved.prebidBuilds||[]).length>1)fail('Choose exactly one current TEST Prebid file.',409);
  const synthetic=saved.site.domain==='example.invalid'&&saved.site.gam_path==='/123/test/';
  if(!synthetic) {
    if(config[markerKey]?.schemaVersion!==1||config[markerKey]?.candidateOnly!==true||!config.builtinRuntimeSelection)fail('Save this site through the TEST editor and select an exact runtime first.',409);
    try{normalizeDraftSite({name:saved.site.name,domain:saved.site.domain,gamPath:saved.site.gam_path});}catch{fail('Saved TEST site identity needs review.',409);}
  }
  return config;
}
export function normalizeSiteDraft(draft) {
  record(draft,['site','units','maps','bottomStickyId',...(Object.hasOwn(draft??{},'takeOver')?['takeOver']:[])],'draft');
  const takeOver=Object.hasOwn(draft,'takeOver')?normalizeTakeOver(draft.takeOver):undefined;
  const site=normalizeDraftSite(draft.site), names=new Set();
  const maps=array(draft.maps,32,'Size maps').map((map)=>{
    record(map,['name','breakpoints'],'size map');const name=identifier(map.name,'map name');
    if(names.has(name))fail('Size map names must be unique.');names.add(name);
    const widths=new Set();
    const breakpoints=array(map.breakpoints,12,'Breakpoints').map((row)=>{
      record(row,['minWidth','sizes'],'breakpoint');
      if(!Number.isInteger(row.minWidth)||row.minWidth<0||row.minWidth>10000||widths.has(row.minWidth))fail('Breakpoint widths must be unique whole numbers between 0 and 10000.');widths.add(row.minWidth);
      const sizes=array(row.sizes,32,'Sizes',0).map((pair)=>{
        if(pair==='fluid')return pair;
        if(!Array.isArray(pair)||pair.length!==2||!pair.every((n)=>Number.isInteger(n)&&n>0&&n<=10000))fail('Use sizes such as 300x250 or fluid.');return [...pair];
      });
      if(new Set(sizes.map(JSON.stringify)).size!==sizes.length)fail('Remove repeated sizes in a breakpoint.');
      return {minWidth:row.minWidth,sizes};
    }).sort((a,b)=>a.minWidth-b.minWidth);
    if(!widths.has(0))fail('Each map needs a 0px base breakpoint.');
    return {name,breakpoints};
  }).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  const ids=new Set();
  const units=array(draft.units,100,'Ad positions').map((unit)=>{
    record(unit,['code','type','sizeMap','enabled',...['display','overlay','lazy'].filter(k=>Object.hasOwn(unit,k))],'ad position');const code=identifier(unit.code,'ad position ID');
    const integrated=unit.display==='takeover';
    if(unit.display!==undefined&&!['standard','sticky','takeover'].includes(unit.display))fail('Choose Standard, Sticky or TakeOver.');
    if(ids.has(code)||code==='Interstitial'||(!integrated&&unit.type!=='DRAFT'&&(code==='TakeOver'||code===takeOver?.adUnitCode))||code.startsWith('adsx-')||code.startsWith('close_sticky'))fail('Ad position IDs must be unique. TakeOver and its Interstitial fallback need separate GAM ad units.');ids.add(code);
    if(!['ATF','BTF','DRAFT'].includes(unit.type)||typeof unit.enabled!=='boolean')fail('Choose ATF/BTF/DRAFT and an enabled state for each position.');
    if(unit.type==='DRAFT'&&unit.display&&unit.display!=='standard')fail('Choose ATF or BTF before enabling Sticky or TakeOver display.');
    if(!names.has(unit.sizeMap))fail('Every ad position must reference an existing size map.');
    if(unit.enabled&&!maps.find((m)=>m.name===unit.sizeMap).breakpoints.some((r)=>r.sizes.length))fail('An enabled ad position needs at least one size.');
    let overlay,lazy;
    try{if(integrated)overlay=normalizeOverlay(unit.overlay);else if(unit.overlay!==undefined)fail('Only TakeOver positions have overlay settings.');if(Object.hasOwn(unit,'lazy'))lazy=normalizeLazy(unit.lazy);}catch(error){fail(error.message);}
    if(integrated){
      if(!unit.enabled)fail('Enable the TakeOver ad position, or explicitly change its display to Standard before disabling it.');
      if(takeOver?.enabled)fail('Move the saved legacy TakeOver into this position before saving.');
      if(lazy?.enabled)fail('TakeOver opens once after consent; lazy rules apply to in-page positions.');
      if(maps.find(m=>m.name===unit.sizeMap).breakpoints.some(r=>r.sizes.length>1||r.sizes.some(s=>s==='fluid'||s[0]<2||s[1]<2)))fail('TakeOver maps need one numeric size per width, or an empty row to turn it off.');
    }
    return {code,type:unit.type,sizeMap:unit.sizeMap,enabled:unit.enabled,...(unit.display!==undefined?{display:unit.display}:{}),...(overlay?{overlay}:{}),...(Object.hasOwn(unit,'lazy')?{lazy}:{})};
  });
  if(!units.some((u)=>u.enabled&&u.type!=='DRAFT'))fail('Keep at least one enabled ad position.');
  const bottomStickyId=draft.bottomStickyId;
  if(typeof bottomStickyId!=='string'||(bottomStickyId&&!units.some((u)=>u.code===bottomStickyId&&u.enabled&&u.type!=='DRAFT')))fail('Choose an enabled position for bottom sticky, or leave it off.');
  if(takeOver?.adUnitCode==='Interstitial')fail('TakeOver must use a different GAM ad unit from its Interstitial fallback.');
  if(units.filter(u=>u.display==='takeover').length>1)fail('Use one TakeOver position per site.');
  if(units.some(u=>u.display==='takeover'&&u.code===bottomStickyId))fail('TakeOver cannot also be bottom Sticky.');
  if(units.some(u=>u.display==='sticky'&&(u.code!==bottomStickyId||!u.enabled)))fail('Choose one enabled bottom Sticky position.');
  return {site,units,maps,bottomStickyId,...(takeOver?{takeOver}:{})};
}
export function readSiteDraft(saved) {
  const config=assertWorkspaceSiteScope(saved);
  let positions;try{positions=readPositions(config,saved.units);}catch(error){fail(error.message,409);}
  let maps;
  try{maps=saved.maps.map((map)=>({name:map.name,breakpoints:JSON.parse(map.map_json).map((row)=>{
    const vp=row.viewport??row.minViewPort;
    if(!Array.isArray(vp)||vp.length!==2||vp[1]!==0)fail('This editor supports width-based size maps only.',409);
    return {minWidth:vp[0],sizes:row.sizes};
  })}));}catch(error){if(error instanceof WorkspaceError)throw error;fail('Saved size maps need review.',409);}
  const draft={site:{name:saved.site.name,domain:saved.site.domain,gamPath:saved.site.gam_path},
    units:saved.units.map((u)=>{if(u.media_type!=='banner')fail('This editor supports banner positions only.',409);
      const basic=JSON.parse(saved.rules.find(r=>r.rule_key===u.code)?.rule_json??'{}');
      const advanced=config.advancedUnitRules?.[u.code]??{};
      const lazy=Object.hasOwn(advanced,'lazy')?advanced.lazy:basic.lazy;
      return {code:u.code,type:u.type,sizeMap:u.size_map_key,enabled:u.enabled===1,
        ...(positions[u.code]?{display:'takeover',overlay:positions[u.code]}:{}),...(lazy!==undefined?{lazy}:{})};}),
    maps,takeOver:savedTakeOver(config),bottomStickyId:Object.hasOwn(config.runtimeControls?.sticky??{},'bottomAdUnitId')
      ? (config.runtimeControls.sticky.bottomAdUnitId||'') : (saved.units.some((u)=>u.enabled===1&&u.code==='Sticky')?'Sticky':'')};
  return normalizeSiteDraft(draft);
}
export async function planSiteDraft(saved,input) {
  record(input,['expectedRevision','acknowledge','draft'],'request');
  if(input.acknowledge!==true)fail('Confirm these changes are for a TEST draft only.');
  if(typeof input.expectedRevision!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedRevision))fail('Reload saved settings before saving.',409);
  const draft=normalizeSiteDraft(input.draft), before=structuredClone(saved),config=assertWorkspaceSiteScope(before);
  if(!config.builtinRuntimeSelection)fail('Choose and save an exact script version before editing the site.',409);
  const expected=input.expectedRevision;
  // Report a stale tab before interpreting its removed units against the newer
  // saved rules. The transaction still rechecks every row before writing.
  if(await digest(before)!==expected)fail('Settings changed. Reload saved settings before trying again.',409);
  const unitCodes=new Set(draft.units.map((u)=>u.code));
  for(const key of [...before.rules.map((r)=>r.rule_key),...Object.keys(config.advancedUnitRules??{})]){
    if(!['__DEFAULT__','__ATF__','__BTF__'].includes(key)&&!unitCodes.has(key))fail('A removed position still has saved rules. Keep it disabled until its rules are reviewed.');
  }
  for(const override of before.overrides){
    if(override.scope_type==='adunit'&&override.enabled===1&&!draft.units.some((u)=>u.code===override.scope_key&&u.enabled))fail('An enabled bidder override uses this position. Disable or remove that override first.');
  }
  config.runtimeControls??={};config.runtimeControls.sticky??={};config.runtimeControls.sticky.bottomAdUnitId=draft.bottomStickyId;
  const previousPositions=readPositions(config,before.units);
  for(const unit of draft.units){
    if(previousPositions[unit.code]&&unit.display===undefined)fail('Reload the ad position editor before changing these settings.',409);
  }
  const positions=Object.fromEntries(draft.units.filter(u=>u.display==='takeover').map(u=>[u.code,u.overlay]));
  if(Object.keys(positions).length||Object.hasOwn(config.runtimeControls,'adPositions'))config.runtimeControls.adPositions=positions;
  for(const unit of draft.units)if(Object.hasOwn(unit,'lazy')){
    config.advancedUnitRules??={};config.advancedUnitRules[unit.code]??={};config.advancedUnitRules[unit.code].lazy=unit.lazy;
  }
  if(draft.takeOver)config.runtimeControls.takeOver=draft.takeOver;
  // Older editor tabs omit TakeOver; retain it and still validate position collisions.
  if(afterTakeOverConflict(draft,config))fail('TakeOver needs a separate GAM ad unit, outside the regular ad positions.');
  config[markerKey]={schemaVersion:1,candidateOnly:true};
  const after={...before,site:{id:TEST_SITE,name:draft.site.name,domain:draft.site.domain,gam_path:draft.site.gamPath},
    config:{config_json:JSON.stringify(config)},
    units:draft.units.map((u,index)=>({code:u.code,type:u.type,media_type:'banner',size_map_key:u.sizeMap,enabled:u.enabled?1:0,sort_order:index})),
    maps:draft.maps.map((m)=>({name:m.name,map_json:JSON.stringify(m.breakpoints.map((r)=>({viewport:[r.minWidth,0],sizes:r.sizes})))}))};
  if(await digest(before)!==expected)fail('Settings changed. Reload saved settings before trying again.',409);
  return {before,after,draft,changed:await digest(before)!==await digest(after)};
}
function afterTakeOverConflict(draft,config){const takeover=savedTakeOver(config);return takeover.adUnitCode==='Interstitial'||draft.units.some(u=>u.type!=='DRAFT'&&u.code===takeover.adUnitCode&&u.display!=='takeover');}
