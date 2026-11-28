import registry from './ab-loader-registry.json' with {type:'json'};

// Original-source mode: one immutable arm, no timeout fallback or retry. Legacy A has no
// native startup guard, so a late script must never race a second inserted arm.
// The original scripts retain their CMP/Prebid handling; the loader uses no storage or CMP API.
export const AB_LOADER_VERSION='1.3.0';
export const AB_REPORTING_KEY='VersionId';
export const AB_LOADER_CONFIG_SCHEMA='tessera-original-ab-loader-config-1';
export const AB_LOADER_PLACEHOLDER='__TESSERA_AB_CONFIG__';
export const AB_LOADER_TEMPLATE=`/* tessera-ab-loader 1.3.0: original scripts, single attempt */
(function (config) {
  'use strict';
  var w = window, d = document, tag = d.currentScript, base = null;
  var variant = null, status = 'starting', arm = null, element = null, duplicates = 0;
  var service = null, owned = {}, failed = false, forced = false;
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function snapshot() {
    return Object.freeze({loader: config.loader.version, release: config.id, testId: config.testId,
      versionId: config.testId, reportingKey: 'VersionId', testName: config.name, variant: variant,
      status: status, deliveryMode: 'ab', scriptRelease: arm ? arm.release : null,
      scriptName: arm ? arm.name : null, scriptSha256: arm ? arm.sha256 : null,
      script: element ? String(element.src) : null, trafficBPercent: config.trafficBPercent,
      prebidVersion: w.pbjs && typeof w.pbjs.version === 'string' ? w.pbjs.version : null,
      blockedDuplicateLoaders: duplicates, fallback: false, collection: 'disabled', coverage: 'unknown'});
  }
  function publish() { if (!w.AdVariant) w.AdVariant = Object.freeze({snapshot: snapshot, inspect: snapshot}); }
  function clearOwn() {
    if (!service) return;
    for (var key in owned) if (own(owned, key)) {
      try { var values = service.getTargeting(key); if (values.length === 1 && values[0] === owned[key]) service.clearTargeting(key); } catch (_) {}
    }
    owned = {};
  }
  function exclude(reason) { failed = true; status = reason; clearOwn(); }
  function keywordConflict() {
    var names = ['adsKeywords', 'ADS_KEYWORDS'];
    for (var i = 0; i < names.length; i++) {
      var value = w[names[i]];
      if (value && typeof value === 'object' && (own(value, 'Variant') || own(value, 'VersionId'))) return true;
    }
    return false;
  }
  try { base = tag && tag.src ? new URL(tag.src) : null; } catch (_) {}
  if (!base) { status = 'no-current-script'; publish(); return; }
  if (w.__tesseraAbLoader) { if (typeof w.__tesseraAbLoader.duplicate === 'function') w.__tesseraAbLoader.duplicate(); return; }
  if (w.__TESSERA_RUNTIME_STARTED || w.ADS_BUILD_TS || w.__tesseraExperimentOwner || w.AdVariant) {
    status = 'existing-runtime-conflict'; publish(); return;
  }
  w.__tesseraAbLoader = Object.freeze({version: config.loader.version, release: config.id,
    duplicate: function () { duplicates++; }, snapshot: snapshot});
  w.__tesseraExperimentOwner = 'tessera-ab-loader-' + config.loader.version;
  publish();
  try {
    if (keywordConflict()) { status = 'excluded-key-conflict'; return; }
    var qa = /(?:^[?]|&)tessera_ab=([AB])(?:&|$)/.exec(w.location && w.location.search || '');
    if (qa) { variant = qa[1]; forced = true; status = 'forced'; }
    else {
      var sample = new Uint32Array(1);
      try { w.crypto.getRandomValues(sample); variant = sample[0] < 4294967296 * (100 - config.trafficBPercent) / 100 ? 'A' : 'B'; status = 'assigned'; }
      catch (_) { variant = 'A'; forced = true; status = 'random-unavailable'; }
    }
    arm = config.arms[variant];
    if (!forced) {
      var g = w.googletag = w.googletag || {cmd: []}; g.cmd = g.cmd || [];
      g.cmd.push(function () {
        if (failed) return;
        try {
          service = g.pubads();
          if (keywordConflict() || service.getTargeting('Variant').length || service.getTargeting('VersionId').length) { exclude('excluded-key-conflict'); return; }
          owned.Variant = variant; service.setTargeting('Variant', variant);
          owned.VersionId = config.testId; service.setTargeting('VersionId', config.testId);
        } catch (_) { exclude('labels-unavailable'); }
      });
      if (failed) return;
    }
    var url = new URL(arm.path, base).href, policy = null;
    if (w.trustedTypes && typeof w.trustedTypes.createPolicy === 'function') {
      try { policy = w.trustedTypes.createPolicy('tessera-original-ab-loader', {createScriptURL: function (value) {
        if (value !== url) throw new TypeError('Not the selected arm'); return value;
      }}); } catch (_) {}
    }
    element = d.createElement('script'); element.async = true;
    element.src = policy ? policy.createScriptURL(url) : url;
    element.integrity = arm.integrity; element.crossOrigin = 'anonymous';
    var nonce = tag.nonce || (typeof tag.getAttribute === 'function' && tag.getAttribute('nonce')) || '';
    if (nonce) { element.nonce = nonce; element.setAttribute('nonce', nonce); }
    element.onload = function () { element.onload = element.onerror = null; if (!failed && status === 'assigned') status = 'loaded'; };
    element.onerror = function () { element.onload = element.onerror = null; exclude('script-error'); };
    (d.head || d.documentElement).appendChild(element);
  } catch (_) { exclude('script-blocked'); }
})(__TESSERA_AB_CONFIG__);
`;

