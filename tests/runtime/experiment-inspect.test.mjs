import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { experimentInspectCommand } from '../../src/debug/experiment-inspect.mjs';
const run=(window={},scripts=[])=>{
  let copied;
  const sandbox={window,document:{scripts},URL,console:{group(){},groupEnd(){},table(){},log(){}},copy:s=>{copied=s;}};
  const report=vm.runInNewContext(experimentInspectCommand,sandbox);
  return {report,copied};
};
test('inspect does not infer executions from tags and strips URL credentials/query/fragments',()=>{
  const {report,copied}=run({pbjs:{version:'11.34.0'},__TESSERA_RUNTIME_STARTED:{}},[
    {src:'https://user:password@example.invalid/ads.js?token=secret#private'},
    {src:'https://example.invalid/ads.js'},
    {src:'https://example.invalid/other.js?secret'}]);
  assert.equal(report.scripts.length,2);assert.equal(report.confirmedRuntimeExecutions,null);
  assert.equal(report.observedPrebidVersion,'11.34.0');assert.equal(report.runtimeMarkerPresent,true);
  assert(!/password|token|secret|private/.test(copied));
});
test('inspect preserves assignment, duplicate counts and timeline without collecting consent or user IDs',()=>{
  const {report,copied}=run({__tcfapi(){throw Error('must not call');},__tesseraExperiments:{site:{context:{siteId:'test',variant:'B',packageSha256:'a'.repeat(64),consent:'do-not-export'},status:'load-error',snapshot:()=>({loaderAttempts:3,blockedDuplicates:2,events:[{type:'assigned',elapsedMs:0},{type:'load-error',elapsedMs:7,secret:'do-not-export'}]})}}});
  assert.equal(report.experiments[0].blockedDuplicates,2);assert.equal(report.experiments[0].events[1].type,'load-error');
  assert(!copied.includes('do-not-export'));assert.equal(report.confirmedRuntimeExecutions,null);
});
test('old or missing instrumentation remains unknown and inspect tolerates unavailable clipboard',()=>{
  const {report}=run({__tesseraExperiments:{old:{context:{siteId:'old'},status:'loaded'}}});
  assert.equal(report.experiments[0].blockedDuplicates,null);
  const sandbox={window:{},document:{scripts:[]},URL,console:{group(){},groupEnd(){},table(){},log(){}}};
  assert.equal(vm.runInNewContext(experimentInspectCommand,sandbox).experiments.length,0);
});
test('new runtime evidence exposes entry counts and separate GPT outcomes without implying total execution count',()=>{
  const {report,copied}=run({__tesseraRuntimeDiagnostics:{site:{snapshot:()=>({siteId:'test',runtimeVersion:'3.11.0-tessera.preview.1',attempts:2,initializations:1,blockedDuplicates:1,totals:{requests:2,empty:1,filled:1},events:[{type:'filled-render',slot:'P1',elapsedMs:40,requestToRenderMs:25,creativeId:'not-exported'}]})}}});
  assert.equal(report.runtimeDiagnostics[0].runtimeEntries,1);
  assert.equal(report.runtimeDiagnostics[0].blockedDuplicates,1);
  assert.equal(report.runtimeDiagnostics[0].totals.empty,1);
  assert.equal(report.confirmedRuntimeExecutions,null);assert(!copied.includes('not-exported'));
});
test('measurement inspector exposes bounded reporting labels without claiming revenue',()=>{
 const {report,copied}=run({__tesseraGamMeasurement:{site:{snapshot:()=>({runtimeVersion:'3.12.0',key:'tessera_ab',value:'d'+'a'.repeat(32)+'_b',identity:{deliverySha256:'a'.repeat(64),variant:'B',secret:'do-not-export'},appliedSlots:3,failedSlots:0,secret:'do-not-export'})}}});
 assert.equal(report.gamMeasurement[0].appliedSlots,3);assert.equal(report.gamMeasurement[0].variant,'B');
 assert(!copied.includes('do-not-export'));assert(report.notes.some(n=>n.includes('not confirmation of GAM')));
});
test('collection diagnostics expose acknowledgements without signed tickets or page IDs',()=>{
 const {report,copied}=run({__tesseraExperiments:{site:{context:{siteId:'test-site'},snapshot:()=>({collection:{status:'acknowledged',attempts:2,acknowledgedTypes:['assigned','script-loaded'],pendingTypes:[],ticket:'never-export-ticket',assignmentId:'never-export-id'}})}}});
 assert.equal(report.experiments[0].collection.attempts,2);assert.equal(report.experiments[0].collection.acknowledgedTypes.length,2);assert(!copied.includes('never-export'));
});
test('cache inspect exposes decisions and age but never bids, consent strings or arbitrary errors',()=>{
 const {report,copied}=run({__tcfapi(){throw Error('Read-only inspector must not call CMP');},__tesseraBidCache:{site:{snapshot:()=>({siteId:'test',runtimeVersion:'3.13.0',mode:'auction-with-cache',maxAgeSeconds:30,consent:{epoch:3,ready:true,tcString:'never-export-consent'},policy:{selections:{cache:1,fresh:2},checks:{accepted:4,rejected:{expired:1,secret:'never-export'}},lastSelection:{code:'P1',origin:'cache',ageMs:1200,adId:'never-export-bid',reason:'never-export-error'}}})}}});
 assert.equal(report.cacheDiagnostics[0].selections.cache,1);assert.equal(report.cacheDiagnostics[0].lastSelection.ageMs,1200);
 assert.equal(report.cacheDiagnostics[0].contextEpoch,3);assert.equal(report.cacheDiagnostics[0].lastSelection.reason,null);assert(!copied.includes('never-export'));
});
test('static delivery and readiness use allowlisted fields and preserve uncertainty',()=>{
 const {report,copied}=run({AdVariant:{snapshot:()=>({release:'observed-v1',variant:'B',script:'https://user:SECRET@cdn.example/ads.js?SECRET',runtimeEntries:1,secret:'SECRET'})},
   AdBidReadiness:{snapshot:()=>({profile:'bid-readiness-observer-1.0.0',cacheEnabled:false,guaranteedAds:50,nativeSelectionVerified:true,
     rows:[{position:'P1',candidates:2,earliestExpiryMs:10000,rejected:{'already-used':1,SECRET:4},counters:{submitted:1},adId:'SECRET'}]})}});
 assert.equal(report.staticDelivery.variant,'B');assert.equal(report.bidReadiness.rows[0].candidates,2);
 assert.equal(report.bidReadiness.guaranteedAds,null);assert.equal(report.bidReadiness.nativeSelectionVerified,false);assert(!copied.includes('SECRET'));
});
test('unavailable readiness observer does not break the existing debug command',()=>{
 const {report}=run({AdVariant:{snapshot(){throw Error('unavailable');}},AdBidReadiness:{snapshot(){throw Error('unavailable');}}});
 assert.equal(report.staticDelivery,null);assert.equal(report.bidReadiness,null);
});

