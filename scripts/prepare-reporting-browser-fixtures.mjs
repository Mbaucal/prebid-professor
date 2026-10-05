import {mkdir,writeFile} from 'node:fs/promises';
import {positionFixture} from '../tests/support/position-runtime-fixture.mjs';
import {previewInput} from '../worker/runtime-next/snapshot.mjs';
import {compilePositions} from '../worker/runtime-next/compiler.mjs';
import {compileReporting} from '../worker/runtime-reporting-v1/compiler.mjs';
import {finalizeJavaScript} from '../worker/runtime/artifact-minifier.mjs';
import {descriptor} from '../.generated/runtime-next-manifest.mjs';
const out=new URL('../.generated/reporting-evidence/',import.meta.url);
await mkdir(out,{recursive:true});
for(const name of ['prebid','gam','gam-overlay','sticky-prebid','sticky-gam','legacy-lazy']) {
  const prebid=!['gam','sticky-gam'].includes(name),s=positionFixture(prebid),c=JSON.parse(s.config.config_json);
  if(name==='gam-overlay')c.runtimeControls.adPositions.Overlay.demand='gam';
  if(name.startsWith('sticky')){
    c.runtimeControls.adPositions={};s.units=s.units.filter(u=>u.code!=='Overlay');s.overrides=[];
    c.runtimeControls.sticky.bottomAdUnitId='Sticky';
    s.units.push({code:'Sticky',type:'ATF',media_type:'banner',size_map_key:'display',enabled:1,sort_order:3});
  }
  s.config.config_json=JSON.stringify(c);
  for(const row of s.rules){const rule=JSON.parse(row.rule_json);rule.refresh={enabled:true,minSeconds:30,minViewPct:50,maxRefreshes:10};if(name==='legacy-lazy')delete rule.lazy;row.rule_json=JSON.stringify(rule);}
  const input=previewInput(s,descriptor,'20260923_160000');
  for(const [engine,compile] of [['base',compilePositions],['reporting',compileReporting]]){
    const js=await finalizeJavaScript(compile(input).adsJs,{cleanComments:true});
    await writeFile(new URL(name+'-'+engine+'.js',out),js.adsJs);
    await writeFile(new URL(name+'-'+engine+'.min.js',out),js.adsMinJs);
  }
}
console.log('Prepared reporting and unchanged base scripts, readable and minified.');
