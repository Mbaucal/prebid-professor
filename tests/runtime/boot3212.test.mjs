import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from 'acorn';
import {compileRuntime3211} from '../../worker/runtime-3211/compiler.mjs';
import {compileRuntime3212} from '../../worker/runtime-3212/compiler.mjs';
import {applyBootAtLoad} from '../../worker/runtime-3212/boot-compiler.mjs';
import {previewInput} from '../../worker/runtime-3212/snapshot.mjs';
import {descriptor} from '../../.generated/runtime-3211-manifest.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {configure, fixture} from './artifact-fixture.mjs';

const ready = (purpose, extra = {}) => ({gdprApplies:true,cmpStatus:'loaded',eventStatus:'useractioncomplete',tcString:'synthetic-choice',purpose:{consents:{1:purpose}},...extra});
function fakeClock() {
  let now = 1000000, next = 0; const pending = new Map();
  return {Date:{now:()=>now},setTimeout(fn,ms=0){pending.set(++next,{fn,at:now+ms});return next;},clearTimeout(id){pending.delete(id);},
    tick(ms=0){const end=now+ms;for(let g=0;g<10000;g++){const due=[...pending].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if(!due)break;now=due[1].at;pending.delete(due[0]);due[1].fn();}now=end;}};
}
function walk(node,visit){if(!node||typeof node!=='object')return;visit(node);for(const v of Object.values(node))if(Array.isArray(v))v.forEach(x=>walk(x,visit));else if(v&&typeof v==='object')walk(v,visit);}
const indexes = new Map();
/** Function and variable declarations of one generated program, parsed once. */
function index(source){
  if(!indexes.has(source)){const functions=new Map(),vars=new Map(),add=(map,key,node)=>map.set(key,[...(map.get(key)||[]),node]);
    walk(parse(source,{ecmaVersion:2015}),n=>{if(n.type==='FunctionDeclaration')add(functions,n.id.name,n);else if(n.type==='VariableDeclarator'&&n.id?.name)add(vars,n.id.name,n);});
    indexes.set(source,{functions,vars});}
  return indexes.get(source);
}
function declarations(source,name){return index(source).functions.get(name)||[];}
function extract(source,name){const nodes=declarations(source,name);assert.equal(nodes.length,1,name);return source.slice(nodes[0].start,nodes[0].end);}
function extractVar(source,name){const nodes=index(source).vars.get(name)||[];assert.equal(nodes.length,1,name);return 'var '+source.slice(nodes[0].start,nodes[0].end)+';';}
/** IIFE-level function declarations by name. */
function topFunctions(source){
  const ast=parse(source,{ecmaVersion:2015}),out=new Map();
  const iife=ast.body.filter(node=>node.type==='ExpressionStatement'&&node.expression.callee?.type==='FunctionExpression'&&
    node.expression.callee.body.body.some(inner=>inner.type==='FunctionDeclaration'&&inner.id.name==='defineAllSlots'));
  assert.equal(iife.length,1,'one ads.js IIFE');
  for(const node of iife[0].expression.callee.body.body)if(node.type==='FunctionDeclaration'){assert(!out.has(node.id.name),'duplicate '+node.id.name);out.set(node.id.name,source.slice(node.start,node.end));}
  return out;
}
function element(id, attrs = {}, log = null) {
  const map = new Map(Object.entries(attrs));
  return {id,hasAttribute:k=>map.has(k),getAttribute:k=>map.has(k)?map.get(k):null,
    setAttribute(k,v){if(log&&k==='data-google-interstitial')log.push(`attr:${id}=${v}`);map.set(k,String(v));},
    removeAttribute(k){if(log&&k==='data-google-interstitial')log.push(`attr:${id} removed`);map.delete(k);},attrs:map};
}
const inputFor = (frequency, prebid = true) => previewInput(configure(positionFixture(prebid), c => { c.runtimeControls.adPositions.Overlay.frequencyMinutes = frequency; }), descriptor, '20261113_000000');
const builds = new Map();
const build = (frequency, prebid = true) => {
  const key = `${frequency}/${prebid}`;
  if (!builds.has(key)) {
    const input = inputFor(frequency, prebid);
    builds.set(key, {input, before: compileRuntime3211(input).adsJs, after: compileRuntime3212(input).adsJs});
  }
  return builds.get(key);
};
const F5 = build(5);

/** Real generated boot, discovery, targeting, readiness and TakeOver functions; GPT, Prebid and the DOM are
 * recorded fakes. Page targeting keeps GPT semantics: setTargeting replaces a key's values. */
