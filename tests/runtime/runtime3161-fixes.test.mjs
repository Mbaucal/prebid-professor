import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from 'acorn';
import {fixture, configure, takeOver} from './artifact-fixture.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {descriptor as previousDescriptor} from '../../.generated/runtime-316-manifest.mjs';
import {previewInput as previousInput} from '../../worker/runtime-316/snapshot.mjs';
import {previewInput} from '../../worker/runtime-3161/snapshot.mjs';
import {compileRuntime316} from '../../worker/runtime-316/compiler.mjs';
import {compileRuntime3161, idempotentStickyStyles} from '../../worker/runtime-3161/compiler.mjs';
import {installSharedStickyStyles, stickyStyles} from '../../worker/runtime/artifact-styles.mjs';
import {finalizeJavaScript} from '../../worker/runtime/artifact-minifier.mjs';
import {applyOutstreamUnit as previousOutstream, outstreamPlayerSize} from '../../worker/runtime-outstream-v2/browser-functions.mjs';

const descriptor={...previousDescriptor,id:'tessera-3.16.1',version:'3.16.1'};
const stamp='20261024_120000';
function walk(node,visit){if(!node||typeof node!=='object')return;visit(node);for(const x of Object.values(node))if(Array.isArray(x))x.forEach(v=>walk(v,visit));else if(x&&typeof x==='object')walk(x,visit);}
function fn(source,name){const nodes=[];walk(parse(source,{ecmaVersion:'latest'}),n=>{if(n.type==='FunctionDeclaration'&&n.id?.name===name)nodes.push(n);});assert.equal(nodes.length,1,name);return source.slice(nodes[0].start,nodes[0].end);}
function sources(snapshot=fixture(),overlay=takeOver()){
 const oldInput=previousInput(snapshot,previousDescriptor,stamp,overlay),nextInput=previewInput(snapshot,descriptor,stamp,overlay);
 return [compileRuntime316(oldInput).adsJs,compileRuntime3161(nextInput).adsJs];
}
const [before,after]=sources();
function clock(){let time=1000000,next=0;const timers=new Map();return{timers,now:()=>time,setTimeout(f,ms){timers.set(++next,{f,at:time+ms});return next;},clearTimeout(i){timers.delete(i);},tick(ms){const end=time+ms;for(let i=0;i<10000;i++){const due=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;time=due[1].at;timers.delete(due[0]);due[1].f();}time=end;}};}
function context(source,name,globals){const ctx=vm.createContext(globals);vm.runInContext(fn(source,name),ctx);return ctx;}

test('T01: effective content rules enable the scheduler even when only a position overrides disabled Default',()=>{
 for(const rules of [[],[{rule_key:'__DEFAULT__',rule_json:'{"timeout":900}'}],
  [{rule_key:'__BTF__',rule_json:'{"refresh":{"enabled":true}}'}],
  [{rule_key:'__DEFAULT__',rule_json:'{"refresh":{"enabled":false}}'},{rule_key:'P1',rule_json:'{"refresh":{"enabled":true}}'}]]){
  const snapshot=fixture();snapshot.rules=rules;
  assert.equal(previousInput(snapshot,previousDescriptor,stamp).core.globalRefresh.enabled,false);
  assert.equal(previewInput(snapshot,descriptor,stamp).core.globalRefresh.enabled,true);
 }
 const snapshot=fixture();snapshot.rules=[{rule_key:'__DEFAULT__',rule_json:'{"refresh":{"enabled":false}}'}];
 assert.equal(previewInput(snapshot,descriptor,stamp).core.globalRefresh.enabled,false);
});

test('T04: no-fill guard permission survives asynchronous consent gate exactly until actual dispatch',()=>{
 for(const [source,expected]of[[before,0],[after,1]]){
  const c=clock(),guard={},sent=[],state={filled:false};let ready=false;const waiters=[];
  const whenConsent=cb=>{if(ready)c.setTimeout(cb,0);else waiters.push(cb);};
  const service={refresh(slots){if(ctx.window.__TAKEOVER_ALLOW_CODELESS_FALLBACK_REQUEST===true)sent.push(slots);}};
  const ctx=context(source,'takeOverReleaseCodelessSuppression',{TAKEOVER_ACTIVE_FOR_PAGE:true,TAKEOVER_BLOCK_CODELESS:true,TAKEOVER_RELEASE_CODELESS_ON_NO_FILL:true,_takeOverCodelessReleased:false,_takeOver:state,_takeOverCodelessGuardSlot:guard,window:{},restoreTakeOverCodelessLinkBlock(){},takeOverDisplayCodelessGuard(){},takeOverEvent(){},takeOverCodelessAdUnitPath:()=>'/test/Interstitial',googletag:{cmd:{push:f=>f()},pubads:()=>service},_tesseraReady:{whenConsent,dispatch:(pa,slots)=>whenConsent(()=>pa.refresh(slots))},_gamReporting:{dispatch:(pa,slots)=>pa.refresh(slots)}});
  ctx.takeOverReleaseCodelessSuppression('empty');assert.equal(sent.length,0);
  ready=true;waiters.forEach(whenConsent);c.tick(0);
  assert.equal(sent.length,expected);assert.equal(ctx.window.__TAKEOVER_ALLOW_CODELESS_FALLBACK_REQUEST,false);
  ctx.takeOverReleaseCodelessSuppression('empty');c.tick(0);assert.equal(sent.length,expected);
  if(expected)assert.equal(state.guardStatus,'fallback-requested');
 }
});

