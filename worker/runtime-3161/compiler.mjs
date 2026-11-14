import {parse} from 'acorn';
import {compileRuntime316} from '../runtime-316/compiler.mjs';
import {browserSources} from '../../.generated/runtime-3161-browser-source.mjs';
import {transform as fixRefreshCounting} from './refresh-counting.mjs';

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach(item => walk(item, visit));
    else if (child && typeof child === 'object') walk(child, visit);
  }
}
export function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Tessera 3.16.1 insertion point changed: ' + before);
  return source.replace(before, () => after);
}
function replaceFunction(source, name, replacement) {
  const matches = [];
  walk(parse(source, {ecmaVersion:'latest'}), node => {
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) matches.push(node);
  });
  if (matches.length !== 1) throw Error('Tessera 3.16.1 expected one ' + name);
  const node = matches[0];
  return source.slice(0, node.start) + replacement + source.slice(node.end);
}
function escapedSchain(value) {
  if (typeof value === 'string') return value.replace(/\$/g, () => '$$');
  if (Array.isArray(value)) return value.map(escapedSchain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/\$/g, () => '$$'), escapedSchain(item)]));
  return value;
}
function deduplicateRenderMetadata(source) {
  const groups={declarations:[],reads:[],lastResponseInfo:[],lastRenderScrollY:[],lastRenderViewPct:[]};
  walk(parse(source,{ecmaVersion:'latest'}),node=>{
    if(node.type==='VariableDeclaration'&&node.declarations.some(d=>d.id.name==='responseInfoAtRender'))groups.declarations.push(node);
    if(node.type==='TryStatement'&&node.block.body.some(statement=>statement.type==='ExpressionStatement'&&statement.expression.type==='AssignmentExpression'&&statement.expression.left.name==='responseInfoAtRender'))groups.reads.push(node);
    if(node.type==='ExpressionStatement'&&node.expression.type==='AssignmentExpression'){
      const left=node.expression.left;
      if(left.type==='MemberExpression'&&left.object.name==='st'&&groups[left.property.name])groups[left.property.name].push(node);
    }
  });
  for(const nodes of Object.values(groups))if(nodes.length!==2)throw Error('Expected duplicated render metadata to match the reviewed source.');
  const remove=Object.values(groups).map(nodes=>nodes[1]);
  for(const node of remove.sort((a,b)=>b.start-a.start))source=source.slice(0,node.start)+source.slice(node.end);
  return source;
}