function page({source = F5.after, persisted = null, blocked = false, eligible = true, cmpSync = null, gptLoaded = true, body = true, htmlAttr, geo = false,
  containers = ['Billboard', 'P1'], keywords} = {}) {
  const clock = fakeClock(), events = [], access = [], values = new Map(), domListeners = new Map(); let cmp = null;
  if (persisted !== null) values.set('tessera:takeover:/123/test/Overlay', persisted);
  const win = {top:1,self:1,innerWidth:1440,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,adSlots:{},
    __tcfapi(command,version,callback){cmp=callback;if(cmpSync)callback(cmpSync,true);}};
  if (keywords !== undefined) win.adsKeywords = keywords;
  if (geo) win.__AD_GEO = {getSnapshot:()=>({version:1,status:'pending'}),ready:()=>new Promise(()=>{})};
  Object.defineProperty(win,'sessionStorage',{get(){access.push('getter');if(blocked)throw Error('denied');return{
    getItem(k){access.push('read');return values.get(k)??null;},setItem(k,v){access.push('write');values.set(k,v);}};}});
  const html = element('html', htmlAttr === undefined ? {} : {'data-google-interstitial': htmlAttr}, events);
  const nodes = Object.fromEntries(containers.map(id => [id, element(id)]));
  const document = {documentElement: html, body: body ? element('body', {}, events) : null, readyState: 'interactive',
    addEventListener(n,f){domListeners.set(n,f);}, removeEventListener(n,f){if(domListeners.get(n)===f)domListeners.delete(n);},
    querySelectorAll: () => Object.values(nodes), getElementById: id => nodes[id] || null};
  const queue = [], pageTargeting = new Map(), kv = [];
  let c;
  const service = {addEventListener(){},enableSingleRequest(){events.push('single-request');},collapseEmptyDivs(){},setCentering(){},
    disableInitialLoad(){},refresh(list){events.push('request:'+list.map(s=>s.getSlotElementId()).join(','));},getSlots:()=>[],
    getTargeting:key=>[...(pageTargeting.get(key)||[])],clearTargeting(key){pageTargeting.delete(key);},
    setTargeting(key,value){const list=(Array.isArray(value)?value:[value]).map(String);kv.push([key,list,c.tesseraTakeOverPending()]);pageTargeting.set(key,list);}};
  const googletag = {cmd: gptLoaded ? {push: f => f()} : queue, pubads: () => service, setConfig(){},
    enums:{OutOfPageFormat:{INTERSTITIAL:5}}, sizeMapping:()=>({addSize(){return this;},build:()=>[]}),
    defineOutOfPageSlot(){events.push('guard');return {addService(){},setConfig(){},getSlotElementId:()=> 'gpt_unit_guard'};},
    defineSlot:(path,sizes,id)=>{events.push('define:'+id);return {getSlotElementId:()=>id,setConfig(){},defineSizeMapping(){},addService(){}};},
    enableServices(){if(c.tesseraTakeOverPending())events.push('ENABLE-WHILE-PENDING');events.push('enable-services');},
    display(id){events.push('display:'+(typeof id==='string'?id:id.getSlotElementId()));}};
  c = vm.createContext({window:win,document,googletag,Date:clock.Date,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,console,Promise,
    TESSERA_OVERLAY:{code:'Overlay',frequencyMinutes:5},HAS_PREBID:false,BIDDERS:[],TAKEOVER_BLOCK_CODELESS:true,
    _tesseraTakeOverEligible:eligible,_tesseraTakeOverWaiting:false,_tesseraTakeOverCapResolved:false,_tesseraTakeOverBootWaiting:false,
    _takeOverCodelessReleased:false,_takeOverCodelessAttrState:{html:null,body:null,bodyHandler:null},_takeOverCodelessGuardSlot:null,_takeOverSlot:null,
    _tesseraInitialStarted:new WeakSet(),_refreshCounts:{},_lastRefreshAt:{},_tesseraInitialScanDone:false,
    AD_GEO_STATE:{settled:false,country:null,initialized:false,fallbackReason:null,fallbackAllowed:null,stickyCheck:null},
    AD_CONDITIONAL_UNITS:geo?{P2:{usesGeo:true}}:{},adGeoNormalizeCountry:value=>value||null,adGeoApplyTargeting(){events.push('geo-targeting');},
    AD_CONTAINER_SELECTOR:'.wrapperAd',STICKY_TARGET_ID:'',STICKY_TOP_TARGET_ID:'',STICKY_LAZY_ENABLED:false,STICKY_TOP_LAZY_ENABLED:false,
    SIZE_MAPS_RAW:{display:[{viewport:[0,0],sizes:[[300,250]]}]},adUnitPath:'/123/test/',COLLAPSE_EMPTY_SLOTS:false,TESSERA_LAZY_STARTED:false,DEBUG_MODE:false,
    tesseraOverlayDevice:()=>({device:'desktop',size:[800,600],autoCloseSec:0}),takeOverDeviceConfig:()=>c.tesseraOverlayDevice(),
    takeOverMainAdUnitPath:()=>'/123/test/Overlay',takeOverCodelessAdUnitPath:()=>'/123/test/Interstitial',
    takeOverEvent(name){events.push('event:'+name);},takeOverBuildDom(){},takeOverConfigureGuardSlot(){},takeOverOnCodelessFallbackRender(){},
    takeOverNeutralizeKnownCodelessSlots(){},takeOverScheduleCodelessSweep(){if(c.TAKEOVER_ACTIVE_FOR_PAGE)events.push('sweep');},
    takeOverReleaseCodelessSuppression(r){events.push('release:'+r);},takeOverOnSlotRenderEnded(){},takeOverOnSlotOnload(){},closeTakeOver(){},
    tesseraRequestOverlay(){events.push('overlay-request');},
    startATFConfigured(list){events.push('atf:'+list.map(s=>s.getSlotElementId()).join(','));},adViewportInitialSlots:s=>s,
    adViewportInstallInitialResume(){events.push('resume-listener');},ensureStickyCss(){},ensureStickyHostsExist(){events.push('sticky-hosts');},
    waitForHostAndButton(){},ensureStickyClose(){},ensureStickyTopClose(){},installAdopsViewabilityTracking(){events.push('viewability');},
    getUnitConfigById:id=>{if(!nodes[id]||(geo&&id==='P2'&&!c.AD_GEO_STATE.settled))return null;nodes[id].setAttribute('data-ad-size-map','0');return {type:'ATF',sizeMapName:'display',sizes:[[300,250]]};},
    tesseraLazyRule:()=>null,getConsentTimeoutForSlots:()=>1500,setupStickyLazy(){},wireLazyBtf(){},setupAutoRefresh(){},tesseraWireConfiguredLazy(){},
    slotHasCurrentViewportSizes:()=>true,tesseraHandleLateSlots(){},
  });
  vm.runInContext(['TAKEOVER_ACTIVE_FOR_PAGE','_takeOver'].map(n=>extractVar(source,n)).join('\n').replace('var _takeOver','var _takeOverRaw') +
    ';_takeOverRaw.events=[];var _takeOver={activeForPage:_takeOverRaw.activeForPage,status:_takeOverRaw.status,initialized:false,events:[],guardAttempts:0,guardDisplayed:false,guardStatus:"pending"};window.TAKEOVER_ACTIVE_FOR_PAGE=TAKEOVER_ACTIVE_FOR_PAGE;', c);
  const names = ['createConsentStorage','createTesseraReadiness','resolveTakeOverCap','initTakeOver','initTakeOverReady','tesseraOverlayAllowed',
    'tesseraRecordOverlayView','startATF','resolveConsent','init','initAfterTakeOverCap','defineAllSlots','takeOverEnsureCodelessGuard',
    'takeOverDisplayCodelessGuard','applyTakeOverCodelessLinkBlock','restoreTakeOverCodelessLinkBlock','takeOverBlockInterstitialOnElement',
    'takeOverMarkBodyForCodelessBlock','startAfterGptAndConsent','tesseraTakeOverPending','tesseraTakeOverDecision','tesseraBootHoldServices',
    'tesseraBootQueueDisplay','tesseraBootRelease','tesseraBootEnableHeldServices','adGeoStart',
    // Page key-values and the PAGE_TYPE fallback run unstubbed (BL-1/WP-1).
    'setKV','mergeKV','applyImmediateTargeting','lateMergeTargeting','computePageTypePrefixes','log'];
  vm.runInContext(['_tesseraDiscovery','ADS_KEYWORDS','PAGE_TYPE_KEYS','PAGE_TYPE_PREFIXES','PAGE_TYPE'].map(n=>extractVar(source,n)).join('\n') + '\n' +
    names.map(n=>extract(source,n)).join('\n'), c);
  // Program order: load-time link block, storage, readiness, the release waiter, then adGeoStart() and init().
  vm.runInContext(`applyTakeOverCodelessLinkBlock();var _tesseraBootHeld=false,_tesseraBootPendingDisplay=[],_tesseraBootStartDeferred=false;
    var _adStorage=createConsentStorage(window);
    var _tesseraReady=createTesseraReadiness(window,{storageConsent:_adStorage.update,rawDispatch:function(){},code:function(){return "Billboard";},clear:function(){},apply:function(){}});
    _tesseraReady.whenConsent(tesseraBootRelease);${geo?'adGeoStart();':''}`, c);
  const count = name => events.filter(e => e === name).length;
  return {c, clock, events, access, html, nodes, document, queue, count, kv, emit:(d,s=true)=>cmp(d,s),
    targeting:key=>pageTargeting.has(key)?[...pageTargeting.get(key)]:undefined,
    pageTargeting:()=>Object.fromEntries([...pageTargeting].map(([k,v])=>[k,[...v]])),
    loadGpt(){googletag.cmd={push:f=>f()};queue.splice(0).forEach(f=>f());},
    domReady(){document.body=element('body',{},events);const f=domListeners.get('DOMContentLoaded');if(f)f();},
    order(...names){const idx=names.map(n=>events.indexOf(n));idx.forEach((i,k)=>assert(i>=0,names[k]+' missing in '+events.join(' ')));
      for(let i=1;i<idx.length;i++)assert(idx[i-1]<idx[i],`${names[i-1]} before ${names[i]} in ${events.join(' ')}`);},
    sound(){assert(!events.includes('ENABLE-WHILE-PENDING'),'I1: enableServices while the cap is pending');
      for(const id of ['Billboard','P1','P2','gpt_unit_guard'])assert(count('display:'+id)<=1,'I6: '+id+' displayed once');
      assert(count('enable-services')<=1,'one enableServices');}};
}

