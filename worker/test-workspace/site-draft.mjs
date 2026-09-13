/** TEST candidate configuration, never publisher setup or a publishing endpoint.
 * Only test-site is writable; arbitrary site IDs, source, integrations and Prebid
 * uploads are not part of this contract. No fetching, SQL, or code execution here.
 */
import { digest } from '../runtime/preview-snapshot.mjs';
import { WorkspaceError, TEST_SITE } from './boundary.mjs';
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
  record(draft,['site','units','maps','bottomStickyId'],'draft');
  const site=normalizeDraftSite(draft.site), names=new Set();
  const maps=array(draft.maps,32,'Size maps').map((map)=>{
    record(map,['name','breakpoints'],'size map');const name=identifier(map.name,'map name');
    if(names.has(name))fail('Size map names must be unique.');names.add(name);
    const widths=new Set();
    const breakpoints=array(map.breakpoints,12,'Breakpoints').map((row)=>{
      record(row,['minWidth','sizes'],'breakpoint');
      if(!Number.isInteger(row.minWidth)||row.minWidth<0||row.minWidth>10000||widths.has(row.minWidth))fail('Breakpoint widths must be unique whole numbers between 0 and 10000.');widths.add(row.minWidth);
      const sizes=array(row.sizes,12,'Sizes',0).map((pair)=>{
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
    record(unit,['code','type','sizeMap','enabled'],'ad position');const code=identifier(unit.code,'ad position ID');
    if(ids.has(code)||code==='TakeOver'||code.startsWith('adsx-')||code.startsWith('close_sticky'))fail('Ad position IDs must be unique; TakeOver is a separate module.');ids.add(code);
    if(!['ATF','BTF'].includes(unit.type)||typeof unit.enabled!=='boolean')fail('Choose ATF/BTF and an enabled state for each position.');
    if(!names.has(unit.sizeMap))fail('Every ad position must reference an existing size map.');
    if(unit.enabled&&!maps.find((m)=>m.name===unit.sizeMap).breakpoints.some((r)=>r.sizes.length))fail('An enabled ad position needs at least one size.');
    return {code,type:unit.type,sizeMap:unit.sizeMap,enabled:unit.enabled};
  });
  if(!units.some((u)=>u.enabled))fail('Keep at least one enabled ad position.');
  const bottomStickyId=draft.bottomStickyId;
  if(typeof bottomStickyId!=='string'||(bottomStickyId&&!units.some((u)=>u.code===bottomStickyId&&u.enabled)))fail('Choose an enabled position for bottom sticky, or leave it off.');
  return {site,units,maps,bottomStickyId};
}
export function readSiteDraft(saved) {
  const config=assertWorkspaceSiteScope(saved);
  let maps;
  try{maps=saved.maps.map((map)=>({name:map.name,breakpoints:JSON.parse(map.map_json).map((row)=>{
    const vp=row.viewport??row.minViewPort;
    if(!Array.isArray(vp)||vp.length!==2||vp[1]!==0)fail('This editor supports width-based size maps only.',409);
    return {minWidth:vp[0],sizes:row.sizes};
  })}));}catch(error){if(error instanceof WorkspaceError)throw error;fail('Saved size maps need review.',409);}
  const draft={site:{name:saved.site.name,domain:saved.site.domain,gamPath:saved.site.gam_path},
    units:saved.units.map((u)=>{if(u.media_type!=='banner')fail('This editor supports banner positions only.',409);return {code:u.code,type:u.type,sizeMap:u.size_map_key,enabled:u.enabled===1};}),
    maps,bottomStickyId:Object.hasOwn(config.runtimeControls?.sticky??{},'bottomAdUnitId')
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
  const unitCodes=new Set(draft.units.map((u)=>u.code));
  for(const key of [...before.rules.map((r)=>r.rule_key),...Object.keys(config.advancedUnitRules??{})]){
    if(!['__DEFAULT__','__ATF__','__BTF__'].includes(key)&&!unitCodes.has(key))fail('A removed position still has saved rules. Keep it disabled until its rules are reviewed.');
  }
  for(const override of before.overrides){
    if(override.scope_type==='adunit'&&override.enabled===1&&!draft.units.some((u)=>u.code===override.scope_key&&u.enabled))fail('An enabled bidder override uses this position. Disable or remove that override first.');
  }
  config.runtimeControls??={};config.runtimeControls.sticky??={};config.runtimeControls.sticky.bottomAdUnitId=draft.bottomStickyId;
  config[markerKey]={schemaVersion:1,candidateOnly:true};
  const after={...before,site:{id:TEST_SITE,name:draft.site.name,domain:draft.site.domain,gam_path:draft.site.gamPath},
    config:{config_json:JSON.stringify(config)},
    units:draft.units.map((u,index)=>({code:u.code,type:u.type,media_type:'banner',size_map_key:u.sizeMap,enabled:u.enabled?1:0,sort_order:index})),
    maps:draft.maps.map((m)=>({name:m.name,map_json:JSON.stringify(m.breakpoints.map((r)=>({viewport:[r.minWidth,0],sizes:r.sizes})))}))};
  if(await digest(before)!==expected)fail('Settings changed. Reload saved settings before trying again.',409);
  return {before,after,draft,changed:await digest(before)!==await digest(after)};
}
