import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const sources={old:readFileSync(new URL('../../worker/runtime-readiness-v1/browser-readiness.mjs',import.meta.url),'utf8'),fixed:readFileSync(new URL('../../worker/runtime-3161/browser-readiness.mjs',import.meta.url),'utf8')};
function fixture(version='fixed',{loaded=true}={}){
 let time=1000000,id=0,cmp=null,alive=true,throwDispatch=false;const timers=new Map(),events=new Map(),requests=[],sent=[];let current=[];
 const clock={now:()=>time,setTimeout(fn,ms){timers.set(++id,{fn,at:time+ms});return id;},clearTimeout(key){timers.delete(key);},tick(ms){const end=time+ms;for(let n=0;n<10000;n++){const due=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;time=due[1].at;timers.delete(due[0]);due[1].fn();}time=end;}};
 const nativeTarget=()=>{
  const bids=current.filter(b=>b.responseTimestamp+(b.ttl-1)*1000>time).sort((a,b)=>b.cpm-a.cpm);if(!bids.length)return{};
  const out={hb_adid:bids[0].adId,hb_pb:String(bids[0].cpm),hb_bidder:bids[0].bidderCode};
  for(const b of bids){out['hb_adid_'+b.bidderCode]=b.adId;out['hb_pb_'+b.bidderCode]=String(b.cpm);}return out;
 };
 const pb={setConfig(){},onEvent(name,fn){events.set(fn,name);},offEvent(name,fn){events.delete(fn);},requestBids(input){requests.push(input);},getAdserverTargetingForAdUnitCode:nativeTarget};
 const win={setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,__tcfapi(cmd,v,fn){if(cmd==='addEventListener')cmp=fn;}};if(loaded)win.pbjs=pb;
 const slot={id:'P1',targeting:{custom:'keep'},getSlotElementId(){return this.id;}};
 const ctx=vm.createContext({Date:{now:clock.now}});vm.runInContext(sources[version].replace('export function','function')+'\nthis.make=createTesseraReadiness;',ctx);
 const gate=ctx.make(win,{rawRequest:(p,input)=>p.requestBids(input),rawDispatch:(_,slots)=>{if(throwDispatch){throwDispatch=false;throw Error('transient native dispatch');}sent.push(slots.map(s=>({...s.targeting})));},clear(s){s.targeting={custom:'keep'};},apply:(s,t)=>Object.assign(s.targeting,t),code:s=>s.id,alive:()=>alive,unit:code=>({code,bids:[{bidder:'a'}]}),timeout:()=>500});
 const consent=(data={})=>cmp({gdprApplies:false,cmpStatus:'loaded',eventStatus:'tcloaded',...data},true);
 const request=(dispatch=false)=>{gate.request(win.pbjs,{adUnits:[{code:'P1'}],timeout:500,bidsBackHandler(){if(dispatch)gate.dispatch({},[slot]);}});clock.tick(0);};
 const complete=(rows=[{adId:'first',bidderCode:'a',cpm:2,ttl:55}])=>{
  const r=requests.at(-1);for(const[fn,type]of events)if(type==='auctionInit')fn({auctionId:r.auctionId});
  current=rows.map(b=>({...b,responseTimestamp:time,adUnitCode:'P1',auctionId:r.auctionId}));r.bidsBackHandler({P1:{bids:current}},false,r.auctionId);clock.tick(0);
 };
 return{clock,gate,pb,win,slot,requests,sent,consent,request,complete,setAlive:v=>alive=v,setTarget:fn=>pb.getAdserverTargetingForAdUnitCode=fn,failNextDispatch:()=>throwDispatch=true};
}

test('T06 before/after: cached expired winner is removed; all-expired display triggers exactly one fresh auction',()=>{
 for(const version of['old','fixed']){
  const f=fixture(version);f.consent();f.request();f.complete();f.clock.tick(90000);f.gate.dispatch({},[f.slot]);f.clock.tick(0);
  if(version==='old'){assert.equal(f.requests.length,1);assert.equal(f.sent[0][0].hb_adid,'first');}
  else{assert.equal(f.requests.length,2);assert.equal(f.sent.length,0);f.complete([{adId:'fresh',bidderCode:'a',cpm:1,ttl:55}]);assert.equal(f.sent.length,1);assert.equal(f.sent[0][0].hb_adid,'fresh');}
 }
});

test('T06 mixed TTL: only the still valid lower bid and bidder-specific values reach GAM without another auction',()=>{
 const f=fixture();f.consent();f.request();f.complete([{adId:'expired-a',bidderCode:'a',cpm:2,ttl:30},{adId:'valid-b',bidderCode:'b',cpm:1,ttl:360}]);f.clock.tick(45000);
 f.gate.dispatch({},[f.slot]);f.clock.tick(0);assert.equal(f.requests.length,1);assert.equal(f.sent.length,1);const t=f.sent[0][0];assert.equal(t.hb_adid,'valid-b');assert.equal(t.hb_pb,'1');assert.equal(t.hb_adid_a,undefined);assert.equal(t.hb_pb_a,undefined);assert.equal(t.hb_adid_b,'valid-b');
});

