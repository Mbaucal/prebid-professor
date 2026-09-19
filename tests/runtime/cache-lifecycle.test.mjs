import test from 'node:test';
import assert from 'node:assert/strict';
import {createConsentEpoch} from '../../worker/runtime-cache/consent-epoch.mjs';
import {createCacheLifecycle} from '../../worker/runtime-cache/lifecycle.mjs';
import {createBidCachePolicy} from '../../worker/runtime-cache/policy.mjs';

function cmp(){
  const callbacks=new Map(),events=new Map();let n=0;
  const win={crypto,addEventListener:(key,fn)=>events.set(key,fn),removeEventListener:key=>events.delete(key),
    __tcfapi(cmd,version,fn,id){if(cmd==='addEventListener'){callbacks.set(++n,fn);fn({gdprApplies:false,cmpStatus:'loaded',eventStatus:'tcloaded',listenerId:n},true);}else if(cmd==='removeEventListener')callbacks.delete(id);}};
  return {win,events,callbacks,emit(data,ok=true){for(const [id,fn] of callbacks)fn({listenerId:id,cmpStatus:'loaded',...data},ok);}};
}
test('TCF listener tracks changes, UI, errors, API replacement and page/viewport changes without exporting consent',()=>{
  const f=cmp(),c=createConsentEpoch(f.win);assert(c.read().cacheAllowed);
  const first=c.read().epoch;f.emit({gdprApplies:true,eventStatus:'useractioncomplete',tcString:'private-choice'});assert(c.read().epoch>first);assert(c.read().cacheAllowed);
  const stable=c.read().epoch;f.emit({gdprApplies:true,eventStatus:'useractioncomplete',tcString:'private-choice'});assert.equal(c.read().epoch,stable);
  f.emit({gdprApplies:true,eventStatus:'cmpuishown',tcString:'private-choice'});assert(!c.read().cacheAllowed);
  f.emit({},false);assert(!c.read().cacheAllowed);
  f.win.__tcfapi=undefined;assert(!c.read().cacheAllowed);assert.equal(f.callbacks.size,0);
  f.win.__tcfapi=cmp().win.__tcfapi;assert(c.read().cacheAllowed);
  f.win.__gpp=()=>{};assert(!c.read().cacheAllowed);delete f.win.__gpp;assert(c.read().cacheAllowed);
  const before=c.read().epoch;f.events.get('resize')();f.events.get('pageshow')();assert.equal(c.read().epoch,before+2);
  assert(!JSON.stringify(c.snapshot()).includes('private-choice'));c.stop();assert(!c.read().cacheAllowed);assert.equal(f.events.size,0);
});

