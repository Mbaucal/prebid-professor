import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {previewInput} from '../../worker/runtime-cache/snapshot.mjs';
import {compileCached} from '../../worker/runtime-cache/compiler.mjs';
import {compileMeasured} from '../../worker/runtime-measured/compiler.mjs';
import {finalizeJavaScript} from '../../worker/runtime/artifact-minifier.mjs';
const descriptor={id:'tessera-cache-preview-1',version:'3.13.0'};
const timestamp='20260917_120000';
function fixture(mode='auction-with-cache',legacyLazy=false,refresh=false){
  const s=positionFixture(true),c=JSON.parse(s.config.config_json);
  c.runtimeControls.bidCache={mode,maxAgeSeconds:30};c.runtimeControls.floors.currency='USD';
  s.bidders.push({bidder:'openx',params_json:'{"unit":"synthetic"}',enabled:1});
  if(legacyLazy)s.rules=s.rules.map(r=>({...r,rule_json:'{"timeout":300}'}));
  if(refresh)s.rules.push({rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{enabled:true,minSeconds:2,maxRefreshes:1,minViewPct:50}})});
  s.config.config_json=JSON.stringify(c);return s;
}
test('new compiler routes all targeting to request time without mutating measured or existing source output',()=>{
  const s=fixture(),before=structuredClone(s),input=previewInput(s,descriptor,timestamp);
  const old=compileMeasured(input,{version:'3.12.0-tessera.preview.1'}).adsJs;
  const result=compileCached(input,descriptor);
  assert.match(result.adsJs,/presetGPTTargeting: false/);assert.match(result.adsJs,/__tesseraBidCache/);
  assert.doesNotMatch(result.adsJs,/applyTargetingMapToSlot\(slot,pbjs.getAdserverTargetingForAdUnitCode/);
  assert.equal(compileMeasured(input,{version:'3.12.0-tessera.preview.1'}).adsJs,old);assert.deepEqual(s,before);
  assert.match(old,/useBidCache: false/);assert(!old.includes('__tesseraBidCache'));
});
test('saved policy must be explicit, bounded, numeric-banner-only and backed by enabled Prebid',()=>{
  for(const rule of [null,{mode:'cache-first',maxAgeSeconds:30},{mode:'fresh-only',maxAgeSeconds:0},{mode:'fresh-only',maxAgeSeconds:30,ignored:true}]){
    const s=fixture(),c=JSON.parse(s.config.config_json);c.runtimeControls.bidCache=rule;s.config.config_json=JSON.stringify(c);assert.throws(()=>previewInput(s,descriptor,timestamp));
  }
  const s=fixture(),c=JSON.parse(s.config.config_json);c.enablePrebid=false;s.config.config_json=JSON.stringify(c);assert.throws(()=>previewInput(s,descriptor,timestamp),/enabled Prebid/);
});
test('emit readable/minified compiled browser fixtures for both cache modes and both lazy paths',async()=>{
  await mkdir('.generated/cache-runtime-evidence',{recursive:true});
  for(const [name,mode,lazy,refresh] of [['cached','auction-with-cache',false,false],['fresh','fresh-only',false,false],['default-lazy','auction-with-cache',true,false],['refresh','auction-with-cache',false,true],['fresh-refresh','fresh-only',false,true]]){
    const result=compileCached(previewInput(fixture(mode,lazy,refresh),descriptor,timestamp),descriptor);
    const js=await finalizeJavaScript(result.adsJs);
    await writeFile('.generated/cache-runtime-evidence/'+name+'.js',js.adsJs);
    await writeFile('.generated/cache-runtime-evidence/'+name+'.min.js',js.adsMinJs);
  }
  const noOverlay=fixture(),c=JSON.parse(noOverlay.config.config_json);delete c.runtimeControls.adPositions;noOverlay.config.config_json=JSON.stringify(c);
  assert.doesNotThrow(()=>compileCached(previewInput(noOverlay,descriptor,timestamp),descriptor));
});
