import {mkdir,writeFile} from 'node:fs/promises';
import {conditionalFixture,mapping} from '../tests/support/conditional-maps-fixture.mjs';
import {previewInput} from '../worker/runtime-317/snapshot.mjs';
import {compileRuntime317,idempotentStickyStyles} from '../worker/runtime-317/compiler.mjs';
import {descriptor} from '../.generated/runtime-317-manifest.mjs';
import {finalizeJavaScript} from '../worker/runtime/artifact-minifier.mjs';
import {installSharedStickyStyles,stickyStyles,placeholderStyles} from '../worker/runtime/artifact-styles.mjs';
const root=new URL('../.generated/conditional-maps-evidence/',import.meta.url);
await mkdir(root,{recursive:true});
for(const variant of ['gam','prebid','disabled','sticky','lazy','empty']){
  const s=conditionalFixture({prebid:variant!=='gam',disabled:variant==='disabled',sticky:variant==='sticky'});
  if(variant==='lazy')s.rules[1].rule_json=JSON.stringify({conditionalMappings:[mapping()],lazy:{enabled:true,fetchMarginPx:500,renderMarginPx:0}});
  if(variant==='empty')s.maps.find(m=>m.name==='naslovna_P2').map_json=JSON.stringify([{viewport:[0,0],sizes:[]},{viewport:[768,0],sizes:[[300,250]]}]);
  const input=previewInput(s,descriptor,'20261109_120000');
  const css=stickyStyles(input.options.sticky.bottomAdUnitId);
  const result=await finalizeJavaScript(idempotentStickyStyles(installSharedStickyStyles(compileRuntime317(input).adsJs,css)));
  await writeFile(new URL(variant+'.js',root),result.adsJs);
  await writeFile(new URL(variant+'.min.js',root),result.adsMinJs);
  await writeFile(new URL(variant+'.css',root),placeholderStyles(input)+input.conditionalCss);
}
console.log('Prepared actual 3.17.0 Banner/Sticky/lazy packages for isolated browser checks.');
