import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {unzipSync} from 'fflate';
import {baseReadable,previousArchiveBase64,preparedTemplates} from '../../.generated/site-ab-baseline.mjs';
import {buildSavedScript,buildSavedTest,verifySavedScript} from '../../scripts/saved-script-package.mjs';
import {sha256} from '../../scripts/static-aa-package.mjs';
import {scriptSettings,displayName} from '../../worker/experiments/saved-scripts-v1.mjs';
const inputs={base:Buffer.from(baseReadable),previousArchive:Buffer.from(previousArchiveBase64,'base64'),preparedTemplates};
const fresh={mode:'fresh-only',refreshSeconds:10},cached={mode:'auction-with-cache',refreshSeconds:10,maxBidAgeSeconds:60};
let a,b,pair;
test.before(async()=>{a=await buildSavedScript({...inputs,name:'Standard 10s',settings:fresh});b=await buildSavedScript({...inputs,name:'Cache 60s',settings:cached});pair=await buildSavedTest({...inputs,name:'Standard vs Cache',trafficBPercent:50,scripts:{A:a,B:b}});});
function run(pkg,sample=0) {
  const files=unzipSync(pkg.archive),inserted=[],tag={src:'https://cdn.example/ads.js'},targeting={};
  const slot={getSlotElementId:()=> 'Billboard',getConfig:()=>({targeting}),setConfig:c=>Object.assign(targeting,c.targeting)};
  const window={__tcfapi(){},pbjs:{version:'11.34.0'},crypto:{getRandomValues(v){v[0]=sample;return v;}},googletag:{cmd:[],pubads:()=>({getSlots:()=>[slot]})}};
  const document={currentScript:tag,readyState:'complete',scripts:[tag],baseURI:'https://www.tanjug.rs/',createElement:()=>({}),head:{appendChild:s=>inserted.push(s)}};
  const code=Buffer.from(files['ads.js']).toString();
  const sandbox={window,document,URL,Uint32Array,WeakSet,Date,console,setTimeout:()=>1,clearTimeout(){}};
  vm.runInNewContext(code,sandbox);assert.equal(window.__adVariantDelivery.enter(),true);window.__adVariantDelivery.apply(slot);
  vm.runInNewContext(code,sandbox);assert.equal(window.__adVariantDelivery.enter(),false);
  return {state:window.AdVariant.snapshot(),window,inserted,targeting};
}
test('standalone named versions are deterministic and never apply Variant targeting',async()=>{
  assert.deepEqual((await buildSavedScript({...inputs,name:'Standard 10s',settings:fresh})).archive,a.archive);
  for(const p of [a,b]){const {state,targeting,inserted,window}=run(p);assert.equal(state.deliveryMode,'single');assert.equal(state.variant,null);assert.deepEqual(targeting,{});
    assert.equal(state.scriptName,p.name);assert.equal(state.scriptRelease,p.id);assert.equal(window.__adVariantDelivery.scriptRelease,p.id);assert.equal(state.blockedDuplicateLoaders,1);assert.equal(state.runtimeEntries,1);assert.equal(inserted.length,1);
    assert.equal(sha256(verifySavedScript(p.manifest,p.archive)[p.manifest.script.path]),state.scriptSha256);
  }
});
test('A/B and A/A packages reuse exact saved runtime bytes and matching names',async()=>{
  for(const sample of [0,4294967295]){const expected=sample===0?a:b,{state,targeting}=run(pair,sample);assert.equal(state.scriptRelease,expected.id);assert.equal(state.scriptName,expected.name);assert.equal(state.testName,'Standard vs Cache');assert.equal(targeting.Variant,sample===0?'A':'B');}
  const zip=unzipSync(pair.archive);
  for(const p of [a,b])assert.deepEqual(zip[p.manifest.script.path],unzipSync(p.archive)[p.manifest.script.path]);
  const aa=await buildSavedTest({...inputs,name:'Cache A/A',trafficBPercent:50,scripts:{A:b,B:b}});
  assert.equal(Object.keys(unzipSync(aa.archive)).length,8);
  assert.equal(run(aa,0).state.scriptRelease,run(aa,4294967295).state.scriptRelease);
  assert.equal(run(aa,0).targeting.Variant,'A');assert.equal(run(aa,4294967295).targeting.Variant,'B');
});
test('new names/settings are new immutable versions; earlier tests remain unchanged',async()=>{
  const saved=Uint8Array.from(pair.archive),oldRuntime=unzipSync(b.archive)[b.manifest.script.path];
  const changed=await buildSavedScript({...inputs,name:'Cache 30s',settings:{...cached,maxBidAgeSeconds:30}});assert.notEqual(changed.id,b.id);
  const renamed=await buildSavedScript({...inputs,name:'My chosen script',settings:cached});assert.notEqual(renamed.id,b.id);
  const reversed=await buildSavedTest({...inputs,name:'Cache versions',trafficBPercent:100,scripts:{A:changed,B:b}});
  assert.equal(run(reversed,0).state.scriptRelease,b.id);assert.deepEqual(pair.archive,saved);assert.deepEqual(unzipSync(reversed.archive)[b.manifest.script.path],oldRuntime);
});
test('names, settings, foreign baselines and corrupted archives are rejected',async()=>{
  for(const n of ['',null,'x'.repeat(81),'bad\nname'])assert.throws(()=>displayName(n));
  assert.equal(displayName('  Moja skripta  '),'Moja skripta');
  assert.throws(()=>scriptSettings({...fresh,trafficBPercent:50}));
  await assert.rejects(()=>buildSavedTest({...inputs,name:'Bad',trafficBPercent:101,scripts:{A:a,B:b}}));
  await assert.rejects(()=>buildSavedTest({...inputs,name:'Bad',trafficBPercent:50,scripts:{A:a,B:{...b,manifest:{...b.manifest,baseline:'other'}}}}));
  assert.throws(()=>verifySavedScript(b.manifest,new Uint8Array(b.archive.length)));
});
