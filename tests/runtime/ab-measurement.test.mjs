import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loaderMeasurementPage as page} from '../support/ab-measurement-page.mjs';
import {previewAbMemoryMeasurements,validateAbMemoryMeasurement} from '../../worker/experiments/ab-measurement.mjs';

const registry=JSON.parse(readFileSync(new URL('../../worker/experiments/ab-loader-registry.json',import.meta.url),'utf8'));
function plan(){return {schemaVersion:1,kind:'tessera-ab-report-plan',id:'abm-'+'d'.repeat(64),site:'memory-site',experimentId:'abx-'+'c'.repeat(64),testId:'loader_memory',recordSha256:'f'.repeat(64),zipSha256:'e'.repeat(64),
  loader:{version:'1.1.0',sha256:registry['1.1.0'].sha256},trafficBPercent:100,
  arms:Object.fromEntries(['A','B'].map(side=>[side,{release:'builtin-release-'+side.toLowerCase().repeat(64),runtimeVersion:'3.25.1',scriptSha256:'a'.repeat(64),runtimeSha256:'b'.repeat(64)}])),prebidSha256:null,
  report:{networkCode:'999',inventoryPath:'/999/memory-site/',startDate:'2026-11-17',endDate:'2026-11-18',currency:'EUR',timeZone:'Europe/Belgrade',revenueBasis:'net',revenueMetric:'total'},
  source:{savedPackageScopeVerified:true,gamReportSourceVerified:false},measurement:{collection:'disabled',coverage:'unknown',revenueReady:false},createdAt:'2026-11-20T16:00:00.000Z',createdBy:'tester@example.invalid'};}

test('offline execution matrix retains assigned B after control fallback and post-assignment exclusion',()=>{
  const p=page();const first=p.measurement();p.advance(8000);p.load();p.service.setTargeting('TestId','foreign');
  const result=previewAbMemoryMeasurements(plan(),[first,p.measurement(),p.measurement()]);
  assert.deepEqual(result.assignments,{A:0,B:1});assert.deepEqual(result.execution.B,{A:1,B:0,none:0});assert.equal(result.fallbacks.B,1);
  assert.equal(result.exclusions.afterAssignment,1);assert.equal(result.duplicateExports,2);assert.equal(result.identifiedPages,1);
  assert.equal(result.revenueReady,false);assert.equal(result.srm.status,'unavailable');assert.deepEqual(result.pageRpm,{A:null,B:null});assert.equal(result.winner,null);
  assert(result.blockers.some(reason=>reason.includes('unlabelled')));
});

test('pre-assignment exclusions and QA remain unassigned; load failure is not dropped',()=>{
  const conflict=page({keywords:{TestId:'foreign'},random:1}),qa=page({search:'?tessera_ab=B',random:2}),failed=page({random:3});failed.advance(16000);
  const result=previewAbMemoryMeasurements(plan(),[conflict.measurement(),qa.measurement(),failed.measurement()]);
  assert.deepEqual(result.assignments,{A:0,B:1});assert.equal(result.identifiedPages,3);assert.equal(result.exclusions.beforeAssignment,1);
  assert.equal(result.execution.B.none,1);assert.equal(result.terminalFailures,1);
});

test('unidentified or bounded-overflow observations cannot establish denominator or SRM',()=>{
  const p=page();p.load();for(let i=0;i<100;i++)p.sandbox.__tesseraAbLoader.duplicate();const unidentified=structuredClone(p.measurement());unidentified.pageId=null;
  const result=previewAbMemoryMeasurements(plan(),[p.measurement(),unidentified]);
  assert.equal(result.unidentifiedExports,1);assert(result.droppedEvents>0);assert.equal(result.assignments.B,1);assert.equal(result.coverage,'unknown');assert.equal(result.srm.status,'unavailable');
});

test('source dimensions, original assignment, execution count and event histories are strict',()=>{
  const value=page().measurement();assert.equal(validateAbMemoryMeasurement(plan(),value),value);
  for(const mutate of [v=>v.site='foreign',v=>v.testId='foreign',v=>v.arms.B.scriptSha256='e'.repeat(64),v=>v.loader.version='1.0.2',v=>v.coverage='complete',v=>v.assignment.variant='A',v=>v.events[0].seq=2,v=>v.events[0].extra=true]){
    const changed=structuredClone(value);mutate(changed);assert.throws(()=>validateAbMemoryMeasurement(plan(),changed),error=>error.status===422);
  }
  const changed=structuredClone(value);changed.events.at(-1).type='script-loaded';assert.throws(()=>previewAbMemoryMeasurements(plan(),[value,changed]),/Conflicting event history/);
});

test('later exports replace prefixes, conflicting identity cannot be joined and missing pages stay unknown',()=>{
  const p=page(),early=p.measurement();p.load();const late=p.measurement();
  const result=previewAbMemoryMeasurements(plan(),[late,early]);assert.equal(result.execution.B.B,1);assert.equal(result.assignments.B,1);
  const changed=structuredClone(late);changed.createdAt='2026-11-19T12:00:00.000Z';assert.throws(()=>previewAbMemoryMeasurements(plan(),[late,changed]),/conflicting immutable/);
  assert.deepEqual(previewAbMemoryMeasurements(plan(),[]).assignments,{A:0,B:0});assert.equal(previewAbMemoryMeasurements(plan(),[]).revenueReady,false);
});

test('forced, random-unavailable and pre-excluded exports cannot acquire later random assignments',()=>{
  for(const first of [{type:'qa-forced',arm:'B'},{type:'random-unavailable'},{type:'exclusion',reason:'excluded-key-conflict',phase:'before-assignment'}]){
    const value=page().measurement(),at=value.assignment.at;
    value.events=[{seq:1,at,...first},{seq:2,at,type:'assignment',variant:'B'}];
    assert.throws(()=>validateAbMemoryMeasurement(plan(),value),/excluded\/QA/);
  }
});
