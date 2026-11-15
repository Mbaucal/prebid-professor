import registry from './ab-loader-registry.json' with {type:'json'};

// Generic A/B loader for every site (MBA-416). A released loader version never changes:
// a new behaviour is a new file and a new registry entry (ab-loader-registry.json), and each
// version file is self-contained, so changing a later one never touches an earlier one.
// 1.0.1 fixes three gaps of 1.0.0, which stays registered unchanged:
//  - Trusted Types: under require-trusted-types-for 'script' a string src throws. The arm URL now
//    goes through a private policy that passes only this test's two arm URLs; when the page allows
//    no such policy, armStatus is 'trusted-types-blocked' instead of an uncaught exception.
//  - Every step after the owner marker fails closed: an arm element the page refuses takes the
//    onerror path (one control retry), and a GPT queue that cannot take the labels loads control
//    A unlabelled (status 'labels-unavailable').
//  - An old direct ads.js tag after the loader can start its runtime before the async arm, whose
//    start guard then returns. The loader watches which script sets __TESSERA_RUNTIME_STARTED and,
//    when it is not the arm, reports existing-runtime-conflict and removes its labels.
export const AB_LOADER_VERSION='1.0.1';
export const AB_LOADER_PLACEHOLDER='__TESSERA_AB_CONFIG__';
export const AB_LOADER_CONFIG_SCHEMA='tessera-ab-loader-config-1';