test('T05: late discovery uses one finite retry chain and ignores stylesheet mutations',()=>{
 const c=clock(),state={started:false,ended:false,attempts:0,timer:null,debounce:null,observer:null,failed:{}},wrappers=[];let defined=0,callback,disconnects=0;
 const ctx=context(after,'scheduleDefineSlotsRetry',{AD_CONTAINER_SELECTOR:'.wrapperAd',_tesseraDiscovery:state,window:{adSlots:{}},document:{querySelectorAll:()=>wrappers,documentElement:{}},getUnitConfigById:()=>({}),setTimeout:c.setTimeout,clearTimeout:c.clearTimeout,MutationObserver:class{constructor(fn){callback=fn;}observe(){}disconnect(){disconnects++;}},defineAllSlots(){defined++;ctx.scheduleDefineSlotsRetry('still empty');}});
 ctx.scheduleDefineSlotsRetry('only sticky');for(let i=0;i<20;i++)callback();c.tick(25000);
 assert.equal(defined,10);assert.equal(state.attempts,10);assert.equal(disconnects,1);assert.equal(c.timers.size,0);
 callback();ctx.scheduleDefineSlotsRetry('too late');c.tick(25000);assert.equal(defined,10);
});

test('T11: the saved gap blocks intervening refreshes and schedules only the remaining time',()=>{
 for(const[source,expected]of[[before,3],[after,2]]){
  let time=1000000;const sent=[],states={},counts={},last={};
  const ctx=context(source,'tryRefresh',{_tesseraLastRefreshSentAt:{},_tesseraRefreshPending:{},slotHasCurrentViewportSizes:()=>true,TESSERA_OUTSTREAM:{disabledRefreshCodes:[]},pageActive:()=>true,REFRESH_EXCLUDE_IDS:[],_refreshCounts:counts,_lastRefreshAt:last,_slotState:states,_slotMeta:{},MAX_REFRESHES_PER_SLOT:20,STICKY_TARGET_ID:'Sticky',STICKY_TOP_TARGET_ID:'',_sticky:{},_stickyTop:{},window:{},log(){},now:()=>time,getAdUnitRefreshRule:()=>({enabled:true,minSeconds:30,minGapSeconds:100,maxRefreshes:20}),canRefreshSlotNow:()=>({ok:true}),scheduleRefreshGuardRetry(){},GAM_NOREFRESH_ADVERTISER_IDS:[],_gamReporting:{plan(){}},fetchBidsAndRefresh(){},enqueueRefresh(id){sent.push({id,time});}});
  const slot={setConfig(){}};ctx.tryRefresh('P1',slot,30);time+=30000;ctx.tryRefresh('P1',slot,30);
  if(source===after)assert.equal(states.P1.gapRemainingMs,70000);
  time+=70000;ctx.tryRefresh('P1',slot,30);assert.equal(sent.length,expected);
 }
});

test('T11: a delayed actual send has its own wall-clock gap independent of the attempt cadence',()=>{
 let time=1136201;const state={},sent=[];
 const ctx=context(after,'tryRefresh',{_tesseraLastRefreshSentAt:{P1:1105000},_tesseraRefreshPending:{},slotHasCurrentViewportSizes:()=>true,TESSERA_OUTSTREAM:{disabledRefreshCodes:[]},pageActive:()=>true,REFRESH_EXCLUDE_IDS:[],_refreshCounts:{P1:1},_lastRefreshAt:{P1:1030000},_slotState:state,_slotMeta:{},MAX_REFRESHES_PER_SLOT:20,STICKY_TARGET_ID:'Sticky',STICKY_TOP_TARGET_ID:'',_sticky:{},_stickyTop:{},window:{},log(){},now:()=>time,getAdUnitRefreshRule:()=>({enabled:true,minSeconds:30,minGapSeconds:100,maxRefreshes:20}),canRefreshSlotNow:()=>({ok:true}),scheduleRefreshGuardRetry(){},GAM_NOREFRESH_ADVERTISER_IDS:[],_gamReporting:{plan(){}},enqueueRefresh:()=>sent.push(time)});
 const slot={setConfig(){}};ctx.tryRefresh('P1',slot,30);assert.equal(sent.length,0);assert.equal(state.P1.gapRemainingMs,68799);
 time=1205000;ctx.tryRefresh('P1',slot,30);assert.equal(sent.length,1);
});