/** A new, explicit patch release. No old compiler or old saved bytes are edited. */
export function compileRuntime3161(input) {
  // The reference builder uses string replacement for this one JSON fragment.
  // Doubling its dollar signs makes replacement literal; the original input is
  // retained in config.json and the emitted JavaScript contains the exact data.
  const safeInput = input.options.schain ? {...input, options:{...input.options, schain:escapedSchain(input.options.schain)}} : input;
  const result = compileRuntime316(safeInput);
  let source = replaceFunction(result.adsJs, 'createTesseraReadiness', browserSources.createTesseraReadiness);
  if(input.options.enablePrebid)source=replaceFunction(source,'applyOutstreamUnit',browserSources.applyOutstreamUnit);
  if(Object.keys(input.lazyRules).length)source=once(source,'tesseraLazyRule(id)?.enabled','(tesseraLazyRule(id) && tesseraLazyRule(id).enabled)');
  source = once(source, '    clear:clearPrebidTargetingFromSlot,apply:applyTargetingMapToSlot,', `    clear:function(slot){
      var keep={};
      ['hb_ver','hb_version'].forEach(function(key){
        try{var values=slot.getTargeting(key);if(values&&values.length)keep[key]=values;}catch(_){}
      });
      clearPrebidTargetingFromSlot(slot);applyTargetingMapToSlot(slot,keep);
    },apply:applyTargetingMapToSlot,
    unit:adUnitFromCode,timeout:getAdUnitTimeoutMs,`);

  // The one-shot guard permission must cover actual synchronous GPT dispatch,
  // after CMP listeners have received the same completed decision.
  const fallbackStart = source.indexOf('    window.__TAKEOVER_ALLOW_CODELESS_FALLBACK_REQUEST = true;');
  const fallbackEnd = source.indexOf('\n      }catch(e){', fallbackStart);
  if (fallbackStart < 0 || fallbackEnd <= fallbackStart) throw Error('TakeOver fallback insertion point changed.');
  source = source.slice(0, fallbackStart) + `    _takeOver.guardStatus = 'fallback-waiting-consent';
    _tesseraReady.whenConsent(function(){
      try{
        window.__TAKEOVER_ALLOW_CODELESS_FALLBACK_REQUEST = true;
        try { _gamReporting.dispatch(pa,[guard]); }
        finally { window.__TAKEOVER_ALLOW_CODELESS_FALLBACK_REQUEST = false; }
        _takeOver.fallbackRequested = true;
        _takeOver.guardStatus = 'fallback-requested';
        takeOverEvent('codeless-fallback-requested',{reason:reason || 'no-fill',path:takeOverCodelessAdUnitPath()});
      }catch(e){
        _takeOver.guardStatus = 'fallback-request-error';
        takeOverEvent('codeless-fallback-request-error',{message:e && e.message});
      }
    });` + source.slice(fallbackEnd);

  // One finite discovery window, not a new retry chain for every CSS mutation.
  source = once(source, 'function defineAllSlots(){', `var _tesseraDiscovery={started:false,ended:false,attempts:0,timer:null,debounce:null,observer:null,failed:Object.create(null)};
  var _tesseraInitialScanDone=false, _tesseraObserveLegacyLazy=null;
  function tesseraStickyDelay(){
    var state=_slotState[STICKY_TARGET_ID],gap=state&&state.gapRemainingMs;
    if(state)state.gapRemainingMs=null;
    return gap!=null?gap:getAdUnitRefreshRule(STICKY_TARGET_ID).minSeconds*1000;
  }
  ${browserSources.tesseraHandleLateSlots}
  function defineAllSlots(){`);
  source = replaceFunction(source, 'scheduleDefineSlotsRetry', browserSources.scheduleDefineSlotsRetry);
  const slotGuard = input.overlay ? 'if (!id || id===TESSERA_OVERLAY.code || window.adSlots[id]) return;' : 'if (!id || window.adSlots[id]) return;';
  source = once(source, slotGuard, slotGuard.replace('window.adSlots[id])', 'window.adSlots[id] || _tesseraDiscovery.failed[id])'));
  source = once(source, "          if (DEBUG_MODE) console.warn('[ADS] defineSlot returned null', id, gptSizes, cfg);", "          _tesseraDiscovery.failed[id]=true;\n          if (DEBUG_MODE) console.warn('[ADS] defineSlot returned null', id, gptSizes, cfg);");
  source = once(source, "        console.warn('[ADS] defineSlot failed:', id, 'sizes=', gptSizes, 'cfg=', cfg, e);", "        _tesseraDiscovery.failed[id]=true;\n        console.warn('[ADS] defineSlot failed:', id, 'sizes=', gptSizes, 'cfg=', cfg, e);");
  source = once(source, "if (stt){ stt.classList.remove('ad-loaded'); stt.style.minHeight='0px'; }", "if (stt && newlyDefinedSlots.some(function(s){return s.getSlotElementId()===STICKY_TOP_TARGET_ID;}) && !_stickyTop.everFilled){ stt.classList.remove('ad-loaded'); stt.style.minHeight='0px'; }");
  source = once(source, "if (st){ st.classList.remove('ad-loaded'); st.style.minHeight='0px'; }", "if (st && newlyDefinedSlots.some(function(s){return s.getSlotElementId()===STICKY_TARGET_ID;}) && !_sticky.everFilled){ st.classList.remove('ad-loaded'); st.style.minHeight='0px'; }");
  source = once(source, '      var atfSlots = collectATF();', '      var atfSlots = collectATF();\n      _tesseraInitialScanDone=true;');
  const lateHook = Object.keys(input.lazyRules).length ?
    '    if(TESSERA_LAZY_STARTED)tesseraWireConfiguredLazy();\n  });\n}\n\n  /* ====== HB helper ====== */' :
    '    });\n  });\n}\n\n  /* ====== HB helper ====== */';
  source = once(source, lateHook, lateHook.replace('\n  });\n}', '\n    tesseraHandleLateSlots(newlyDefinedSlots);\n  });\n}'));
  const registerStart = source.indexOf('    // Registruj oba observer-a za BTF slotove');
  const registerEnd = source.indexOf('\n  }\n\n/* R4:', registerStart);
  if (registerStart < 0 || registerEnd < registerStart) throw Error('Legacy lazy registration insertion point changed.');
  source = source.slice(0, registerStart) + `    _tesseraObserveLegacyLazy=function(id){
      if(tesseraLazyRule(id))return;
      if(id===STICKY_TARGET_ID||id===STICKY_TOP_TARGET_ID)return;
      var cfg=getUnitConfigById(id)||{};
      if(String(cfg.type||'BTF').toUpperCase()==='ATF')return;
      var dom=document.getElementById(id);
      if(dom){prefetchIO.observe(dom);displayIO.observe(dom);}
    };
    Object.keys(window.adSlots).forEach(_tesseraObserveLegacyLazy);` + source.slice(registerEnd);

  // Honor inherited schedules, the explicit wall-clock gap and empty retries.
  source = once(source, 'var effectiveMinGapSec = Number(minGapSec || rrForGap.minSeconds || 30);',
    'var effectiveMinGapSec = Math.max(Number(minGapSec || rrForGap.minSeconds || 30),Number(rrForGap.minGapSeconds || 0));');
  source = once(source, 'if (since < 1000*effectiveMinGapSec) {', `var actualSentAt=_tesseraLastRefreshSentAt[id];
var actualGapRemaining=actualSentAt==null?0:Number(rrForGap.minGapSeconds||0)*1000-(now()-actualSentAt);
if (since < 1000*effectiveMinGapSec || actualGapRemaining > 0) {
  var gapState=_slotState[id]||(_slotState[id]={});
  gapState.gapRemainingMs=Math.max(0,1000*effectiveMinGapSec-since,actualGapRemaining);`);
  source = once(source, 'st.dwellRemainingMs = nextSec * 1000;', 'st.dwellRemainingMs = st.gapRemainingMs!=null?st.gapRemainingMs:nextSec * 1000;\nst.gapRemainingMs=null;');
  source = once(source, "  if(!slot) return;\n  if (REFRESH_EXCLUDE_IDS.indexOf(id)>-1) return;", `  if(!slot) return;
  if(id===STICKY_TARGET_ID&&_sticky.closed||id===STICKY_TOP_TARGET_ID&&_stickyTop.closed)return;
  if (REFRESH_EXCLUDE_IDS.indexOf(id)>-1) return;`);
  source = source.replaceAll('tryRefresh(STICKY_TARGET_ID, slot, STICKY_REFRESH_SEC);', 'tryRefresh(STICKY_TARGET_ID, slot, 0);');
  const stickyInterval = 'tesseraStickyDelay()';
  source = source.replaceAll('STICKY_REFRESH_SEC*1000', stickyInterval);
  source = once(source, '  if (rule.minViewPct > 0 && pct < rule.minViewPct) {', `  var stickyHost=document.getElementById(id);
  var emptySticky=((id===STICKY_TARGET_ID&&!_sticky.closed)||(id===STICKY_TOP_TARGET_ID&&!_stickyTop.closed))&&
    !(stickyHost&&stickyHost.classList&&stickyHost.classList.contains('ad-loaded'));
  if (!emptySticky && rule.minViewPct > 0 && pct < rule.minViewPct) {`);
  source = once(source, '    } else {\n      st.dwellRemainingMs = null;\n    }\n    st.dwellDeadline = 0;',
    '    } else if (!preserveRemaining) {\n      st.dwellRemainingMs = null;\n    }\n    st.dwellDeadline = 0;');
  source = once(source, '  window.__ADS_RESUME_DWELL = function(){\n    try{', '  window.__ADS_RESUME_DWELL = function(){\n    if(!pageActive())return;\n    try{');
  source = once(source, '        if (st.dwellRemainingMs != null && st.dwellRemainingMs > 0){', '        if (!st.dwellTimer){');
  source = once(source, '  st.refreshGuardTimer = setTimeout(function(){', `  if(!rule.enabled||id===STICKY_TARGET_ID||id===STICKY_TOP_TARGET_ID||!st.inView)return;
  st.refreshGuardTimer = setTimeout(function(){
    st.refreshGuardTimer=null;
    if(!pageActive()||!st.inView||!getAdUnitRefreshRule(id).enabled)return;`);
  source = once(source, '            st.inView = false;\n            // R1:', `            st.inView = false;
            if(st.refreshGuardTimer){clearTimeout(st.refreshGuardTimer);st.refreshGuardTimer=null;}
            // R1:`);

  // Late keywords affect later requests only; viewport map selection stays fixed.
  source = once(source, '  var PAGE_TYPE_PREFIXES = (function(){', '  function computePageTypePrefixes(){');
  source = once(source, "    return prefixes;\n  })();\n  var PAGE_TYPE =", "    return prefixes;\n  }\n  var PAGE_TYPE_PREFIXES=computePageTypePrefixes();\n  var PAGE_TYPE =");
  source = replaceFunction(source, 'lateMergeTargeting', browserSources.lateMergeTargeting);

  // A disabled breakpoint can be crossed while CMP is still waiting.
  source = once(source, '    var deviceCfg = takeOverDeviceConfig();\n    _takeOver.device', `    var deviceCfg = takeOverDeviceConfig();
    if(!deviceCfg){
      _takeOver.status='skipped-viewport';
      takeOverEvent('skipped-viewport',{width:window.innerWidth});
      takeOverReleaseCodelessSuppression('viewport-disabled');
      return;
    }
    _takeOver.device`);
  source = once(source, 'desktopSize: TAKEOVER_DESKTOP_SIZE.slice(),', 'desktopSize: TESSERA_OVERLAY ? null : TAKEOVER_DESKTOP_SIZE.slice(),\n        sizeMap: TESSERA_OVERLAY ? TESSERA_OVERLAY.maps : null,\n        current: TESSERA_OVERLAY ? tesseraOverlayDevice() : null,');
  source = once(source, 'mobileSize: TAKEOVER_MOBILE_SIZE.slice(),', 'mobileSize: TESSERA_OVERLAY ? null : TAKEOVER_MOBILE_SIZE.slice(),');

  // Only real CSS calls, never matching text inside saved bidder/SChain strings.
  const cssProperties=new Set(['zIndex','pointerEvents','fontSize','lineHeight','textAlign','boxShadow','userSelect','alignItems','justifyContent','borderRadius','fontFamily']);
  const cssEdits=[];
  walk(parse(source,{ecmaVersion:'latest'}),node=>{
    if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&node.callee.property.name==='setProperty'){
      const name=node.arguments[0];
      if(name?.type==='Literal'&&cssProperties.has(name.value))cssEdits.push({start:name.start,end:name.end,value:name.value.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase())});
    }
  });
  if(cssEdits.length!==13)throw Error('Expected thirteen reviewed Sticky CSS property calls.');
  for(const edit of cssEdits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+JSON.stringify(edit.value)+source.slice(edit.end);
  const gapConstants=[];
  walk(parse(source,{ecmaVersion:'latest'}),node=>{
    if(node.type==='VariableDeclarator'&&['MIN_SECONDS_BETWEEN_REFRESHES','MOBILE_MIN_SECONDS_BETWEEN_REFRESHES'].includes(node.id?.name))gapConstants.push(node.init);
  });
  if(gapConstants.length!==2)throw Error('Expected two inherited dwell fallback constants.');
  for(const node of gapConstants.sort((a,b)=>b.start-a.start))source=source.slice(0,node.start)+JSON.stringify(Number(input.core.globalRefresh.minSeconds)||30)+source.slice(node.end);
  source=deduplicateRenderMetadata(source);
  source=fixRefreshCounting(source);
  parse(source, {ecmaVersion:2015});
  return {...result, adsJs:source, adsMinJs:source, patches:[...result.patches,
    '3.16.1: finite late-slot discovery, consent-safe Interstitial fallback, unexpired Send All Bids at dispatch',
    '3.16.1: effective content refresh, inherited Sticky schedules, empty retry, wall-clock gap and tab resume',
    '3.16.1: exact SChain values, bounded late keywords and viewport-safe TakeOver diagnostics']};
}

/** Must run after the historical shared stylesheet installer. */
export function idempotentStickyStyles(source) {
  const matches = [];
  walk(parse(source, {ecmaVersion:'latest'}), node => {
    if(node.type==='AssignmentExpression' && node.left.type==='MemberExpression' && node.left.object.name==='tag' && node.left.property.name==='textContent') matches.push(node);
  });
  if(matches.length!==2)throw Error('Expected shared bottom and original top Sticky stylesheet assignments.');
  for(const node of matches.sort((a,b)=>b.start-a.start)){
    const value=source.slice(node.right.start,node.right.end);
    source=source.slice(0,node.start)+'(tag.textContent!=='+value+' ? '+source.slice(node.start,node.end)+' : void 0)'+source.slice(node.end);
  }
  return source;
}
