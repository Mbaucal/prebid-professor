/** Independent memory-only checks; forbidden page APIs are observable throwing getters. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loaderMeasurementPage as page} from '../support/ab-measurement-page.mjs';
import * as current from '../../worker/experiments/ab-loader-1.1.0.mjs';
import * as previous from '../../worker/experiments/ab-loader-1.0.2.mjs';
import {validateAbMemoryMeasurement,previewAbMemoryMeasurements} from '../../worker/experiments/ab-measurement.mjs';
import {reportPlanIdentity} from '../../worker/experiments/ab-report-plan.mjs';

const traps=`
window.__forbiddenTouches=[];
['fetch','XMLHttpRequest','localStorage','sessionStorage','__tcfapi','__gpp','__uspapi'].forEach(function(name){
  Object.defineProperty(window,name,{configurable:true,get:function(){__forbiddenTouches.push(name);throw Error('Forbidden '+name);}});
});
window.navigator={};Object.defineProperty(navigator,'sendBeacon',{get:function(){__forbiddenTouches.push('sendBeacon');throw Error('Forbidden beacon');}});
Object.defineProperty(document,'cookie',{get:function(){__forbiddenTouches.push('cookie');throw Error('Forbidden cookie');},set:function(){__forbiddenTouches.push('cookie-write');throw Error('Forbidden cookie');}});
`;
function instrumented(L=current,prefix=''){
  return {...L,renderAbLoader(config){return traps+prefix+L.renderAbLoader(config);}};
}
function planFor(value){
  const plan={schemaVersion:1,kind:'tessera-ab-report-plan',id:null,site:value.site,experimentId:value.experimentId,testId:value.testId,
    recordSha256:'a'.repeat(64),zipSha256:'b'.repeat(64),loader:value.loader,trafficBPercent:value.trafficBPercent,
    arms:Object.fromEntries(['A','B'].map(side=>[side,{release:value.arms[side].release,scriptSha256:value.arms[side].scriptSha256,runtimeVersion:'3.25.1',runtimeSha256:'c'.repeat(64)}])),prebidSha256:null,
    report:{networkCode:'123',inventoryPath:'/123/inventory/',startDate:'2026-11-18',endDate:'2026-11-19',currency:'EUR',timeZone:'UTC',revenueBasis:'net',revenueMetric:'total'},
    source:{savedPackageScopeVerified:true,gamReportSourceVerified:false},measurement:{collection:'disabled',coverage:'unknown',revenueReady:false},createdBy:'qa@example.invalid',createdAt:value.createdAt};
  plan.id='abm-'+createHash('sha256').update(reportPlanIdentity(plan)).digest('hex');return plan;
}
const serving=p=>({scripts:p.scripts.map(script=>({src:script.src,removed:!!script.removed})),targeting:[...p.values],timers:p.timers.size,starts:p.starts.length,
  state:Object.fromEntries(['variant','status','scriptRelease','armStatus','fallback','keyConflict','runtimeStarted','blockedLateArmStarts'].map(key=>[key,p.state()[key]]))});

test('memory observation preserves 1.0.2 serving results and never touches outbound/storage/CMP APIs',()=>{
  const cases=[
    {run:p=>p.load()},
    {run:p=>{const retired=p.scripts[0];p.advance(8000);assert.equal(p.runtime(retired),false);p.load();}},
    {run:p=>{p.advance(8000);p.error();}},
    {options:{keywords:{Variant:'publisher',section:'sport'}},run:p=>p.load()},
    {run:p=>{p.load();p.service.setTargeting('Variant','publisher');}},
    {options:{ready:false},run:p=>{p.advance(8000);p.flush();p.load();}},
    {options:{search:'?tessera_ab=B'},run:p=>p.load()},
    {options:{crypto:false},run:p=>p.load()},
    {run:p=>{p.sandbox.__tesseraAbLoader.duplicate();p.load();}},
  ];
  for(const scenario of cases){
    const before=page({...scenario.options,L:instrumented(previous)}),after=page({...scenario.options,L:instrumented(current)});
    scenario.run(before);scenario.run(after);
    assert.deepEqual(serving(after),serving(before));
    assert.deepEqual([...after.sandbox.__forbiddenTouches],[]);
    const value=after.measurement();assert.equal(value.collection,'memory-only');assert.equal(value.coverage,'unknown');
    assert.deepEqual([...after.sandbox.__forbiddenTouches],[]);
  }
});

test('failure of the separate crypto page-ID draw neither rerolls allocation nor blocks the selected runtime',()=>{
  const prefix=`window.__draws=[];crypto.getRandomValues=function(array){__draws.push(array.length);if(array.length===4)throw Error('Synthetic identity failure');array[0]=4294967295;return array;};`;
  const p=page({L:instrumented(current,prefix)});p.load();const value=p.measurement();
  assert.deepEqual([...p.sandbox.__draws],[1,4]);assert.equal(value.pageId,null);assert.equal(value.assignment.variant,'B');
  assert.equal(p.starts.length,1);assert.equal(p.state().variant,'B');assert.deepEqual([...p.sandbox.__forbiddenTouches],[]);
  const result=previewAbMemoryMeasurements(planFor(value),[value]);assert.equal(result.unidentifiedExports,1);assert.deepEqual(result.assignments,{A:0,B:0});
  assert.equal(result.revenueReady,false);assert.equal(result.srm.status,'unavailable');
});

test('detached snapshots cannot alter immutable assignment, source pins, loader or subsequent observations',()=>{
  const p=page({L:instrumented()}),first=p.measurement();
  const loaderHash=first.loader.sha256,scriptHash=first.arms.B.scriptSha256,assignedAt=first.assignment.at;
  first.assignment.variant='A';first.loader.sha256='f'.repeat(64);first.arms.B.scriptSha256='f'.repeat(64);first.events[0].variant='A';
  p.load();const second=p.measurement();
  assert.equal(second.assignment.variant,'B');assert.equal(second.assignment.at,assignedAt);assert.equal(second.events[0].variant,'B');
  assert.equal(second.loader.sha256,loaderHash);assert.equal(second.arms.B.scriptSha256,scriptHash);
  assert(second.events.some(row=>row.type==='runtime-started'&&row.arm==='B'));assert.deepEqual([...p.sandbox.__forbiddenTouches],[]);
});

test('fallback/exclusion preserves B intention-to-treat while execution and unattributed revenue stay separate',()=>{
  const p=page({L:instrumented()}),initial=p.measurement();p.advance(8000);p.load();const fallback=p.measurement();p.service.setTargeting('TestId','foreign');const excluded=p.measurement();
  const result=previewAbMemoryMeasurements(planFor(excluded),[fallback,initial,excluded,excluded]);
  assert.equal(result.identifiedPages,1);assert.equal(result.duplicateExports,3);assert.deepEqual(result.assignments,{A:0,B:1});
  assert.deepEqual(result.execution.B,{A:1,B:0,none:0});assert.equal(result.fallbacks.B,1);assert.equal(result.exclusions.afterAssignment,1);
  assert.deepEqual(result.pageRpm,{A:null,B:null});assert.equal(result.winner,null);assert.equal(result.revenueReady,false);
  assert(result.blockers.some(text=>/unlabelled revenue/.test(text)));assert.deepEqual([...p.sandbox.__forbiddenTouches],[]);
});

test('QA-forced, missing-random and pre-assignment exclusion cannot be followed by a fabricated randomized assignment',()=>{
  const p=page(),value=p.measurement(),plan=planFor(value);
  for(const event of [{type:'qa-forced',arm:'B'},{type:'random-unavailable'},{type:'exclusion',reason:'excluded-key-conflict',phase:'before-assignment'}]){
    const forged=structuredClone(value);
    forged.events=[{seq:1,at:value.createdAt,...event},...value.events.map(row=>({...row,seq:row.seq+1}))];
    assert.throws(()=>validateAbMemoryMeasurement(plan,forged));
  }
});

test('prefix dedup rejects divergent copied histories and bounded dropping remains an explicit readiness blocker',()=>{
  const p=page(),old=p.measurement();p.load();const next=p.measurement(),plan=planFor(next);
  const altered=structuredClone(next);altered.events[1].arm='A';
  assert.throws(()=>previewAbMemoryMeasurements(plan,[old,altered]),/Conflicting event history/);
  for(let i=0;i<100;i++)p.sandbox.__tesseraAbLoader.duplicate();const full=p.measurement(),result=previewAbMemoryMeasurements(plan,[full,old]);
  assert.equal(full.events.length,64);assert(full.droppedEvents>0);assert.equal(result.assignments.B,1);assert.equal(result.identifiedPages,1);
  assert.equal(result.droppedEvents,full.droppedEvents);assert(result.blockers.some(text=>/dropped events/.test(text)));assert.equal(result.srm.status,'unavailable');assert.equal(result.revenueReady,false);
});
