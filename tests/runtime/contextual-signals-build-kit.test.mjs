import test from 'node:test';
import assert from 'node:assert/strict';
import {contextualBuildKit} from '../../worker/site-runtime/contextual-signals-build-kit.mjs';
import {PREBID_CONTEXTUAL_MODULE_SOURCE} from '../../worker/runtime-321/prebid-module.mjs';
import {contextualSignalsInspectCommand} from '../../src/debug/contextual-signals-inspect.mjs';
import vm from 'node:vm';
const text=bytes=>new TextDecoder().decode(bytes);
test('kit preserves approved module metadata and adds only provider/core with exact source',()=>{
 const result=contextualBuildKit({site:{id:'fixture'},prebidBuilds:[{version:'11.34.0',modules_json:'["pubmaticBidAdapter","consentManagementTcf","rtdModule"]'}]});
 assert.equal(text(result['modules/contextualSignalsRtdProvider.js']),PREBID_CONTEXTUAL_MODULE_SOURCE);
 assert.deepEqual(JSON.parse(text(result['modules.json'])),['consentManagementTcf','contextualSignalsRtdProvider','pubmaticBidAdapter','rtdModule']);
 const manifest=JSON.parse(text(result['integration.json']));assert.equal(manifest.upstreamCommit,'195e0c6069928ed906bde550cb4e4183d1dc8474');
 assert.match(text(result['README.txt']),/not an SSP acknowledgement/);
 assert.match(text(result['README.txt']),/FIRST realTimeData/);
 assert.match(text(result['README.txt']),/BEFORE ads.js/);
});
test('unknown builds remain explicitly unreviewed and invalid module paths cannot become build inputs',()=>{
 const files=contextualBuildKit({site:{id:'fixture'}});assert.equal(JSON.parse(text(files['integration.json'])).reviewedVersion,false);
 assert.match(text(files['README.txt']),/not a replacement/);
 assert.throws(()=>contextualBuildKit({site:{id:'fixture'},prebidBuilds:[{},{}]}),/multiple current/);
 assert.throws(()=>contextualBuildKit({site:{id:'fixture'},prebidBuilds:[{version:'11.34.0',modules_json:'["../../evil"]'}]}),/metadata/);
});
test('debug reads evidence without calling requestBids and handles absent helper',()=>{
 const logs=[],snapshot={outputs:[{destination:'openx',taxonomy:'iab-content-3.0',ids:['VK7KD0'],evidence:'configuration-only'}],prebidVersion:'11.34.0',providerRegistered:true,rtd:{status:'rtd-config-changed-after-initialization',owner:'wrapper',providerObserved:true},evidence:'Not server acceptance'};
 const context={window:{__AD_CONTEXT:{snapshot:()=>snapshot}},console:{table:rows=>logs.push(rows),log:()=>{},warn:()=>{}}};
 assert.equal(vm.runInNewContext(contextualSignalsInspectCommand(),context),snapshot);assert.equal(logs[0][0].ids,'VK7KD0');assert.equal(logs[0][0].rtdStatus,'rtd-config-changed-after-initialization');assert.equal(logs[0][0].providerObserved,true);
 assert.equal(vm.runInNewContext(contextualSignalsInspectCommand(),{...context,window:{}}),null);
});