const check=(ok,message)=>{if(!ok)throw Object.assign(new Error(message),{status:400});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const HASH=/^[a-f0-9]{64}$/,ID=/^original-source-[a-f0-9]{64}$/;
const SAFE={'<':'\\u003c','>':'\\u003e','&':'\\u0026','\u2028':'\\u2028','\u2029':'\\u2029'};
export function renderAbLoader(config){
  check(exact(config,'schema,id,testId,name,trafficBPercent,arms,loader')&&config.schema===AB_LOADER_CONFIG_SCHEMA,'Invalid original-script loader configuration.');
  check(/^abx-[a-f0-9]{64}$/.test(config.id)&&/^[a-z0-9_]{1,24}$/.test(config.testId)&&text(config.name,60),'Invalid test identity.');
  check(Number.isInteger(config.trafficBPercent)&&config.trafficBPercent>=0&&config.trafficBPercent<=100,'Invalid traffic share.');
  check(exact(config.arms,'A,B'),'Choose two original script sources.');
  const arms={};
  for(const side of ['A','B']){
    const a=config.arms[side];
    check(exact(a,'release,name,runtimeVersion,path,sha256,integrity')&&ID.test(a.release)&&a.path===`r/${a.release}/ads.js`&&HASH.test(a.sha256)&&
      /^sha384-[A-Za-z0-9+/]{64}$/.test(a.integrity)&&text(a.name,160)&&text(a.runtimeVersion,60),'Invalid original script arm.');
    arms[side]=Object.fromEntries(['release','name','runtimeVersion','path','sha256','integrity'].map(k=>[k,a[k]]));
  }
  check(arms.A.release!==arms.B.release||JSON.stringify(arms.A)===JSON.stringify(arms.B),'One original source cannot have different details.');
  check(exact(config.loader,'version,sha256')&&config.loader.version===AB_LOADER_VERSION&&config.loader.sha256===registry[AB_LOADER_VERSION].sha256,'Invalid original-script loader pin.');
  const normalized={schema:AB_LOADER_CONFIG_SCHEMA,id:config.id,testId:config.testId,name:config.name,trafficBPercent:config.trafficBPercent,arms,
    loader:{version:AB_LOADER_VERSION,sha256:registry[AB_LOADER_VERSION].sha256}};
  return AB_LOADER_TEMPLATE.replace(AB_LOADER_PLACEHOLDER,()=>JSON.stringify(normalized).replace(/[<>&\u2028\u2029]/g,c=>SAFE[c]));
}
