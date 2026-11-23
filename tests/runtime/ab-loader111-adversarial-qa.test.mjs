import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loader111Page as page} from '../support/ab-loader111-page.mjs';

const root=process.env.LOADER111_ROOT?pathToFileURL(resolve(process.env.LOADER111_ROOT)+'/'):new URL('../../',import.meta.url);
const L=await import(new URL('worker/experiments/ab-loader-1.1.1.mjs',root));
const old=await import(new URL('worker/experiments/ab-loader-1.1.0.mjs',root));
const {validateAbMemoryMeasurement,previewAbMemoryMeasurements}=await import(new URL('worker/experiments/ab-measurement.mjs',root));

const events=(p,type)=>p.measurement().events.filter(row=>row.type===type);
function plan(p){return {schemaVersion:1,kind:'tessera-ab-report-plan',id:'abm-'+'d'.repeat(64),site:p.config.site,
  experimentId:p.config.id,testId:p.config.testId,recordSha256:'f'.repeat(64),zipSha256:'e'.repeat(64),
  loader:p.config.loader,trafficBPercent:p.config.trafficBPercent,
  arms:Object.fromEntries(['A','B'].map(side=>[side,{release:p.config.arms[side].release,runtimeVersion:'3.25.1',scriptSha256:'a'.repeat(64),runtimeSha256:'b'.repeat(64)}])),
  prebidSha256:null,report:{networkCode:'999',inventoryPath:'/999/independent-qa/',startDate:'2026-11-17',endDate:'2026-11-18',currency:'EUR',timeZone:'Europe/Belgrade',revenueBasis:'net',revenueMetric:'total'},
  source:{savedPackageScopeVerified:true,gamReportSourceVerified:false},measurement:{collection:'disabled',coverage:'unknown',revenueReady:false},
  createdAt:'2026-11-20T16:00:00.000Z',createdBy:'qa@example.invalid'};}

test('slow assigned B can beat the pending control after the soft deadline, exactly once',()=>{
  const p=page(L),b=p.scripts[0];p.advance(8000);const a=p.scripts[1];
  assert.equal(p.scripts.length,2);assert(!b.removed,'A timeout cannot cancel valid pending B');
  assert.equal(p.load(b),true);assert.equal(p.load(a),false);
  assert.equal(p.starts.length,1);assert.equal(p.dispatches.length,1);
  assert.deepEqual(p.dispatches[0].Variant,['B']);assert.deepEqual(p.dispatches[0].TestId,['loader_qa']);
  assert.equal(p.state().executionArm,'B');assert.equal(p.state().fallback,false);
  assert.equal(p.state().fallbackRequested,true);assert.equal(events(p,'fallback').length,0);
  assert.deepEqual(events(p,'runtime-started').map(row=>row.arm),['B']);assert.equal(p.timers.size,0);
});

test('control can beat late B while original B labels and denominator stay B',()=>{
  const p=page(L),b=p.scripts[0];p.advance(8000);const a=p.scripts[1];
  const staleError=b.onerror,staleLoad=b.onload;
  assert.equal(p.load(a),true);staleError?.();staleLoad?.();assert.equal(p.load(b),false);
  assert.equal(p.state().executionArm,'A');assert.equal(p.state().fallback,true);
  assert.equal(p.state().originalVariant,'B');assert.equal(p.measurement().assignment.variant,'B');
  assert.deepEqual(p.dispatches.map(row=>row.Variant),[['B']]);assert.equal(p.starts.length,1);
  assert.equal(events(p,'fallback').length,1);assert.equal(events(p,'runtime-started').length,1);assert.equal(p.timers.size,0);
});

test('exhausting both diagnostic deadlines never invalidates a still-valid arm or retries forever',()=>{
  const p=page(L),b=p.scripts[0];p.advance(16000);
  assert.equal(p.state().status,'waiting-for-arm');assert.equal(p.timers.size,0);
  assert.equal(p.scripts.length,2);assert.equal(events(p,'terminal-failure').length,0);
  p.advance(120000);assert.equal(p.scripts.length,2);assert.equal(p.load(b),true);
  assert.equal(p.state().executionArm,'B');assert.equal(p.dispatches.length,1);
  assert.equal(events(p,'runtime-started').length,1);
});

