import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from 'acorn';
import {createConsentStorage} from '../../worker/runtime-3211/browser-storage.mjs';
import {applyStoragePrivacy} from '../../worker/runtime-3211/storage-compiler.mjs';
import {compileRuntime321} from '../../worker/runtime-321/compiler.mjs';
import {previewInput} from '../../worker/runtime-321/snapshot.mjs';
import {descriptor} from '../../.generated/runtime-321-manifest.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {configure, fixture} from './artifact-fixture.mjs';

const ready = purpose => ({gdprApplies:true,cmpStatus:'loaded',eventStatus:'useractioncomplete',tcString:'synthetic-choice',purpose:{consents:{1:purpose}}});
function fakeClock() {
  let now = 1000000, next = 0; const pending = new Map();
  return {Date:{now:()=>now},setTimeout(fn,ms=0){pending.set(++next,{fn,at:now+ms});return next;},clearTimeout(id){pending.delete(id);},
    setNow(value){now=value;},tick(ms=0){const end=now+ms;for(let guard=0;guard<10000;guard++){
      const due=[...pending].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if(!due)break;now=due[1].at;pending.delete(due[0]);due[1].fn();
    }now=end;}};
}
function storeFixture({blocked=false}={}) {
  const access=[], values=new Map(), win={};
  Object.defineProperty(win,'sessionStorage',{get(){access.push('getter');if(blocked)throw Error('denied');return{
    getItem(key){access.push('read');return values.get(key)??null;},
    setItem(key,value){access.push('write');values.set(key,value);},
  };}});
  return {win,access,values};
}
function controller(options) {
  const clock=fakeClock(), storage=storeFixture(options), context=vm.createContext({window:storage.win,Date:clock.Date});
  vm.runInContext(createConsentStorage.toString()+';this.store=createConsentStorage(window);',context);
  return {...storage,clock,store:context.store};
}
test('pending, unknown, failed and purpose-1 rejected decisions never touch the storage getter',()=>{
  const h=controller();
  for(const [data,success,isReady] of [[undefined,false,false],[ready(false),true,true],[{...ready(true),eventStatus:'cmpuishown'},true,false],
    [{...ready(true),gdprApplies:undefined},true,false],[ready(true),false,true],[{...ready(true),cmpStatus:'error'},true,true],
    [{...ready(true),tcString:''},true,true],[{gdprApplies:false},true,false]]){
    h.store.update(data,success,isReady);h.store.allowed('/123/position',5);h.store.record('/123/position',5);
  }
  assert.deepEqual(h.access,[]);
});
test('current purpose-1 grant and explicit out-of-scope permit session storage, not a truthy consent surrogate',()=>{
  for(const data of [ready(true),{gdprApplies:false}]){
    const h=controller();h.store.update(data,true,true);h.store.allowed('/123/P1',5);h.store.record('/123/P1',5);
    assert.deepEqual(h.access,['getter','read','getter','write']);
  }
  const h=controller();h.store.update(ready(1),true,true);h.store.record('/123/P1',5);assert.deepEqual(h.access,[]);
});
test('revocation and UI-open immediately drop prior permission while keeping the page-memory cap',()=>{
  const h=controller();h.store.update(ready(true),true,true);h.store.record('/123/P1',5);h.access.length=0;
  h.store.update({...ready(true),eventStatus:'cmpuishown'},true,false);
  assert.equal(h.store.allowed('/123/P1',5),false);h.store.record('/123/P2',5);assert.deepEqual(h.access,[]);
  h.store.update(ready(false),true,true);assert.equal(h.store.allowed('/123/P2',5),false);assert.deepEqual(h.access,[]);
  h.store.update(ready(true),true,true);assert.equal(h.store.allowed('/123/P2',5),false,'later grant preserves earlier rejected-render memory cap');
  assert.deepEqual(h.access,['getter','read']);
  h.clock.tick(300000);assert.equal(h.store.allowed('/123/P2',5),true);
});
test('frequency zero, throwing storage, corrupt values, clock rollback and expiry preserve bounded serving',()=>{
  const h=controller({blocked:true});h.store.update(ready(true),true,true);
  assert.equal(h.store.allowed('/123/P1',0),true);h.store.record('/123/P1',0);assert.deepEqual(h.access,[]);
  assert.equal(h.store.allowed('/123/P1',5),true);h.store.record('/123/P1',5);assert.equal(h.store.allowed('/123/P1',5),false);
  h.clock.tick(300000);assert.equal(h.store.allowed('/123/P1',5),true);
  h.clock.setNow(500000);assert.equal(h.store.allowed('/123/P1',5),true,'future memory timestamp cannot lock the page');
  const available=controller();available.store.update(ready(true),true,true);
  for(const value of ['invalid','Infinity','-1','2000000']){
    available.values.set('tessera:takeover:/123/P1',value);assert.equal(available.store.allowed('/123/P1',5),true);
  }
  available.values.set('tessera:takeover:/123/P1','900000');assert.equal(available.store.allowed('/123/P1',5),false);
});

