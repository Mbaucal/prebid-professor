import assert from 'node:assert/strict';
import {parse} from 'acorn';

// A separate static Pages delivery profile. Existing runtimes and loaders stay frozen.
export const AA_RELEASE = 'tanjug-aa-1.0.0';

export function bootStaticAA(config) {
  'use strict';
  var tag = document.currentScript;
  if (!tag || !tag.src) return;
  if (window.__adVariantDelivery) { window.__adVariantDelivery.duplicate(); return; }
  var base = new URL(tag.src), nonce = tag.nonce, started = Date.now();
  var attempts = 1, entries = 0, blockedEntries = 0, applied = 0, failed = 0;
  var status = 'starting', reason = null, events = [], assigned = null;
  var cleanup = function() {}, owned = new WeakSet(), requests = 0, renders = 0;
  function prebidVersion(){return window.pbjs&&typeof window.pbjs.version==='string'?window.pbjs.version.replace(/^v/,''):null;}
  function event(type) { if (events.length < 50) events.push({type:type,ms:Date.now()-started}); }
  function fail(code) { if (status === 'error') return; status='error';reason=code;cleanup();event(code); }
  function targeting(slot) {
    try { var v=slot.getConfig('targeting').targeting.Variant;return Array.isArray(v)?v.join(','):v||null; }
    catch (_) { return null; }
  }
  function snapshot() {
    var slots=[];
    try { slots=window.googletag.pubads().getSlots().filter(function(s){return owned.has(s);}).map(function(s){
      return {position:s.getSlotElementId(),Variant:targeting(s)};
    }); } catch (_) {}
    return {release:config.release,baseRuntime:config.baseRuntime,variant:assigned,status:status,error:reason,
      script:assigned?new URL(config.arms[assigned].path,base).href:null,scriptSha256:config.armSha256,
      prebidVersion:prebidVersion(),mode:'fresh-only',
      loaderAttempts:attempts,blockedDuplicateLoaders:attempts-1,runtimeEntries:entries,blockedRuntimeEntries:blockedEntries,
      configuredPositions:config.positions.slice(),appliedSlots:applied,targetingFailures:failed,
      requests:requests,renders:renders,slots:slots,events:events.slice()};
  }
  var api = Object.freeze({
    release:config.release,
    duplicate:function(){attempts++;event('duplicate-loader-blocked');},
    enter:function(){
      if (status!=='loading-arm'||entries||window.__TESSERA_RUNTIME_STARTED) { blockedEntries++;return false; }
      entries++;event('runtime-entered');return true;
    },
    apply:function(slot){
      if (!entries||!assigned||!slot||owned.has(slot)) return;
      try {slot.setConfig({targeting:{Variant:assigned}});owned.add(slot);applied++;}
      catch (_) {failed++;event('targeting-error');throw Error('Variant targeting could not be applied');}
    },
    snapshot:snapshot
  });
  window.__adVariantDelivery=api;
  if (!window.AdVariant) window.AdVariant=Object.freeze({
    inspect:function(){var s=snapshot();console.table([{release:s.release,Variant:s.variant,status:s.status,
      script:s.script,Prebid:s.prebidVersion,mode:s.mode,runtimeEntries:s.runtimeEntries,
      blockedDuplicates:s.blockedDuplicateLoaders+s.blockedRuntimeEntries,error:s.error}]);console.table(s.slots);return s;},
    snapshot:snapshot
  });
  if (window.__TESSERA_RUNTIME_STARTED || window.__tesseraExperimentOwner) {fail('existing-runtime-conflict');return;}
  try {var sample=new Uint32Array(1);window.crypto.getRandomValues(sample);assigned=sample[0]<2147483648?'A':'B';}
  catch (_) {fail('random-unavailable');return;}
  event('assigned-'+assigned);
  // No storage, cookies, geography or CMP calls. The assignment lasts for this document.
  window.googletag=window.googletag||{cmd:[]};
  window.googletag.cmd=window.googletag.cmd||[];
  window.googletag.cmd.push(function(){
    try {
      var service=window.googletag.pubads();
      service.addEventListener('slotRequested',function(e){if(owned.has(e.slot))requests++;});
      service.addEventListener('slotRenderEnded',function(e){if(owned.has(e.slot))renders++;});
    } catch (_) {event('gpt-observer-unavailable');}
  });
  function insert(path,integrity,done,code) {
    var s=document.createElement('script'),settled=false;
    s.src=new URL(path,base).href;s.async=true;s.integrity=integrity;s.crossOrigin='anonymous';
    if(nonce)s.nonce=nonce;
    var timer=setTimeout(function(){finish(false);},30000);
    function finish(ok){if(settled)return;settled=true;clearTimeout(timer);s.onload=s.onerror=null;
      if(status==='error')return;if(ok)done();else fail(code);}
    s.onload=function(){finish(true);};s.onerror=function(){finish(false);};
    try{(document.head||document.documentElement).appendChild(s);}catch(_){finish(false);}
  }
  function loadArm(){
    if(status==='error'||status==='loading-arm'||status==='loaded')return;
    if(window.__TESSERA_RUNTIME_STARTED){fail('existing-runtime-conflict');return;}
    if(prebidVersion()!==config.prebidVersion){fail('prebid-version-mismatch');return;}
    status='loading-arm';event('prebid-ready');
    insert(config.arms[assigned].path,config.arms[assigned].integrity,function(){
      if(entries!==1){fail('runtime-did-not-enter');return;}status='loaded';event('arm-loaded');
    },'arm-load-error');
  }
  function dependency(){
    if(status==='error')return;
    if(window.pbjs&&window.pbjs.version){loadArm();return;}
    var prebidUrl=new URL('prebid.js',base);
    var existing=Array.from(document.scripts).filter(function(s){
      if(!s.src)return false;var u=new URL(s.src,document.baseURI);return u.origin===prebidUrl.origin&&u.pathname===prebidUrl.pathname;
    });
    if(existing.length>1){fail('duplicate-prebid-tags');return;}
    status='waiting-prebid';
    if(existing.length){
      var s=existing[0],timer=setTimeout(function(){fail('prebid-timeout');},30000);
      var poll=setInterval(function(){if(window.pbjs&&window.pbjs.version){cleanup();loadArm();}},50);
      function loaded(){cleanup();loadArm();}function error(){fail('prebid-load-error');}
      cleanup=function(){clearTimeout(timer);clearInterval(poll);s.removeEventListener('load',loaded);s.removeEventListener('error',error);};
      s.addEventListener('load',loaded);s.addEventListener('error',error);
    } else {
      insert(config.prebidPath,config.prebidIntegrity,loadArm,'prebid-load-error');
    }
  }
  // Wait for parser-created tags to exist before deciding to add a dependency.
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',dependency,{once:true});
  else dependency();
}

export function instrumentFullRuntime(source, release=AA_RELEASE) {
  const entry='if (window.__TESSERA_RUNTIME_STARTED) return;';
  const slot='window.adSlots[id] = slot;';
  assert.equal(source.split(entry).length,2,'Review runtime entry before instrumenting');
  assert.equal(source.split(slot).length,2,'Review owned-slot definition before instrumenting');
  const prefix=`if (!window.__adVariantDelivery || window.__adVariantDelivery.release !== ${JSON.stringify(release)} || !window.__adVariantDelivery.enter()) return;\n    `;
  const output=source.replace(entry,prefix+entry).replace(slot,slot+'\n                    window.__adVariantDelivery.apply(slot);');
  parse(output,{ecmaVersion:'latest'});
  return output;
}

export function staticAALoader(config) {
  assert.equal(config.release,AA_RELEASE);
  assert.deepEqual(Object.keys(config.arms).sort(),['A','B']);
  assert.equal(config.arms.A.integrity,config.arms.B.integrity,'A/A requires identical bytes');
  const output='('+bootStaticAA.toString()+')('+JSON.stringify(config).replace(/</g,'\\u003c')+');\n';
  parse(output,{ecmaVersion:'latest'});return output;
}
