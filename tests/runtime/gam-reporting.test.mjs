import test from 'node:test';
import assert from 'node:assert/strict';
import {createGamReporting} from '../../worker/runtime-reporting-v1/browser-reporting.mjs';
import {compileReporting} from '../../worker/runtime-reporting-v1/compiler.mjs';
import {compilePositions} from '../../worker/runtime-next/compiler.mjs';
import {previewInput} from '../../worker/runtime-next/snapshot.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {descriptor} from '../../.generated/runtime-next-manifest.mjs';
function fixture(prebid=true) {
  const make = id => ({id, targeting:{Variant:'A',hb_pb:'1.20'}, getSlotElementId(){return id;},
    setConfig({targeting}){for(const [key,value] of Object.entries(targeting))if(value===null)delete this.targeting[key];else this.targeting[key]=value;}});
  const a=make('a'), b=make('b'), foreign=make('foreign'), calls=[], inputs=[];
  const r=createGamReporting({owns:s=>s===a||s===b,prebid:s=>prebid&&s!==b});
  const pb={requestBids(input){inputs.push(input);return 'return-value';}};
  const service={refresh(list,options){calls.push({slots:list.map(s=>({id:s.id,targeting:{...s.targeting}})),options});return 'gpt-value';}};
  const bid=(overrides={})=>({auctionId:'auction',adUnitCode:'a',adId:'ad-1',bidderCode:'one',cpm:1,...overrides});
  const auction=(bids=[bid()], timeout=false, id='auction')=>{r.request(pb,{adUnits:[{code:'a'}],bidsBackHandler(){}});inputs.at(-1).bidsBackHandler({a:{bids}},timeout,id);};
  const send=(list=[a])=>r.dispatch(service,list,{changeCorrelator:false});
  return {a,b,foreign,r,pb,service,calls,inputs,bid,auction,send};
}
test('GAM-only first/refresh requests get the exact count, bucket and planned interval, never aq keys',()=>{
  const f=fixture(false);f.a.targeting.aq_bid_count='7';
  for(let n=0;n<6;n++){
    f.r.plan(f.a,30);assert.equal(f.send(),'gpt-value');
    const t=f.calls.at(-1).slots[0].targeting;
    assert.equal(t.refresh_count,String(n));assert.equal(t.refresh_bucket,n===0?'initial':n<=3?'r1_3':'r4_plus');
    assert.equal(t.refresh_interval,n===0?'initial':'30');assert.equal(t.refresh_policy,n===0?'initial':'gam_only');
    assert(!Object.keys(t).some(k=>k.startsWith('aq_')));assert.equal(t.Variant,'A');assert.equal(t.hb_pb,'1.20');
  }
});
test('counts only unique positive bids from the current slot and auction; distinct bidders are not bids',()=>{
  const f=fixture();f.auction([f.bid(),f.bid(),f.bid({adId:'ad-2'}),f.bid({adId:'ad-3',bidderCode:'two'}),
    ...[0,-1,NaN,Infinity,'2',null].map((cpm,i)=>f.bid({adId:'bad-'+i,cpm})),
    f.bid({adId:'old',auctionId:'old'}),f.bid({adId:'other-slot',adUnitCode:'b'})]);
  f.send();assert.deepEqual(Object.fromEntries(Object.entries(f.a.targeting).filter(([k])=>k.startsWith('aq_'))),
    {aq_bid_count:'3',aq_bidder_count:'2',aq_timed_out:'no'});
});
test('completed no-bid auction is zero; timeout is the actual callback flag',()=>{
  const f=fixture();f.auction([],true);f.send();assert.equal(f.a.targeting.aq_bid_count,'0');assert.equal(f.a.targeting.aq_timed_out,'yes');
  f.auction([],false);f.r.plan(f.a,10);f.send();assert.equal(f.a.targeting.refresh_policy,'fresh_auction');assert.equal(f.a.targeting.refresh_interval,'10');
});
test('missing or malformed callback fields omit aq rather than report fake zero/no',()=>{
  for(const args of [[undefined,undefined,undefined],[{},undefined,'a'],[{},false,undefined],[{a:{bids:{}}},false,'a']]){
    const f=fixture();f.r.request(f.pb,{adUnits:[{code:'a'}]});f.inputs[0].bidsBackHandler(...args);f.send();
    assert(!Object.keys(f.a.targeting).some(k=>k.startsWith('aq_')));
  }
});
test('empty response map for a completed auction is a known zero, not missing callback',()=>{
  const f=fixture();f.r.request(f.pb,{adUnits:[{code:'a'}]});f.inputs[0].bidsBackHandler({},false,'a');f.send();assert.equal(f.a.targeting.aq_bid_count,'0');
});
test('fallback consumes pending data and a late callback cannot contaminate the next request',()=>{
  const f=fixture();f.auction();f.send();f.r.request(f.pb,{adUnits:[{code:'a'}]});const late=f.inputs.at(-1);
  f.r.plan(f.a,30);f.send();assert.equal(f.a.targeting.refresh_policy,'prebid_fallback');assert.equal(f.a.targeting.aq_bid_count,undefined);
  late.bidsBackHandler({a:{bids:[f.bid()]}},false,'auction');f.send();assert.equal(f.a.targeting.aq_bid_count,undefined);
});
test('newer auction wins even when old callback completes later; records are single-use',()=>{
  const f=fixture();f.r.request(f.pb,{adUnits:[{code:'a'}]});const old=f.inputs[0];f.auction([],true);
  old.bidsBackHandler({a:{bids:[f.bid()]}},false,'auction');f.send();assert.equal(f.a.targeting.aq_bid_count,'0');
  f.send();assert.equal(f.a.targeting.aq_bid_count,undefined);assert.equal(f.a.targeting.refresh_interval,'unscheduled');
});
test('batched results remain slot-specific; GAM-only overlay and foreign slots are not attributed',()=>{
  const f=fixture();f.r.request(f.pb,{adUnitCodes:['a','b']});
  f.inputs[0].bidsBackHandler({a:{bids:[f.bid()]},b:{bids:[f.bid({adUnitCode:'b'})]}},true,'auction');
  f.send([f.a,f.b,f.foreign]);assert.equal(f.a.targeting.aq_bid_count,'1');assert.equal(f.b.targeting.aq_bid_count,undefined);
  assert.equal(f.foreign.targeting.refresh_bucket,undefined);assert.equal(f.calls.length,1);
});
test('visibility gate drops are not counted or reused and original return/context/options are preserved',()=>{
  const f=fixture();f.service.__ads_gate_wrapped=true;
  f.service.refresh=function(list,opts){assert.equal(this,f.service);f.r.discard([f.a]);return 'blocked';};
  f.auction();assert.equal(f.send(),'blocked');delete f.service.__ads_gate_wrapped;
  f.service.refresh=function(list,opts){assert.equal(this,f.service);assert.equal(opts.changeCorrelator,false);return 42;};
  assert.equal(f.send(),42);assert.equal(f.a.targeting.refresh_count,'0');assert.equal(f.a.targeting.aq_bid_count,undefined);
});
test('request wrapper preserves input, callback arguments, context, exceptions and return value',()=>{
  const f=fixture();const context={},result={a:{bids:[f.bid()]}};let args;
  const input={adUnits:[{code:'a'}],timeout:1500,bidsBackHandler:function(...values){assert.equal(this,context);args=values;return 'cb';}};
  assert.equal(f.r.request(f.pb,input),'return-value');assert.notEqual(f.inputs[0],input);assert.equal(f.inputs[0].timeout,1500);
  assert.equal(f.inputs[0].bidsBackHandler.call(context,result,false,'auction'),'cb');assert.deepEqual(args,[result,false,'auction']);
  f.pb.requestBids=()=>{throw Error('pb failure');};assert.throws(()=>f.r.request(f.pb,input),/pb failure/);
  f.send();assert.equal(f.a.targeting.aq_bid_count,undefined);
});
test('reporting failures do not block GPT; thrown dispatch does not advance the count',()=>{
  const f=fixture(false),original=f.service.refresh;
  f.service.refresh=()=>{throw Error('gpt failure');};assert.throws(f.send,/gpt failure/);
  f.service.refresh=original;f.send();assert.equal(f.a.targeting.refresh_count,'0');
  f.a.setConfig=()=>{throw Error('targeting failure');};f.send();assert.equal(f.calls.length,2);
});
test('new compiler leaves old engine bytes and fixtures untouched, instruments all paths',()=>{
  for(const prebid of [true,false]){
    const snapshot=positionFixture(prebid),before=JSON.stringify(snapshot),input=previewInput(snapshot,descriptor,'20260923_160000');
    const old=compilePositions(input).adsJs,newCode=compileReporting(input).adsJs;
    assert.equal(compilePositions(input).adsJs,old);assert.equal(JSON.stringify(snapshot),before);
    assert.match(newCode,/_gamReporting\.send\(orig,pa,allow,opts\)/);
    assert.match(newCode,/_gamReporting\.plan\(slot,effectiveMinGapSec\)/);
    assert(newCode.includes('aq_bidder_count'));assert(!old.includes('aq_bidder_count'));
  }
});
