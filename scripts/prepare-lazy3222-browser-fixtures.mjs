/** Actual generated packages for controlled lazy-observer Chromium regressions. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fixture,configure,TS} from '../tests/runtime/artifact-fixture.mjs';
import {pinRuntime} from '../worker/runtime/version-pin.mjs';
import {prebidRequirements,inspectPrebidArtifact,sha256} from '../worker/runtime/prebid-artifact-check-v2.mjs';
const out=new URL('../.generated/lazy3222-evidence/',import.meta.url);
async function checked(snapshot,input){
 const required=prebidRequirements(input,JSON.parse(snapshot.config.config_json));
 assert.deepEqual(required.issues,[]);
 if(!required.required)return null;
 const bytes=new TextEncoder().encode(`/* prebid.js v11.11.0\nModules: ${required.modules.join(', ')} */\nvoid 0;`).buffer;
 const build={id:'lazy-check',publisher_id:snapshot.site.id,status:'current',version:'11.11.0',file_key:`publishers/${snapshot.site.id}/prebid-builds/lazy-check/prebid.js`,modules_json:JSON.stringify(required.modules)};
 const object={size:bytes.byteLength,customMetadata:{sha256:await sha256(bytes),version:'11.11.0'},async arrayBuffer(){return bytes;}};
 const report=await inspectPrebidArtifact({siteId:snapshot.site.id,builds:[build],requirements:required},{async get(){return object;}});
 assert.equal(report.status,'checked',JSON.stringify(report.issues));return {bytes,report};
}
for(const [version,stem]of [['3.22.1','3221'],['3.22.2','3222']]){
 const {descriptor}=await import(`../.generated/runtime-${stem}-manifest.mjs`);
 const {previewInput}=await import(`../worker/runtime-${stem}/snapshot.mjs`);
 const {buildArtifactCandidate}=await import(`../worker/runtime-${stem}/artifact-candidate.mjs`);
 for(const prebid of [true,false]){
  const snapshot=configure(fixture(),config=>{config.enablePrebid=prebid;config.runtimeControls.sticky.bottomAdUnitId='';config.runtimeControls.currencyConversion={enabled:false};});
  snapshot.units=snapshot.units.filter(unit=>unit.code==='P1');snapshot.overrides=[];
  snapshot.rules=[{rule_key:'__DEFAULT__',rule_json:'{"refresh":{"enabled":false}}'}];
  const input=previewInput(snapshot,descriptor,TS),pin=pinRuntime(descriptor,{allowPreview:true});
  const packageResult=await buildArtifactCandidate({snapshot,pin,buildTimestamp:TS,prebid:await checked(snapshot,input)});
  const dir=new URL(`${version}/${prebid?'prebid':'gam'}/`,out);await mkdir(dir,{recursive:true});
  for(const name of ['ads.js','ads.min.js','manifest.json'])await writeFile(new URL(name,dir),packageResult.files[name]);
 }
}
console.log('Prepared actual 3.22.1/3.22.2 packages for synthetic lazy observer Chromium checks.');
