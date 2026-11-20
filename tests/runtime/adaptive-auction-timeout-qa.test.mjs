/** Independent MBA-402 contract checks. Local signals and native event objects only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=resolve(process.env.ADAPTIVE_TIMEOUT_QA_ROOT??fileURLToPath(new URL('../..',import.meta.url)));
const {createAdaptiveAuctionTimeout}=await import(pathToFileURL(resolve(root,'worker/runtime-326/browser-auction-timeout.mjs')).href);
const {normalizeAdaptiveTimeout,requireAdaptiveTimeoutRuntime}=await import(pathToFileURL(resolve(root,'shared/auction-timeout/settings.mjs')).href);
const policy=(extra={})=>({enabled:true,minMs:800,maxMs:4000,mobileAdjustmentMs:0,slowConnectionAdjustmentMs:0,
  videoAdjustmentMs:0,additionalPositionMs:0,maxPositionAdjustmentMs:0,...extra});
const input=(count=1,video=false)=>({adUnits:Array.from({length:count},(_,i)=>({code:'P'+i,
  mediaTypes:video&&i===0?{video:{context:'outstream'}}:{banner:{sizes:[[300,250]]}}}))});
const mobileSlow=()=>({innerWidth:390,navigator:{userAgent:'Mozilla/5.0 (Linux; Android 14) Mobile',
  userAgentData:{mobile:true},connection:{effectiveType:'2g'}},matchMedia:()=>({matches:true})});

test('QA: disabled policy preserves a valid saved timeout outside the adaptive bounds',()=>{
  const helper=createAdaptiveAuctionTimeout({},policy({enabled:false}));
  assert.equal(helper.resolve(input(),500).timeoutMs,500);
  assert.equal(helper.resolve(input(),5000).timeoutMs,5000);
});

test('QA: enabled local selection enforces both bounds, including shortening a larger saved timeout',()=>{
  const helper=createAdaptiveAuctionTimeout({},policy());
  for(const [base,expected]of [[100,800],[800,800],[1700,1700],[4000,4000],[30000,4000]])
    assert.equal(helper.resolve(input(),base).timeoutMs,expected,String(base));
});

test('QA: mobile, slow connection, video and additional logical positions affect the same request',()=>{
  const helper=createAdaptiveAuctionTimeout(mobileSlow(),policy({mobileAdjustmentMs:200,slowConnectionAdjustmentMs:500,
    videoAdjustmentMs:300,additionalPositionMs:100,maxPositionAdjustmentMs:500}));
  assert.equal(helper.resolve(input(1),1000).timeoutMs,1700);
  assert.equal(helper.resolve(input(2),1000).timeoutMs,1800);
  assert.equal(helper.resolve(input(2,true),1000).timeoutMs,2100);
  assert.equal(helper.resolve(input(20,true),1000).timeoutMs,2500,'Position adjustment has a finite cap');
});

test('QA: absent context retains the bounded saved timeout and explains the fallback',()=>{
  const helper=createAdaptiveAuctionTimeout({},policy({mobileAdjustmentMs:200,slowConnectionAdjustmentMs:500}));
  const selected=helper.resolve(input(),1400);
  assert.equal(selected.timeoutMs,1400);
  assert.equal(Array.isArray(selected.reasons),true);assert(selected.reasons.length>0);
});

test('QA: effective native RTD extension controls the outer deadline even beyond local max',()=>{
  const helper=createAdaptiveAuctionTimeout({},policy({maxMs:1200}));
  const selected=helper.resolve(input(),1000),native=helper.started(selected,{timeout:1800});
  assert.equal(selected.timeoutMs,1000);assert.equal(native.actualMs,1800);assert.equal(native.failsafeMs,2300);
});

test('QA: native shortening controls its deadline without changing another concurrent selection',()=>{
  const helper=createAdaptiveAuctionTimeout({},policy());
  const first=helper.resolve(input(),3000),second=helper.resolve(input(2),1200);
  const b=helper.started(second,{timeout:2000}),a=helper.started(first,{timeout:600});
  assert.equal(a.actualMs,600);assert.equal(a.failsafeMs,1100);
  assert.equal(b.actualMs,2000);assert.equal(b.failsafeMs,2500);
  assert.equal(first.timeoutMs,3000);assert.equal(second.timeoutMs,1200);
});

test('QA: invalid native timeouts cannot create an immediate or unbounded watchdog',()=>{
  const helper=createAdaptiveAuctionTimeout({},policy());
  for(const timeout of [undefined,null,0,-1,Infinity,NaN,30001,'1800',{},[]]){
    const native=helper.started(helper.resolve(input(),1400),{timeout});
    assert.equal(native.actualMs,1400,JSON.stringify(timeout));assert.equal(native.failsafeMs,1900);
  }
  for(const timeout of [1,30000])assert.equal(helper.started(helper.resolve(input(),1400),{timeout}).actualMs,timeout);
});

test('QA: local selection never mutates the caller ad units or navigator objects',()=>{
  const win=mobileSlow(),request=input(2,true),before=structuredClone(request),signals=JSON.stringify(win.navigator);
  Object.freeze(request.adUnits[0].mediaTypes);Object.freeze(request.adUnits[0]);Object.freeze(request.adUnits);
  Object.freeze(request);Object.freeze(win.navigator.connection);Object.freeze(win.navigator);
  const helper=createAdaptiveAuctionTimeout(win,policy({mobileAdjustmentMs:200,slowConnectionAdjustmentMs:500}));
  const selected=helper.resolve(request,1400);helper.started(selected,{timeout:2000});
  assert.deepEqual(request,before);assert.equal(JSON.stringify(win.navigator),signals);
});

test('QA: missing and throwing browser signal APIs never prevent a bounded auction',()=>{
  for(const win of [{}, {get navigator(){throw Error('blocked navigator');}},
    {navigator:{get userAgentData(){throw Error('blocked UA');},get connection(){throw Error('blocked connection');}}},
    {innerWidth:390,matchMedia(){throw Error('blocked media query');},navigator:{}}]){
    const selected=createAdaptiveAuctionTimeout(win,policy({mobileAdjustmentMs:200,slowConnectionAdjustmentMs:500})).resolve(input(),1400);
    assert.equal(selected.timeoutMs,1400);assert(selected.reasons.some(reason=>reason.includes('fallback')));
  }
});

test('QA: repeated positions are counted once and codes-only requests remain supported',()=>{
  const helper=createAdaptiveAuctionTimeout({},policy({additionalPositionMs:100,maxPositionAdjustmentMs:500}));
  const repeated=input(2);repeated.adUnits.push(repeated.adUnits[0]);
  assert.equal(helper.resolve(repeated,1000).timeoutMs,1100);
  assert.equal(helper.resolve({adUnitCodes:['P1','P2']},1000).timeoutMs,1100);
});

test('QA: a later connection change affects only a later request',()=>{
  const win=mobileSlow(),helper=createAdaptiveAuctionTimeout(win,policy({slowConnectionAdjustmentMs:500}));
  const slow=helper.resolve(input(),1400);win.navigator.connection.effectiveType='4g';
  const fast=helper.resolve(input(),1400);
  assert.equal(slow.timeoutMs,1900);assert.equal(fast.timeoutMs,1400);
  helper.started(fast,{timeout:fast.timeoutMs});helper.started(slow,{timeout:slow.timeoutMs});
  assert.equal(slow.failsafeMs,2400);assert.equal(fast.failsafeMs,1900);
});

test('QA: diagnostics retain only the last50 requests and cannot be changed through a snapshot',()=>{
  const helper=createAdaptiveAuctionTimeout({},policy());
  for(let n=0;n<75;n++)helper.started(helper.resolve({adUnitCodes:['P'+n]},1400),{timeout:1400});
  const before=helper.snapshot();assert.equal(before.auctions.length,50);
  assert.deepEqual(before.auctions[0].codes,['P25']);assert.deepEqual(before.auctions.at(-1).codes,['P74']);
  before.auctions[0].codes.push('forged');before.auctions[0].reasons.push('forged');before.auctions[0].timeoutMs=1;
  before.auctions.pop();
  const after=helper.snapshot();assert.equal(after.auctions.length,50);
  assert.deepEqual(after.auctions[0].codes,['P25']);assert(!after.auctions[0].reasons.includes('forged'));
  assert.equal(after.auctions[0].timeoutMs,1400);
});

test('QA: saved policy defaults are OFF, detached and reject remote/unknown or unbounded settings',()=>{
  const first=normalizeAdaptiveTimeout();assert.equal(first.enabled,false);
  first.enabled=true;assert.equal(normalizeAdaptiveTimeout().enabled,false);
  for(const setting of [{enabled:'true'},{enabled:true,minMs:99},{enabled:true,maxMs:10001},
    {enabled:true,minMs:4000,maxMs:800},{mobileAdjustmentMs:-1},{additionalPositionMs:0.1},
    {enabled:true,endpoint:'https://remote.invalid/policy'},JSON.parse('{"__proto__":{}}')])
    assert.throws(()=>normalizeAdaptiveTimeout(setting));
});

test('QA: an enabled policy cannot silently run on a saved older runtime',()=>{
  const old={id:'tessera-3.25.1',version:'3.25.1',capabilities:[]};
  assert.throws(()=>requireAdaptiveTimeoutRuntime({adaptiveAuctionTimeout:{enabled:true}},old),/3\.26\.0/);
  assert.doesNotThrow(()=>requireAdaptiveTimeoutRuntime({},old));
  assert.doesNotThrow(()=>requireAdaptiveTimeoutRuntime({adaptiveAuctionTimeout:{enabled:false}},old));
  assert.doesNotThrow(()=>requireAdaptiveTimeoutRuntime({adaptiveAuctionTimeout:{enabled:true}},
    {id:'tessera-3.26.0',version:'3.26.0',capabilities:['adaptive-auction-timeout']}));
});
