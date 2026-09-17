import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { observeRuntime } from '../../worker/runtime-observed/observer.mjs';
function fixture({queued=false}={}){
  const listeners=new Map(),slot={};let clock=0;
  const service={addEventListener:(t,f)=>listeners.set(t,f),removeEventListener:(t,f)=>{if(listeners.get(t)===f)listeners.delete(t);}};
  const window={googletag:{cmd:queued?[]:{push:f=>f()},pubads:()=>service}};
  const context=vm.createContext({window,Date:{now:()=>clock},metadata:{siteId:'test-site',runtimeVersion:'3.11.0-tessera.preview.1',units:['P1']},owns:s=>s===slot?'P1':null});
  const enter=()=>vm.runInContext('('+observeRuntime.toString()+')(metadata,owns).start()',context);
  return {window,slot,enter,listeners,tick:n=>clock+=n,emit:(type,value={})=>listeners.get(type)?.({slot,...value}),snapshot:()=>window.__tesseraRuntimeDiagnostics['test-site'].snapshot()};
}
test('runtime entry and duplicate counts are independent of tags and load events',()=>{
  const f=fixture();assert.equal(f.enter(),true);assert.equal(f.enter(),false);
  assert.equal(f.snapshot().initializations,1);assert.equal(f.snapshot().attempts,2);assert.equal(f.listeners.size,4);
});
test('GAM filled/empty refresh cycles, timings and iframe events remain separate',()=>{
  const f=fixture();f.enter();f.emit('slotRequested');f.tick(25);f.emit('slotRenderEnded',{isEmpty:true});
  f.emit('slotRenderEnded',{isEmpty:true});f.tick(5);f.emit('slotRequested');f.tick(40);f.emit('slotRenderEnded',{isEmpty:false});f.emit('slotOnload');f.emit('impressionViewable');
  const s=f.snapshot();assert.deepEqual(JSON.parse(JSON.stringify(s.totals)),{requests:2,renders:2,empty:1,filled:1,iframeLoads:1,viewableEvents:1,ambiguousRenders:0});
  assert.equal(s.firstFilledRenderMs,70);assert.equal(s.events.find(e=>e.type==='filled-render').requestToRenderMs,40);
  s.totals.requests=999;s.events.length=0;assert.equal(f.snapshot().totals.requests,2);
});
test('foreign slots and ambiguous overlapping requests cannot produce false latency',()=>{
  const f=fixture();f.enter();f.emit('slotRequested',{slot:{}});assert.equal(f.snapshot().totals.requests,0);
  f.emit('slotRequested');f.emit('slotRequested');f.emit('slotRenderEnded',{isEmpty:false});
  assert.equal(f.snapshot().totals.ambiguousRenders,1);assert.equal(f.snapshot().events.at(-1).requestToRenderMs,null);
});
test('diagnostics are bounded and can stop before or after GPT becomes ready',()=>{
  const f=fixture();f.enter();for(let i=0;i<550;i++)f.emit('slotRequested');
  assert.equal(f.snapshot().events.length,500);assert(f.snapshot().droppedEvents>0);
  f.window.__tesseraRuntimeDiagnostics['test-site'].stop();assert.equal(f.listeners.size,0);
  const q=fixture({queued:true});q.enter();q.window.__tesseraRuntimeDiagnostics['test-site'].stop();q.window.googletag.cmd[0]();assert.equal(q.listeners.size,0);
});
test('legacy marker blocks new runtime without reporting a successful initialization',()=>{
  const f=fixture();f.window.__TESSERA_RUNTIME_STARTED={};assert.equal(f.enter(),false);
  assert.equal(f.snapshot().initializations,0);assert.equal(f.listeners.size,0);assert.equal(f.snapshot().events[0].type,'legacy-conflict');
});
