import test from 'node:test';
import assert from 'node:assert/strict';
import {createBidReadinessObserver} from '../../worker/runtime-readiness/observer.mjs';

function fixture(options={}) {
  let clock=100000,epoch=1,consent=true,sizes=[[300,250]],floor=.1;
  const listeners=new Map(),events=new Map(),native=new Map(),config={useBidCache:false};
  const values={},slots=[];
  const slot={getSlotElementId:()=> 'P1',getTargetingKeys:()=>Object.keys(values),getTargeting:k=>values[k]||[]};slots.push(slot);
  const pub={version:'v11.34.0',onEvent(n,cb){listeners.set(n,cb);},offEvent(n){listeners.delete(n);},
    getConfig:n=>config[n],getBidResponseByAdId:id=>native.get(id),
    requestBids(){throw Error('Observer must not auction');},setConfig(){throw Error('Observer must not configure');},
    getHighestCpmBids(){throw Error('Observer must not mutate native selection metadata');}};
  const service={getSlots:()=>slots,addEventListener(n,cb){events.set(n,cb);},removeEventListener(n){events.delete(n);}};
  const observer=createBidReadinessObserver({pbjs:pub,service,codes:['P1','P2'],now:()=>clock,
    contextForCode:code=>code==='P1'?{slot,epoch,consentReady:consent,sizes,floor,currency:'EUR',bidderFloors:{}}:null,...options});
  function emit(n,p){listeners.get(n)?.(p);}
  function auction(id='auction-1'){emit('auctionInit',{auctionId:id,adUnits:[{code:'P1'}]});}
  function bid(id='bid-1',patch={}){const b={adId:id,auctionId:'auction-1',adUnitCode:'P1',responseTimestamp:clock,ttl:60,
    cpm:1,currency:'EUR',mediaType:'banner',width:300,height:250,ad:'<div>fixture</div>',...patch};native.set(id,b);emit('bidResponse',b);return b;}
  const end=(id='auction-1')=>emit('auctionEnd',{auctionId:id});
  return {observer,pub,service,listeners,events,native,config,slot,values,auction,bid,end,emit,
    row:()=>observer.snapshot().rows[0],advance:ms=>clock+=ms,epoch:()=>epoch++,consent:v=>consent=v,
    sizes:v=>sizes=v,floor:v=>floor=v,replaceSlot:()=>slots.splice(0),request:()=>events.get('slotRequested')?.({slot})};
}
test('screening is passive, scoped, time-sensitive, and does not claim guaranteed ads',()=>{
  const f=fixture();f.auction();f.bid();assert.equal(f.row().candidates,0);f.end();
  assert.equal(f.row().candidates,1);assert.equal(f.row().earliestExpiryMs,59000);
  const before=JSON.stringify([...f.native]);for(let i=0;i<5;i++)f.row();assert.equal(JSON.stringify([...f.native]),before);
  f.advance(57000);assert.equal(f.row().candidates,0);assert.equal(f.row().rejected['expired-or-too-close'],1);
  const s=f.observer.snapshot();assert.equal(s.cacheEnabled,false);assert.equal(s.nativeSelectionVerified,false);assert.equal(s.guaranteedAds,null);
});
test('bid-specific and configured native TTL buffers plus max age are respected',()=>{
  for(const [patch,buffer,advance] of [[{ttl:20,ttlBuffer:5},1,13000],[{ttl:20},5,13000],[{ttl:300},1,58000]]){
    const f=fixture();f.config.ttlBuffer=buffer;f.auction();f.bid('b',patch);f.end();assert.equal(f.row().candidates,1);
    f.advance(advance);assert.equal(f.row().candidates,0);
  }
});
test('manual primary and deal targeting are consumed once, even without native status updates',()=>{
  const f=fixture();f.auction();const first=f.bid(),deal=f.bid('deal');f.end();
  assert.equal(f.row().candidates,2);f.values.hb_adid=[first.adId];f.values.hb_adid_partner=[deal.adId];
  f.request();delete f.values.hb_adid;delete f.values.hb_adid_partner;
  assert.equal(f.row().candidates,0);assert.equal(f.row().counters.submitted,2);
  f.request();assert.equal(f.row().counters.submitted,2);assert.equal(first.status,undefined);
});
test('native targeting status, native targeting event, won and render outcomes exclude reuse',()=>{
  for(const stage of ['targetingSet','rendered','setTargeting','bidWon','adRenderSucceeded','adRenderFailed','bidRejected']){
    const f=fixture();f.auction();const b=f.bid();f.end();
    if(['targetingSet','rendered'].includes(stage))b.status=stage;
    else f.emit(stage,stage==='setTargeting'?{P1:{hb_adid:[b.adId]}}:stage.startsWith('adRender')?{adId:b.adId,bid:b}:b);
    assert.equal(f.row().candidates,0,stage);
  }
});
test('changed or missing context and incompatible price/creative data are rejected',()=>{
  for(const change of [f=>f.epoch(),f=>f.consent(false),f=>f.sizes([[728,90]]),f=>f.floor(2),f=>f.replaceSlot(),
    f=>f.native.clear(),f=>f.config.bidCacheFilterFunction=()=>true]){
    const f=fixture();f.auction();f.bid();f.end();change(f);assert.equal(f.row().candidates,0);
  }
  for(const patch of [{cpm:0},{cpm:NaN},{currency:'USD'},{mediaType:'video'},{ad:''},{width:728},{ttl:0},{ttlBuffer:-1},{responseTimestamp:Infinity}]){
    const f=fixture();f.auction();f.bid('b',patch);f.end();assert.equal(f.row().candidates,0,JSON.stringify(patch));
  }
});
test('no historical reconstruction, no cross-slot counting, duplicate events and bounded memory',()=>{
  const f=fixture({bidLimit:2});f.bid('historical');f.auction();f.bid('other',{adUnitCode:'P2'});
  f.bid();f.bid();f.end();assert.equal(f.row().candidates,1);assert.equal(f.row().counters.received,1);
  f.bid('second');f.bid('third');assert.equal(f.observer.snapshot().capacityReached,true);assert.equal(f.row().candidates,0);
  assert.equal(f.observer.snapshot().trackedBids,2);
});
test('stop unregisters every observer and never changes native configuration',()=>{
  const f=fixture();f.auction();f.bid();f.end();f.observer.stop();f.observer.stop();
  assert.equal(f.listeners.size,0);assert.equal(f.events.size,0);assert.equal(f.row().candidates,0);assert.equal(f.config.useBidCache,false);
});
test('snapshot excludes bid identifiers, creatives, raw consent and arbitrary event payloads',()=>{
  const f=fixture();f.auction('SECRET-AUCTION');f.bid('SECRET-BID',{auctionId:'SECRET-AUCTION',ad:'SECRET-CREATIVE',userId:'SECRET-USER'});f.end('SECRET-AUCTION');
  const s=JSON.stringify(f.observer.snapshot());assert(!s.includes('SECRET'));assert.equal(f.row().candidates,1);
});
