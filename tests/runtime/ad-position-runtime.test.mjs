import test from 'node:test';
import assert from 'node:assert/strict';
import { positionFixture } from '../support/position-runtime-fixture.mjs';
import { previewInput } from '../../worker/runtime-next/snapshot.mjs';
import { compilePositions } from '../../worker/runtime-next/compiler.mjs';
import { runtimeCatalog, previewInput as selectedInput, buildArtifactCandidate } from '../../worker/test-workspace/runtime-catalog.mjs';
import { pinRuntime } from '../../worker/runtime/version-pin.mjs';
import { normalizeLazy, normalizeOverlay, defaultOverlay } from '../../worker/runtime-next/position-settings.mjs';
const stamp='20260914_220000';
const input=s=>previewInput(s,runtimeCatalog[0],stamp);
test('TakeOver uses a real unit/map/override while source and saved snapshot stay separate',()=>{
  const snapshot=positionFixture(),before=structuredClone(snapshot),planned=input(snapshot);
  assert.equal(planned.overlay.code,'Overlay');assert.equal(planned.core.bidderAdUnitParams.pubmatic.Overlay.adSlot,'overlay-slot');
  const generated=compilePositions(planned);
  assert.match(generated.adsJs,/tesseraRequestOverlay\(slot\)/);
  assert.match(generated.adsJs,/"adSlot":"overlay-slot"/);
  assert.deepEqual(snapshot,before);
});
test('old exact engine stays bundled and rejects new features rather than dropping them',()=>{
  assert.equal(runtimeCatalog[1].codeSha256,'222569881b377c085f0b5d373523d092d64e2ac5dab05d421c3cc9f371078de9');
  assert.throws(()=>selectedInput(positionFixture(),runtimeCatalog[1],stamp),/require version 3.10.0/);
});
test('responsive modal rows cannot hide multiple sizes, fluid or pixel creatives',()=>{
  for(const sizes of [['fluid'],[[1,1]],[[300,250],[320,250]]]){
    const s=positionFixture();s.maps[1].map_json=JSON.stringify([{viewport:[0,0],sizes}]);assert.throws(()=>input(s),/one numeric size/);
  }
  const s=positionFixture();s.maps[1].map_json=JSON.stringify([{viewport:[0,0],sizes:[]},{viewport:[1024,0],sizes:[[800,600]]}]);assert.doesNotThrow(()=>input(s));
});
test('position rules reject invalid timers, intervals and margins',()=>{
  for(const v of [-1,1.5,10081])assert.throws(()=>normalizeOverlay({...defaultOverlay(),frequencyMinutes:v}));
  assert.throws(()=>normalizeLazy({enabled:true,fetchMarginPx:20001}));
  assert.throws(()=>normalizeLazy({enabled:'true'}));
});
test('complete candidate records new settings and excludes the automatic modal container',async()=>{
  const s=positionFixture(false),p=await buildArtifactCandidate({snapshot:s,pin:pinRuntime(runtimeCatalog[0],{allowPreview:true}),buildTimestamp:stamp});
  const decode=name=>new TextDecoder().decode(p.files[name]);
  assert.doesNotMatch(decode('implementation.html'),/id="Overlay"/);
  assert.doesNotMatch(decode('min-height.css'),/#Overlay/);
  assert.match(decode('implementation.html'),/id="P1"/);
  const config=JSON.parse(decode('config.json'));
  assert.equal(config.adPosition.code,'Overlay');assert.equal(config.lazyRules.__BTF__.fetchMarginPx,500);
  assert.equal(p.manifest.runtime.runtimeVersion,'3.10.0-tessera.preview.1');
});
