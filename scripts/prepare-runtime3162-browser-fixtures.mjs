/** Synthetic Sticky-only fixtures for the 3.16.2 empty-retry gap correction.
 * Settings are saved through the real advanced-rule admin path; the same saved
 * snapshot is compiled by 3.16.0, 3.16.1 and 3.16.2. No network, no deploys.
 */
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {adminAuditStore} from '../tests/support/admin-audit-store.mjs';
import {updateAdvancedRule} from '../worker/advanced-rules.ts';
import {fixture,configure} from '../tests/runtime/artifact-fixture.mjs';
import {descriptor} from '../.generated/runtime-316-manifest.mjs';
import {previewInput as input316} from '../worker/runtime-316/snapshot.mjs';
import {previewInput as input3161} from '../worker/runtime-3161/snapshot.mjs';
import {compileRuntime316} from '../worker/runtime-316/compiler.mjs';
import {compileRuntime3161,idempotentStickyStyles} from '../worker/runtime-3161/compiler.mjs';
import {compileRuntime3162} from '../worker/runtime-3162/compiler.mjs';
import {finalizeJavaScript} from '../worker/runtime/artifact-minifier.mjs';
import {installSharedStickyStyles,stickyStyles} from '../worker/runtime/artifact-styles.mjs';
import {positionFixture} from '../tests/support/position-runtime-fixture.mjs';

