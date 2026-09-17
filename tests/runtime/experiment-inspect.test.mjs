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