test('an A retry is not attributed as an actual B-to-A fallback',()=>{
  for(const winner of [0,1]){
    const p=page(L,{random:0});p.advance(8000);assert.equal(p.scripts.length,2);
    assert.equal(p.load(p.scripts[winner]),true);assert.equal(p.load(p.scripts[1-winner]),false);
    assert.equal(p.state().executionArm,'A');assert.equal(p.state().fallback,false);
    assert.equal(p.state().controlRetryRequested,true);assert.equal(events(p,'fallback').length,0);
    assert.equal(events(p,'control-retry').length,1);assert.equal(p.dispatches.length,1);
    assert.deepEqual(p.dispatches[0].Variant,['A']);
  }
});

test('a loaded script that never starts is classified and the valid control can recover',()=>{
  const p=page(L),b=p.scripts[0];p.onload(b);
  assert.equal(p.scripts.length,2);assert(events(p,'arm-failed').some(row=>row.arm==='B'&&row.reason==='no-start'));
  assert.equal(p.runtime(b),false);assert.equal(p.load(p.scripts[1]),true);
  assert.equal(p.state().executionArm,'A');assert.equal(p.state().fallback,true);
  assert.equal(p.dispatches.length,1);assert.equal(p.timers.size,0);
});

test('a failed candidate cannot invalidate another pending valid candidate',()=>{
  const p=page(L),b=p.scripts[0];p.advance(8000);const a=p.scripts[1];p.error(a);
  assert.equal(events(p,'terminal-failure').length,0);assert.equal(p.load(b),true);assert.equal(p.runtime(a),false);
  assert.equal(p.state().executionArm,'B');assert.equal(p.state().fallback,false);assert.equal(p.dispatches.length,1);
});

test('only two definitive failures are terminal; late events cannot revive rejected candidates',()=>{
  const p=page(L),b=p.scripts[0];p.error(b);const a=p.scripts[1];p.error(a);p.advance(120000);
  assert.equal(p.scripts.length,2);assert.equal(events(p,'terminal-failure').length,1);
  assert.equal(p.runtime(b),false);assert.equal(p.runtime(a),false);assert.equal(p.dispatches.length,0);
  assert.equal(p.state().executionArm,null);assert.equal(p.timers.size,0);
});

test('a foreign runtime setter cannot claim a candidate identity, even with a copied URL',()=>{
  const p=page(L),b=p.scripts[0];p.advance(8000);
  const foreign={src:b.src};p.runtime(foreign);
  assert.equal(p.state().executionArm,null);assert.equal(events(p,'runtime-started').length,0);
  assert.equal(p.state().exclusionReason,'existing-runtime-conflict');
  assert.equal(p.load(b),false);assert.equal(p.load(p.scripts[1]),false);
  assert.deepEqual(p.service.getTargeting('Variant'),[]);assert.deepEqual(p.service.getTargeting('TestId'),[]);
});

test('a failed element creation cannot turn currentScript null into a managed candidate',()=>{
  const p=page(L),b=p.scripts[0];p.document.createElement=()=>{throw Error('Synthetic creation failure');};p.advance(8000);
  p.document.currentScript=null;
  assert.equal(Boolean(p.sandbox.__TESSERA_RUNTIME_STARTED),false,'There is no started or current managed runtime');
  p.sandbox.__TESSERA_RUNTIME_STARTED={external:true};
  assert.equal(p.state().executionArm,null);assert.equal(p.state().exclusionReason,'existing-runtime-conflict');
  assert.equal(p.load(b),false);assert.equal(p.dispatches.length,0);
});

test('a keyword accessor changing between native startup getter and setter cannot launch two arms',()=>{
  const p=page(L);let reads=0;
  Object.defineProperty(p.sandbox,'adsKeywords',{configurable:true,get(){return ++reads===2?{Variant:'publisher'}:{};}});
  const b=p.scripts[0];p.runtime(b);
  for(const script of p.scripts.filter(script=>script!==b))p.load(script);
  assert.equal(p.starts.length,1,'An already admitted native body must own the startup before any fallback is allowed');
  assert.equal(p.dispatches.length,1);assert.equal(p.state().runtimeStarted,true);
  assert.equal(events(p,'runtime-started').length,1);
  assert.equal(p.state().exclusionReason,'excluded-key-conflict');
  assert.deepEqual(p.service.getTargeting('Variant'),[]);assert.deepEqual(p.service.getTargeting('TestId'),[]);
});