function lifecycle(){
  const f=cmp(),requests=[],nativeCalls=[],listeners=new Map(),timers=new Map();let n=0,time=1000,liveSlot;
  const values={publisher:['keep'],tessera_ab:['assignment']};
  const slot={getSlotElementId:()=> 'P1',getTargetingKeys:()=>Object.keys(values),getTargeting:k=>values[k]||[],clearTargeting:k=>delete values[k]};liveSlot=slot;
  const config={},bids=new Map();let targetCalls=0;
  const emit=(name,e)=>{for(const fn of listeners.get(name)||[])fn(e);};
  const pbjs={version:'11.34.0',setConfig:c=>Object.assign(config,c),getConfig:k=>k.split('.').reduce((v,p)=>v?.[p],config),
    onEvent(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},offEvent:(name,fn)=>listeners.get(name)?.delete(fn),
    requestBids(input){nativeCalls.push(input);emit('auctionInit',{auctionId:input.auctionId,adUnitCodes:['P1']});},
    setTargetingForGPTAsync(){targetCalls++;const bid=[...bids.values()].at(-1);if(bid){bid.status='targetingSet';values.hb_adid=[bid.adId];}},getBidResponseByAdId:id=>bids.get(id)};
  Object.assign(f.win,{setTimeout(fn){timers.set(++n,fn);return n;},clearTimeout:id=>timers.delete(id),adSlots:{P1:slot},googletag:{pubads:()=>({refresh:slots=>requests.push(slots.map(()=>structuredClone(values)))})}});
  const api=createCacheLifecycle({win:f.win,pbjs,siteId:'test',runtimeVersion:'3.13.0',mode:'auction-with-cache',maxAgeSeconds:30,
    contextForCode:code=>code==='P1'?{slot:liveSlot,sizes:[[300,250]]}:null,codeForSlot:s=>s===liveSlot?'P1':null,
    policyFactory:createBidCachePolicy,consentFactory:createConsentEpoch,now:()=>time});
  function request(done=()=>api.refresh([slot])){api.requestBids({adUnits:[{code:'P1'}],timeout:100,bidsBackHandler:done});}
  function respond(index=nativeCalls.length-1){const input=nativeCalls[index],id='private-bid-'+index;bids.set(id,{adId:id,adUnitCode:'P1',auctionId:input.auctionId,mediaType:'banner',status:'good',width:300,height:250,responseTimestamp:time,ttl:60});input.bidsBackHandler();}
  return {...f,api,slot,requests,nativeCalls,config,timers,request,respond,lateInit:()=>emit('auctionInit',{auctionId:nativeCalls[0].auctionId,adUnitCodes:['P1']}),targetCalls:()=>targetCalls,replaceSlot:()=>liveSlot={...slot},advance:ms=>time+=ms};
}
test('targeting is deferred until render, then exactly one request preserves non-Prebid keys',()=>{
  const f=lifecycle();f.request(()=>{});f.respond();assert.equal(f.targetCalls(),0);
  f.advance(2000);f.api.refresh([f.slot]);assert.equal(f.targetCalls(),1);assert.equal(f.requests.length,1);
  assert.deepEqual(f.requests[0][0].publisher,['keep']);assert.deepEqual(f.requests[0][0].tessera_ab,['assignment']);
  assert.equal(f.api.snapshot().policy.lastSelection.ageMs,2000);f.api.refresh([f.slot]);assert.equal(f.requests.length,1);f.api.stop();
});
test('failsafe submits clean GAM once; late bids cannot cause targeting or reenter the cache',()=>{
  const f=lifecycle();f.request();f.api.refresh([f.slot]);assert.equal(f.requests.length,1);assert(!f.requests[0][0].hb_adid);
  f.lateInit();assert.equal(f.api.snapshot().policy.trackedAuctions,0);
  f.respond();assert.equal(f.requests.length,1);assert.equal(f.targetCalls(),0);assert.equal(f.api.snapshot().policy.trackedAuctions,0);
  f.request();f.respond();assert.equal(f.requests.length,2);assert.equal(f.targetCalls(),1);f.api.stop();
});
test('CMP change, replaced slot and overwritten preset settings cannot submit ready old bids',()=>{
  for(const change of [f=>f.emit({gdprApplies:false,eventStatus:'useractioncomplete',addtlConsent:'new-private-choice'}),f=>f.replaceSlot(),f=>f.config.targetingControls.presetGPTTargeting=true]){
    const f=lifecycle();f.request(()=>{});f.respond();change(f);f.api.refresh([f.slot]);assert.equal(f.requests.length,0);f.api.stop();
  }
});
test('duplicate pending auction and teardown are bounded and do not run another bidder call',()=>{
  const f=lifecycle();f.request();f.request();assert.equal(f.nativeCalls.length,1);f.respond();f.api.stop();assert.equal(f.timers.size,0);
  f.respond();f.api.refresh([f.slot]);assert.equal(f.requests.length,1);assert.equal(f.api.snapshot().trackedSlots,0);
});
test('page return invalidates prepared targeting, then the next owned auction recovers',()=>{
 const f=lifecycle();f.request(()=>{});f.respond();
 const epoch=f.api.snapshot().consent.epoch;
 f.events.get('pagehide')();f.events.get('pageshow')();
 f.api.refresh([f.slot]);assert.equal(f.requests.length,0);assert.equal(f.targetCalls(),0);
 assert.equal(f.api.snapshot().consent.epoch,epoch+2);
 f.request();f.respond();assert.equal(f.requests.length,1);assert.equal(f.targetCalls(),1);
 assert.equal(f.api.snapshot().policy.lastSelection.origin,'fresh');f.api.stop();
});
test('replaced CMP ignores queued old callbacks and teardown unregisters only owned listeners',()=>{
 const old=cmp(),replacement=cmp(),observer=createConsentEpoch(old.win),queued=[...old.callbacks.values()][0];
 old.win.__tcfapi=replacement.win.__tcfapi;
 assert(observer.read().cacheAllowed);assert.equal(old.callbacks.size,0);assert.equal(replacement.callbacks.size,1);
 const epoch=observer.read().epoch;queued({listenerId:1,gdprApplies:true,cmpStatus:'loaded',eventStatus:'cmpuishown',tcString:'private-stale'},true);
 assert.equal(observer.read().epoch,epoch);assert(observer.read().cacheAllowed);
 replacement.emit({gdprApplies:true,eventStatus:'cmpuishown',tcString:'private-choice'});assert(!observer.read().cacheAllowed);
 replacement.emit({gdprApplies:true,eventStatus:'useractioncomplete',tcString:'private-choice'});assert(observer.read().cacheAllowed);
 assert(!JSON.stringify(observer.snapshot()).includes('private-'));observer.stop();assert.equal(replacement.callbacks.size,0);
});
test('many lifecycle auctions bound state and timers; teardown prevents pending callbacks from submitting',()=>{
 const f=lifecycle();
 for(let i=0;i<600;i++){f.request();assert.equal(f.timers.size,1);f.respond();f.advance(1000);assert.equal(f.timers.size,0);}
 const s=f.api.snapshot();assert.equal(s.trackedSlots,1);assert.equal(s.policy.trackedAuctions,128);
 assert(s.policy.trackedSubmittedBids<=31);assert.equal(f.requests.length,600);assert.equal(s.totals.auctions,600);
 f.request();f.api.stop();f.respond();assert.equal(f.requests.length,600);assert.equal(f.timers.size,0);
 assert.equal(f.events.size,0);assert.equal(f.callbacks.size,0);assert.equal(f.api.snapshot().policy.trackedAuctions,0);
});
