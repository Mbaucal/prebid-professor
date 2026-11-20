import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parse} from 'acorn';
import {compileRuntime325} from '../../worker/runtime-325/compiler.mjs';
import {previewInput} from '../../worker/runtime-325/snapshot.mjs';
import {runtime324Site} from './runtime324-site.mjs';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
import {createTesseraRequestMetrics} from '../../worker/runtime-325/browser-request-metrics.mjs';

function helper(source,name) {
  let found;
  (function walk(node){if(!node||typeof node!=='object')return;if(node.type==='FunctionDeclaration'&&node.id?.name===name){assert.equal(found,undefined);found=node;}for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);})(parse(source,{ecmaVersion:2015}));
  assert(found,name);return source.slice(found.start,found.end);
}
test('new readiness reporting hook failures cannot stop inherited consent, auction callback or GAM dispatch',()=>{
  const descriptor=runtimeReleaseHistory.find(row=>row.version==='3.24.0');
  const generated=compileRuntime325(previewInput(runtime324Site(),descriptor,'20261117_010000')).adsJs;
  const create=vm.runInNewContext('('+helper(generated,'createTesseraReadiness')+')');
  const queue=[],listeners={};let called=0,requests=0,nativeCalls=0,reportOnlyReads=0;
  const win={setTimeout(fn,delay){const timer={fn,delay};queue.push(timer);return timer;},clearTimeout(timer){if(timer)timer.dead=true;},
    __tcfapi(_name,_version,accept){accept({gdprApplies:false},true);}};
  const pb=win.pbjs={setConfig(){},onEvent(name,fn){listeners[name]=fn;},offEvent(name){delete listeners[name];},getAdserverTargetingForAdUnitCode(){return{};},requestBids(input){requests++;listeners.auctionInit({auctionId:input.auctionId});input.bidsBackHandler({P1:{bids:[{auctionId:input.auctionId,adUnitCode:'P1',adId:'id',cpm:2,ttl:60,responseTimestamp:Date.now(),get bidderCode(){reportOnlyReads++;throw Error('report-only field failed');}}]}},false,input.auctionId);}};
  const actual=createTesseraRequestMetrics(win,{});actual.consent(true,1);
  const metrics={enter(){throw Error('enter failed');},consent(){throw Error('consent failed');},auction:actual.auction};
  const ready=create(win,{requestMetrics:metrics,rawRequest(instance,input){return instance.requestBids(input);},clear(){},apply(){},code:()=> 'P1',rawDispatch(){nativeCalls++;}});
  ready.request(pb,{adUnits:[{code:'P1'}],bidsBackHandler(){called++;ready.dispatch({},[{}],{});}});
  for(let pass=0;pass<20;pass++){const timer=queue.find(item=>!item.dead&&item.delay===0);if(!timer)break;timer.dead=true;timer.fn();}
  assert.equal(requests,1);assert.equal(called,1);assert.equal(nativeCalls,1);assert.equal(reportOnlyReads,1);
});
test('the emitted deadline adapter preserves the existing maximum/fallback budget and logical TakeOver code',()=>{
  const descriptor=runtimeReleaseHistory.find(row=>row.version==='3.24.0');
  const generated=compileRuntime325(previewInput(runtime324Site(),descriptor,'20261117_010000')).adsJs;
  let config;
  (function walk(node){if(!node||typeof node!=='object')return;if(node.type==='VariableDeclarator'&&node.id?.name==='_gamReporting')config=node.init.arguments[0];for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);})(parse(generated,{ecmaVersion:2015}));
  assert(config);
  const overlay={getSlotElementId:()=> 'adsx-takeover-slot'},rules={P1:{cmpTimeout:800},Overlay:{cmpTimeout:2500}};
  const units={P1:{bids:[{bidder:'pm_ag'}]},Overlay:{bids:[{bidder:'pm_ag'}]},Fluid:null,NoParams:{bids:[]}};
  const context={_takeOverSlot:overlay,_takeOverCodelessGuardSlot:null,TESSERA_OVERLAY:{code:'Overlay',demand:'site'},window:{adSlots:{}},getAdUnitRuntimeRule:code=>rules[code]||{},HAS_PREBID:true,BIDDERS:[{bidder:'pm_ag'}],adUnitFromCode:code=>units[code]};
  const script=helper(generated,'getConsentTimeoutForSlots')+';('+generated.slice(config.start,config.end)+')';
  const emitted=vm.runInNewContext(script,context);
  assert.equal(emitted.code(overlay),'Overlay');
  assert.equal(emitted.consentDeadline(['P1',emitted.code(overlay)]),2500);
  assert.equal(emitted.consentDeadline(['P1']),800);
  assert.equal(emitted.consentDeadline(['Unknown']),1500);
  assert.equal(emitted.reportingPrebid(emitted.code(overlay)),true);
  assert.equal(emitted.reportingPrebid('P1'),true);
  assert.equal(emitted.reportingPrebid('Fluid'),false);
  assert.equal(emitted.reportingPrebid('NoParams'),false);
  context.BIDDERS=[];
  assert.equal(emitted.prebid(overlay),true,'The inherited refresh/reporting predicate remains unchanged');
  assert.equal(emitted.reportingPrebid('Overlay'),false,'Origin uses its separate configured-demand predicate');
});
test('reporter failures before/after native GPT preserve actual calls and original native exceptions',async()=>{
  const source=(await readFile(new URL('../../worker/runtime-325/browser-reporting.mjs',import.meta.url),'utf8')).replace('export function','function');
  for(const phase of ['before','commit','rollback']){
    const metrics={before(){if(phase==='before')throw Error('measurement before');return{};},commit(){if(phase==='commit')throw Error('measurement commit');},rollback(){if(phase==='rollback')throw Error('measurement rollback');}};
    const make=vm.runInNewContext(source+';createGamReporting',{window:{},createTesseraRequestMetrics:()=>metrics});
    const slot={getSlotElementId:()=> 'P1',setConfig(){}};
    const reporter=make({owns:()=>true,code:()=> 'P1',prebid:()=>false});let calls=0;const nativeError=new Error('native GPT failed');
    const native=()=>{calls++;if(phase==='rollback')throw nativeError;return 'sent';};
    if(phase==='rollback')assert.throws(()=>reporter.send(native,{},[slot]),error=>error===nativeError);
    else assert.equal(reporter.send(native,{},[slot]),'sent');
    assert.equal(calls,1,phase);
  }
});
test('the compiled ready callback records a new pending gate if consent is revoked before its timer runs',()=>{
  const descriptor=runtimeReleaseHistory.find(row=>row.version==='3.24.0');
  const generated=compileRuntime325(previewInput(runtime324Site(),descriptor,'20261117_010000')).adsJs;
  const create=vm.runInNewContext('('+helper(generated,'createTesseraReadiness')+')');
  const timers=[],page={};let clock=0,accept,nativeCalls=0;
  const win={performance:{now:()=>clock},googletag:{setConfig({targeting}){for(const[key,value]of Object.entries(targeting))if(value===null)delete page[key];else page[key]=value;}},
    setTimeout(fn,delay){const timer={fn,delay};timers.push(timer);return timer;},clearTimeout(timer){if(timer)timer.dead=true;},
    __tcfapi(_name,_version,callback){accept=callback;callback({gdprApplies:false},true);}};
  const metrics=createTesseraRequestMetrics(win,{prebid:()=>false,code:slot=>slot.code,consentDeadline:()=>1000});
  const ready=create(win,{requestMetrics:metrics,clear(){},apply(){},code:slot=>slot.code,
    rawDispatch(service,slots){const token=metrics.before(service,slots);nativeCalls++;metrics.commit(token);}});
  ready.dispatch({},[{code:'P1',setConfig(){}}]);
  clock=10;accept({gdprApplies:true,cmpStatus:'loading'},true);
  clock=20;timers.shift().fn();assert.equal(nativeCalls,0);
  clock=2020;accept({gdprApplies:false},true);assert.equal(nativeCalls,0,'CMP event queues the same existing consent callback');
  timers.shift().fn();assert.equal(nativeCalls,1);assert.equal(page.aq_consent_wait,'timeout');assert.equal(page.aq_first_request,'2000_2999');
});
test('a rapid revoke and ready decision before the queued callback remains gated and reports an immediate wait',()=>{
  const descriptor=runtimeReleaseHistory.find(row=>row.version==='3.24.0');
  const generated=compileRuntime325(previewInput(runtime324Site(),descriptor,'20261117_010000')).adsJs;
  const create=vm.runInNewContext('('+helper(generated,'createTesseraReadiness')+')');
  const timers=[],page={};let clock=0,accept,nativeCalls=0;
  const win={performance:{now:()=>clock},googletag:{setConfig({targeting}){for(const[key,value]of Object.entries(targeting))if(value===null)delete page[key];else page[key]=value;}},
    setTimeout(fn,delay){const timer={fn,delay};timers.push(timer);return timer;},clearTimeout(timer){if(timer)timer.dead=true;},
    __tcfapi(_name,_version,callback){accept=callback;callback({gdprApplies:false},true);}};
  const metrics=createTesseraRequestMetrics(win,{prebid:()=>false,code:slot=>slot.code,consentDeadline:()=>1000});
  const ready=create(win,{requestMetrics:metrics,clear(){},apply(){},code:slot=>slot.code,
    rawDispatch(service,slots){const token=metrics.before(service,slots);nativeCalls++;metrics.commit(token);}});
  ready.dispatch({},[{code:'P1',setConfig(){}}]);clock=10;accept({gdprApplies:true,cmpStatus:'loading'},true);
  clock=15;accept({gdprApplies:false},true);assert.equal(nativeCalls,0);
  clock=20;timers.shift().fn();assert.equal(nativeCalls,1);assert.equal(page.aq_consent_wait,'lt_500');
});
