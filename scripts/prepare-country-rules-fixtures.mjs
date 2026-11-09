import {mkdir,writeFile} from 'node:fs/promises';
import {countryRulesFixture,onlySerbia} from '../tests/support/country-rules-fixture.mjs';
import {positionFixture} from '../tests/support/position-runtime-fixture.mjs';
import {previewInput} from '../worker/runtime-319/snapshot.mjs';
import {compileRuntime319,idempotentStickyStyles} from '../worker/runtime-319/compiler.mjs';
import {descriptor} from '../.generated/runtime-319-manifest.mjs';
import {finalizeJavaScript} from '../worker/runtime/artifact-minifier.mjs';
import {installSharedStickyStyles,stickyStyles} from '../worker/runtime/artifact-styles.mjs';
const out=new URL('../.generated/country-rules-evidence/',import.meta.url);await mkdir(out,{recursive:true});
for(const name of ['gam','prebid','fallback','sticky','lazy']){
 const s=name==='fallback'?positionFixture(false):countryRulesFixture(name==='prebid');
 if(name==='fallback')s.rules.push({rule_key:'__INTERSTITIAL__',rule_json:JSON.stringify({conditionalMappings:[onlySerbia()]})});
 if(name==='lazy')s.rules.push({rule_key:'P2',rule_json:JSON.stringify({...JSON.parse(s.rules.find(r=>r.rule_key==='P2').rule_json),lazy:{enabled:true,fetchMarginPx:500,renderMarginPx:0}})});
 if(name==='sticky'){
  const c=JSON.parse(s.config.config_json);c.runtimeControls.sticky.bottomAdUnitId='Sticky';s.config.config_json=JSON.stringify(c);
  s.units.push({...s.units[0],code:'Sticky'});s.rules.push({rule_key:'Sticky',rule_json:JSON.stringify({conditionalMappings:[onlySerbia()]})});
 }
 const input=previewInput(s,descriptor,'20261109_190000',undefined,'test');
 const result=await finalizeJavaScript(idempotentStickyStyles(installSharedStickyStyles(compileRuntime319(input).adsJs,stickyStyles(input.options.sticky.bottomAdUnitId))));
 await writeFile(new URL(name+'.js',out),result.adsJs);await writeFile(new URL(name+'.min.js',out),result.adsMinJs);
}
console.log('Prepared complete 3.19 GEO/GAM, maps, conditional activation, lazy, Sticky and fallback scripts.');
