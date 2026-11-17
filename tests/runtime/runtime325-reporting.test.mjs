import test from 'node:test';
import assert from 'node:assert/strict';
import {createTesseraRequestMetrics} from '../../worker/runtime-325/browser-request-metrics.mjs';

function harness({prebid=true,deadline=10000,configured=true}={}) {
  let time=0;
  const page={}, records=Object.create(null), slots=[];
  const merge=(target,values)=>{for(const[key,value]of Object.entries(values))if(value===null)delete target[key];else target[key]=value;};
  const win={performance:{now:()=>time},googletag:{setConfig:({targeting})=>merge(page,targeting)}};
  const metrics=createTesseraRequestMetrics(win,{prebid:()=>prebid,reportingPrebid:()=>configured,code:slot=>slot.code,readiness:code=>records[code],consentDeadline:()=>deadline});
  function slot(code='P1',targeting={}) {
    const value={code,values:{...targeting},getTargeting(key){const v=this.values[key];return v===undefined?[]:Array.isArray(v)?v:[v];},setConfig({targeting:next}){merge(this.values,next);}};
    slots.push(value);return value;
  }
  function bid(id,alias='pm_ag',code='P1',auctionId='a1') {return{adId:id,bidderCode:alias,adUnitCode:code,auctionId,cpm:2,ttl:60,responseTimestamp:Date.now()};}
  function complete(auctionId,bids,allowed=bids.map(value=>value.adId),code='P1') {
    metrics.auction([code],{[code]:{bids}},auctionId,1,true);
    records[code]={epoch:1,completed:true,auctionId,allowed:Object.fromEntries(allowed.map(id=>[id,Date.now()+59000]))};
  }
  const send=list=>{const token=metrics.before({},list);metrics.commit(token);return token;};
  return{metrics,page,records,slots,slot,bid,complete,send,time:value=>time=value};
}

