import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {prepareTanjugCacheReview,cacheReviewHtml} from '../../worker/pilots/tanjug-cache-review.mjs';
import {sha256} from '../../worker/runtime/prebid-artifact-check.mjs';
import {describeCandidate} from '../../worker/runtime/draft-release-store.mjs';
import {createExperimentDelivery} from '../../worker/experiments/delivery.mjs';
import {metadata as originalMetadata,zipBase64} from '../../.generated/tanjug-pilot.mjs';
const read=path=>new Uint8Array(readFileSync(new URL('../../'+path,import.meta.url))),decode=bytes=>new TextDecoder().decode(bytes);
const proposal=JSON.parse(decode(read('worker/pilots/tanjug-cache-review-v1.json'))),sourceBytes=read(proposal.sourceFile),prebidBytes=read('vendor/prebid/tanjug-11.34.0/prebid.js');
const args={proposal,sourceBytes,prebidBytes};let result;
test.before(async()=>{globalThis.fetch=()=>assert.fail('No network during pilot preparation');result=await prepareTanjugCacheReview(args);});
test('full Tanjug incompatibility is reported; the explicit two-position proposal preserves all other source settings',()=>{
 const source=JSON.parse(decode(sourceBytes)),r=result.report;
 assert.equal(r.status,'offline-review-only');assert.equal(r.source.liveConfigurationVerified,false);
 assert.equal(r.fullSource.supported,false);assert.deepEqual(r.fullSource.blockers.map(b=>b.map),['InText']);
 assert.deepEqual(r.fullSource.blockers[0].units,['InText_1','InText_2','InText_3','InText_4','InText_5']);
 assert(r.fullSource.blockers[0].rows.every(row=>row.sizes.includes('fluid')&&row.sizes.some(s=>Array.isArray(s)&&s[0]===1&&s[1]===1)));
 assert.deepEqual(r.scope.includedUnits,['Billboard','Sticky']);assert.equal(r.scope.excludedUnits.length,17);
 for(const [arm,snapshot] of Object.entries(result.snapshots)){
  const expected=structuredClone(source.snapshot);expected.site.id=proposal.siteId;expected.site.name=proposal.siteName;
  expected.units=expected.units.filter(u=>proposal.includedUnits.includes(u.code));expected.maps=expected.maps.filter(m=>['Billboard','Sticky'].includes(m.name));
  const config=JSON.parse(expected.config.config_json);config.runtimeControls.bidCache={mode:proposal.modes[arm],maxAgeSeconds:60};expected.config.config_json=JSON.stringify(config);
  assert.deepEqual(snapshot,expected);
 }
 assert.equal(r.refresh.stickySeconds,30);assert.deepEqual(r.refresh.global.schedule,{mode:'percentage',firstSeconds:30,growthPercent:50,maxSeconds:120});
 assert.equal(r.refresh.global.maxRefreshes,20);assert.equal(r.runtime.runtimeVersion,'3.13.0');
});
test('both full packages verify, differ only in cache mode, and leave the frozen source and previous ZIP unchanged',async()=>{
 const configs=[];
 for(const [arm,candidate] of Object.entries(result.candidates)){
  const verified=await describeCandidate(proposal.siteId,candidate),files=unzipSync(candidate.zip);
  assert.equal(verified.descriptor.packageSha256,result.report.arms[arm].packageSha256);
  assert.equal(await sha256(candidate.zip),result.report.arms[arm].zipSha256);
  assert.deepEqual(files['prebid.js'],prebidBytes);assert.equal(Object.keys(files).length,10);
  for(const [name,bytes] of Object.entries(candidate.files))assert.deepEqual(files[name],bytes);
  const config=JSON.parse(decode(files['config.json']));assert.equal(config.options.takeOver.enabled,false);configs.push(config);
 }
 assert.notEqual(result.report.arms.control.packageSha256,result.report.arms.cache.packageSha256);
 assert.equal(configs[0].bidCache.mode,'fresh-only');assert.equal(configs[1].bidCache.mode,'auction-with-cache');
 delete configs[0].bidCache.mode;delete configs[1].bidCache.mode;assert.deepEqual(configs[0],configs[1]);
 assert.deepEqual(sourceBytes,read(proposal.sourceFile));assert.equal(await sha256(sourceBytes),proposal.sourceSha256);
 assert.equal(await sha256(Buffer.from(zipBase64,'base64')),originalMetadata.zipSha256);
 assert.equal(originalMetadata.zipSha256,JSON.parse(decode(read('docs/evidence/tanjug-test-v1-public-verification.json'))).zipSha256);
});
test('A/A and A/B plans are disabled and serve only exact pinned JS through the existing delivery adapter',async()=>{
 const registry={};for(const candidate of Object.values(result.candidates)){const checked=await describeCandidate(proposal.siteId,candidate);registry[checked.descriptor.packageSha256]=checked;}
 for(const [name,plan] of Object.entries(result.report.plans)){
  assert.equal(plan.enabled,false);assert.equal(plan.trafficB,50);
  const pins=[...new Set([plan.controlPackageSha256,plan.testPackageSha256])],packages=Object.fromEntries(pins.map(pin=>[pin,registry[pin]]));
  assert.equal(pins.length,name==='aa'?1:2);
  const delivery=await createExperimentDelivery(plan,packages,{random:()=>{assert.fail('Disabled proposal must not assign test traffic');}});
  const loader=await delivery.fetch(new Request('https://review.invalid/ads.js')).text();
  assert(loader.includes('"active":false'));assert(loader.includes('"variant":"A"'));assert(loader.includes(plan.controlPackageSha256));
  const dependency=delivery.fetch(new Request(`https://review.invalid/releases/${plan.controlPackageSha256}/prebid.js`));assert.deepEqual(new Uint8Array(await dependency.arrayBuffer()),prebidBytes);
  assert.equal(delivery.fetch(new Request(`https://review.invalid/releases/${plan.controlPackageSha256}/config.json`)).status,404);
 }
});
test('changed dependency, source, runtime, scope or policy require another review',async()=>{
 for(const patch of [{sourceSha256:'0'.repeat(64)},{runtimeVersion:'3.14.0'},{includedUnits:['Billboard','InText_1']},{maxAgeSeconds:30},{modes:{control:'fresh-only',cache:'cache-first'}}]){
  await assert.rejects(prepareTanjugCacheReview({...args,proposal:{...proposal,...patch}}));
 }
 const changed=prebidBytes.slice();changed[changed.length-1]^=1;await assert.rejects(prepareTanjugCacheReview({...args,prebidBytes:changed}),/Prebid bytes/);
});
test('review HTML is static, cannot start auctions and escapes all displayed metadata',()=>{
 const html=cacheReviewHtml({...result.report,source:{sha256:'<script>alert(1)</script>'}});
 assert(!/<script[\s>]/i.test(html));assert(!/<iframe[\s>]/i.test(html));assert(!/https?:\/\//.test(html));
 assert(html.includes("default-src 'none'"));assert(html.includes('&lt;script&gt;'));assert(html.includes('17 pozicija'));
 assert(html.includes('tanjug-cache-review-v1-control.zip'));assert(html.includes('tanjug-cache-review-v1-cache.zip'));
});
test('identical inputs reproduce both complete packages and their frozen ZIPs',async()=>{
 const again=await prepareTanjugCacheReview(args);assert.deepEqual(again.report,result.report);
 for(const arm of ['control','cache'])assert.deepEqual(again.candidates[arm],result.candidates[arm]);
});