test('frequency 0 and pages without a TakeOver compile to the exact 3.21.1 program', () => {
  for (const prebid of [false, true]) { const f0 = build(0, prebid); assert.equal(f0.after, f0.before); }
  const plain = previewInput(configure(fixture(), c => { c.enablePrebid = false; }), descriptor, '20261113_000000');
  assert.equal(plain.overlay, null);
  assert.equal(compileRuntime3212(plain).adsJs, compileRuntime3211(plain).adsJs);
  assert.equal(applyBootAtLoad(F5.before, {...F5.input, overlay: null}), F5.before);
  assert.equal(applyBootAtLoad(F5.before, {...F5.input, overlay: {...F5.input.overlay, frequencyMinutes: 0}}), F5.before);
  for (const prebid of [false, true]) assert.notEqual(build(5, prebid).after, build(5, prebid).before);
  assert.match(F5.after, /TAKEOVER_ACTIVE_FOR_PAGE = _tesseraTakeOverEligible \? \(TESSERA_OVERLAY.frequencyMinutes \? null : true\) : false/);
  assert.match(F5.after, /status: TAKEOVER_ACTIVE_FOR_PAGE \? 'waiting' : TAKEOVER_ACTIVE_FOR_PAGE === null \? 'waiting-consent' : 'inactive'/);
  assert.doesNotMatch(F5.after, /localStorage\.(?:getItem|setItem|removeItem)\('ADOPS_DEBUG'/);
});

test('interval patch is limited to the boot functions; every other generated function stays 3.21.1 text', () => {
  for (const prebid of [false, true]) {
    const {before, after} = build(30, prebid), old = topFunctions(before), next = topFunctions(after);
    const patched = ['defineAllSlots', 'resolveTakeOverCap', 'init', 'initAfterTakeOverCap'];
    const added = ['tesseraTakeOverPending', 'tesseraTakeOverDecision', 'tesseraBootHoldServices', 'tesseraBootQueueDisplay', 'tesseraBootRelease', 'tesseraBootEnableHeldServices'];
    assert.deepEqual([...next.keys()].filter(name => !old.has(name)).sort(), [...added].sort());
    assert.deepEqual([...old.keys()].filter(name => !next.has(name)), []);
    for (const [name, text] of old) if (!patched.includes(name)) assert.equal(next.get(name), text, name + ' must stay 3.21.1 text');
    for (const name of patched) assert.notEqual(next.get(name), old.get(name), name + ' is patched');
    // Option E: the link block keeps its !TAKEOVER_ACTIVE_FOR_PAGE gate, so an undecided (null) page is never blocked at load.
    assert.match(next.get('applyTakeOverCodelessLinkBlock'), /if \(!TAKEOVER_ACTIVE_FOR_PAGE \|\| !TAKEOVER_BLOCK_CODELESS/);
    // The held start replays the original statements verbatim.
    const held = next.get('tesseraBootEnableHeldServices'), define = old.get('defineAllSlots');
    for (const fragment of ["try { takeOverEnsureCodelessGuard(); } catch(e) { takeOverEvent('guard-pre-enable-error', {message:e && e.message}); }",
      'try { googletag.pubads().enableSingleRequest(); } catch(_){}', 'try { googletag.enableServices(); } catch(_){}',
      'try { takeOverDisplayCodelessGuard(); } catch(_){}', 'try { takeOverScheduleCodelessSweep(); } catch(_){}', 'try { googletag.display(elemId); } catch(_){}']) {
      assert(define.includes(fragment), fragment); assert(held.includes(fragment), fragment);
    }
  }
});

test('the release waiter is registered once, before adGeoStart() and init(); init is declared once', () => {
  for (const prebid of [false, true]) {
    const {after} = build(30, prebid), waiter = '  _tesseraReady.whenConsent(tesseraBootRelease);';
    assert.equal(after.split(waiter).length, 2);
    assert.equal(declarations(after, 'init').length, 1);
    assert.equal(after.split('\n  adGeoStart();\n').length, 2);
    assert(after.indexOf(waiter) < after.indexOf('\n  adGeoStart();\n'));
    assert(after.indexOf(waiter) < after.indexOf("document.addEventListener('DOMContentLoaded', init); } else { init(); }"));
    const calls = []; walk(parse(after, {ecmaVersion: 2015}), node => { if (node.type === 'CallExpression' && node.callee.name === 'init') calls.push(node); });
    assert.equal(calls.length, 1, 'init is called exactly once');
  }
});

test('every compiler anchor must match exactly once, or generation throws', () => {
  const base = F5.before, input = F5.input;
  const guardLine = "    try { takeOverEnsureCodelessGuard(); } catch(e) { takeOverEvent('guard-pre-enable-error', {message:e && e.message}); }\n";
  const once = (source, before, after) => { assert.equal(source.split(before).length, 2, before); return source.replace(before, () => after); };
  const mutations = {
    'guard moved after enableServices': s => once(once(s, guardLine, ''), '    // Guard se display-uje bez requesta', guardLine + '    // Guard se display-uje bez requesta'),
    'second pre-enable guard': s => once(s, guardLine, guardLine + guardLine),
    'display loop removed': s => s.replace(/newlyDefinedSlots\.forEach\(function\(s\)\{\n\s*var elemId[\s\S]*?\}\);\n/, () => ''),
    'sweep before guard display': s => once(s, '    try { takeOverDisplayCodelessGuard(); } catch(_){}\n    try { takeOverScheduleCodelessSweep(); } catch(_){}',
      '    try { takeOverScheduleCodelessSweep(); } catch(_){}\n    try { takeOverDisplayCodelessGuard(); } catch(_){}'),
    'duplicate init': s => once(s, 'function init() {', 'function init() {}\nfunction init() {'),
    'missing status anchor': s => once(s, "    status: TAKEOVER_ACTIVE_FOR_PAGE ? 'waiting' : 'inactive',", "    status: 'inactive',"),
    'missing interval initializer': s => once(s, '  var TAKEOVER_ACTIVE_FOR_PAGE = _tesseraTakeOverEligible && !TESSERA_OVERLAY.frequencyMinutes;', '  var TAKEOVER_ACTIVE_FOR_PAGE = _tesseraTakeOverEligible;'),
    'duplicate readiness anchor': s => once(s, '  window.__tesseraReadiness={snapshot:_tesseraReady.snapshot};', '  window.__tesseraReadiness={snapshot:_tesseraReady.snapshot};\n  window.__tesseraReadiness={snapshot:_tesseraReady.snapshot};'),
    'missing boot-waiting anchor': s => once(s, '  var _tesseraTakeOverBootWaiting=false;\n', '  var _tesseraTakeOverBootWaiting=0;\n'),
    'missing initial start': s => once(s, '  startAfterGptAndConsent();  // HB-first', '  void 0;  // HB-first'),
    'missing resolveTakeOverCap': s => once(s, 'function resolveTakeOverCap() {', 'function resolveTakeOverCapRenamed() {'),
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const mutated = mutate(base);
    assert.notEqual(mutated, base, label);
    assert.throws(() => applyBootAtLoad(mutated, input), /3\.21\.2 boot expected/, label);
  }
  assert.doesNotThrow(() => applyBootAtLoad(base, input));
});

test('WIRE-F1: a pending CMP boots slots and size-map attributes at load without GPT services, storage or the link block', () => {
  const h = page(); h.c.init(); h.clock.tick(60000);
  assert.deepEqual(h.access, []);
  assert(h.c.window.adSlots.Billboard && h.c.window.adSlots.P1);
  assert.equal(h.nodes.P1.getAttribute('data-ad-size-map'), '0');
  assert.equal(h.html.hasAttribute('data-google-interstitial'), false, 'option E: undecided pages are not blocked');
  assert.equal(h.c.document.body.hasAttribute('data-google-interstitial'), false);
  assert(h.events.includes('sticky-hosts') && h.events.includes('resume-listener'));
  for (const e of ['enable-services','single-request','guard','display:Billboard','display:P1','viewability','overlay-request','sweep']) assert(!h.events.includes(e), e);
  assert(!h.events.some(e => e.startsWith('atf:') || e.startsWith('attr:')), h.events.join(' '));
  assert.equal(h.c._takeOver.status, 'waiting-consent'); assert.equal(h.c.window.TAKEOVER_ACTIVE_FOR_PAGE, null);
  assert.equal(h.c._takeOver.activeForPage, null); assert.equal(h.c.tesseraTakeOverPending(), true);
  h.sound();
});

test('active TakeOver: link block, guard before enableServices, displays, initial start, TakeOver and ATF in 3.21.1 order', () => {
  for (const grant of [true, false]) {
    const h = page(); h.c.init(); h.emit(ready(grant)); h.clock.tick(5000);
    h.order('define:Billboard','attr:html=false','guard','single-request','enable-services','display:gpt_unit_guard','sweep','display:Billboard','display:P1','viewability','overlay-request','atf:Billboard,P1');
    assert.equal(h.count('enable-services'),1); assert.equal(h.count('display:Billboard'),1); assert.equal(h.count('guard'),1);
    assert.deepEqual(h.access, grant ? ['getter','read'] : []);
    assert.equal(h.c.window.TAKEOVER_ACTIVE_FOR_PAGE, true); assert.equal(h.c._takeOver.activeForPage, true);
    assert.notEqual(h.c._takeOver.status, 'waiting-consent'); assert.notEqual(h.c._takeOver.status, 'inactive');
    assert.equal(h.html.getAttribute('data-google-interstitial'), 'false');
    assert.equal(h.c.document.body.getAttribute('data-google-interstitial'), 'false');
    h.sound();
  }
});

test('capped and viewport-skipped pages: no guard, no overlay and the publisher interstitial attributes are never touched', () => {
  const capped = page({persisted:'900000'}); capped.c.init(); capped.emit(ready(true)); capped.clock.tick(5000);
  assert.deepEqual(capped.access, ['getter','read']); assert.equal(capped.c._takeOver.status, 'frequency-capped');
  assert.equal(capped.c.window.TAKEOVER_ACTIVE_FOR_PAGE, false);
  assert(!capped.events.includes('guard')); assert(!capped.events.includes('overlay-request')); assert(!capped.events.includes('sweep'));
  assert(!capped.events.some(e => e.startsWith('attr:')), capped.events.join(' '));
  assert.equal(capped.html.hasAttribute('data-google-interstitial'), false);
  capped.order('event:frequency-capped','enable-services','display:Billboard','display:P1','viewability','atf:Billboard,P1');
  capped.sound();
  const own = page({persisted:'900000', htmlAttr:'true'}); own.c.init();
  assert.equal(own.html.getAttribute('data-google-interstitial'),'true','publisher value untouched at load');
  own.emit(ready(true)); own.clock.tick(5000);
  assert.equal(own.html.getAttribute('data-google-interstitial'),'true','publisher value untouched after a capped decision');
  assert(!own.events.some(e => e.startsWith('attr:')));
  const resized = page(); resized.c.init(); resized.c.tesseraOverlayDevice = () => null; resized.emit(ready(true)); resized.clock.tick(5000);
  assert.equal(resized.c._takeOver.status,'skipped-viewport'); assert.deepEqual(resized.access, []);
  assert(!resized.events.includes('guard')); assert(!resized.events.some(e => e.startsWith('attr:')));
  resized.order('event:skipped-viewport','enable-services','display:Billboard','atf:Billboard,P1');
  resized.sound();
});

test('CRIT-1: out-of-scope, refused and denied storage keep 3.21.1 semantics', () => {
  const out = page({persisted:'900000'}); out.c.init(); out.emit({gdprApplies:false}); out.clock.tick();
  assert.deepEqual(out.access, ['getter','read']); assert.equal(out.c._takeOver.status,'frequency-capped');
  const denied = page({blocked:true}); denied.c.init(); denied.emit(ready(true)); denied.clock.tick(5000);
  assert.deepEqual(denied.access, ['getter']); assert(denied.events.includes('guard')); assert(denied.events.includes('overlay-request'));
  const refused = page({persisted:'900000'}); refused.c.init(); refused.emit(ready(false)); refused.clock.tick(5000);
  assert.deepEqual(refused.access, []); assert(refused.events.includes('overlay-request'), 'stored cap unreadable without purpose 1');
  for (const h of [out, denied, refused]) h.sound();
});

test('decision flip before the release waiter runs: nothing starts until the current decision is ready again', () => {
  const h = page(); h.c.init(); h.emit(ready(true)); h.emit({...ready(true), eventStatus:'cmpuishown', tcString:''}); h.clock.tick(5000);
  assert(!h.events.includes('enable-services')); assert.equal(h.c._takeOver.status,'waiting-consent'); assert.deepEqual(h.access, []);
  assert(!h.events.some(e => e.startsWith('attr:')));
  h.emit(ready(true)); h.clock.tick(5000);
  h.order('attr:html=false','guard','enable-services','display:Billboard','overlay-request','atf:Billboard,P1');
  assert.equal(h.count('enable-services'),1); assert.deepEqual(h.access, ['getter','read']);
  h.sound();
});

test('decision before boot (synchronous CMP) and GPT loading after the decision use the unchanged 3.21.1 order', () => {
  const sync = page({cmpSync: ready(true)}); sync.clock.tick(); sync.c.init(); sync.clock.tick(5000);
  sync.order('attr:html=false','guard','define:Billboard','enable-services','display:gpt_unit_guard','display:Billboard','viewability','overlay-request','atf:Billboard,P1');
  sync.sound();
  const late = page({gptLoaded:false}); late.c.init(); late.emit(ready(true)); late.clock.tick();
  assert.deepEqual(late.events.filter(e=>!['resume-listener','sticky-hosts','attr:html=false','attr:body=false'].includes(e)), []);
  late.loadGpt(); late.clock.tick(5000);
  late.order('guard','define:Billboard','enable-services','display:Billboard','viewability','overlay-request','atf:Billboard,P1');
  assert.equal(late.count('guard'),1); late.sound();
});

test('slots defined by discovery while held are displayed once, after enableServices, in the initial ATF batch', () => {
  const h = page(); h.c.init(); h.nodes.P2 = element('P2'); h.c.defineAllSlots(); h.clock.tick(1000);
  assert(h.c.window.adSlots.P2); assert(!h.events.includes('display:P2'));
  h.emit(ready(true)); h.clock.tick(5000);
  h.order('enable-services','display:Billboard','display:P2','atf:Billboard,P1,P2');
  assert.equal(h.count('display:P2'),1); h.sound();
});

test('a container inserted during the hold is found by discovery, defined and queued, then displayed once after enableServices', () => {
  for (const capped of [false, true]) {
    const h = page({containers: [], persisted: capped ? '900000' : null}); h.c.init();
    assert.equal(h.c.window.__ADS_WAITING_FOR_SLOTS, true, 'discovery starts at load, as in 3.21.0');
    h.clock.tick(3000); h.nodes.P2 = element('P2'); h.clock.tick(2000);
    assert(h.c.window.adSlots.P2, 'the next discovery attempt defines the inserted container while undecided');
    assert.equal(h.nodes.P2.getAttribute('data-ad-size-map'), '0');
    assert.equal(h.count('define:P2'), 1); assert(!h.events.includes('display:P2')); assert(!h.events.includes('enable-services'));
    assert.deepEqual(h.access, []); assert.equal(h.c._takeOver.status, 'waiting-consent');
    h.emit(ready(true)); h.clock.tick(30000);
    if (capped) h.order('define:P2','event:frequency-capped','single-request','enable-services','display:P2','viewability','atf:P2');
    else h.order('define:P2','attr:html=false','guard','single-request','enable-services','display:gpt_unit_guard','sweep','display:P2','viewability','atf:P2');
    assert.equal(h.count('guard'), capped ? 0 : 1);
    assert.equal(h.count('define:P2'), 1); assert.equal(h.count('display:P2'), 1); assert.equal(h.count('enable-services'), 1);
    h.sound();
  }
});

test('the decision defines no slots: containers inserted after the 20 s discovery window stay undefined, as in 3.21.0', () => {
  for (const capped of [false, true]) {
    // No container at load: the window opened at load has closed before the late insert.
    const empty = page({containers: [], persisted: capped ? '900000' : null}); empty.c.init(); empty.clock.tick(21000);
    assert.equal(empty.c.window.__ADS_WAITING_FOR_SLOTS, false);
    empty.nodes.P2 = element('P2'); empty.clock.tick(1000);
    empty.emit(ready(true)); empty.clock.tick(30000);
    assert(!empty.c.window.adSlots.P2); assert.equal(empty.count('define:P2'), 0); assert(!empty.events.includes('display:P2'));
    empty.sound();
    // Containers at load: no discovery runs, and a container added before the decision is not picked up by the release.
    const h = page({persisted: capped ? '900000' : null}); h.c.init(); h.clock.tick(2000);
    h.nodes.P2 = element('P2'); h.clock.tick(1000);
    const before = h.events.length;
    h.emit(ready(true)); h.clock.tick(30000);
    // Only the TakeOver's own slot is defined after the decision, as in 3.21.1.
    assert.deepEqual(h.events.slice(before).filter(e => e.startsWith('define:')), capped ? [] : ['define:adsx-takeover-slot'], h.events.slice(before).join(' '));
    assert(!h.c.window.adSlots.P2); assert(!h.events.includes('display:P2'));
    if (capped) h.order('event:frequency-capped','enable-services','display:Billboard','display:P1','atf:Billboard,P1');
    else h.order('guard','single-request','enable-services','display:gpt_unit_guard','display:Billboard','display:P1','atf:Billboard,P1');
    assert.equal(h.count('define:Billboard'), 1); assert.equal(h.count('display:Billboard'), 1); assert.equal(h.count('guard'), capped ? 0 : 1);
    h.sound();
  }
});

/** Sport/[a,b] before ads.js, Politika/[c] 2 s after load, decision 4 s after load (BL-1/WP-1 scenario). */
function keywordChange(source, {grant = true, inPlace = false} = {}) {
  const h = page({source, keywords: {pageType: 'naslovna', category: 'Sport', tags: ['a', 'b']}});
  h.c.init(); h.clock.tick(2000);
  const atLoad = h.pageTargeting();
  if (inPlace) { h.c.window.adsKeywords.category = 'Politika'; h.c.window.adsKeywords.tags = ['c']; }
  else h.c.window.adsKeywords = {pageType: 'naslovna', category: 'Politika', tags: ['c']};
  h.clock.tick(2000);
  assert(!h.events.includes('enable-services'));
  h.emit(ready(grant)); h.clock.tick(60000);
  return {h, atLoad};
}

test('BL-1: adsKeywords changed between load and the decision keep the single load-time page values of 3.21.0 (interval 30, unstubbed targeting)', () => {
  const {after} = build(30);
  for (const grant of [true, false]) for (const inPlace of [false, true]) {
    const {h, atLoad} = keywordChange(after, {grant, inPlace});
    assert.deepEqual(atLoad.category, ['Sport'], 'page key-values are set at load, as in 3.21.0');
    assert.deepEqual(atLoad.tags, ['a', 'b']); assert.deepEqual(atLoad.pageType, ['naslovna']);
    h.order('define:Billboard','guard','enable-services','display:Billboard','atf:Billboard,P1');
    assert.deepEqual(h.pageTargeting(), atLoad, 'page targeting after the decision equals the load-time targeting');
    assert.deepEqual(h.targeting('category'), ['Sport']); assert.deepEqual(h.targeting('tags'), ['a', 'b']);
    assert(h.kv.every(([, , pending]) => pending), 'no page key-value is written at or after the decision: ' + JSON.stringify(h.kv));
    assert(h.kv.filter(([key]) => key === 'category').every(([, values]) => values.length === 1 && values[0] === 'Sport'), JSON.stringify(h.kv));
    h.sound();
  }
  // The harness detects the defect: re-running defineAllSlots at the release (withdrawn design 2(b)) unions old and new values.
  const anchor = '  tesseraTakeOverDecision();\n  if (_tesseraBootHeld)';
  assert.equal(after.split(anchor).length, 2);
  const {h: union} = keywordChange(after.replace(anchor, '  tesseraTakeOverDecision();\n  defineAllSlots();\n  if (_tesseraBootHeld)'));
  assert.deepEqual(union.targeting('category'), ['Politika', 'Sport']); assert.deepEqual(union.targeting('tags'), ['c', 'a', 'b']);
});

test('the release and the held start never define slots, decide unit rules or apply page key-values', () => {
  const forbidden = ['defineAllSlots', 'applyImmediateTargeting', 'lateMergeTargeting', 'mergeKV', 'setKV', 'getUnitConfigById', 'adConditionalConfig'];
  for (const prebid of [false, true]) for (const frequency of [5, 30]) {
    const {after} = build(frequency, prebid);
    for (const name of ['tesseraBootRelease', 'tesseraBootEnableHeldServices', 'tesseraTakeOverDecision', 'resolveTakeOverCap']) {
      const called = new Set();
      walk(parse(extract(after, name), {ecmaVersion: 2015}), node => { if (node.type === 'CallExpression' && node.callee.type === 'Identifier') called.add(node.callee.name); });
      for (const callee of forbidden) assert(!called.has(callee), `${name} must not call ${callee}`);
    }
  }
});

test('a geo-dependent unit settling before the decision is held; settling after the decision follows the 3.21.1 path', () => {
  const before = page({geo:true}); before.nodes.P2 = element('P2'); before.c.init();
  assert(!before.c.window.adSlots.P2);
  before.clock.tick(1500); // bounded lookup settles unknown, still undecided
  assert(before.c.AD_GEO_STATE.settled); assert(before.c.window.adSlots.P2); assert(!before.events.includes('display:P2'));
  assert(!before.events.includes('enable-services'));
  before.emit(ready(true)); before.clock.tick(5000);
  before.order('define:P2','guard','enable-services','display:Billboard','display:P2','atf:Billboard,P1,P2');
  assert.equal(before.count('display:P2'),1); before.sound();
  const after = page({geo:true}); after.nodes.P2 = element('P2'); after.c.init();
  after.emit(ready(true)); after.clock.tick(100);
  assert(after.events.includes('enable-services')); assert(!after.c.window.adSlots.P2);
  after.clock.tick(2000);
  after.order('enable-services','atf:Billboard,P1','define:P2','display:P2');
  assert.equal(after.count('display:P2'),1); after.sound();
});

test('ineligible TakeOver page boots synchronously; the release waiter is a no-op', () => {
  const h = page({eligible:false}); h.c.init();
  h.order('define:Billboard','enable-services','display:Billboard','viewability');
  assert(!h.events.includes('guard')); assert.equal(h.c.window.TAKEOVER_ACTIVE_FOR_PAGE, false); assert.equal(h.c._takeOver.status,'inactive');
  const before = h.events.length;
  h.emit(ready(true)); h.clock.tick(5000); assert.deepEqual(h.access, []); assert.equal(h.count('enable-services'),1);
  assert(!h.events.slice(before).some(e => e.startsWith('define:') || e.startsWith('display:')), 'no release work on an ineligible page');
  h.sound();
});

test('a failing cap decision reports cap-error and never holds GPT services', () => {
  const broken = page(); broken.c.init(); broken.c.tesseraOverlayDevice = () => { throw Error('viewport probe failed'); };
  broken.emit(ready(true)); broken.clock.tick(5000);
  assert.equal(broken.c._takeOver.status, 'cap-error'); assert.equal(broken.c.window.TAKEOVER_ACTIVE_FOR_PAGE, false);
  assert.equal(broken.c._takeOver.activeForPage, false); assert.equal(broken.c.tesseraTakeOverPending(), false);
  assert(!broken.events.includes('guard')); assert(!broken.events.includes('overlay-request'));
  broken.order('event:cap-error','enable-services','display:Billboard','atf:Billboard,P1');
  assert.equal(broken.html.hasAttribute('data-google-interstitial'), false);
  broken.sound();
});

test('a slot removed or replaced before the decision is not displayed by the held start', () => {
  const removed = page(); removed.c.init(); delete removed.c.window.adSlots.P1; delete removed.nodes.P1;
  removed.emit(ready(true)); removed.clock.tick(5000);
  assert(!removed.events.includes('display:P1')); assert(removed.events.includes('display:Billboard'));
  assert.equal(removed.count('define:P1'), 1); removed.sound();
  // The container is still on the page but nothing defines it again: the stale slot is dropped, as the release defines nothing.
  const stale = page(); stale.c.init(); delete stale.c.window.adSlots.P1;
  stale.emit(ready(true)); stale.clock.tick(5000);
  assert.equal(stale.count('define:P1'), 1); assert(!stale.events.includes('display:P1')); stale.sound();
  // A discovery pass while held defines a fresh slot; only that one is displayed.
  const replaced = page(); replaced.c.init(); const old = replaced.c.window.adSlots.P1; delete replaced.c.window.adSlots.P1;
  replaced.c.defineAllSlots();
  replaced.emit(ready(true)); replaced.clock.tick(5000);
  assert.equal(replaced.count('define:P1'), 2); assert.equal(replaced.count('display:P1'), 1);
  assert.notEqual(replaced.c.window.adSlots.P1, old); replaced.order('enable-services','display:P1','atf:Billboard,P1');
  replaced.sound();
});

test('script in head: the body is blocked only after an active decision, never for capped or undecided pages', () => {
  const capped = page({body:false, persisted:'900000', cmpSync: ready(true)}); capped.clock.tick();
  assert.equal(capped.c._takeOver.status, 'frequency-capped'); capped.domReady(); capped.c.init(); capped.clock.tick(5000);
  assert(!capped.events.some(e => e.startsWith('attr:')), capped.events.join(' '));
  assert(capped.events.includes('enable-services')); capped.sound();
  const active = page({body:false, cmpSync: ready(true)}); active.clock.tick();
  assert.equal(active.html.getAttribute('data-google-interstitial'), 'false');
  assert.equal(active.c._takeOverCodelessAttrState.bodyHandler !== null, true, 'body handler waits for DOMContentLoaded');
  active.domReady(); assert.equal(active.c.document.body.getAttribute('data-google-interstitial'), 'false');
  active.c.init(); active.clock.tick(5000); active.order('attr:body=false','guard','enable-services'); active.sound();
  const pending = page({body:false}); pending.domReady(); pending.c.init(); pending.clock.tick(30000);
  assert(!pending.events.some(e => e.startsWith('attr:'))); assert.equal(pending.c._takeOverCodelessAttrState.bodyHandler, null);
  assert(!pending.events.includes('enable-services')); pending.sound();
});
