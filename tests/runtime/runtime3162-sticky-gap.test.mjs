import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from 'acorn';
import {fixture, configure, takeOver} from './artifact-fixture.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {descriptor as previousDescriptor} from '../../.generated/runtime-316-manifest.mjs';
import {previewInput} from '../../worker/runtime-3162/snapshot.mjs';
import {compileRuntime3161} from '../../worker/runtime-3161/compiler.mjs';
import {compileRuntime3162, idempotentStickyStyles} from '../../worker/runtime-3162/compiler.mjs';
import {installSharedStickyStyles, stickyStyles} from '../../worker/runtime/artifact-styles.mjs';
import {finalizeJavaScript} from '../../worker/runtime/artifact-minifier.mjs';

const descriptor={...previousDescriptor,id:'tessera-3.16.2',version:'3.16.2'};
const stamp='20261024_120000';
function walk(node,visit){if(!node||typeof node!=='object')return;visit(node);for(const x of Object.values(node))if(Array.isArray(x))x.forEach(v=>walk(v,visit));else if(x&&typeof x==='object')walk(x,visit);}
function fn(source,name){const nodes=[];walk(parse(source,{ecmaVersion:'latest'}),n=>{if(n.type==='FunctionDeclaration'&&n.id?.name===name)nodes.push(n);});assert.equal(nodes.length,1,name);return source.slice(nodes[0].start,nodes[0].end);}
const input=previewInput(fixture(),descriptor,stamp);
const before=compileRuntime3161(input).adsJs,after=compileRuntime3162(input).adsJs;
function clock(start){let time=start,next=0;const timers=new Map();return{timers,now:()=>time,skip(ms){time+=ms;},setTimeout(f,ms){timers.set(++next,{f,at:time+ms});return next;},clearTimeout(i){timers.delete(i);},tick(ms){const end=time+ms;for(let i=0;i<10000;i++){const due=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;time=due[1].at;timers.delete(due[0]);due[1].f();}time=end;}};}

/** The real generated tryRefresh and empty-retry timers; GPT dispatch is a stub
 * that records an actual send the way the visibility gate does. `wall` maps the
 * timer clock to Date.now(), so the two clocks can disagree. */
function sticky(source,{rule={},sentAt=1000000,active=()=>true,wall=t=>t}={}){
  const c=clock(sentAt+10),sent=[],state={},sticky={closed:false,retryIdx:0},sentTimes={Sticky:sentAt},wallNow=()=>wall(c.now());
  const refreshRule={enabled:true,minSeconds:30,minGapSeconds:100,maxRefreshes:20,...rule};
  const ctx=vm.createContext({_tesseraLastRefreshSentAt:sentTimes,_tesseraRefreshPending:{},slotHasCurrentViewportSizes:()=>true,TESSERA_OUTSTREAM:{disabledRefreshCodes:[]},
    pageActive:()=>active(),REFRESH_EXCLUDE_IDS:[],_refreshCounts:{},_lastRefreshAt:{Sticky:0},_slotState:state,_slotMeta:{},MAX_REFRESHES_PER_SLOT:20,
    STICKY_TARGET_ID:'Sticky',STICKY_TOP_TARGET_ID:'',STICKY_EMPTY_RETRY_DELAYS:[30000],_sticky:sticky,_stickyTop:{},window:{adSlots:{Sticky:{setConfig(){}}}},
    log(){},now:wallNow,setTimeout:c.setTimeout,clearTimeout:c.clearTimeout,getAdUnitRefreshRule:()=>refreshRule,canRefreshSlotNow:()=>({ok:true}),
    scheduleRefreshGuardRetry(){},GAM_NOREFRESH_ADVERTISER_IDS:[],_gamReporting:{plan(){}},enqueueRefresh(){throw Error('Sticky must not use the content queue');},
    fetchBidsAndRefresh(){sent.push(c.now());sentTimes.Sticky=wallNow();}});
  const names=['tryRefresh','clearStickyEmptyRetryTimer','scheduleStickyEmptyRetryDelay','scheduleStickyEmptyRetry','pauseStickyEmptyRetryTimer','resumeStickyEmptyRetryTimer'];
  if(source===after)names.push('tesseraDeferStickyEmptyRetry');
  vm.runInContext(names.map(name=>fn(source,name)).join('\n'),ctx);
  return {c,ctx,sent,state,sticky,sentTimes,offsets:()=>sent.map(t=>t-sentAt)};
}