// A literal, never Function.prototype.toString output: bundlers rename identifiers inside
// function text (scripts/canonical-text-guard.mjs). It holds no backslash and no
// substitution, so the template literal's value is exactly the text below.
export const AB_LOADER_TEMPLATE=`/* tessera-ab-loader 1.0.1 */
(function (config) {
  'use strict';
  var w = window, d = document, tag = d.currentScript, base = null, nonce = '';
  var assigned = null, forced = null, status = 'starting', arm = null, script = null, armStatus = null;
  var fallback = false, retried = false, duplicates = 0, keyConflict = false;
  var element = null, labelled = false, policy = null;
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function checkKeys() {
    var sets = [w.adsKeywords, w.ADS_KEYWORDS];
    for (var i = 0; i < sets.length; i++) {
      try { if (sets[i] && typeof sets[i] === 'object' && (own(sets[i], 'Variant') || own(sets[i], 'TestId'))) keyConflict = true; } catch (_) {}
    }
    return keyConflict;
  }
  function prebidVersion() {
    var p = w.pbjs;
    return p && typeof p.version === 'string' ? p.version.replace(/^v/, '') : null;
  }
  function snapshot() {
    return Object.freeze({loader: config.loader.version, release: config.id, testId: config.testId, testName: config.name,
      variant: assigned || forced, status: status, deliveryMode: 'ab',
      scriptRelease: arm ? arm.release : null, scriptName: arm ? arm.name : null, script: script,
      scriptSha256: arm ? arm.sha256 : null, armStatus: armStatus, trafficBPercent: config.trafficBPercent,
      prebidVersion: prebidVersion(), blockedDuplicateLoaders: duplicates, fallback: fallback,
      keyConflict: checkKeys(), runtimeStarted: !!w.__TESSERA_RUNTIME_STARTED});
  }
  function inspect() {
    var s = snapshot();
    if (w.console && typeof w.console.table === 'function') w.console.table([s]);
    return s;
  }
  function publish() { if (!w.AdVariant) w.AdVariant = Object.freeze({snapshot: snapshot, inspect: inspect}); }
  function label() {
    var g = w.googletag = w.googletag || {cmd: []};
    g.cmd = g.cmd || [];
    g.cmd.push(function () {
      // A pageview that left the test before GPT ran its queue gets no labels.
      if (!assigned) return;
      try {
        var p = w.googletag.pubads();
        labelled = true;
        p.setTargeting('Variant', assigned);
        p.setTargeting('TestId', config.testId);
      } catch (_) {}
    });
  }
  // Another runtime started instead of the arm: the page leaves the test and keeps no labels.
  function conflict() {
    status = 'existing-runtime-conflict'; assigned = forced = null;
    if (!labelled) return;
    try {
      w.googletag.cmd.push(function () {
        try { var p = w.googletag.pubads(); p.clearTargeting('Variant'); p.clearTargeting('TestId'); } catch (_) {}
      });
    } catch (_) {}
  }
  // Every runtime sets this flag at the top of its first script, so the script running at that
  // moment shows whose runtime the page got: the arm, or another tag such as an old direct ads.js.
  function watchStart() {
    var value = w.__TESSERA_RUNTIME_STARTED;
    try {
      Object.defineProperty(w, '__TESSERA_RUNTIME_STARTED', {configurable: true, enumerable: true,
        get: function () { return value; },
        set: function (next) {
          var first = !value && next;
          value = next;
          if (first && (!element || d.currentScript !== element)) conflict();
        }});
    } catch (_) {}
  }
  function armUrl(side) { return new URL(config.arms[side].path, base).href; }
  // A string src throws under require-trusted-types-for 'script'. The policy stays private to this
  // run and passes only this test's two arm URLs; when the page's trusted-types directive refuses the
  // name, the plain string is used, which works wherever Trusted Types are not required.
  function scriptUrl(url) {
    if (policy === null) {
      policy = false;
      try {
        if (w.trustedTypes && typeof w.trustedTypes.createPolicy === 'function') policy = w.trustedTypes.createPolicy('tessera-ab-loader', {
          createScriptURL: function (u) { if (u !== armUrl('A') && u !== armUrl('B')) throw new TypeError('Not an arm of this test'); return u; }});
      } catch (_) { policy = false; }
    }
    return policy ? policy.createScriptURL(url) : url;
  }
  function insert(next) {
    var s = null, blocked = false;
    arm = next; armStatus = 'loading'; element = null;
    try {
      script = new URL(next.path, base).href;
      s = d.createElement('script');
      s.async = true;
      blocked = true; s.src = scriptUrl(script); blocked = false;
      s.integrity = next.integrity; s.crossOrigin = 'anonymous';
      if (nonce) { s.nonce = nonce; s.setAttribute('nonce', nonce); }
      s.onload = function () { s.onload = s.onerror = null; armStatus = 'loaded'; };
      s.onerror = function () { s.onload = s.onerror = null; failed('error'); };
      element = s;
      (d.head || d.documentElement).appendChild(s);
    } catch (_) {
      // Any refused step takes the onerror path, so the one control retry still applies.
      if (s) s.onload = s.onerror = null;
      element = null;
      failed(blocked ? 'trusted-types-blocked' : 'error');
    }
  }
  // One control retry for an assigned pageview, never once any runtime has started.
  function failed(reason) {
    armStatus = reason;
    if (!assigned || retried || w.__TESSERA_RUNTIME_STARTED) return;
    retried = fallback = true; status = 'fallback-control';
    insert(config.arms.A);
  }
  try { base = tag && tag.src ? new URL(tag.src) : null; } catch (_) { base = null; }
  if (!base) { status = 'no-current-script'; publish(); return; }
  if (w.__tesseraAbLoader) { w.__tesseraAbLoader.duplicate(); return; }
  w.__tesseraAbLoader = Object.freeze({version: config.loader.version, release: config.id,
    duplicate: function () { duplicates++; }, snapshot: snapshot});
  if (w.__TESSERA_RUNTIME_STARTED || w.__tesseraExperimentOwner || w.AdVariant) {
    status = 'existing-runtime-conflict'; publish(); return;
  }
  // Pilot loaders refuse to start while this marker is set.
  w.__tesseraExperimentOwner = 'tessera-ab-loader-' + config.loader.version;
  publish();
  watchStart();
  nonce = tag.nonce || (typeof tag.getAttribute === 'function' && tag.getAttribute('nonce')) || '';
  var qa = /(?:^[?]|&)tessera_ab=([AB])(?:&|$)/.exec(w.location && w.location.search || '');
  if (qa) { forced = qa[1]; status = 'forced'; insert(config.arms[forced]); return; }
  try {
    var sample = new Uint32Array(1);
    w.crypto.getRandomValues(sample);
    assigned = sample[0] < 4294967296 * (100 - config.trafficBPercent) / 100 ? 'A' : 'B';
  } catch (_) { status = 'random-unavailable'; insert(config.arms.A); return; }
  status = 'assigned';
  // Without a GPT queue for the labels the pageview cannot be measured: control A, unlabelled.
  try { label(); } catch (_) { assigned = null; status = 'labels-unavailable'; insert(config.arms.A); return; }
  insert(config.arms[assigned]);
})(__TESSERA_AB_CONFIG__);
`;