test('actual primary identity follows fresh → admitted cached → confirmed none and clears stale values',()=>{
  const h=harness(),s=h.slot('P1',{Variant:'B',hb_adid:'winner',hb_bidder:'pm_ag',hb_adid_openx:'unused'});
  h.metrics.consent(true,1);h.metrics.enter(true,1);
  h.complete('a1',[h.bid('winner'),h.bid('unused','openx')]);h.send([s]);
  assert.equal(s.values.aq_bid_origin,'fresh');
  h.complete('a2',[],['unused']);s.values.hb_adid='unused';s.values.hb_bidder='openx';h.send([s]);
  assert.equal(s.values.aq_bid_origin,'cached');
  h.complete('a3',[]);delete s.values.hb_adid;delete s.values.hb_bidder;h.send([s]);
  assert.equal(s.values.aq_bid_origin,'none');assert.equal(s.values.Variant,'B');
});
test('a cached secondary never overrides a fresh primary',()=>{
  const h=harness(),s=h.slot('P1',{hb_adid:'fresh',hb_bidder:'pm_ag',hb_adid_openx:'cache'});
  h.metrics.consent(true,1);h.metrics.enter(true,1);
  h.complete('a1',[h.bid('cache','openx')]);h.complete('a2',[h.bid('fresh','pm_ag','P1','a2')],['fresh','cache']);h.send([s]);
  assert.equal(s.values.aq_bid_origin,'fresh');
});
test('unknown, wrong alias/code, duplicate and unadmitted historic identities omit origin',()=>{
  for(const kind of ['unknown','alias','code','duplicate','unadmitted','multi-primary']) {
    const h=harness(),s=h.slot('P1',{hb_adid:'id',hb_bidder:'pm_ag',aq_bid_origin:'cached'});
    h.metrics.consent(true,1);h.metrics.enter(true,1);
    if(kind==='unknown')h.complete('a1',[],['id']);
    else if(kind==='code'){h.complete('a1',[h.bid('id','pm_ag','Other')],['id']);}
    else if(kind==='duplicate'){h.complete('a1',[h.bid('id'),h.bid('id','openx')]);}
    else if(kind==='unadmitted'){h.complete('a1',[h.bid('id')]);h.complete('a2',[]);}
    else {h.complete('a1',[h.bid('id')]);if(kind==='alias')s.values.hb_bidder='openx';else s.values.hb_adid=['id','other'];}
    h.send([s]);assert.equal(s.values.aq_bid_origin,undefined,kind);
  }
});
test('confirmed empty fallback reports none for configured Prebid while inactive Prebid omits',()=>{
  for(const prebid of [true,false]) {
    const h=harness({prebid}),s=h.slot('P1',{aq_bid_origin:'fresh'});h.metrics.consent(true,1);h.metrics.enter(true,1);
    h.records.P1={epoch:1,completed:false,auctionId:null,allowed:{}};h.send([s]);assert.equal(s.values.aq_bid_origin,prebid?'none':undefined);
  }
});
test('a missing or unfinished auction cannot identify nonempty targeting but valid empty targeting still proves none',()=>{
  for(const incomplete of [true,false]){
    const h=harness(),s=h.slot('P1',{hb_adid:'unproven',hb_bidder:'pm_ag',aq_bid_origin:'cached'});
    h.metrics.consent(true,1);
    if(incomplete)h.records.P1={epoch:1,completed:false,auctionId:null,allowed:{}};
    h.send([s]);assert.equal(s.values.aq_bid_origin,undefined);
    delete s.values.hb_adid;delete s.values.hb_bidder;h.send([s]);assert.equal(s.values.aq_bid_origin,'none');
  }
});
test('slots with no configured Prebid demand omit origin even when the global Prebid switch is on',()=>{
  const h=harness({prebid:true,configured:false}),s=h.slot('P1',{aq_bid_origin:'cached'});h.metrics.consent(true,1);
  h.send([s]);assert.equal(s.values.aq_bid_origin,undefined);
});
test('only the documented empty targeting array confirms none; malformed getters omit',()=>{
  for(const value of [undefined,null,'',0]) {
    const h=harness(),s=h.slot('P1',{aq_bid_origin:'cached'});h.metrics.consent(true,1);h.complete('a1',[]);
    s.getTargeting=()=>value;h.send([s]);assert.equal(s.values.aq_bid_origin,undefined,String(value));
  }
  const h=harness(),s=h.slot('P1',{aq_bid_origin:'cached'});h.metrics.consent(true,1);h.complete('a1',[]);
  s.getTargeting=()=>{throw Error('unknown targeting');};h.send([s]);assert.equal(s.values.aq_bid_origin,undefined);
});
test('page buckets are set before first dispatch and remain fixed for batch, refresh and late lazy slots',()=>{
  const h=harness({prebid:false}),a=h.slot('A',{aq_first_request:'bad',aq_consent_wait:'bad'}),b=h.slot('B');
  h.time(100);h.metrics.enter(false,0);h.time(1100);h.metrics.consent(true,1);h.time(2250);
  h.page.aq_bid_origin='forged';h.send([a,b]);
  assert.deepEqual(h.page,{aq_first_request:'2000_2999',aq_consent_wait:'1000_1499'});
  assert.equal(a.values.aq_first_request,undefined);assert.equal(a.values.aq_consent_wait,undefined);
  h.time(20000);h.send([h.slot('Late')]);assert.equal(h.page.aq_first_request,'2000_2999');assert.equal(h.page.aq_consent_wait,'1000_1499');
});
test('first-request measurement includes reporting work immediately before the native boundary',()=>{
  const h=harness(),s=h.slot();h.metrics.consent(true,1);h.metrics.enter(true,1);h.time(490);
  s.getTargeting=()=>{h.time(510);return[];};
  h.send([s]);assert.equal(h.page.aq_first_request,'500_999');assert.equal(h.page.aq_consent_wait,'lt_500');
});
test('already-ready gate measures from gate entry rather than earlier listener installation',()=>{
  const h=harness();h.time(2000);h.metrics.consent(true,1);h.time(5000);h.metrics.enter(true,1);h.time(5500);h.send([h.slot()]);
  assert.equal(h.page.aq_consent_wait,'lt_500');assert.equal(h.page.aq_first_request,'3000_plus');
});
test('decision revocation is remeasured while duplicate ready callbacks do not inflate waiting',()=>{
  for(const revoke of [true,false]) {
    const h=harness();h.metrics.enter(false,0);h.time(100);h.metrics.consent(true,1);
    if(revoke){h.time(200);h.metrics.consent(false,2);}
    h.time(1800);h.metrics.consent(true,revoke?3:1);h.time(2500);h.send([h.slot()]);
    assert.equal(h.page.aq_consent_wait,revoke?'1500_1999':'lt_500');
  }
});
test('timeout observes actual CMP waiting at the configured boundary, never SSP delay after ready',()=>{
  for(const [decision,expected]of [[1499.99,'1000_1499'],[1500,'timeout'],[4500,'timeout']]){
    const h=harness({deadline:1500});h.metrics.enter(false,0);h.time(decision);h.metrics.consent(true,1);h.time(10000);h.send([h.slot()]);
    assert.equal(h.page.aq_consent_wait,expected,String(decision));
  }
  const h=harness({deadline:1500});h.metrics.enter(false,0);h.time(100);h.metrics.consent(true,1);h.time(10000);h.send([h.slot()]);
  assert.equal(h.page.aq_consent_wait,'lt_500');assert.equal(h.page.aq_first_request,'3000_plus');
});
test('a larger first-batch budget preserves elapsed buckets and an already-ready late script never times out',()=>{
  const h=harness({deadline:5000});h.metrics.enter(false,0);h.time(3000);h.metrics.consent(true,1);h.time(8000);h.send([h.slot('P1'),h.slot('P2')]);
  assert.equal(h.page.aq_consent_wait,'3000_plus');
  const ready=harness({deadline:1500});ready.time(7000);ready.metrics.consent(true,1);ready.time(10000);ready.metrics.enter(true,1);ready.send([ready.slot()]);
  assert.equal(ready.page.aq_consent_wait,'lt_500');
});
test('all millisecond bucket boundaries are exact and a new document starts over',()=>{
  for(const [ms,value]of [[0,'lt_500'],[499.99,'lt_500'],[500,'500_999'],[999.99,'500_999'],[1000,'1000_1499'],[1499.99,'1000_1499'],[1500,'1500_1999'],[1999.99,'1500_1999'],[2000,'2000_2999'],[2999.99,'2000_2999'],[3000,'3000_plus']]){
    const h=harness();h.metrics.enter(false,0);h.time(ms);h.metrics.consent(true,1);h.send([h.slot()]);
    assert.equal(h.page.aq_first_request,value,String(ms));assert.equal(h.page.aq_consent_wait,value,String(ms));
  }
});
test('a synchronous GPT failure rolls back provisional page timing for a later retry',()=>{
  const h=harness(),s=h.slot();h.metrics.enter(true,1);h.time(750);const token=h.metrics.before({},[s]);
  assert.equal(h.page.aq_first_request,'500_999');h.metrics.rollback({},token);assert.equal(h.page.aq_first_request,undefined);
  h.time(1700);h.send([s]);assert.equal(h.page.aq_first_request,'1500_1999');
});
test('empty dispatch does not freeze page values; a genuinely ungated dispatch reports na',()=>{
  const h=harness({prebid:false});h.time(500);assert.equal(h.metrics.before({},[]),null);assert.deepEqual(h.page,{});
  h.time(1500);h.send([h.slot()]);assert.equal(h.page.aq_first_request,'1500_1999');assert.equal(h.page.aq_consent_wait,'na');
});
test('consent epoch change discards earlier bid identities',()=>{
  const h=harness(),s=h.slot('P1',{hb_adid:'id',hb_bidder:'pm_ag'});h.metrics.consent(true,1);h.complete('a1',[h.bid('id')]);
  h.metrics.consent(false,2);h.metrics.consent(true,3);h.records.P1={epoch:3,completed:true,auctionId:'a3',allowed:{id:Date.now()+59000}};
  h.send([s]);assert.equal(s.values.aq_bid_origin,undefined);
});
test('long-page identity history is bounded and refuses evicted or expired identities',()=>{
  const h=harness(),s=h.slot('P1',{hb_adid:'old',hb_bidder:'pm_ag'});h.metrics.consent(true,1);h.complete('a0',[h.bid('old')]);
  for(let index=1;index<=64;index++)h.complete('a'+index,[]);
  h.records.P1.allowed.old=Date.now()+59000;h.send([s]);assert.equal(s.values.aq_bid_origin,undefined);
  const expired=h.bid('expired','pm_ag','P1','last');expired.ttl=1;
  h.complete('last',[expired]);s.values.hb_adid='expired';h.records.P1.allowed.expired=Date.now()+59000;h.send([s]);
  assert.equal(s.values.aq_bid_origin,undefined);
});
test('a malformed response getter cannot leave partially retained auction identities',()=>{
  const h=harness(),s=h.slot('P1',{hb_adid:'good',hb_bidder:'pm_ag'});h.metrics.consent(true,1);
  const bad=h.bid('bad');Object.defineProperty(bad,'bidderCode',{get(){throw Error('malformed bidder metadata');}});
  assert.throws(()=>h.metrics.auction(['P1'],{P1:{bids:[h.bid('good'),bad]}},'a1',1,true),/malformed bidder/);
  h.records.P1={epoch:1,completed:true,auctionId:'a1',allowed:{good:Date.now()+59000}};
  h.send([s]);assert.equal(s.values.aq_bid_origin,undefined);
});