test('T12: Sticky follows inherited sequence rather than its initial fixed constant',()=>{
 for(const[source,expected]of[[before,[20000,40000,60000]],[after,[20000,80000,200000]]]){
  const c=clock(),state={timer:null,nextAt:0,closed:false},sent=[],counts={};
  const ctx=vm.createContext({_sticky:state,_slotState:{},STICKY_TARGET_ID:'Sticky',STICKY_REFRESH_SEC:20,window:{adSlots:{Sticky:{}}},setTimeout:c.setTimeout,clearTimeout:c.clearTimeout,now:c.now,pageActive:()=>true,getStickyHost:()=>({getBoundingClientRect:()=>({top:0,bottom:100,height:100})}),log(){},getAdUnitRefreshRule:()=>({minSeconds:[20,60,120][Math.min(counts.n||0,2)]}),tryRefresh(){sent.push(c.now()-1000000);counts.n=(counts.n||0)+1;}});
  ctx.window.innerHeight=900;
  vm.runInContext(fn(source,'clearStickyTimer')+'\n'+(source===after?fn(source,'tesseraStickyDelay'):'')+'\n'+fn(source,'scheduleStickyTimerDelay')+'\n'+fn(source,'scheduleStickyTimer'),ctx);
  ctx.scheduleStickyTimer();c.tick(source===after?200000:60000);assert.deepEqual(sent,expected);
 }
});

test('T13: only empty, open Sticky bypasses view percentage; filled and disabled rules still apply',()=>{
 for(const[source,emptyExpected]of[[before,false],[after,true]]){
  let filled=false;const rule={enabled:true,minViewPct:70,requirePreviousViewable:false};
  const ctx=context(source,'canRefreshSlotNow',{getAdUnitRefreshRule:()=>rule,_slotState:{Sticky:{}},getSlotViewPct:()=>60,document:{getElementById:()=>({classList:{contains:()=>filled}})},STICKY_TARGET_ID:'Sticky',STICKY_TOP_TARGET_ID:'',_sticky:{closed:false},_stickyTop:{}});
  assert.equal(ctx.canRefreshSlotNow('Sticky').ok,emptyExpected);filled=true;assert.equal(ctx.canRefreshSlotNow('Sticky').ok,false);
  rule.enabled=false;filled=false;assert.equal(ctx.canRefreshSlotNow('Sticky').ok,false);
 }
});

test('T14: a second pause preserves the first remaining dwell deadline',()=>{
 for(const[source,expected]of[[before,null],[after,20000]]){
  const state={P1:{dwellTimer:1,dwellDeadline:30000,dwellRemainingMs:null}};
  const ctx=context(source,'clearDwell',{_slotState:state,clearTimeout(){},now:()=>10000});
  ctx.clearDwell('P1',true);ctx.clearDwell('P1',true);assert.equal(state.P1.dwellRemainingMs,expected);
 }
});

test('T15: late keyword polling reaches later values without changing already selected size maps',()=>{
 for(const[source,expected]of[[before,0],[after,1]]){
  const c=clock(),merged=[],target={},win={};const ctx=vm.createContext({window:win,ADS_KEYWORDS:{},PAGE_TYPE:'',PAGE_TYPE_KEYS:['pageType'],setTimeout:c.setTimeout,googletag:{cmd:{push:f=>f()}},mergeKV:v=>merged.push(v),setKV:(k,v)=>target[k]=v,log(){}});
  if(source===after)vm.runInContext(fn(source,'computePageTypePrefixes'),ctx);
  vm.runInContext(fn(source,'lateMergeTargeting'),ctx);ctx.lateMergeTargeting(2500,250);c.tick(400);win.adsKeywords={category:'sport',pageType:'article'};c.tick(500);
  assert.equal(merged.filter(v=>v.category==='sport').length,expected);if(expected)assert.equal(target.page_type,'article');
 }
});

test('T22: replacement-sensitive SChain values survive exactly without mutating the saved input',()=>{
 for(const value of['s$&t','X$$Y',"r$'q",'n$`m','a$$$&b','Ca$h',"literal .setProperty('zIndex'"]){
  const snapshot=configure(fixture(),c=>c.runtimeControls.schain={enabled:true,version:'1.0',complete:1,nodes:[{asi:'seller.test',sid:value,hp:1}]});
  const input=previewInput(snapshot,descriptor,stamp),saved=structuredClone(input),source=compileRuntime3161(input).adsJs;
  assert.deepEqual(input,saved);let ortb;
  walk(parse(source,{ecmaVersion:'latest'}),node=>{if(node.type==='Property'&&node.key.name==='ortb2')ortb=node.value;});
  assert(ortb);const config=vm.runInNewContext('('+source.slice(ortb.start,ortb.end)+')');assert.equal(config.source.schain.nodes[0].sid,value);
 }
});