function walk(node,visit){if(!node||typeof node!=='object')return;visit(node);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(x=>walk(x,visit));else if(value&&typeof value==='object')walk(value,visit);}
function extract(source,name){const nodes=[];walk(parse(source,{ecmaVersion:2015}),node=>{if(node.type==='FunctionDeclaration'&&node.id?.name===name)nodes.push(node);});assert.equal(nodes.length,1,name);return source.slice(nodes[0].start,nodes[0].end);}
const saved=configure(positionFixture(false),config=>{config.runtimeControls.adPositions.Overlay.frequencyMinutes=5;});
const input=previewInput(saved,descriptor,'20261113_000000');
const before=compileRuntime321(input).adsJs,after=applyStoragePrivacy(before,input);

function lifecycle({prebid='off',body=true,persisted=null,source=after,frequency=5}={}) {
  const clock=fakeClock(), h=storeFixture(), events=[], domListeners=new Map();let cmp;
  if(persisted!==null)h.values.set('tessera:takeover:/123/test/Overlay',persisted);
  const pb={requestBids(){},setConfig(){},onEvent(){}};
  const win=Object.assign(h.win,{top:1,self:1,innerWidth:1440,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,
    __tcfapi(command,version,callback){assert.equal(command,'addEventListener');cmp=callback;}});
  if(prebid==='ready')win.pbjs=pb;
  const slot={setConfig(){},addService(){},getSlotElementId:()=> 'Overlay'};
  const service={addEventListener(){},refresh(){events.push('request');},enableSingleRequest(){}};
  const context=vm.createContext({window:win,Date:clock.Date,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,
    document:{body:body?{}:null,addEventListener(name,callback){domListeners.set(name,callback);}},
    TESSERA_OVERLAY:{code:'Overlay',frequencyMinutes:frequency},HAS_PREBID:prebid!=='off',BIDDERS:prebid==='off'?[]:[{}],
    TAKEOVER_ACTIVE_FOR_PAGE:frequency===0,_tesseraTakeOverEligible:true,_tesseraTakeOverWaiting:false,
    _takeOver:{initialized:false},_tesseraInitialStarted:new WeakSet(),_takeOverSlot:null,
    tesseraOverlayDevice:()=>({device:'desktop',size:[800,600],autoCloseSec:0}),
    takeOverDeviceConfig:()=>context.tesseraOverlayDevice(),takeOverMainAdUnitPath:()=>'/123/test/Overlay',
    takeOverBuildDom(){events.push('dom');},takeOverEvent(name){events.push(name);},
    takeOverEnsureCodelessGuard(){events.push('guard');},takeOverDisplayCodelessGuard(){},takeOverNeutralizeKnownCodelessSlots(){},
    takeOverReleaseCodelessSuppression(reason){events.push('release:'+reason);},applyTakeOverCodelessLinkBlock(){events.push('block');},
    takeOverOnSlotRenderEnded(){},takeOverOnSlotOnload(){},tesseraRequestOverlay(){events.push('overlay');},closeTakeOver(){events.push('close');},
    startATFConfigured(){events.push('enable-services');},
    adViewportInitialSlots:slots=>slots,
    googletag:{cmd:{push:fn=>fn()},defineSlot:()=>slot,pubads:()=>service,display(){},enableServices(){events.push('enable-services');}},
  });
  const names=['createConsentStorage','createTesseraReadiness','initTakeOver','initTakeOverReady','tesseraOverlayAllowed','tesseraRecordOverlayView','startATF','resolveConsent'];
  vm.runInContext(names.map(name=>extract(source,name)).join('\n'),context);
  vm.runInContext('var _adStorage=createConsentStorage(window);var _tesseraReady=createTesseraReadiness(window,{storageConsent:_adStorage.update,rawDispatch:function(){},code:function(){return "Billboard";},clear:function(){},apply:function(){}});',context);
  return {...h,clock,events,context,emit:(data,success=true)=>cmp(data,success),
    start(atf=true){context.resolveConsent(()=>{context.initTakeOver();context.startATF(atf?[{}]:[]);});},
    bodyReady(){context.document.body={};domListeners.get('DOMContentLoaded')?.();}};
}
test('generated startup and debug helpers make no persistent access; frozen source retains the reproducible defect',()=>{
  assert.match(before,/takeOverIsActiveForPage\(\) && tesseraOverlayAllowed\(\)/);
  assert.match(before,/localStorage\.getItem\('ADOPS_DEBUG'\)/);
  assert.doesNotMatch(after,/localStorage\.(?:getItem|setItem|removeItem)\('ADOPS_DEBUG'/);
  assert.match(after,/TAKEOVER_ACTIVE_FOR_PAGE = _tesseraTakeOverEligible && !TESSERA_OVERLAY.frequencyMinutes/);
  parse(after,{ecmaVersion:2015});
  const noOverlay=previewInput(configure(fixture(),c=>{c.enablePrebid=false;}),descriptor,'20261113_000000');
  const plain=applyStoragePrivacy(compileRuntime321(noOverlay).adsJs,noOverlay);
  assert.doesNotMatch(plain,/localStorage\.(?:getItem|setItem|removeItem)\('ADOPS_DEBUG'/);
  assert.doesNotMatch(plain,/function createConsentStorage/);
});
test('generated readiness permits rejected-render memory only; no storage access before CMP',()=>{
  const h=lifecycle();h.start();h.clock.tick(1000);assert.deepEqual(h.access,[]);assert.deepEqual(h.events,[]);
  h.emit(ready(false));h.clock.tick();assert(h.events.includes('overlay'));h.context.tesseraRecordOverlayView();
  assert.deepEqual(h.access,[]);assert.equal(h.context.tesseraOverlayAllowed(),false);
});
test('generated cap is decided after consent and suppresses only TakeOver with no codeless guard for capped opportunity',()=>{
  const h=lifecycle({persisted:'900000'});h.start();assert.deepEqual(h.access,[]);
  h.emit(ready(true));h.clock.tick();
  assert.deepEqual(h.access,['getter','read']);assert.equal(h.context._takeOver.status,'frequency-capped');
  assert(!h.events.includes('guard'));assert(!h.events.includes('overlay'));assert(h.events.includes('enable-services'));
  assert.equal(h.context.window.TAKEOVER_ACTIVE_FOR_PAGE,false);
});
test('new consent task preserves guard-before-ATF ordering for GAM-only and Prebid available/unavailable',()=>{
  for(const prebid of ['off','ready','missing']){
    const h=lifecycle({prebid});h.start();h.emit(ready(true));h.clock.tick(3001);
    assert(h.events.indexOf('guard')>=0);assert(h.events.indexOf('enable-services')>h.events.indexOf('guard'),prebid);
    assert.equal(h.events.filter(v=>v==='overlay').length,1);
  }
  const empty=lifecycle();empty.start(false);empty.emit(ready(false));empty.clock.tick();
  assert.equal(empty.events.filter(v=>v==='overlay').length,1);assert.deepEqual(empty.access,[]);
});
test('late body callback rechecks current CMP and viewport before initializing',()=>{
  const h=lifecycle({body:false});h.start(false);h.emit(ready(true));h.clock.tick();
  assert.equal(h.context._takeOver.initialized,false);h.access.length=0;
  h.emit({...ready(true),eventStatus:'cmpuishown'});h.bodyReady();h.clock.tick();
  assert.deepEqual(h.access,[]);assert(!h.events.includes('overlay'));
  h.emit(ready(false));h.clock.tick();assert(h.events.includes('overlay'));assert.deepEqual(h.access,[]);
  const resized=lifecycle({frequency:0});resized.start();resized.context.tesseraOverlayDevice=()=>null;
  resized.emit(ready(false));resized.clock.tick();assert.equal(resized.context._takeOver.status,'skipped-viewport');
  assert(resized.events.includes('release:viewport-disabled'));assert.deepEqual(resized.access,[]);
});
