import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeCatalog,previewInput,buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {compileRuntime324} from '../../worker/runtime-324/compiler.mjs';
import {compileRuntime3222} from '../../worker/runtime-3222/compiler.mjs';
import {runtime324Source,sourceFiles} from '../../scripts/prepare-runtime324.mjs';
import {sourceFiles as accountFiles} from '../../scripts/prepare-runtime3222.mjs';
import {sourceFiles as cacheFiles} from '../../scripts/prepare-runtime323.mjs';
import {fixture,configure,TS} from './artifact-fixture.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {accountDealPlan} from '../../shared/bidder-accounts/deals.mjs';

const descriptor=runtimeCatalog.find(r=>r.version==='3.24.0');
test('the combined runtime is explicit preview and retains both complete source closures and capabilities',async()=>{
  assert.equal(descriptor.channel,'preview');assert.throws(()=>pinRuntime(descriptor),/explicit opt-in/);
  const combined=new Set(sourceFiles);
  for(const path of [...accountFiles,...cacheFiles])assert(combined.has(path),path);
  for(const version of ['3.22.2','3.23.0'])for(const name of runtimeCatalog.find(r=>r.version===version).capabilities)
    assert(descriptor.capabilities.includes(name),version+': '+name);
  assert.equal((await runtime324Source(process.cwd())).codeSha256,descriptor.codeSha256);
  assert.equal(runtimeReleaseHistory.find(r=>r.channel==='stable').version,'3.23.0');
});
for(const prebid of [true,false])for(const frequency of [0,5])test(`no active cache keeps the exact 3.22.2 program (${prebid}/${frequency})`,()=>{
  const snapshot=configure(positionFixture(prebid),c=>{c.runtimeControls.adPositions.Overlay.frequencyMinutes=frequency;});
  const input=previewInput(snapshot,descriptor,TS);
  assert.equal(compileRuntime324(input).adsJs,compileRuntime3222(input).adsJs);
});
test('GAM-only packages accept saved cache/account data without enabling identity or Prebid runtime work',async()=>{
  const snapshot=configure(fixture(),c=>{c.enablePrebid=false;c.prebidBidCache={enabled:true,maxBidAgeSeconds:60};});
  snapshot.bidders=[{bidder:'adf_ag',enabled:1,params_json:'{"mid":111}',account_json:'{"baseAdapter":"adf","schain":{"mode":"none"}}'}];
  const result=await buildArtifactCandidate({snapshot,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:TS});
  const js=new TextDecoder().decode(result.files['ads.js']);
  assert(!result.files['prebid.js']);assert(!js.includes('TESSERA_BID_CACHE='));assert(!js.includes('function createBidderAccounts('));
  assert.equal(result.manifest.runtime.runtimeVersion,'3.24.0');
});
function accounts(names){
  const snapshot=fixture();snapshot.overrides=[];
  snapshot.bidders=names.map((bidder,index)=>({bidder,enabled:1,params_json:JSON.stringify({publisherId:'synthetic',adSlot:'synthetic-'+index}),
    account_json:JSON.stringify(bidder==='improvedigital'?{}:{baseAdapter:'pubmatic',schain:{mode:'none'}})}));
  return snapshot;
}
test('Generate input retains the existing native 20-character targeting collision guard even with no saved deals',()=>{
  const snapshot=accounts(['pubmatic_agency_1','pubmatic_agency_2']);
  assert.throws(()=>previewInput(snapshot,descriptor,TS),/Bidder names collide in GAM targeting/);
});
test('a unique long alias and improvedigital remain valid and deal metadata uses native truncated keys',()=>{
  const snapshot=configure(accounts(['agency_pubmatic_long','improvedigital']),c=>{
    c.runtimeControls.deals={schemaVersion:1,entries:[{id:'agency',name:'Agency deal',bidder:'agency_pubmatic_long',dealId:'D-1234',positions:['P1'],startsAt:'2026-01-01T00:00:00.000Z',endsAt:'2027-01-01T00:00:00.000Z',enabled:true,mode:'price'}]};
  });
  const input=previewInput(snapshot,descriptor,TS),plan=accountDealPlan(snapshot,input.deals);
  assert.equal(input.bidderAccounts[1].baseAdapter,'improvedigital');
  assert.equal(plan.entries[0].targeting.key,('hb_deal_agency_pubmatic_long').slice(0,20));
  assert.equal(plan.entries[0].creativeAdIdMacro,'%%PATTERN:'+('hb_adid_agency_pubmatic_long').slice(0,20)+'%%');
});