test('full cache package exposes targeting, fallback and rejection counters without running ad APIs',()=>{
 const forbidden=()=>{throw Error('Inspector must not change ad delivery');};
 const snapshot={profile:'full-cache-lifecycle-v1',siteId:'tanjug',runtimeVersion:'tanjug-cache-1.0.1',mode:'auction-with-cache',maxAgeSeconds:60,
   totals:{auctions:4,submissionAttempts:4,fallbacks:1,blocked:0,lateCallbacks:0,errors:0},
   consent:{epoch:2,cacheAllowed:true,tcString:'DO_NOT_EXPORT'},
   policy:{selections:{fresh:2,cache:1,none:1,errors:0,blockedDuplicates:0},checks:{accepted:5,rejected:{expired:3,used:2,DO_NOT_EXPORT:1}},
     lastSelection:{code:'Billboard',origin:'cache',ageMs:34000,adId:'DO_NOT_EXPORT'}}};
 const before=JSON.stringify(snapshot);
 const {report,copied}=run({AdVariant:{snapshot:()=>({release:'tanjug-cache-1.0.1',variant:'B',mode:'auction-with-cache',
   scriptSha256:'a'.repeat(64),appliedSlots:19,targetingFailures:0,slots:[{position:'Billboard',Variant:'B',secret:'DO_NOT_EXPORT'}]})},
   AdBidCache:{snapshot:()=>snapshot,inspect:forbidden},pbjs:{requestBids:forbidden,setConfig:forbidden,setTargetingForGPTAsync:forbidden,getHighestCpmBids:forbidden},
   googletag:{pubads:forbidden},__tcfapi:forbidden,fetch:forbidden});
 assert.equal(report.staticCache.status,'active');assert.equal(report.staticCache.selections.cache,1);
 assert.equal(report.staticCache.totals.fallbacks,1);assert.equal(report.staticCache.filterChecks.rejected.expired,3);
 assert.equal(report.staticCache.lastSelection.ageMs,34000);assert.equal(report.staticCache.cacheContextReady,true);
 assert.equal(report.staticDelivery.scriptSha256,'a'.repeat(64));assert.equal(report.staticDelivery.slots[0].Variant,'B');
 assert.equal(report.staticDelivery.appliedSlots,19);assert.equal(JSON.stringify(snapshot),before);
 assert(!copied.includes('DO_NOT_EXPORT'));assert(report.notes.some(n=>n.includes('not rendered ads or revenue')));
});