test('a publisher getter reentering the label gate cannot keep a retired B eligible',()=>{
  const p=page(L);let changed=false;
  Object.defineProperty(p.sandbox,'adsKeywords',{configurable:true,get(){
    if(!changed){changed=true;p.service.setTargeting('Variant','publisher');}
    return {};
  }});
  const b=p.scripts[0];assert.equal(p.runtime(b),false);
  assert.equal(p.scripts.length,2);assert.equal(p.load(p.scripts[1]),true);
  assert.equal(p.starts.length,1);assert.equal(p.dispatches.length,1);
  assert.equal(p.state().executionArm,'A');assert.equal(p.state().exclusionReason,'excluded-key-conflict');
});

test('duplicate entry observations remain bounded while valid slow arms stay eligible',()=>{
  const p=page(L),b=p.scripts[0];p.advance(16000);
  for(let i=0;i<100;i++)p.sandbox.__tesseraAbLoader.duplicate();
  assert.equal(p.scripts.length,2);assert.equal(p.timers.size,0);
  assert.equal(p.measurement().events.length,64);assert(p.measurement().droppedEvents>0);
  assert.equal(p.load(b),true);assert.equal(p.starts.length,1);assert.equal(p.dispatches.length,1);
  assert.equal(p.state().executionArm,'B');assert.equal(p.measurement().assignment.variant,'B');
  const preview=previewAbMemoryMeasurements(plan(p),[p.measurement()]);
  assert.equal(preview.revenueReady,false);assert.equal(preview.coverage,'unknown');assert.equal(preview.winner,null);
});

test('v2 retry observations are strict and cannot weaken v1 or financial readiness',()=>{
  const p=page(L,{random:0});p.advance(16000);p.load(p.scripts[0]);
  const snapshot=p.measurement();assert.equal(snapshot.schemaVersion,2);
  assert.equal(validateAbMemoryMeasurement(plan(p),snapshot),snapshot);
  const preview=previewAbMemoryMeasurements(plan(p),[snapshot]);
  assert.deepEqual(preview.assignments,{A:1,B:0});assert.equal(preview.fallbacks.A,0);
  assert.equal(preview.revenueReady,false);assert.equal(preview.winner,null);assert.equal(preview.upliftPercent,null);
  assert.deepEqual(preview.pageRpm,{A:null,B:null});
  for(const change of [v=>v.schemaVersion=1,v=>v.events.push({...v.events.at(-1),seq:v.events.length+1,type:'made-up'}),v=>v.arms.A.scriptSha256='f'.repeat(64),v=>v.coverage='complete']){
    const changed=structuredClone(snapshot);change(changed);assert.throws(()=>validateAbMemoryMeasurement(plan(p),changed));
  }
  const legacy=page(old),v1=legacy.measurement();assert.equal(v1.schemaVersion,1);
  const forged=structuredClone(v1);forged.events.push({seq:forged.events.length+1,at:forged.createdAt,type:'arm-deadline',arm:'B'});
  assert.throws(()=>validateAbMemoryMeasurement(plan(legacy),forged));
});

test('v2 rejects execution by a definitively failed candidate while allowing a valid A retry',()=>{
  const p=page(L);p.load();const value=p.measurement();
  const index=value.events.findIndex(row=>row.type==='runtime-started');
  value.events.splice(index,0,{seq:0,at:value.createdAt,type:'arm-failed',arm:'B',reason:'error'});
  value.events.forEach((row,i)=>{row.seq=i+1;});
  assert.throws(()=>validateAbMemoryMeasurement(plan(p),value));
  const retry=page(L,{random:0});retry.error(retry.scripts[0]);retry.load(retry.scripts[1]);
  assert.doesNotThrow(()=>validateAbMemoryMeasurement(plan(retry),retry.measurement()));
});
