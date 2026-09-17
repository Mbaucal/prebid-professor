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
