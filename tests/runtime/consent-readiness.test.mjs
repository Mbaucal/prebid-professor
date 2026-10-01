import test from 'node:test';
import assert from 'node:assert/strict';
import {createGamReporting} from '../../worker/runtime-reporting-v1/browser-reporting.mjs';
import {createTesseraReadiness} from '../../worker/runtime-readiness-v1/browser-readiness.mjs';
function fixture({loaded=true,initial=null,reporting=false}={}){
  let time=0,id=0;const timers=new Map(),listeners=new Map(),sent=[],requests=[];let cmp=null,removed=0;
  const win={setTimeout(fn,ms){timers.set(++id,{fn,at:time+ms});return id;},clearTimeout(id){timers.delete(id);},
    __tcfapi(cmd,version,cb){if(cmd==='addEventListener'){cmp=cb;if(initial)cb(initial,true);}else removed++;}};
  const pb={setConfig(){},onEvent(name,cb){listeners.set(cb,name);},offEvent(name,cb){listeners.delete(cb);},requestBids(input){requests.push(input);},getAdserverTargetingForAdUnitCode(){return pb.targeting||{};}};
  if(loaded)win.pbjs=pb;
  const slot={id:'a',targeting:{hb_pb:'old',custom:'keep'},getSlotElementId(){return this.id;},setConfig({targeting}){for(const[k,v]of Object.entries(targeting))if(v===null)delete this.targeting[k];else this.targeting[k]=v;}};
  const reporter=createGamReporting({owns:s=>s===slot,prebid:()=>true});
  const service={refresh(slots){sent.push(slots.map(s=>({...s.targeting})));}};
  const gate=createTesseraReadiness(win,{rawRequest:reporting?reporter.request:(pb,input)=>pb.requestBids(input),rawDispatch:reporting?((_,slots)=>reporter.dispatch(service,slots)):((_,slots)=>service.refresh(slots)),discard:reporting?(()=>reporter.discard([slot])):null,clear(s){for(const k of Object.keys(s.targeting))if(k.startsWith('hb_'))delete s.targeting[k];},apply(s,t){Object.assign(s.targeting,t);},code:s=>s.id});
  function tick(ms){const end=time+ms;for(let n=0;n<10000;n++){const due=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;time=due[1].at;timers.delete(due[0]);due[1].fn();}time=end;}
  const consent=(data={})=>cmp({cmpStatus:'loaded',eventStatus:'tcloaded',gdprApplies:false,...data},true);
  const start=()=>{const r=requests.at(-1);for(const [fn,name]of listeners)if(name==='auctionInit')fn({auctionId:r.auctionId});return r;};
  const request=()=>gate.request(win.pbjs,{adUnits:[{code:'a'}],timeout:500,bidsBackHandler(){gate.dispatch({},[slot]);}});
  return {win,pb,gate,tick,consent,start,slot,request,requests,sent,removed:()=>removed,timers};
}
test('CMP UI stays pending past 1200ms, then one completed decision resumes at 8 seconds',()=>{
  const f=fixture();f.consent({eventStatus:'cmpuishown',gdprApplies:true});f.request();f.tick(7999);assert.equal(f.requests.length,0);assert.equal(f.sent.length,0);assert.equal(f.removed(),0);
  f.consent({eventStatus:'useractioncomplete',gdprApplies:true,tcString:'decision'});f.tick(1);assert.equal(f.requests.length,1);
});
test('unknown scope, missing TC string, CMP loading and CMP no response never bypass consent',()=>{
  for(const data of [null,{gdprApplies:undefined},{gdprApplies:true},{gdprApplies:true,tcString:'decision',cmpStatus:'loading'}]){
    const f=fixture();if(data)f.consent(data);f.request();f.tick(30000);assert.equal(f.requests.length,0);assert.equal(f.sent.length,0);
    f.consent();f.tick(0);assert.equal(f.requests.length,1);
  }
});
test('rejection is a completed CMP decision; GPT/Prebid keep native enforcement and receive no NPA override',()=>{
  const f=fixture();f.consent({gdprApplies:true,tcString:'rejected',purpose:{consents:{}},vendor:{consents:{}}});f.request();f.tick(0);const r=f.start();r.bidsBackHandler({},false,r.auctionId);f.tick(0);assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0][0],{custom:'keep'});
});
test('missing/blocked Prebid falls back once after readiness timeout; a late library cannot restart it',()=>{
  const f=fixture({loaded:false});f.consent();f.request();f.tick(2999);assert.equal(f.sent.length,0);f.tick(1);assert.equal(f.sent.length,1);f.win.pbjs=f.pb;f.tick(10000);assert.equal(f.requests.length,0);assert.equal(f.sent.length,1);
});
test('Prebid arriving within readiness window starts only one auction',()=>{
  const f=fixture({loaded:false});f.consent();f.request();f.tick(2000);f.win.pbjs=f.pb;f.tick(50);assert.equal(f.requests.length,1);const r=f.start();r.bidsBackHandler({},false,r.auctionId);f.tick(0);assert.equal(f.sent.length,1);
});
test('pre-auction wait cannot consume the bidder timeout; actual auction starts its own deadline',()=>{
  const f=fixture();f.consent();f.request();f.tick(6000);assert.equal(f.sent.length,0);f.start();f.tick(999);assert.equal(f.sent.length,0);f.tick(1);assert.equal(f.sent.length,1);
  const r=f.requests[0];r.bidsBackHandler({},false,r.auctionId);f.tick(100);assert.equal(f.sent.length,1);
});
test('bounded pre-auction watchdog is a fallback, never fabricated auction completion',()=>{
  const f=fixture();f.consent();f.request();f.tick(10000);assert.equal(f.sent.length,1);assert.equal(f.gate.snapshot().events.at(-1).phase,'pre-auction-deadline');assert.equal(f.gate.snapshot().events.at(-1).completed,false);
});
test('targeting accepts current completed positive bids only, preserves unrelated targeting',()=>{
  for(const stale of [true,false]){
    const f=fixture();f.consent();f.request();f.tick(0);const r=f.start();f.pb.targeting={hb_adid:stale?'old':'new',hb_pb:'1.20'};
    r.bidsBackHandler({a:{bids:[{auctionId:r.auctionId,adUnitCode:'a',cpm:1.2,adId:'new'}]}},false,r.auctionId);f.tick(0);
    assert.deepEqual(f.sent[0][0],stale?{custom:'keep'}:{custom:'keep',hb_adid:'new',hb_pb:'1.20'});assert.deepEqual(f.gate.targeting('a'),{});
  }
});
test('changed consent cancels old auction, blocks dispatch during UI, and ignores old callback after new decision',()=>{
  const f=fixture();f.consent({gdprApplies:true,tcString:'one'});f.request();f.tick(0);const r=f.start();
  f.consent({gdprApplies:true,eventStatus:'cmpuishown'});f.tick(5000);assert.equal(f.sent.length,0);
  f.pb.targeting={hb_adid:'old',hb_pb:'9'};r.bidsBackHandler({a:{bids:[{auctionId:r.auctionId,adUnitCode:'a',cpm:9,adId:'old'}]}},false,r.auctionId);
  f.consent({gdprApplies:true,tcString:'two'});f.tick(0);assert.deepEqual(f.sent,[[{custom:'keep'}]]);assert(!JSON.stringify(f.gate.snapshot()).includes('two'));
});

 test('minimal out-of-scope TCData needs no eventStatus or cmpStatus under the CMP API contract',()=>{
  const f=fixture({initial:{gdprApplies:false,tcfPolicyVersion:4,cmpId:1,cmpVersion:1}});f.request();f.tick(0);assert.equal(f.requests.length,1);
 });
 test('actual reporting helper cannot acquire canceled-epoch aq data from a late callback',()=>{
  for(const completeBeforeChange of [false,true]){
    const f=fixture({reporting:true});f.consent({gdprApplies:true,tcString:'one'});f.request();f.tick(0);const r=f.start();
    const bids={a:{bids:[{auctionId:r.auctionId,adUnitCode:'a',cpm:9,adId:'old',bidderCode:'pubmatic'}]}};
    if(completeBeforeChange)r.bidsBackHandler(bids,false,r.auctionId);
    f.consent({gdprApplies:true,eventStatus:'cmpuishown'});f.tick(10);
    if(!completeBeforeChange)r.bidsBackHandler(bids,false,r.auctionId);
    f.consent({gdprApplies:true,tcString:'two'});f.tick(0);
    assert.equal(f.sent.length,1);assert(!Object.keys(f.sent[0][0]).some(k=>k.startsWith('aq_')));assert.equal(f.sent[0][0].hb_pb,undefined);
  }
 });

test('GAM-only refreshes waiting for a new decision coalesce per slot',()=>{
  const f=fixture();f.consent({gdprApplies:true,eventStatus:'cmpuishown'});
  for(let i=0;i<3;i++){f.gate.dispatch({},[f.slot]);f.tick(30000);}
  assert.equal(f.sent.length,0);f.consent({gdprApplies:true,tcString:'decision'});f.tick(0);assert.equal(f.sent.length,1);
});