test('R2-01: a gap-refused empty Sticky retry runs once at the exact remaining gap',()=>{
  const old=sticky(before);old.ctx.scheduleStickyEmptyRetry();old.c.tick(400000);
  assert.deepEqual(old.sent,[],'3.16.1 refuses the 30 s retry and never schedules it again');
  assert.equal(old.c.timers.size,0);assert.equal(old.state.Sticky.gapRemainingMs,69990);
  const fixed=sticky(after);fixed.ctx.scheduleStickyEmptyRetry();fixed.c.tick(400000);
  assert.deepEqual(fixed.offsets(),[100000]);assert.equal(fixed.c.timers.size,0);
  assert.equal(fixed.state.Sticky.gapRemainingMs,null);assert.equal(fixed.sticky.retryIdx,1);
});

test('R2-01 interval variant: an inherited schedule longer than the retry delay is deferred too',()=>{
  const run=source=>{const s=sticky(source,{rule:{minSeconds:60,minGapSeconds:0}});s.ctx._lastRefreshAt.Sticky=1000000;s.ctx.scheduleStickyEmptyRetry();s.c.tick(400000);return s;};
  assert.deepEqual(run(before).sent,[]);
  assert.deepEqual(run(after).offsets(),[60000]);
});

test('a deferred retry is not deferred again after another request was sent',()=>{
  const s=sticky(after);s.ctx.scheduleStickyEmptyRetry();s.c.tick(31000);
  assert.equal(s.c.timers.size,1);assert.equal(s.sticky.emptyGapDeferrals,1);
  s.sentTimes.Sticky=s.c.now();// another actual request restarts the wall-clock gap
  s.c.tick(400000);assert.deepEqual(s.sent,[]);assert.equal(s.c.timers.size,0);
  s.ctx.scheduleStickyEmptyRetry();assert.equal(s.c.timers.size,0,'the configured retry budget stays exhausted');
});

test('a wall clock that steps back during the deferred wait still gives exactly one send',()=>{
  for(const lag of [1,5,50]){
    const s=sticky(after,{wall:t=>t>=1050000?t-lag:t});s.ctx.scheduleStickyEmptyRetry();s.c.tick(400000);
    assert.deepEqual(s.offsets(),[100000+lag],'lag '+lag);assert.equal(s.c.timers.size,0);assert.equal(s.sticky.emptyGapDeferrals,2);
  }
});

test('a frozen wall clock stops after three deferrals with no timer left',()=>{
  const s=sticky(after,{wall:t=>Math.min(t,1050000)});s.ctx.scheduleStickyEmptyRetry();s.c.tick(1000000);
  assert.deepEqual(s.sent,[]);assert.equal(s.c.timers.size,0);assert.equal(s.sticky.emptyGapDeferrals,3);
  s.ctx.scheduleStickyEmptyRetry();assert.equal(s.c.timers.size,0,'the configured retry budget stays exhausted');
});

test('close, cap and disabled rules stop the deferred retry; nothing is sent early',()=>{
  const closed=sticky(after);closed.ctx.scheduleStickyEmptyRetry();closed.c.tick(50000);closed.sticky.closed=true;closed.c.tick(400000);
  assert.deepEqual(closed.sent,[]);assert.equal(closed.c.timers.size,0);
  for(const rule of [{maxRefreshes:0},{enabled:false}]){
    const s=sticky(after,{rule});if(rule.enabled===false)s.ctx.canRefreshSlotNow=()=>({ok:false,reason:'refresh disabled'});
    s.ctx.scheduleStickyEmptyRetry();s.c.tick(400000);assert.deepEqual(s.sent,[]);assert.equal(s.c.timers.size,0);
  }
  for(const gap of [100,250]){
    const s=sticky(after,{rule:{minGapSeconds:gap}});s.ctx.scheduleStickyEmptyRetry();s.c.tick(600000);
    assert.deepEqual(s.offsets(),[gap*1000]);
  }
});

test('a retry due on a hidden page waits for the page and sends at most once after resume',()=>{
  let active=true;const s=sticky(after,{active:()=>active});
  s.ctx.scheduleStickyEmptyRetry();s.c.tick(31000);active=false;s.c.tick(200000);
  assert.deepEqual(s.sent,[]);assert.equal(s.c.timers.size,0);assert.equal(s.sticky.emptyRemainingMs,1);
  s.ctx.resumeStickyEmptyRetryTimer();s.c.tick(1000);assert.deepEqual(s.sent,[],'resume while hidden parks again');
  active=true;s.ctx.resumeStickyEmptyRetryTimer();s.ctx.resumeStickyEmptyRetryTimer();s.c.tick(400000);
  assert.equal(s.sent.length,1);assert(s.sent[0]-1000000>=100000);
  const old=sticky(before,{active:()=>false});old.ctx.scheduleStickyEmptyRetry();old.c.tick(31000);
  assert.equal(old.sticky.emptyRemainingMs,undefined,'3.16.1 drops a retry that fires on a hidden page');
});

