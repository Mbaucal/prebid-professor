import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeCatalog,previewInput,descriptorForPin,buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {fixture,configure,checkedFixture,TS} from './artifact-fixture.mjs';
import {defaultBidderRules} from '../../shared/bidder-rules/settings.mjs';
const current=runtimeCatalog.find(row=>row.version==='3.22.0');
const policy=()=>({schemaVersion:1,enabled:true,rules:[{id:'rs',name:'RS only',bidder:'ix',enabled:true,positions:['P1'],countries:{mode:'include',values:['RS'],unknown:'skip'},devices:['desktop']}]});

test('every older bundled runtime rejects enabled rules with an actionable version choice',()=>{
  assert(current?.capabilities.includes('bidder-rules'));
  const snapshot=configure(fixture(),c=>{c.runtimeControls.bidderRules=policy();});
  for(const descriptor of runtimeCatalog.filter(row=>row!==current))assert.throws(()=>previewInput(snapshot,descriptor,TS),/Bidder rules require script 3.22.0/);
  assert.deepEqual(previewInput(snapshot,current,TS).bidderRules,policy());
  assert.equal(descriptorForPin(pinRuntime(current)).version,'3.22.0');
});
test('unconfigured rules and disabled rules preserve older script selections',()=>{
  const previous=runtimeCatalog.find(row=>row.version==='3.21.0'),snapshot=fixture();
  assert.doesNotThrow(()=>previewInput(snapshot,previous,TS));
  configure(snapshot,c=>{c.runtimeControls.bidderRules={...policy(),enabled:false};});
  assert.doesNotThrow(()=>previewInput(snapshot,previous,TS));
  assert.deepEqual(previewInput(fixture(),current,TS).bidderRules,defaultBidderRules());
});
test('catalog routes generation through 3.22 and keeps the exact enabled policy in exported config',async()=>{
  const snapshot=configure(fixture(),c=>{c.runtimeControls.bidderRules=policy();}),before=structuredClone(snapshot);
  const candidate=await buildArtifactCandidate({snapshot,pin:pinRuntime(current),buildTimestamp:TS,prebid:await checkedFixture(snapshot)});
  const config=JSON.parse(new TextDecoder().decode(candidate.files['config.json']));
  assert.equal(config.runtime.runtimeVersion,'3.22.0');assert.deepEqual(config.bidderRules,policy());
  assert.match(new TextDecoder().decode(candidate.files['ads.js']),/__AD_BIDDER_RULES/);
  assert.deepEqual(snapshot,before);
});