const ID=/^abx-[a-f0-9]{64}$/,TEST_ID=/^[a-z0-9_]{1,24}$/,SHA256=/^[a-f0-9]{64}$/,SRI=/^sha384-[A-Za-z0-9+/]{64}$/;
const RELEASE=/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/,RUNTIME=/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/;
const ARM_KEYS=['release','name','runtimeVersion','path','sha256','integrity'];
const KEYS=['schema','id','testId','name','trafficBPercent','arms','loader'];
const REBUILD='Rebuild the test bundle with this version of Tessera.';
const check=(ok,message)=>{if(!ok)throw Object.assign(new Error(message),{status:400});};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
// JSON is valid JavaScript; escaping these keeps a name such as "</script>" inside the string.
const SAFE={'<':'\\u003c','>':'\\u003e','&':'\\u0026','\u2028':'\\u2028','\u2029':'\\u2029'};
const scriptJson=value=>JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,c=>SAFE[c]);

function arm(value,side){
  check(exact(value,ARM_KEYS),`Version ${side} has missing or unexpected fields. Choose the saved version again.`);
  check(typeof value.release==='string'&&RELEASE.test(value.release),`Version ${side} has an invalid release id. Choose a saved version again.`);
  check(value.path===`r/${value.release}/ads.js`,`Version ${side} must be served from r/<release id>/ads.js. ${REBUILD}`);
  check(typeof value.sha256==='string'&&SHA256.test(value.sha256),`Version ${side} needs the sha256 of its script as 64 lowercase hexadecimal characters. ${REBUILD}`);
  check(typeof value.integrity==='string'&&SRI.test(value.integrity),`Version ${side} needs the sha384 integrity value of its script. ${REBUILD}`);
  check(text(value.name,160),`Give version ${side} a name of 1 to 160 characters.`);
  check(typeof value.runtimeVersion==='string'&&RUNTIME.test(value.runtimeVersion),`Version ${side} needs its runtime version, for example 3.23.0. Choose the saved version again.`);
  return Object.fromEntries(ARM_KEYS.map(k=>[k,value[k]]));
}

/** Validates one test's loader configuration and returns the public ads.js text.
 * The same configuration always gives the same bytes, whatever its key order. */
export function renderAbLoader(config){
  check(exact(config,KEYS),`The A/B loader configuration has missing or unexpected fields. ${REBUILD}`);
  check(config.schema===AB_LOADER_CONFIG_SCHEMA,`The A/B loader configuration has an unknown schema. ${REBUILD}`);
  check(typeof config.id==='string'&&ID.test(config.id),'The test id must be "abx-" followed by 64 lowercase hexadecimal characters. Save the test again to get a valid id.');
  check(typeof config.testId==='string'&&TEST_ID.test(config.testId),'Use a TestId of 1 to 24 lowercase letters, digits or underscores, for example "site_1".');
  check(text(config.name,60),'Give the test a name of 1 to 60 characters.');
  check(Number.isInteger(config.trafficBPercent)&&config.trafficBPercent>=0&&config.trafficBPercent<=100,'Use a whole number from 0 to 100 for the B traffic share.');
  check(exact(config.arms,['A','B']),'The test needs exactly two versions, A and B. Choose both saved versions again.');
  const A=arm(config.arms.A,'A'),B=arm(config.arms.B,'B');
  // A/A is allowed, but one release id always means one file.
  check(A.release!==B.release||ARM_KEYS.every(k=>A[k]===B[k]),'Versions A and B use the same release with different details. Choose the saved versions again.');
  const entry=registry[AB_LOADER_VERSION];
  check(exact(config.loader,['version','sha256'])&&config.loader.version===AB_LOADER_VERSION,`This bundle needs A/B loader ${AB_LOADER_VERSION}. ${REBUILD}`);
  check(config.loader.sha256===entry.sha256,`The loader checksum does not match the registered A/B loader ${AB_LOADER_VERSION}. ${REBUILD}`);
  const parts=AB_LOADER_TEMPLATE.split(AB_LOADER_PLACEHOLDER);
  check(parts.length===2,'The A/B loader template must contain exactly one configuration placeholder. Restore the released loader file.');
  const normalized={schema:AB_LOADER_CONFIG_SCHEMA,id:config.id,testId:config.testId,name:config.name,trafficBPercent:config.trafficBPercent,
    arms:{A,B},loader:{version:AB_LOADER_VERSION,sha256:entry.sha256}};
  return parts[0]+scriptJson(normalized)+parts[1];
}
