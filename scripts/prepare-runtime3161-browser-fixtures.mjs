import {mkdir,writeFile} from 'node:fs/promises';
import {fixture,configure} from '../tests/runtime/artifact-fixture.mjs';
import {descriptor} from '../.generated/runtime-316-manifest.mjs';
import {previewInput as oldInput} from '../worker/runtime-316/snapshot.mjs';
import {previewInput} from '../worker/runtime-3161/snapshot.mjs';
import {compileRuntime316} from '../worker/runtime-316/compiler.mjs';
import {compileRuntime3161,idempotentStickyStyles} from '../worker/runtime-3161/compiler.mjs';
import {finalizeJavaScript} from '../worker/runtime/artifact-minifier.mjs';
import {stickyStyles,installSharedStickyStyles} from '../worker/runtime/artifact-styles.mjs';
import {positionFixture} from '../tests/support/position-runtime-fixture.mjs';
const out=new URL('../.generated/runtime3161-evidence/',import.meta.url);await mkdir(out,{recursive:true});
for(const version of['before','fixed']){
 const path=new URL(version+'/',out);await mkdir(path,{recursive:true});
 for(const name of['late','configured','refresh','gap','cmp-gap','per-unit','sticky-empty','native-legacy','native-configured']){
  const native=name.startsWith('native-'),snapshot=configure(fixture(),c=>{c.enablePrebid=native;c.runtimeControls.currencyConversion={enabled:false};if(native)c.runtimeControls.sticky.bottomAdUnitId='';});
  if(native){snapshot.units=snapshot.units.filter(u=>u.code!=='Sticky');snapshot.overrides=[];snapshot.bidders=[{bidder:'pubmatic',enabled:1,params_json:'{"publisherId":"fixture","adSlot":"fixture"}'},{bidder:'ix',enabled:1,params_json:'{"siteId":"fixture"}'}];}
  if(name==='cmp-gap'){configure(snapshot,c=>c.runtimeControls.sticky.bottomAdUnitId='');snapshot.units=snapshot.units.filter(u=>u.code!=='Sticky');}
  snapshot.rules=name==='late'?[]:[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{enabled:!native,minSeconds:30,minViewPct:50,minGapSeconds:name.endsWith('gap')?100:0}})}];
  if(name==='per-unit')snapshot.rules=[{rule_key:'__DEFAULT__',rule_json:'{"refresh":{"enabled":false}}'},{rule_key:'P1',rule_json:'{"refresh":{"enabled":true,"minSeconds":30,"minViewPct":50}}'}];
  if(name==='configured'||name==='native-configured')snapshot.rules.push({rule_key:'__ATF__',rule_json:'{"lazy":{"enabled":true,"fetchMarginPx":500,"renderMarginPx":0}}'},{rule_key:'__BTF__',rule_json:'{"lazy":{"enabled":true,"fetchMarginPx":500,"renderMarginPx":0}}'});
  const d=version==='before'?descriptor:{...descriptor,id:'tessera-3.16.1',version:'3.16.1'};
  const input=(version==='before'?oldInput:previewInput)(snapshot,d,'20261024_120000');
  const generated=(version==='before'?compileRuntime316:compileRuntime3161)(input);
  let source=installSharedStickyStyles(generated.adsJs,stickyStyles(input.options.sticky.bottomAdUnitId));
  if(version==='fixed')source=idempotentStickyStyles(source);
  const result=await finalizeJavaScript(source);
  await writeFile(new URL(name+'.js',path),result.adsJs);await writeFile(new URL(name+'.min.js',path),result.adsMinJs);
 }
}
// The existing consent and TakeOver matrices can run against this same output.
for(const name of ['prebid','gam','sticky','legacy-lazy','desktop-only','mobile-only']){
 const snapshot=positionFixture(!['gam','desktop-only','mobile-only'].includes(name));
 snapshot.bidders.forEach(b=>b.params_json='{"publisherId":"fixture","adSlot":"fixture"}');
 const config=JSON.parse(snapshot.config.config_json);
 if(name==='sticky'){
  config.runtimeControls.sticky.bottomAdUnitId='Sticky';
  snapshot.units.push({code:'Sticky',type:'ATF',media_type:'banner',size_map_key:'display',enabled:1,sort_order:3});
 }
 if(name==='legacy-lazy')snapshot.rules=[];
 if(name==='desktop-only')snapshot.maps[1].map_json=JSON.stringify([{viewport:[0,0],sizes:[]},{viewport:[1024,0],sizes:[[800,600]]}]);
 if(name==='mobile-only')snapshot.maps[1].map_json=JSON.stringify([{viewport:[0,0],sizes:[[300,250]]},{viewport:[1024,0],sizes:[]}]);
 snapshot.config.config_json=JSON.stringify(config);
 const input=previewInput(snapshot,{...descriptor,id:'tessera-3.16.1',version:'3.16.1'},'20260930_003000');
 const generated=compileRuntime3161(input);
 const result=await finalizeJavaScript(idempotentStickyStyles(installSharedStickyStyles(generated.adsJs,stickyStyles(input.options.sticky.bottomAdUnitId))));
 await writeFile(new URL('fixed/'+name+'.js',out),result.adsJs);await writeFile(new URL('fixed/'+name+'.min.js',out),result.adsMinJs);
}
console.log('Prepared 3.16.0 before / working 3.16.1 browser fixtures; synthetic traffic only.');
