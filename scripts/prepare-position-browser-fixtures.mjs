import { mkdir,writeFile } from 'node:fs/promises';
import { positionFixture } from '../tests/support/position-runtime-fixture.mjs';
import { previewInput } from '../worker/runtime-next/snapshot.mjs';
import { compilePositions } from '../worker/runtime-next/compiler.mjs';
import { descriptor } from '../.generated/runtime-next-manifest.mjs';
const out=new URL('../.generated/position-evidence/',import.meta.url);await mkdir(out,{recursive:true});
for(const name of ['prebid','gam','desktop-only','frequency','atf-lazy','btf-immediate']){
  const s=positionFixture(name!=='gam');
  if(name==='desktop-only')s.maps[1].map_json=JSON.stringify([{viewport:[0,0],sizes:[]},{viewport:[1024,0],sizes:[[800,600]]}]);
  if(name==='frequency'){const c=JSON.parse(s.config.config_json);c.runtimeControls.adPositions.Overlay.frequencyMinutes=30;s.config.config_json=JSON.stringify(c);}
  if(name==='atf-lazy')s.rules[0].rule_json='{"lazy":{"enabled":true,"fetchMarginPx":500,"renderMarginPx":0},"timeout":300}';
  if(name==='btf-immediate')s.rules[1].rule_json='{"lazy":{"enabled":false,"fetchMarginPx":0,"renderMarginPx":0},"timeout":300}';
  await writeFile(new URL(name+'.js',out),compilePositions(previewInput(s,descriptor,'20260914_220000')).adsJs);
}
console.log('Prepared new position runtime browser cases.');
