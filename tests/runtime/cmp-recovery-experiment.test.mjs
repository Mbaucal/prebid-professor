import test from 'node:test';
import assert from 'node:assert/strict';
import {createTesseraReadiness} from '../../worker/runtime-readiness-v1/browser-readiness.mjs';
import {createCmpRecoveryExperiment} from '../support/cmp-recovery-experiment.mjs';
const loading={gdprApplies:true,cmpStatus:'loading',listenerId:1};
const decision=reject=>({gdprApplies:true,cmpStatus:'loaded',eventStatus:'useractioncomplete',tcString:reject?'synthetic-reject':'synthetic-accept',purpose:{consents:reject?{}:{1:true}},vendor:{consents:reject?{}:{1:true}},listenerId:1});
function api(initial,{throws=false}={}) {
 const callbacks=[],removed=[];
 const fn=(cmd,v,cb,id)=>{if(cmd==='removeEventListener'){removed.push(id);return;}if(cmd==='addEventListener'){callbacks.push(cb);if(initial)cb(initial,true);if(throws)throw Error('synthetic registration failure');}};
 return {fn,callbacks,removed,emit(data,success=true){for(const cb of callbacks)cb(data,success);}};
}
function fixture(experiment,initial) {
 let time=0,id=0;const timers=new Map(),sent=[],discarded=[];
 const host={__tcfapi:initial,setTimeout(fn,ms){timers.set(++id,{fn,at:time+ms});return id;},clearTimeout(n){timers.delete(n);}};
 const adapter=experiment?createCmpRecoveryExperiment(host):null;
 const gate=createTesseraReadiness(adapter?.facade||host,{rawDispatch(_,slots){sent.push(slots.map(s=>({...s.targeting})));},clear(s){delete s.targeting.hb_pb;},apply(s,t){Object.assign(s.targeting,t);},code:s=>s.id,discard:codes=>discarded.push(codes)});
 const slot={id:'slot',targeting:{custom:'keep',hb_pb:'stale'}};
 const tick=ms=>{const end=time+ms;let count=0;while(true){const due=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;assert(++count<10000);time=due[1].at;timers.delete(due[0]);due[1].fn();}time=end;};
 const dispatch=()=>gate.dispatch({},[slot]);
 return {host,adapter,gate,slot,tick,dispatch,sent,timers,discarded};
}
for(const experimental of [false,true]) {
 const label=experimental?'experiment':'frozen baseline';
 test(`${label}: absent API later appears; no timeout permission`,()=>{
  const f=fixture(experimental);f.dispatch();f.tick(30000);assert.equal(f.sent.length,0);
  const real=api(decision(false));f.host.__tcfapi=real.fn;f.tick(250);assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0],[{custom:'keep'}]);
 });
 test(`${label}: nonforwarding stub replacement has measured before/after`,()=>{
  const stub=api(),f=fixture(experimental,stub.fn);f.dispatch();f.tick(30000);assert.equal(f.sent.length,0);assert.equal(stub.callbacks.length,1);
  const real=api(decision(false));f.host.__tcfapi=real.fn;f.tick(250);assert.equal(f.sent.length,experimental?1:0);assert.equal(real.callbacks.length,experimental?1:0);
 });
 for(const reject of [false,true])test(`${label}: same API prolonged loading -> late ${reject?'Reject':'Accept'} resumes once`,()=>{
  const cmp=api(loading),f=fixture(experimental,cmp.fn);f.dispatch();f.dispatch();f.tick(60000);assert.equal(f.sent.length,0);assert.equal(cmp.callbacks.length,1);
  cmp.emit(decision(reject));f.tick(0);cmp.emit(decision(reject));f.tick(0);assert.equal(f.sent.length,1);
 });
}
test('experiment: replaced ready API invalidates at detection and ignores stale callbacks',()=>{
 const old=api(decision(false)),f=fixture(true,old.fn);f.tick(0);const epoch=f.gate.snapshot().consent.epoch;
 const next=api(loading);f.host.__tcfapi=next.fn;f.tick(250);assert.equal(f.gate.snapshot().consent.ready,false);assert(f.gate.snapshot().consent.epoch>epoch);
 f.dispatch();old.emit(decision(false));f.tick(30000);assert.equal(f.sent.length,0);assert.equal(next.callbacks.length,1);assert.deepEqual(old.removed,[1]);
 next.emit(decision(true));f.tick(0);assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0],[{custom:'keep'}]);
});
test('experiment: failed partial registration does not multiply listeners; new API recovers',()=>{
 const broken=api(null,{throws:true}),f=fixture(true,broken.fn);f.dispatch();f.tick(60000);assert.equal(broken.callbacks.length,1);assert.equal(f.sent.length,0);
 broken.emit(decision(false));f.tick(0);assert.equal(f.sent.length,0);assert.deepEqual(broken.removed,[1]);
 const next=api(decision(true));f.host.__tcfapi=next.fn;f.tick(250);assert.equal(f.sent.length,1);assert.equal(next.callbacks.length,1);
});
test('experiment: missing replacement clears readiness; dispose cleans known listener and sole poll',()=>{
 const old=api(decision(false)),f=fixture(true,old.fn);delete f.host.__tcfapi;f.tick(250);assert.equal(f.gate.snapshot().consent.ready,false);assert.deepEqual(old.removed,[1]);
 const next=api(loading);f.host.__tcfapi=next.fn;f.tick(250);assert.equal(f.timers.size,1);f.adapter.dispose();assert.equal(f.timers.size,0);assert.deepEqual(next.removed,[1]);
 next.emit(decision(false));f.tick(1000);assert.equal(f.gate.snapshot().consent.ready,false);assert.equal(f.sent.length,0);assert.equal(f.timers.size,0);
});
test('experiment: late ID from replaced silent stub is removed without accepting consent',()=>{
 const old=api(),f=fixture(true,old.fn),next=api(loading);f.host.__tcfapi=next.fn;f.tick(250);old.emit(decision(false));f.tick(0);assert.deepEqual(old.removed,[1]);assert.equal(f.gate.snapshot().consent.ready,false);
});
test('before/after: thrown registration retries accumulate in frozen helper but experiment stays at one',()=>{
 for(const experimental of [false,true]){const broken=api(null,{throws:true}),f=fixture(experimental,broken.fn);f.dispatch();f.tick(5000);assert.equal(broken.callbacks.length,experimental?1:6);assert.equal(f.sent.length,0);}
});
test('experiment: synchronous valid callback followed by throw stays blocked',()=>{
 const broken=api(decision(false),{throws:true}),f=fixture(true,broken.fn);f.dispatch();f.tick(1000);assert.equal(f.sent.length,0);assert.equal(f.gate.snapshot().consent.ready,false);assert.deepEqual(broken.removed,[1]);
});
test('experiment: old callback detects replacement before scheduled poll',()=>{
 const old=api(decision(false)),f=fixture(true,old.fn),next=api(loading);const epoch=f.gate.snapshot().consent.epoch;
 f.host.__tcfapi=next.fn;old.emit(decision(false));assert.equal(f.gate.snapshot().consent.ready,false);assert(f.gate.snapshot().consent.epoch>epoch);assert.equal(next.callbacks.length,1);
 f.dispatch();f.tick(0);assert.equal(f.sent.length,0);next.emit(decision(false));f.tick(0);assert.equal(f.sent.length,1);
});
test('experiment: unknown scope and error callbacks never imply out-of-scope permission',()=>{
 const cmp=api(),f=fixture(true,cmp.fn);f.dispatch();for(const [data,success]of [[{},true],[{gdprApplies:undefined},true],[decision(false),false]]){cmp.emit(data,success);f.tick(30000);assert.equal(f.sent.length,0);assert.equal(f.gate.snapshot().consent.ready,false);}
 cmp.emit({gdprApplies:false});f.tick(0);assert.equal(f.sent.length,1);
});
test('experiment: repeated identity changes keep one poll and remove each known listener',()=>{
 const chain=Array.from({length:20},()=>api(loading)),f=fixture(true,chain[0].fn);
 for(const cmp of chain.slice(1)){f.host.__tcfapi=cmp.fn;f.tick(250);assert.equal(f.timers.size,1);}
 for(const cmp of chain.slice(0,-1)){assert.equal(cmp.callbacks.length,1);assert.deepEqual(cmp.removed,[1]);}
 f.adapter.dispose();assert.equal(f.timers.size,0);assert.deepEqual(chain.at(-1).removed,[1]);
});
test('known limitation: replacement before poll can dispatch under old ready decision',()=>{
 for(const experimental of [false,true])for(const queuedFirst of [false,true]) {
  const old=api(decision(false)),f=fixture(experimental,old.fn),next=api(loading);
  if(queuedFirst)f.dispatch();f.host.__tcfapi=next.fn;if(!queuedFirst)f.dispatch();f.tick(0);
  assert.equal(f.sent.length,1,'Prototype does not guard request/dispatch boundaries before detection.');
 }
});
test('known limitation: silent replaced APIs retain callbacks until they supply listener IDs',()=>{
 const chain=Array.from({length:20},()=>api()),f=fixture(true,chain[0].fn);
 for(const cmp of chain.slice(1)){f.host.__tcfapi=cmp.fn;f.tick(250);}
 f.adapter.dispose();assert.equal(f.timers.size,0);
 assert.equal(chain.reduce((n,cmp)=>n+cmp.callbacks.length,0),20);assert.equal(chain.reduce((n,cmp)=>n+cmp.removed.length,0),0);
});
test('known limitation: removal failure is only attempted cleanup, never consent recovery',()=>{
 let callback,removalAttempts=0;
 const broken=(cmd,v,cb)=>{if(cmd==='addEventListener'){callback=cb;cb(loading,true);}else {removalAttempts++;throw Error('synthetic removal failure');}};
 const f=fixture(true,broken),next=api(loading);f.host.__tcfapi=next.fn;f.tick(250);callback(decision(false),true);f.tick(0);
 assert.equal(removalAttempts,1);assert.equal(f.gate.snapshot().consent.ready,false);assert.equal(f.sent.length,0);
});