test('fresh-only A, waiting B and unavailable instrumentation are distinct',()=>{
 const fresh=run({AdVariant:{snapshot:()=>({variant:'A',mode:'fresh-only'})}}).report;
 assert.equal(fresh.staticCache.status,'not-enabled');
 const waiting=run({AdVariant:{snapshot:()=>({variant:'B',mode:'auction-with-cache'})},AdBidCache:{snapshot:()=>({mode:'auction-with-cache',status:'waiting'})}}).report;
 assert.equal(waiting.staticCache.status,'waiting');assert.equal(waiting.staticCache.selections.cache,null);
 assert.equal(run({}).report.staticCache.status,'unavailable');
 assert.equal(run({AdVariant:{snapshot:()=>({variant:'B',mode:'auction-with-cache'})}}).report.staticCache.status,'unavailable');
});

test('embedded cache snapshot is used when the standalone API is absent',()=>{
 const {report}=run({AdVariant:{snapshot:()=>({variant:'B',mode:'auction-with-cache',bidCache:{mode:'auction-with-cache',stopped:true,policy:{selections:{cache:3}}}})}});
 assert.equal(report.staticCache.status,'stopped');assert.equal(report.staticCache.selections.cache,3);
});

test('unreadable cache instrumentation does not prevent remaining page diagnostics',()=>{
 const unavailable={snapshot(){throw Error('DO_NOT_EXPORT');}};
 const {report,copied}=run({AdVariant:unavailable,AdBidCache:unavailable,__tesseraBidCache:{broken:unavailable},pbjs:{version:'11.34.0'}});
 assert.equal(report.staticCache.status,'unavailable');assert.equal(report.cacheDiagnostics.length,0);
 assert.equal(report.observedPrebidVersion,'11.34.0');assert(!copied.includes('DO_NOT_EXPORT'));
});

test('static slot report is bounded and does not expose arbitrary targeting',()=>{
 const {report,copied}=run({AdVariant:{snapshot:()=>({mode:'fresh-only',scriptSha256:'DO_NOT_EXPORT',
   slots:Array.from({length:110},(_,i)=>({position:'P'+i,Variant:i?'B':'DO_NOT_EXPORT',userId:'DO_NOT_EXPORT'}))})}});
 assert.equal(report.staticDelivery.slots.length,100);assert.equal(report.staticDelivery.slots[0].Variant,null);
 assert.equal(report.staticDelivery.scriptSha256,null);assert(!copied.includes('DO_NOT_EXPORT'));
});
