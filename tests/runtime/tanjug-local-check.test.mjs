import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {captureBaseline,LIVE_SCRIPTS,hash} from '../../scripts/capture-tanjug-live-baseline.mjs';
import {buildOverrideKits} from '../../scripts/tanjug-local-override-kit.mjs';
import {prepareTanjugCacheReview} from '../../worker/pilots/tanjug-cache-review.mjs';
const response=(body='/* captured public JS */',{type='application/javascript',status=200}={})=>new Response(body,{status,headers:{'content-type':type}});
test('baseline captures only the two observed URLs, checks repeat reads and retains exact bytes',async()=>{
 const calls=[],bodies={'ads.js':'/* first */\r\nvar a=1;','prebid.js':'/* second */\nvar b=2;'};
 const r=await captureBaseline(async(url,options)=>{calls.push(url);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');return response(bodies[url.split('/').pop()]);},()=> '2026-09-18T06:00:00.000Z');
 assert.deepEqual(calls,[...Object.values(LIVE_SCRIPTS),...Object.values(LIVE_SCRIPTS)]);
 for(const [name,text] of Object.entries(bodies)){assert.equal(r.files[name].toString(),text);assert.equal(r.report.scripts[name].sha256,hash(Buffer.from(text)));}
 assert.equal(r.report.repeatedReadsMatch,true);
});
test('baseline rejects changing bytes, HTML, HTTP errors, redirects, empty and oversized bodies',async()=>{
 let reads=0;await assert.rejects(captureBaseline(async()=>response('var a='+(reads++))),/changed during capture/);
 for(const get of [()=>response('<html>error</html>'),()=>response('',{}),()=>response('blocked',{status:403}),()=>response('data',{type:'text/html'}),()=>response('x'.repeat(2*1024*1024+1)),()=>({status:200,headers:new Headers({'content-type':'application/javascript'}),redirected:true,body:new ReadableStream()})])await assert.rejects(captureBaseline(async()=>get()));
});
test('local kits replace exactly one wrapper and the pinned dependency; archive and runtime bytes stay intact',async()=>{
 const read=path=>readFileSync(new URL('../../'+path,import.meta.url)),proposal=JSON.parse(read('worker/pilots/tanjug-cache-review-v1.json'));
 const review=await prepareTanjugCacheReview({proposal,sourceBytes:read(proposal.sourceFile),prebidBytes:read('vendor/prebid/tanjug-11.34.0/prebid.js')});
 const kits=await buildOverrideKits(review);
 for(const arm of ['control','cache']){
  const kit=kits[arm],files=unzipSync(kit.zip);
  assert.deepEqual(Object.keys(files).sort(),['README.md','mapping.json','overrides/tanjug.pages.dev/ads.js','overrides/tanjug.pages.dev/prebid.js']);
  assert.deepEqual(files['overrides/tanjug.pages.dev/ads.js'],review.candidates[arm].files['ads.min.js']);
  assert.deepEqual(files['overrides/tanjug.pages.dev/prebid.js'],review.candidates[arm].files['prebid.js']);
  assert.equal(kit.report.packageSha256,review.report.arms[arm].packageSha256);assert.equal(kit.report.readiness,'prepared-not-executed');
 }
 assert.deepEqual(kits.control.files['overrides/tanjug.pages.dev/prebid.js'],kits.cache.files['overrides/tanjug.pages.dev/prebid.js']);
 const original=review.report.arms.control.packageSha256;review.report.arms.control.packageSha256='0'.repeat(64);await assert.rejects(buildOverrideKits(review),/identity changed/);review.report.arms.control.packageSha256=original;
 const zip=review.candidates.control.zip;review.candidates.control.zip=new Uint8Array([1]);await assert.rejects(buildOverrideKits(review),/archive changed/);review.candidates.control.zip=zip;
 review.candidates.control.files['ads.min.js']=new Uint8Array([1]);await assert.rejects(buildOverrideKits(review));
});
