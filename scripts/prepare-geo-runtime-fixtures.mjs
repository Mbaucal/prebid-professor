import {mkdir,writeFile} from 'node:fs/promises';
import {conditionalFixture} from '../tests/support/conditional-maps-fixture.mjs';
import {previewInput} from '../worker/runtime-318/snapshot.mjs';
import {compileRuntime318,idempotentStickyStyles} from '../worker/runtime-318/compiler.mjs';
import {descriptor} from '../.generated/runtime-318-manifest.mjs';
import {finalizeJavaScript} from '../worker/runtime/artifact-minifier.mjs';
import {installSharedStickyStyles,stickyStyles} from '../worker/runtime/artifact-styles.mjs';
const root=new URL('../.generated/geo-runtime-evidence/',import.meta.url);
await mkdir(root,{recursive:true});
for(const variant of ['gam','prebid']){
  const s=conditionalFixture({prebid:variant==='prebid'});
  const rule=JSON.parse(s.rules[0].rule_json);rule.refresh={enabled:true,minSeconds:30,minGapBetweenRequestsSeconds:0,minViewPct:0};
  s.rules[0].rule_json=JSON.stringify(rule);
  const input=previewInput(s,descriptor,'20261109_170000',undefined,'test');
  const result=await finalizeJavaScript(idempotentStickyStyles(installSharedStickyStyles(compileRuntime318(input).adsJs,stickyStyles(input.options.sticky.bottomAdUnitId))));
  await writeFile(new URL(variant+'.js',root),result.adsJs);
  await writeFile(new URL(variant+'.min.js',root),result.adsMinJs);
}
console.log('Prepared full 3.18 scripts with conditional maps and background country detection.');