const out=new URL('../.generated/runtime3162-evidence/',import.meta.url);
const gap={enabled:true,minViewPct:0,minGapSeconds:100,maxRefreshes:20,schedule:{mode:'fixed',fixedSeconds:30}};
// emptyRetryDelays is a compiler option without an editor; production uses [30000].
const retries=Array(8).fill(30000);
export const variants={
  'gap':{refresh:gap},
  'gap-retries':{refresh:gap,emptyRetryDelays:retries},
  'gap-retries-cap3':{refresh:{...gap,maxRefreshes:3},emptyRetryDelays:retries},
  'fixed60':{refresh:{enabled:true,minViewPct:0,maxRefreshes:20,schedule:{mode:'fixed',fixedSeconds:60}}},
  'default':{refresh:null},
};
const versions={
  '3.16.0':{input:input316,compile:compileRuntime316,descriptor},
  '3.16.1':{input:input3161,compile:compileRuntime3161,descriptor:{...descriptor,id:'tessera-3.16.1',version:'3.16.1'}},
  '3.16.2':{input:input3161,compile:compileRuntime3162,descriptor:{...descriptor,id:'tessera-3.16.2',version:'3.16.2'}},
};
async function savedSnapshot(rule){
  const snapshot=configure(fixture(),c=>{c.enablePrebid=false;c.runtimeControls.currencyConversion={enabled:false};});
  snapshot.units=snapshot.units.filter(u=>u.code==='Sticky');snapshot.overrides=[];
  if(!rule)return snapshot;
  const store=adminAuditStore({config:JSON.parse(snapshot.config.config_json)});
  try{
    const response=await updateAdvancedRule(new Request('https://local.invalid/advanced',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({refresh:rule})}),store.env,'audit-site','__DEFAULT__');
    assert.equal(response.status,200,await response.text());
    snapshot.config.config_json=JSON.stringify(store.readConfig());
    snapshot.rules=store.sqlite.prepare('SELECT rule_key,rule_json FROM unit_rules').all().map(row=>({...row}));
  }finally{store.close();}
  return snapshot;
}
for(const [name,variant] of Object.entries(variants)){
  const snapshot=await savedSnapshot(variant.refresh);
  for(const [version,v] of Object.entries(versions)){
    const input=v.input(structuredClone(snapshot),v.descriptor,'20261024_180000');
    if(variant.emptyRetryDelays)input.options={...input.options,sticky:{...input.options.sticky,emptyRetryDelays:variant.emptyRetryDelays}};
    let js=installSharedStickyStyles(v.compile(input).adsJs,stickyStyles(input.options.sticky.bottomAdUnitId));
    if(version!=='3.16.0')js=idempotentStickyStyles(js);
    const finalized=await finalizeJavaScript(js);
    const dir=new URL(version+'/',out);await mkdir(dir,{recursive:true});
    await writeFile(new URL(name+'.js',dir),finalized.adsJs);
    await writeFile(new URL(name+'.min.js',dir),finalized.adsMinJs);
  }
}
// The 3.16.1 consent, delayed-CMP and native matrices, compiled by 3.16.2.
const fixed=new URL('fixed/',out);await mkdir(fixed,{recursive:true});
async function emit(name,snapshot){
  const input=input3161(snapshot,versions['3.16.2'].descriptor,'20261024_120000');
  const result=await finalizeJavaScript(idempotentStickyStyles(installSharedStickyStyles(compileRuntime3162(input).adsJs,stickyStyles(input.options.sticky.bottomAdUnitId))));
  await writeFile(new URL(name+'.js',fixed),result.adsJs);await writeFile(new URL(name+'.min.js',fixed),result.adsMinJs);
}
for(const name of['late','configured','refresh','gap','cmp-gap','per-unit','sticky-empty','native-legacy','native-configured']){
  const native=name.startsWith('native-'),snapshot=configure(fixture(),c=>{c.enablePrebid=native;c.runtimeControls.currencyConversion={enabled:false};if(native)c.runtimeControls.sticky.bottomAdUnitId='';});
  if(native){snapshot.units=snapshot.units.filter(u=>u.code!=='Sticky');snapshot.overrides=[];snapshot.bidders=[{bidder:'pubmatic',enabled:1,params_json:'{"publisherId":"fixture","adSlot":"fixture"}'},{bidder:'ix',enabled:1,params_json:'{"siteId":"fixture"}'}];}
  if(name==='cmp-gap'){configure(snapshot,c=>c.runtimeControls.sticky.bottomAdUnitId='');snapshot.units=snapshot.units.filter(u=>u.code!=='Sticky');}
  snapshot.rules=name==='late'?[]:[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{enabled:!native,minSeconds:30,minViewPct:50,minGapSeconds:name.endsWith('gap')?100:0}})}];
  if(name==='per-unit')snapshot.rules=[{rule_key:'__DEFAULT__',rule_json:'{"refresh":{"enabled":false}}'},{rule_key:'P1',rule_json:'{"refresh":{"enabled":true,"minSeconds":30,"minViewPct":50}}'}];
  if(name==='configured'||name==='native-configured')snapshot.rules.push({rule_key:'__ATF__',rule_json:'{"lazy":{"enabled":true,"fetchMarginPx":500,"renderMarginPx":0}}'},{rule_key:'__BTF__',rule_json:'{"lazy":{"enabled":true,"fetchMarginPx":500,"renderMarginPx":0}}'});
  await emit(name,snapshot);
}
for(const name of ['prebid','gam','sticky','legacy-lazy','desktop-only','mobile-only']){
  const snapshot=positionFixture(!['gam','desktop-only','mobile-only'].includes(name));
  snapshot.bidders.forEach(b=>b.params_json='{"publisherId":"fixture","adSlot":"fixture"}');
  const config=JSON.parse(snapshot.config.config_json);
  if(name==='sticky'){config.runtimeControls.sticky.bottomAdUnitId='Sticky';snapshot.units.push({code:'Sticky',type:'ATF',media_type:'banner',size_map_key:'display',enabled:1,sort_order:3});}
  if(name==='legacy-lazy')snapshot.rules=[];
  if(name==='desktop-only')snapshot.maps[1].map_json=JSON.stringify([{viewport:[0,0],sizes:[]},{viewport:[1024,0],sizes:[[800,600]]}]);
  if(name==='mobile-only')snapshot.maps[1].map_json=JSON.stringify([{viewport:[0,0],sizes:[[300,250]]},{viewport:[1024,0],sizes:[]}]);
  snapshot.config.config_json=JSON.stringify(config);
  await emit(name,snapshot);
}
console.log('Prepared 3.16.0 / 3.16.1 / 3.16.2 Sticky gap fixtures and the 3.16.2 consent matrix; synthetic traffic only.');