test('a pause during the deferred wait keeps the remaining time and the single send',()=>{
  const s=sticky(after);s.ctx.scheduleStickyEmptyRetry();s.c.tick(50000);
  s.ctx.pauseStickyEmptyRetryTimer();assert.equal(s.sticky.emptyRemainingMs,49990);s.c.tick(300000);assert.deepEqual(s.sent,[]);
  s.ctx.resumeStickyEmptyRetryTimer();s.c.tick(400000);assert.deepEqual(s.offsets(),[400000]);assert.equal(s.c.timers.size,0);
});

test('a pause that runs after a retry fell due parks it instead of dropping it',()=>{
  for(const [source,parked,expected] of [[before,0,[]],[after,1,[100000]]]){
    const s=sticky(source);s.ctx.scheduleStickyEmptyRetry();s.c.skip(31000);
    s.ctx.pauseStickyEmptyRetryTimer();assert.equal(s.sticky.emptyRemainingMs,parked);
    s.ctx.resumeStickyEmptyRetryTimer();s.c.tick(400000);assert.deepEqual(s.offsets(),expected);assert.equal(s.c.timers.size,0);
  }
  const s=sticky(after);s.ctx.scheduleStickyEmptyRetry();s.c.tick(31000);s.c.skip(70000);
  s.ctx.pauseStickyEmptyRetryTimer();assert.equal(s.sticky.emptyRemainingMs,1);
  s.ctx.resumeStickyEmptyRetryTimer();s.c.tick(400000);assert.deepEqual(s.offsets(),[101011]);assert.equal(s.c.timers.size,0);
});

test('tryRefresh no longer leaves a gap value from an earlier refusal for a later timer',()=>{
  for(const [source,expected] of [[before,12345],[after,null]]){
    const s=sticky(source,{rule:{minGapSeconds:0}});s.state.Sticky={gapRemainingMs:12345};s.ctx.tryRefresh('Sticky',s.ctx.window.adSlots.Sticky,0);
    assert.equal(s.sent.length,1);assert.equal(s.state.Sticky.gapRemainingMs,expected);
  }
});

test('3.16.2 changes only the reviewed anchors and stays parser-valid in every mode',async()=>{
  const restore=source=>source
    .replace('  function tryRefresh(id, slot, minGapSec){\n  if(_slotState[id])_slotState[id].gapRemainingMs=null;\n','  function tryRefresh(id, slot, minGapSec){\n')
    .replace('_sticky.emptyRemainingMs = null;\n  _sticky.emptyNextAt = now() + d;','_sticky.emptyNextAt = now() + d;')
    .replace('    if (!pageActive()) { _sticky.emptyRemainingMs = 1; return; }','    if (!pageActive()) return;')
    .replace("    tryRefresh(STICKY_TARGET_ID, slot, 0);\n    tesseraDeferStickyEmptyRetry();\n","    tryRefresh(STICKY_TARGET_ID, slot, 0);\n")
    .replace(fn(after,'tesseraDeferStickyEmptyRetry')+'\n','')
    .replace('  _sticky.retryIdx = idx+1;\n  _sticky.emptyGapDeferrals = 0;','  _sticky.retryIdx = idx+1;')
    .replace('_sticky.emptyRemainingMs = Math.max(1, _sticky.emptyNextAt - now());','_sticky.emptyRemainingMs = Math.max(0, _sticky.emptyNextAt - now());');
  for(const snapshot of [fixture(),configure(fixture(),c=>c.enablePrebid=false),configure(fixture(),c=>{c.runtimeControls.sticky.bottomAdUnitId='';}),positionFixture(true),positionFixture(false)]){
    for(const overlay of [undefined,takeOver()]){
      const saved=structuredClone(snapshot),next=previewInput(snapshot,descriptor,stamp,overlay);
      const old=compileRuntime3161(next),generated=compileRuntime3162(next);
      assert.equal(restore(generated.adsJs),old.adsJs);
      assert.equal(generated.patches.length,old.patches.length+2);
      const out=await finalizeJavaScript(idempotentStickyStyles(installSharedStickyStyles(generated.adsJs,stickyStyles(next.options.sticky.bottomAdUnitId))));
      for(const code of [out.adsJs,out.adsMinJs]){parse(code,{ecmaVersion:2015});new vm.Script(code);assert(code.includes('tesseraDeferStickyEmptyRetry'));}
      assert.deepEqual(snapshot,saved);
    }
  }
});