test('T06 every Send All Bids identity must be current and valid; an unknown secondary identity is never dispatched',()=>{
 const f=fixture();f.consent();f.request();f.complete();f.setTarget(()=>({hb_adid:'first',hb_pb:'2',hb_adid_foreign:'other-auction',hb_pb_foreign:'9'}));
 f.gate.dispatch({},[f.slot]);f.clock.tick(0);assert.equal(f.requests.length,2);f.complete([{adId:'second',bidderCode:'a',cpm:1,ttl:55}]);assert.equal(f.sent.length,1);assert(!Object.keys(f.sent[0][0]).some(k=>k.startsWith('hb_')));
});

test('T06 no-bid and changed-consent records never trigger a replacement auction',()=>{
 const noBid=fixture();noBid.consent();noBid.request();noBid.complete([]);noBid.clock.tick(310000);noBid.gate.dispatch({},[noBid.slot]);noBid.clock.tick(0);assert.equal(noBid.requests.length,1);assert.equal(noBid.sent.length,1);
 const changed=fixture();changed.consent({gdprApplies:true,tcString:'one'});changed.request();changed.complete();changed.clock.tick(90000);changed.consent({gdprApplies:true,eventStatus:'cmpuishown'});changed.gate.dispatch({},[changed.slot]);changed.clock.tick(10000);assert.equal(changed.requests.length,1);assert.equal(changed.sent.length,0);changed.consent({gdprApplies:true,tcString:'two'});changed.clock.tick(0);assert.equal(changed.requests.length,1);assert.equal(changed.sent.length,1);assert(!Object.keys(changed.sent[0][0]).some(k=>k.startsWith('hb_')));
});

test('T06 refresh is bounded even if replacement returns no bids or its slot is removed',()=>{
 for(const removed of[false,true]){
  const f=fixture();f.consent();f.request();f.complete();f.clock.tick(90000);f.gate.dispatch({},[f.slot]);f.gate.dispatch({},[f.slot]);f.clock.tick(0);assert.equal(f.requests.length,2);
  if(removed)f.setAlive(false);f.complete([]);assert.equal(f.sent.length,removed?0:1);assert.equal(f.requests.length,2);
 }
});

test('T06 unknown expiry metadata is not treated as an infinitely valid bid',()=>{
 const f=fixture();f.consent();f.request();f.complete([{adId:'unknown-ttl',bidderCode:'a',cpm:9}]);f.setTarget(()=>({hb_adid:'unknown-ttl',hb_pb:'9'}));f.gate.dispatch({},[f.slot]);f.clock.tick(0);
 assert.equal(f.requests.length,1);assert.equal(f.sent.length,1);assert(!Object.keys(f.sent[0][0]).some(k=>k.startsWith('hb_')));
});

test('a transient native dispatch exception releases the coalescing lock for an explicit retry',()=>{
 for(const version of['old','fixed']){
  const f=fixture(version);f.consent();f.request();f.complete();f.failNextDispatch();f.gate.dispatch({},[f.slot]);assert.throws(()=>f.clock.tick(0),/transient native dispatch/);
  f.gate.dispatch({},[f.slot]);f.clock.tick(0);assert.equal(f.sent.length,1);assert.equal(f.sent[0][0].hb_adid,'first');assert.equal(f.requests.length,1);
 }
});

test('T24 B8: concurrent and later calls share one page deadline; late Prebid is used immediately when available',()=>{
 const f=fixture('fixed',{loaded:false});f.consent();let fallback=0,ready=0;f.gate.prebid(()=>ready++,()=>fallback++);f.clock.tick(1000);f.gate.prebid(()=>ready++,()=>fallback++);f.clock.tick(1999);assert.equal(fallback,0);f.clock.tick(1);assert.equal(fallback,2);
 f.gate.prebid(()=>ready++,()=>fallback++);assert.equal(fallback,3);f.win.pbjs=f.pb;f.gate.prebid(()=>ready++,()=>fallback++);assert.equal(ready,1);assert.equal(fallback,3);
 assert.equal(f.gate.snapshot().events.filter(e=>e.phase==='prebid-unavailable').length,1);
});

test('pending CMP remains authoritative through a delayed TTL replacement and old callbacks cannot leak',()=>{
 const f=fixture();f.consent();f.request();f.complete();f.clock.tick(90000);f.gate.dispatch({},[f.slot]);f.clock.tick(0);const old=f.requests.at(-1);
 f.consent({gdprApplies:true,eventStatus:'cmpuishown'});f.clock.tick(30000);assert.equal(f.sent.length,0);
 f.complete([{adId:'late-canceled',bidderCode:'a',cpm:9,ttl:300}]);f.consent({gdprApplies:true,tcString:'rejected',purpose:{consents:{}},vendor:{consents:{}}});f.clock.tick(0);
 assert.equal(f.sent.length,1);assert(!Object.keys(f.sent[0][0]).some(k=>k.startsWith('hb_')));old.bidsBackHandler({},false,old.auctionId);f.clock.tick(0);assert.equal(f.sent.length,1);
});
