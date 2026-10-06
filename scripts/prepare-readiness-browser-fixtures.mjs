import {mkdir,writeFile} from 'node:fs/promises';
import {compileReadiness} from '../worker/runtime-readiness-v1/compiler.mjs';
import {previewInput} from '../worker/runtime-next/snapshot.mjs';
import {descriptor} from '../.generated/runtime-readiness-manifest.mjs';
import {positionFixture} from '../tests/support/position-runtime-fixture.mjs';
import {finalizeJavaScript} from '../worker/runtime/artifact-minifier.mjs';
const out=new URL('../.generated/readiness-evidence/',import.meta.url);await mkdir(out,{recursive:true});
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
 const compiled=compileReadiness(input);const final=await finalizeJavaScript(compiled.adsJs,{cleanComments:true});
 await writeFile(new URL(name+'.js',out),final.adsJs);await writeFile(new URL(name+'.min.js',out),final.adsMinJs);
}
console.log('Prepared readiness browser fixtures.');
