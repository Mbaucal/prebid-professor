import test from 'node:test';
import assert from 'node:assert/strict';
import {loaderMeasurementPage} from '../support/ab-measurement-page.mjs';
import * as current from '../../worker/experiments/ab-loader-1.1.1.mjs';
import {previewAbMemoryMeasurements,validateAbMemoryMeasurement} from '../../worker/experiments/ab-measurement.mjs';

const page=options=>loaderMeasurementPage({L:current,...options});
function plan(value){return {schemaVersion:1,kind:'tessera-ab-report-plan',id:'abm-'+'d'.repeat(64),site:value.site,experimentId:value.experimentId,testId:value.testId,recordSha256:'f'.repeat(64),zipSha256:'e'.repeat(64),
  loader:value.loader,trafficBPercent:value.trafficBPercent,
  arms:Object.fromEntries(['A','B'].map(side=>[side,{...value.arms[side],runtimeVersion:'3.25.1',runtimeSha256:'b'.repeat(64)}])),prebidSha256:null,
  report:{networkCode:'999',inventoryPath:'/999/memory-site/',startDate:'2026-11-17',endDate:'2026-11-18',currency:'EUR',timeZone:'Europe/Belgrade',revenueBasis:'net',revenueMetric:'total'},
  source:{savedPackageScopeVerified:true,gamReportSourceVerified:false},measurement:{collection:'disabled',coverage:'unknown',revenueReady:false},createdAt:'2026-11-20T16:00:00.000Z',createdBy:'tester@example.invalid'};}

test('v2 fallback requests do not become actual fallbacks when the original B wins',()=>{
  const p=page(),first=p.measurement(),b=p.scripts[0];p.advance(16000);const waiting=p.measurement();p.load(b);const end=p.measurement(),context=plan(end);
  assert.equal(validateAbMemoryMeasurement(context,waiting),waiting);assert.equal(waiting.schemaVersion,2);
  const value=previewAbMemoryMeasurements(context,[first,waiting,end]);
  assert.deepEqual(value.assignments,{A:0,B:1});assert.equal(value.execution.B.B,1);assert.equal(value.fallbacks.B,0);assert.equal(value.terminalFailures,0);
  assert.equal(value.revenueReady,false);assert.deepEqual(value.pageRpm,{A:null,B:null});assert.equal(value.winner,null);
});

test('v2 actual control fallback is accounted to original B; A retry is not a fallback',()=>{
  const p=page();p.advance(16000);p.load();const value=p.measurement(),preview=previewAbMemoryMeasurements(plan(value),[value]);
  assert.equal(preview.execution.B.A,1);assert.equal(preview.fallbacks.B,1);
  const retry=page({trafficBPercent:50,random:0});retry.advance(16000);retry.load();const result=retry.measurement();
  assert.equal(validateAbMemoryMeasurement(plan(result),result),result);assert.equal(previewAbMemoryMeasurements(plan(result),[result]).fallbacks.A,0);
});

test('v2 definite terminal failure is distinct from a pair of soft deadlines',()=>{
  const p=page();p.error();p.error();const value=p.measurement();
  assert.equal(validateAbMemoryMeasurement(plan(value),value),value);assert.equal(previewAbMemoryMeasurements(plan(value),[value]).terminalFailures,1);
  const waiting=page();waiting.advance(16000);const slow=waiting.measurement(),forged=structuredClone(slow);
  forged.events.push({seq:forged.events.length+1,at:slow.createdAt,type:'terminal-failure',arm:'A',reason:'timeout'});
  assert.throws(()=>validateAbMemoryMeasurement(plan(slow),forged),/pending arm/);
});

test('schema versions, new event vocabulary, exact fields and runtime/fallback identities remain strict',()=>{
  const p=page();p.advance(8000);p.load();const value=p.measurement(),context=plan(value);
  for(const mutate of [v=>v.schemaVersion=1,v=>v.schemaVersion=3,v=>v.events.find(row=>row.type==='fallback').fromArm='A',v=>v.events.find(row=>row.type==='fallback-requested').toArm='B',v=>v.events.find(row=>row.type==='arm-deadline').extra=true]){
    const changed=structuredClone(value);mutate(changed);assert.throws(()=>validateAbMemoryMeasurement(context,changed));
  }
  const old=loaderMeasurementPage().measurement();old.events.push({seq:old.events.length+1,at:old.createdAt,type:'arm-deadline',arm:'B'});
  assert.throws(()=>validateAbMemoryMeasurement(plan(old),old),/Invalid memory event/);
});

test('new source/version metadata cannot be joined into a page prefix from another ledger version',()=>{
  const p=page(),early=p.measurement();p.advance(8000);p.load();const final=p.measurement();
  assert.equal(previewAbMemoryMeasurements(plan(final),[early,final,early]).identifiedPages,1);
  const changed=structuredClone(early);changed.loader={version:'1.1.0',sha256:'a'.repeat(64)};changed.schemaVersion=1;
  assert.throws(()=>previewAbMemoryMeasurements(plan(final),[changed,final]),/another saved experiment/);
});

test('a running B may finish loading after a targeting exclusion, but a failed B cannot later start',()=>{
  const p=page(),b=p.scripts[0];p.runtime(b);p.service.setTargeting('TestId','publisher-change');b.onload();const value=p.measurement();
  assert.equal(validateAbMemoryMeasurement(plan(value),value),value);assert.equal(previewAbMemoryMeasurements(plan(value),[value]).execution.B.B,1);
  const forged=structuredClone(value),index=forged.events.findIndex(row=>row.type==='runtime-started');
  forged.events.splice(index,0,{seq:0,at:value.createdAt,type:'arm-failed',arm:'B',reason:'error'});forged.events.forEach((row,i)=>row.seq=i+1);
  assert.throws(()=>validateAbMemoryMeasurement(plan(value),forged),/after failure/);
});