test('T19: CSS call fixes leave CSS-looking bidder data unchanged',()=>{
 const value="literal .setProperty('zIndex'",snapshot=fixture();snapshot.bidders[0].params_json=JSON.stringify({siteId:'test',description:value});
 const source=compileRuntime3161(previewInput(snapshot,descriptor,stamp)).adsJs;let data=0,invalidCalls=0;
 walk(parse(source,{ecmaVersion:'latest'}),node=>{
  if(node.type==='Literal'&&node.value===value)data++;
  if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&node.callee.property.name==='setProperty'&&/[A-Z]/.test(node.arguments[0]?.value??''))invalidCalls++;
 });
 assert.equal(data,1);assert.equal(invalidCalls,0);
});

test('T23: crossing an empty TakeOver breakpoint while waiting skips it and releases fallback',()=>{
 for(const[source,throws]of[[before,true],[after,false]]){
  const state={},events=[];const ctx=context(source,'initTakeOver',{TAKEOVER_ACTIVE_FOR_PAGE:true,_takeOver:state,window:{top:1,self:1,innerWidth:800},document:{body:{}},takeOverDeviceConfig:()=>null,takeOverEvent:(name)=>events.push(name),takeOverReleaseCodelessSuppression:()=>events.push('fallback'),takeOverBuildDom(){},googletag:{cmd:{push(){}}}});
  if(throws)assert.throws(()=>ctx.initTakeOver(),/device/);else{ctx.initTakeOver();assert.equal(state.status,'skipped-viewport');assert.deepEqual(events,['skipped-viewport','fallback']);}
 }
});

test('T20: one render reads response information once and retains identical diagnostic metadata',()=>{
 for(const[source,expected]of[[before,2],[after,1]]){
  let reads=0;const handlers={},states={},service={addEventListener:(name,callback)=>handlers[name]=callback};
  const slot={getSlotElementId:()=> 'P1',getResponseInformation(){reads++;return{advertiserId:7};},getTargetingKeys:()=>[],getTargeting:()=>[]};
  const tag={cmd:{push:fn=>fn()},pubads:()=>service};const ctx=context(source,'installAdopsViewabilityTracking',{window:{googletag:tag,scrollY:0},googletag:tag,_slotState:states,getSlotViewPct:()=>100});
  ctx.installAdopsViewabilityTracking();handlers.slotRenderEnded({slot,isEmpty:false,size:[300,250]});assert.equal(reads,expected);assert.equal(states.P1.lastResponseInfo.advertiserId,7);
 }
});

test('T25: ES2015 Outstream helper preserves mixed formats, partner parameters and own data properties',()=>{
 const settings={format:'banner-outstream',playerSize:[300,250],minDuration:5,maxDuration:30,playbackMethod:6,placement:3,plcmt:2,partner:{bidder:'pubmatic',outstreamAU:'renderer'}};
 const unit={code:'P1',mediaTypes:{banner:{sizes:[[300,250]]}},bids:[{bidder:'pubmatic',params:JSON.parse('{"publisherId":"1","__proto__":{"safe":"own-data"}}')},{bidder:'ix',params:{siteId:'2'}}]};
 const ctx=context(after,'applyOutstreamUnit',{outstreamPlayerSize});const next=ctx.applyOutstreamUnit(unit,settings,'display'),old=previousOutstream(unit,settings,'display');
 assert.deepEqual(JSON.parse(JSON.stringify(next)),old);assert.equal(Object.hasOwn(next.bids[0].params,'__proto__'),true);assert.equal(next.bids[0].params.safe,undefined);
 parse(fn(after,'applyOutstreamUnit'),{ecmaVersion:2015});
});

test('all normal modes and overlay/lazy variants generate parser-equivalent readable and minified code',async()=>{
 for(const snapshot of[fixture(),configure(fixture(),c=>c.enablePrebid=false),positionFixture(true),positionFixture(false)]){
  const beforeSnapshot=structuredClone(snapshot),input=previewInput(snapshot,descriptor,stamp),generated=compileRuntime3161(input);
  const styled=idempotentStickyStyles(installSharedStickyStyles(generated.adsJs,stickyStyles(input.options.sticky.bottomAdUnitId)));
  const out=await finalizeJavaScript(styled);new vm.Script(out.adsJs);new vm.Script(out.adsMinJs);
  parse(out.adsJs,{ecmaVersion:2015});parse(out.adsMinJs,{ecmaVersion:2015});
  assert.deepEqual(snapshot,beforeSnapshot);assert(!/\.setProperty\(['"][a-z]+[A-Z]/.test(out.adsJs));
 }
});
