/** MBA-402: exercise the readiness helper extracted from the actual compiled 3.26 program. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parse} from 'acorn';
const root=resolve(process.env.ADAPTIVE_TIMEOUT_QA_ROOT??fileURLToPath(new URL('../..',import.meta.url)));
const load=p=>import(pathToFileURL(resolve(root,p)).href);
const {compileRuntime326}=await load('worker/runtime-326/compiler.mjs');
const {previewInput}=await load('worker/runtime-3251/snapshot.mjs');
const {descriptor}=await load('.generated/runtime-3251-manifest.mjs');
const {runtime325BrowserSite}=await load('tests/runtime/runtime325-browser-site.mjs');
const {DEFAULT_ADAPTIVE_TIMEOUT}=await load('shared/auction-timeout/settings.mjs');
const initial=previewInput(runtime325BrowserSite(),descriptor,'20261120_120000');
initial.adaptiveAuctionTimeout={...DEFAULT_ADAPTIVE_TIMEOUT};
const compiled=compileRuntime326(initial).adsJs;
const names=['createTesseraReadiness','createAdaptiveAuctionTimeout'],functions=new Map();
(function walk(node){
 if(!node||typeof node!=='object')return;
 if(node.type==='FunctionDeclaration'&&names.includes(node.id?.name)){
  assert(!functions.has(node.id.name),'One canonical helper: '+node.id.name);
  functions.set(node.id.name,compiled.slice(node.start,node.end));
 }
 for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);
})(parse(compiled,{ecmaVersion:2015}));
assert.equal(functions.size,2);

function fixture({enabled=true,legacy=false,loaded=true}={}){
 let time=1000000,nextId=0,cmp,throwRequest=false;
 const timers=new Map(),listeners=new Map(),requests=[],sent=[];
 const tick=ms=>{const end=time+ms;let steps=0;for(;;){
  const due=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;
  assert(++steps<10000,'Bounded timer work');time=due[1].at;timers.delete(due[0]);due[1].fn();
 }time=end;};
 const pb={setConfig(){},onEvent(name,fn){listeners.set(fn,name);},offEvent(name,fn){listeners.delete(fn);},
  requestBids(input){if(throwRequest)throw Error('synthetic native failure');requests.push(input);},
  getAdserverTargetingForAdUnitCode(){return{};}};
 const win={setTimeout(fn,ms){timers.set(++nextId,{fn,at:time+ms});return nextId;},clearTimeout(id){timers.delete(id);},
  __tcfapi(command,version,callback){if(command==='addEventListener')cmp=callback;}};
 if(loaded)win.pbjs=pb;
 const source=legacy?readFileSync(resolve(root,'worker/runtime-3161/browser-readiness.mjs'),'utf8').replace('export function','function'):
  names.map(name=>functions.get(name)).join('\n');
 const context=vm.createContext({Date:{now:()=>time}});
 vm.runInContext(source+'\nthis.create=createTesseraReadiness;'+(legacy?'':'this.timeout=createAdaptiveAuctionTimeout;'),context);
 const timeout=legacy?null:context.timeout(win,{...DEFAULT_ADAPTIVE_TIMEOUT,enabled,minMs:100,mobileAdjustmentMs:0,
  slowConnectionAdjustmentMs:0,videoAdjustmentMs:0,additionalPositionMs:0,maxPositionAdjustmentMs:0});
 const gate=context.create(win,{auctionTimeout:timeout,rawRequest:(p,input)=>p.requestBids(input),
  rawDispatch:(_,slots)=>sent.push({at:time,codes:slots.map(s=>s.code)}),code:s=>s.code,clear(){},apply(){},alive:()=>true});
 const consent=(ready=true)=>{cmp(ready?{gdprApplies:false,cmpStatus:'loaded',eventStatus:'tcloaded'}:
  {gdprApplies:true,cmpStatus:'loaded',eventStatus:'cmpuishown'},true);tick(0);};
 const request=(code='P1',base=500)=>{const input={adUnits:[{code,mediaTypes:{banner:{sizes:[[300,250]]}}}],timeout:base,
  bidsBackHandler(){gate.dispatch({},[{code}]);}};gate.request(pb,input);tick(0);return input;};
 const emit=(name,event)=>{for(const [callback,type]of [...listeners])if(type===name)callback(event);};
 const start=(index=0,timeout=1800)=>emit('auctionInit',{auctionId:requests[index].auctionId,timeout});
 const complete=index=>{const input=requests[index];input.bidsBackHandler({},false,input.auctionId);tick(0);};
 return{win,pb,gate,timeout,requests,sent,tick,consent,request,start,complete,emit,setThrow:value=>{throwRequest=value;}};
}

test('QA RED baseline: inherited readiness dispatches before an extended native auction completes',()=>{
 const f=fixture({legacy:true});f.consent();f.request();f.start(0,1800);f.tick(1000);
 assert.equal(f.sent.length,1,'The accepted baseline reproduces the early fallback');
 assert.equal(f.gate.snapshot().events.at(-1).phase,'auction-deadline');
});

test('QA: actual compiled watchdog honours native extension even when adaptation is OFF',()=>{
 for(const enabled of [true,false]){
  const f=fixture({enabled});f.consent();const caller=f.request();f.start(0,1800);f.tick(1000);
  assert.equal(f.sent.length,0,'No early GAM at the obsolete request deadline');assert.equal(caller.timeout,500);
  f.tick(800);f.complete(0);assert.equal(f.sent.length,1);f.tick(10000);f.complete(0);assert.equal(f.sent.length,1);
 }
});

test('QA: a missing native callback falls back exactly once at effective timeout plus500',()=>{
 const f=fixture();f.consent();f.request();f.start(0,1800);f.tick(2299);assert.equal(f.sent.length,0);
 f.tick(1);assert.equal(f.sent.length,1);assert.equal(f.gate.snapshot().events.at(-1).phase,'auction-deadline');
 f.complete(0);f.start(0,5000);f.tick(20000);assert.equal(f.sent.length,1);
});

test('QA: native shortening changes only its matching concurrent request deadline',()=>{
 const f=fixture();f.consent();f.request('P1',3000);f.request('P2',1200);
 f.start(1,1800);f.start(0,600);f.tick(1099);assert.equal(f.sent.length,0);
 f.tick(1);assert.deepEqual(f.sent.map(s=>s.codes),[['P1']]);
 f.tick(1199);assert.equal(f.sent.length,1);f.tick(1);assert.deepEqual(f.sent.map(s=>s.codes),[['P1'],['P2']]);
});

test('QA: foreign and duplicate auctionInit events never steal or extend the owned deadline',()=>{
 const f=fixture();f.consent();f.request();f.emit('auctionInit',{auctionId:'foreign',timeout:1});
 f.tick(2000);assert.equal(f.sent.length,0);f.start(0,600);f.tick(500);f.start(0,30000);
 f.tick(599);assert.equal(f.sent.length,0);f.tick(1);assert.equal(f.sent.length,1);
});

test('QA: CMP waiting and native pre-auction delay consume none of the actual auction budget',()=>{
 const f=fixture();f.request();f.tick(20000);assert.equal(f.requests.length,0);assert.equal(f.sent.length,0);
 assert.equal(f.timeout.snapshot().auctions.length,0);
 f.consent();assert.equal(f.requests.length,1);f.tick(9000);assert.equal(f.sent.length,0);
 f.start(0,1800);f.tick(2299);assert.equal(f.sent.length,0);f.tick(1);assert.equal(f.sent.length,1);
});

test('QA: pre-auction timeout, request throw and blocked library recover once; late work cannot repeat GAM',()=>{
 for(const kind of ['pre-auction','throw','library']){
  const f=fixture({loaded:kind!=='library'});f.consent();if(kind==='throw')f.setThrow(true);f.request();
  f.tick(kind==='library'?3000:10000);assert.equal(f.sent.length,1,kind);
  if(f.requests.length){f.start(0,1800);f.complete(0);}
  if(kind==='library'){f.win.pbjs=f.pb;f.tick(100);}
  f.tick(30000);assert.equal(f.sent.length,1,kind);
 }
});

test('QA: revocation during an extended auction keeps GAM gated and discards every late callback',()=>{
 const f=fixture();f.consent();f.request();f.start(0,1800);f.tick(500);f.consent(false);
 f.complete(0);f.tick(10000);assert.equal(f.sent.length,0);
 f.consent();assert.equal(f.sent.length,1);f.complete(0);f.tick(10000);assert.equal(f.sent.length,1);
});
