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
  const context={_takeOverSlot:overlay,_takeOverCodelessGuardSlot:null,TESSERA_OVERLAY:{code:'Overlay'},window:{adSlots:{}},getAdUnitRuntimeRule:code=>rules[code]||{}};
  const script=helper(generated,'getConsentTimeoutForSlots')+';('+generated.slice(config.start,config.end)+')';
  const emitted=vm.runInNewContext(script,context);
  assert.equal(emitted.code(overlay),'Overlay');
  assert.equal(emitted.consentDeadline(['P1',emitted.code(overlay)]),2500);
  assert.equal(emitted.consentDeadline(['P1']),800);
  assert.equal(emitted.consentDeadline(['Unknown']),1500);
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
