import registry from './ab-loader-registry.json' with {type:'json'};

// 1.1.1 keeps valid pending scripts eligible after a soft loading deadline.
// Exactly one supported native startup guard claims execution; observations stay local.
export const AB_LOADER_VERSION='1.1.1';
export const AB_LOADER_PLACEHOLDER='__TESSERA_AB_CONFIG__';
export const AB_LOADER_CONFIG_SCHEMA='tessera-ab-loader-config-2';

export const AB_LOADER_TEMPLATE=`/* tessera-ab-loader 1.1.1 */
(function (config) {
  'use strict';
  var w = window, d = document, tag = d.currentScript, base = null, nonce = '';
  var assigned = null, forced = null, status = 'starting', arm = null, script = null, armStatus = null;
  var fallback = false, duplicates = 0, keyConflict = false, exclusion = null;
  var policy = null, gateTimer = null, launched = false, controlOnly = false;
  var attempts = [], winner = null, fallbackRequested = false, controlRetryRequested = false, controlReason = null;
  var blockedLate = 0, runtimeValue = w.__TESSERA_RUNTIME_STARTED, guardReady = false, terminalObserved = false;
  var service = null, nativeSet = null, nativeClear = null, writingOwn = false, everLabelled = false, owned = {};
  var originalAssignment = null, pageId = null, identityTried = false, events = [], droppedEvents = 0, eventSequence = 0, createdAt = null;
  function stamp() { try { return new Date().toISOString(); } catch (_) { return null; } }
  createdAt = stamp();
  function observe(type, detail) {
    try {
      identifyPage();
      var row = {seq: ++eventSequence, at: stamp(), type: type};
      for (var k in detail) if (Object.prototype.hasOwnProperty.call(detail, k)) row[k] = detail[k];
      if (events.length < 64) events.push(row); else droppedEvents++;
    } catch (_) {}
  }
  function identifyPage() {
    if (identityTried) return;
    identityTried = true;
    try {
      var values = new Uint32Array(4), parts = [];
      w.crypto.getRandomValues(values);
      for (var i = 0; i < values.length; i++) parts.push(('00000000' + values[i].toString(16)).slice(-8));
      pageId = parts.join('');
    } catch (_) { pageId = null; }
  }
  function measurement() {
    var pins = function (v) { return {release: v.release, scriptSha256: v.sha256}; };
    // Returning a copy keeps the original random assignment and event sequence private.
    return JSON.parse(JSON.stringify({schemaVersion: 2, kind: 'tessera-ab-memory-measurement',
      site: config.site, experimentId: config.id, testId: config.testId, loader: config.loader,
      trafficBPercent: config.trafficBPercent, arms: {A: pins(config.arms.A), B: pins(config.arms.B)},
      pageId: pageId, createdAt: createdAt, assignment: originalAssignment, events: events,
      droppedEvents: droppedEvents, collection: 'memory-only', coverage: 'unknown', consentPolicy: 'native-runtime-unchanged'}));
  }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function reserved(k) { return k === 'Variant' || k === 'TestId'; }
  function started() { return guardReady ? !!runtimeValue : !!w.__TESSERA_RUNTIME_STARTED; }
  function clearAttemptTimer(attempt) { if (attempt.timer !== null) w.clearTimeout(attempt.timer); attempt.timer = null; }
  function clearTimers() { for (var i = 0; i < attempts.length; i++) clearAttemptTimer(attempts[i]); }
  function clearGateTimer() { if (gateTimer !== null) w.clearTimeout(gateTimer); gateTimer = null; }
  function checkKeys() {
    var names = ['adsKeywords', 'ADS_KEYWORDS'];
    for (var i = 0; i < names.length; i++) {
      try { var set = w[names[i]]; if (set && typeof set === 'object' && (own(set, 'Variant') || own(set, 'TestId'))) keyConflict = true; } catch (_) { keyConflict = true; }
    }
    return keyConflict;
  }
  function cleanKeywordCopies() {
    var names = ['adsKeywords', 'ADS_KEYWORDS'];
    for (var i = 0; i < names.length; i++) {
      try {
        var original = w[names[i]];
        if (!original || typeof original !== 'object' || (!own(original, 'Variant') && !own(original, 'TestId'))) continue;
        var copy = Object.create(null);
        for (var k in original) if (own(original, k) && !reserved(k)) copy[k] = original[k];
        w[names[i]] = copy;
      } catch (_) {}
    }
  }
  function clearOwned() {
    if (!service || !nativeClear || typeof service.getTargeting !== 'function') return;
    for (var k in owned) if (own(owned, k)) {
      try {
        var current = service.getTargeting(k), keep = [], removed = false;
        for (var i = 0; i < current.length; i++) {
          if (current[i] === owned[k]) removed = true; else keep.push(current[i]);
        }
        if (removed) {
          if (keep.length) nativeSet.call(service, k, keep); else nativeClear.call(service, k);
        }
      } catch (_) {}
      delete owned[k];
    }
  }
  function exclude(reason, deferControl) {
    if (exclusion !== reason) observe('exclusion', {reason: reason, phase: originalAssignment ? 'after-assignment' : 'before-assignment'});
    exclusion = reason; status = reason; assigned = forced = null; controlOnly = true;
    clearOwned();
    if (!started() && attempts.length) {
      var hasControl = false;
      for (var i = 0; i < attempts.length; i++) {
        if (attempts[i].arm === config.arms.A && attempts[i].eligible) hasControl = true;
        if (attempts[i].arm !== config.arms.A) retire(attempts[i], 'excluded');
      }
      if (!hasControl && attempts.length < 2 && !deferControl) { controlReason = reason; insert(config.arms.A); }
      if (!deferControl) updatePending(reason);
    }
  }
  function excludeKeys(deferControl) { keyConflict = true; cleanKeywordCopies(); exclude('excluded-key-conflict', deferControl); }
  function snapshot() {
    var p = w.pbjs;
    return Object.freeze({loader: config.loader.version, release: config.id, testId: config.testId, testName: config.name,
      variant: assigned || forced, status: status, deliveryMode: 'ab',
      scriptRelease: arm ? arm.release : null, scriptName: arm ? arm.name : null, script: script,
      scriptSha256: arm ? arm.sha256 : null, armStatus: armStatus, trafficBPercent: config.trafficBPercent,
      prebidVersion: p && typeof p.version === 'string' ? p.version.replace(/^v/, '') : null,
      blockedDuplicateLoaders: duplicates, fallback: fallback, keyConflict: keyConflict,
      runtimeStarted: started(), executionArm: winner ? winner.side : null, exclusionReason: exclusion,
      blockedLateArmStarts: blockedLate, armDeadlineMs: 8000, originalVariant: originalAssignment ? originalAssignment.variant : null,
      fallbackRequested: fallbackRequested, controlRetryRequested: controlRetryRequested,
      attempts: attempts.map(function (attempt) { return {arm: attempt.side, state: attempt.state, eligible: attempt.eligible, deadlineExceeded: attempt.deadlineExceeded}; }),
      measurement: {collection: 'memory-only', coverage: 'unknown', droppedEvents: droppedEvents}});
  }
  function inspect() { var s = snapshot(); if (w.console && typeof w.console.table === 'function') w.console.table([s]); return s; }
  function publish() { if (!w.AdVariant) w.AdVariant = Object.freeze({snapshot: snapshot, inspect: inspect, measurement: measurement}); }
  function currentAttempt() {
    for (var i = 0; i < attempts.length; i++) if (attempts[i].element && d.currentScript === attempts[i].element) return attempts[i];
    return null;
  }
  function retire(attempt, state) {
    clearAttemptTimer(attempt); attempt.eligible = false; attempt.state = state;
    var old = attempt.element;
    if (!old) return;
    old.onload = old.onerror = null;
    try { if (old.parentNode) old.parentNode.removeChild(old); else if (typeof old.remove === 'function') old.remove(); } catch (_) {}
  }
  function claim(attempt, next) {
    winner = attempt; runtimeValue = next; arm = attempt.arm; script = attempt.url;
    attempt.state = 'started'; armStatus = 'started'; clearTimers(); clearGateTimer();
    for (var i = 0; i < attempts.length; i++) if (attempts[i] !== attempt) retire(attempts[i], 'superseded');
    fallback = !!originalAssignment && originalAssignment.variant === 'B' && attempt.side === 'A';
    if (!exclusion) status = fallback ? 'fallback-control' : assigned ? 'assigned' : status;
    observe('runtime-started', {arm: attempt.side});
    if (fallback) observe('fallback', {fromArm: 'B', toArm: 'A', reason: controlReason || 'control'});
  }
  function watchStart() {
    try {
      Object.defineProperty(w, '__TESSERA_RUNTIME_STARTED', {configurable: true, enumerable: true,
        get: function () {
          var attempt = currentAttempt();
          if (attempt && (!attempt.eligible || winner && winner !== attempt)) { blockedLate++; return true; }
          if (!runtimeValue && attempt && attempt.arm !== config.arms.A && checkKeys()) {
            excludeKeys(); blockedLate++; return true;
          }
          // Publisher getters consulted above may reenter the targeting gate.
          if (attempt && (!attempt.eligible || winner && winner !== attempt)) { blockedLate++; return true; }
          return runtimeValue;
        },
        set: function (next) {
          var attempt = currentAttempt();
          if (attempt && (!attempt.eligible || winner && winner !== attempt)) return;
          // Native startup is monotonic. A later write cannot reopen a claimed runtime.
          if (runtimeValue || !next) return;
          // The native body continues after this assignment. Claim it before
          // consulting publisher getters again, which may change or reenter.
          if (attempt && attempt.eligible) {
            claim(attempt, next);
            if (checkKeys()) excludeKeys();
            return;
          }
          if (attempt) return;
          runtimeValue = next; clearTimers(); clearGateTimer();
          for (var i = 0; i < attempts.length; i++) retire(attempts[i], 'external-runtime');
          armStatus = 'external-runtime';
          exclude('existing-runtime-conflict');
          if (checkKeys()) excludeKeys();
        }});
      guardReady = true;
    } catch (_) { guardReady = false; }
    return guardReady;
  }
  function armUrl(side) { return new URL(config.arms[side].path, base).href; }
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
  function updatePending(reason) {
    if (winner || started()) return;
    var pending = null, hasTimer = false;
    for (var i = 0; i < attempts.length; i++) if (attempts[i].eligible) {
      pending = attempts[i]; if (attempts[i].timer !== null) hasTimer = true;
    }
    if (pending) {
      arm = pending.arm; script = pending.url; armStatus = hasTimer ? 'loading' : 'pending';
      if (!exclusion) status = hasTimer ? fallbackRequested ? 'waiting-control' : controlRetryRequested ? 'retry-control' : status : 'waiting-for-arm';
      return;
    }
    armStatus = reason || 'error';
    if (!exclusion) status = 'control-load-error';
    if (!terminalObserved && attempts.length) {
      terminalObserved = true;
      observe('terminal-failure', {arm: attempts[attempts.length - 1].side, reason: reason || 'error'});
    }
  }
  function requestControl(attempt, reason) {
    if (attempts.length >= 2 || controlOnly || !assigned || !guardReady || started()) return;
    controlReason = reason;
    if (attempt.side === 'A') {
      controlRetryRequested = true; observe('control-retry', {arm: 'A', reason: reason});
    } else {
      fallbackRequested = true; observe('fallback-requested', {fromArm: 'B', toArm: 'A', reason: reason});
    }
    insert(config.arms.A);
  }
  function insert(next) {
    var s = null, blocked = false;
    if (started() || attempts.length >= 2) return;
    if (checkKeys()) { excludeKeys(true); next = config.arms.A; }
    if (started() || attempts.length >= 2) return;
    arm = next; armStatus = 'loading';
    var attempt = {arm: next, side: next === config.arms.B ? 'B' : 'A', element: null, url: null,
      timer: null, eligible: true, deadlineExceeded: false, state: 'loading'};
    attempts.push(attempt);
    try {
      script = new URL(next.path, base).href; attempt.url = script;
      s = d.createElement('script'); s.async = true;
      attempt.element = s;
      blocked = true; s.src = scriptUrl(script); blocked = false;
      s.integrity = next.integrity; s.crossOrigin = 'anonymous';
      if (nonce) { s.nonce = nonce; s.setAttribute('nonce', nonce); }
      s.onload = function () {
        if (!attempt.eligible && winner !== attempt) return;
        observe('script-loaded', {arm: attempt.side});
        if (winner === attempt || !guardReady && started()) {
          s.onload = s.onerror = null; clearAttemptTimer(attempt); attempt.state = 'loaded'; armStatus = 'loaded';
        } else failed(attempt, 'no-start');
      };
      s.onerror = function () { if (attempt.eligible) failed(attempt, 'error'); };
      attempt.timer = w.setTimeout(function () {
        attempt.timer = null;
        if (!attempt.eligible || started()) return;
        attempt.deadlineExceeded = true; attempt.state = 'slow';
        observe('arm-deadline', {arm: attempt.side});
        requestControl(attempt, 'timeout'); updatePending('timeout');
      }, 8000);
      observe('script-requested', {arm: attempt.side});
      (d.head || d.documentElement).appendChild(s);
    } catch (_) {
      if (s) s.onload = s.onerror = null;
      failed(attempt, blocked ? 'trusted-types-blocked' : 'error');
    }
  }
  function failed(attempt, reason) {
    if (winner || started()) { clearAttemptTimer(attempt); return; }
    if (!attempt.eligible) return;
    observe('arm-failed', {arm: attempt.side, reason: reason}); retire(attempt, reason);
    requestControl(attempt, reason); updatePending(reason);
  }
  function installGate(p) {
    if (!p || typeof p.setTargeting !== 'function' || typeof p.clearTargeting !== 'function' || typeof p.getTargeting !== 'function' || typeof p.getSlots !== 'function' || typeof p.refresh !== 'function') return false;
    service = p; nativeSet = p.setTargeting; nativeClear = p.clearTargeting;
    function verifyDispatch(slots) {
      if (!everLabelled || exclusion || !assigned) return;
      try {
        var variant = p.getTargeting('Variant'), test = p.getTargeting('TestId');
        if (variant.length !== 1 || variant[0] !== assigned || test.length !== 1 || test[0] !== config.testId) { excludeKeys(); return; }
        if (slots === undefined || slots === null) slots = p.getSlots();
        if (!Array.isArray(slots)) return;
        for (var i = 0; i < slots.length; i++) {
          var slot = slots[i];
          if (slot && typeof slot.getTargeting === 'function' && (slot.getTargeting('Variant').length || slot.getTargeting('TestId').length)) { excludeKeys(); return; }
        }
      } catch (_) { exclude('labels-unavailable'); }
    }
    var set = function (key) {
      if (everLabelled && reserved(key) && !writingOwn) { excludeKeys(); return this; }
      return nativeSet.apply(this, arguments);
    };
    var clear = function (key) {
      if (everLabelled && !writingOwn && (arguments.length === 0 || reserved(key))) exclude('excluded-targeting-cleared');
      return nativeClear.apply(this, arguments);
    };
    try {
      p.setTargeting = set; p.clearTargeting = clear;
      if (p.setTargeting !== set || p.clearTargeting !== clear) return false;
      var nativeRefresh = p.refresh;
      var refresh = function (slots) { verifyDispatch(slots); return nativeRefresh.apply(this, arguments); };
      p.refresh = refresh;
      if (p.refresh !== refresh) return false;
      var g = w.googletag, originalConfig = g.setConfig, originalDisplay = g.display;
      if (typeof originalDisplay !== 'function') return false;
      var display = function () { verifyDispatch(); return originalDisplay.apply(this, arguments); };
      g.display = display;
      if (g.display !== display) return false;
      if (typeof originalConfig === 'function') {
        var setConfig = function (config) {
          var args = arguments;
          if (everLabelled && config && typeof config === 'object' && own(config, 'targeting')) {
            var targeting = config.targeting;
            if (targeting && typeof targeting === 'object' && (own(targeting, 'Variant') || own(targeting, 'TestId'))) {
              excludeKeys();
              var clean = {}, keys = {}, k;
              for (k in config) if (own(config, k) && k !== 'targeting') clean[k] = config[k];
              for (k in targeting) if (own(targeting, k) && !reserved(k)) keys[k] = targeting[k];
              clean.targeting = keys;
              args = Array.prototype.slice.call(arguments); args[0] = clean;
            } else if (targeting === null) exclude('excluded-targeting-cleared');
          }
          return originalConfig.apply(this, args);
        };
        g.setConfig = setConfig;
        if (g.setConfig !== setConfig) return false;
      }
    } catch (_) { return false; }
    return true;
  }
  function launch() {
    if (launched || started()) return;
    launched = true; clearGateTimer(); insert(config.arms[assigned || forced || 'A']);
  }
  function prepareLabels() {
    var g = w.googletag = w.googletag || {cmd: []}; g.cmd = g.cmd || [];
    status = 'waiting-gpt';
    gateTimer = w.setTimeout(function () { exclude('labels-unavailable'); launch(); }, 8000);
    g.cmd.push(function () {
      clearGateTimer();
      try {
        var p = w.googletag.pubads();
        if (!installGate(p)) { exclude('labels-unavailable'); launch(); return; }
        if (checkKeys() || p.getTargeting('Variant').length || p.getTargeting('TestId').length) { excludeKeys(); launch(); return; }
        if (assigned) {
          writingOwn = true;
          try {
            p.setTargeting('Variant', assigned); owned.Variant = assigned; everLabelled = true;
            p.setTargeting('TestId', config.testId); owned.TestId = config.testId;
          } finally { writingOwn = false; }
          status = 'assigned';
        }
      } catch (_) { writingOwn = false; exclude('labels-unavailable'); }
      launch();
    });
  }
  try { base = tag && tag.src ? new URL(tag.src) : null; } catch (_) { base = null; }
  if (!base) { status = 'no-current-script'; observe('exclusion', {reason: status, phase: 'before-assignment'}); publish(); return; }
  if (w.__tesseraAbLoader) { w.__tesseraAbLoader.duplicate(); return; }
  w.__tesseraAbLoader = Object.freeze({version: config.loader.version, release: config.id,
    duplicate: function () { duplicates++; observe('duplicate-loader', {}); }, snapshot: snapshot, measurement: measurement});
  if (started() || w.__tesseraExperimentOwner || w.AdVariant) { status = 'existing-runtime-conflict'; observe('exclusion', {reason: status, phase: 'before-assignment'}); publish(); return; }
  w.__tesseraExperimentOwner = 'tessera-ab-loader-' + config.loader.version;
  publish();
  nonce = tag.nonce || (typeof tag.getAttribute === 'function' && tag.getAttribute('nonce')) || '';
  if (!watchStart()) { exclude('startup-guard-unavailable'); launch(); return; }
  if (checkKeys()) { excludeKeys(); launch(); return; }
  var qa = /(?:^[?]|&)tessera_ab=([AB])(?:&|$)/.exec(w.location && w.location.search || '');
  if (qa) { forced = qa[1]; controlOnly = true; status = 'forced'; observe('qa-forced', {arm: forced}); launch(); return; }
  try {
    var sample = new Uint32Array(1); w.crypto.getRandomValues(sample);
    assigned = sample[0] < 4294967296 * (100 - config.trafficBPercent) / 100 ? 'A' : 'B';
  } catch (_) { controlOnly = true; status = 'random-unavailable'; observe('random-unavailable', {}); launch(); return; }
  identifyPage();
  originalAssignment = {variant: assigned, at: stamp()};
  observe('assignment', {variant: assigned});
  try { prepareLabels(); } catch (_) { exclude('labels-unavailable'); launch(); }
})(__TESSERA_AB_CONFIG__);
`;

const ID=/^abx-[a-f0-9]{64}$/,TEST_ID=/^[a-z0-9_]{1,24}$/,SHA256=/^[a-f0-9]{64}$/,SRI=/^sha384-[A-Za-z0-9+/]{64}$/;
const RELEASE=/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/,RUNTIME=/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/;
const ARM_KEYS=['release','name','runtimeVersion','path','sha256','integrity'];
const KEYS=['schema','id','site','testId','name','trafficBPercent','arms','loader'];
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
  check(typeof config.site==='string'&&/^[a-z0-9][a-z0-9-]{0,97}$/.test(config.site),'Choose the site belonging to this saved test.');
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
  const normalized={schema:AB_LOADER_CONFIG_SCHEMA,id:config.id,site:config.site,testId:config.testId,name:config.name,trafficBPercent:config.trafficBPercent,
    arms:{A,B},loader:{version:AB_LOADER_VERSION,sha256:entry.sha256}};
  return parts[0]+scriptJson(normalized)+parts[1];
}
