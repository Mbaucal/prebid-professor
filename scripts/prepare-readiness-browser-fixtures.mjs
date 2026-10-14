import {mkdir,writeFile} from 'node:fs/promises';
import {positionFixture} from '../tests/support/position-runtime-fixture.mjs';
import {finalizeJavaScript} from '../worker/runtime/artifact-minifier.mjs';
const stable=process.argv.includes('--stable');
const compile=stable?(await import('../worker/runtime-316/compiler.mjs')).compileRuntime316:(await import('../worker/runtime-readiness-v1/compiler.mjs')).compileReadiness;
const {previewInput}=await import(stable?'../worker/runtime-316/snapshot.mjs':'../worker/runtime-next/snapshot.mjs');
const {descriptor}=await import(stable?'../.generated/runtime-316-manifest.mjs':'../.generated/runtime-readiness-manifest.mjs');
const out=new URL(stable?'../.generated/stable-readiness-evidence/':'../.generated/readiness-evidence/',import.meta.url);await mkdir(out,{recursive:true});
for(const name of ['prebid','gam','sticky','legacy-lazy']){
 const snapshot=positionFixture(name!=='gam');
 snapshot.bidders.forEach(b=>b.params_json='{"publisherId":"fixture","adSlot":"fixture"}');
 const config=JSON.parse(snapshot.config.config_json);
 if(name==='sticky'){
   config.runtimeControls.sticky.bottomAdUnitId='Sticky';
   snapshot.units.push({code:'Sticky',type:'ATF',media_type:'banner',size_map_key:'display',enabled:1,sort_order:3});
 }
 if(name==='legacy-lazy')snapshot.rules=[];
 snapshot.config.config_json=JSON.stringify(config);
 const input=previewInput(snapshot,descriptor,'20260930_003000');
 const compiled=compile(input);const final=await finalizeJavaScript(compiled.adsJs,{cleanComments:true});
 await writeFile(new URL(name+'.js',out),final.adsJs);await writeFile(new URL(name+'.min.js',out),final.adsMinJs);
}
console.log('Prepared readiness browser fixtures.');
