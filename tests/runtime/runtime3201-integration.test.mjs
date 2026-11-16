import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {descriptor} from '../../.generated/runtime-3201-manifest.mjs';
import {previewInput} from '../../worker/runtime-3201/snapshot.mjs';
import {compileRuntime3201} from '../../worker/runtime-3201/compiler.mjs';
import {buildArtifactCandidate} from '../../worker/runtime-3201/artifact-candidate.mjs';
import {requireRevenueRuntime} from '../../worker/runtime-3201/settings-guard.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {prebidRequirements, inspectPrebidArtifact, sha256} from '../../worker/runtime/prebid-artifact-check.mjs';
import {escapeCssId, escapeHtml} from '../../shared/gam/ad-unit-code.mjs';
import {conditionalFixture, mapping} from '../support/conditional-maps-fixture.mjs';
import {configure} from './artifact-fixture.mjs';

const stamp = '20261110_101500';
const codes = ['m.box_3', 'm.InText_1', '1Banner', '-1Banner', 'slot.*"\\/!<:()', 'Članak', '投放', '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty'];
const decode = bytes => new TextDecoder().decode(bytes);
const plain = value => JSON.parse(JSON.stringify(value));
const input = snapshot => previewInput(snapshot, descriptor, stamp);
function fixture(prebid = false) {
  const snapshot = conditionalFixture({prebid});
  snapshot.units = codes.map(code => ({code, type: 'ATF', media_type: 'banner', enabled: 1, size_map_key: 'P2'}));
  snapshot.maps[0].map_json = JSON.stringify([{viewport: [768, 600], sizes: [[300, 250]]}, {viewport: [1024, 0], sizes: [[970, 90]]}]);
  snapshot.maps[1].map_json = JSON.stringify([{viewport: [0, 0], sizes: ['fluid']}, {viewport: [768, 600], sizes: [[300, 100]]}, {viewport: [768, 1000], sizes: [[300, 600]]}]);
  snapshot.rules = [{rule_key: '__DEFAULT__', rule_json: JSON.stringify({refresh: {enabled: false}})},
    ...codes.map(code => ({rule_key: code, rule_json: JSON.stringify({conditionalMappings: [mapping()]})}))];
  snapshot.overrides = prebid ? codes.map(code => ({bidder: 'ix', scope_type: 'adunit', scope_key: code, enabled: 1, params_json: JSON.stringify({siteId: 'exact-' + code, unrelated: code})})) : [];
  return snapshot;
}
function nodes(source) {
  const list = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    list.push(node);
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child);
  }
  visit(parse(source, {ecmaVersion: 2015})); return list;
}
function functionSource(source, name) {
  const found = nodes(source).filter(node => node.type === 'FunctionDeclaration' && node.id?.name === name);
  assert.equal(found.length, 1, name); return source.slice(found[0].start, found[0].end);
}
function variableSource(source, name) {
  const found = nodes(source).filter(node => node.type === 'VariableDeclarator' && node.id?.name === name);
  assert.equal(found.length, 1, name); return 'var ' + name + '=' + source.slice(found[0].init.start, found[0].init.end) + ';';
}
async function checked(snapshot, normalized) {
  const requirements = prebidRequirements(normalized, JSON.parse(snapshot.config.config_json));
  if (!requirements.required) return null;
  const bytes = new TextEncoder().encode(`/* prebid.js v11.11.0\nModules: ${requirements.modules.join(', ')} */\nvoid 0;`).buffer;
  const build = {id: 'fixture-build', publisher_id: snapshot.site.id, status: 'current', version: '11.11.0', file_key: `publishers/${snapshot.site.id}/prebid-builds/fixture-build/prebid.js`, modules_json: JSON.stringify(requirements.modules)};
  const object = {size: bytes.byteLength, customMetadata: {sha256: await sha256(bytes), version: '11.11.0'}, async arrayBuffer() {return bytes;}};
  const report = await inspectPrebidArtifact({siteId: snapshot.site.id, builds: [build], requirements}, {async get() {return object;}});
  return {bytes, report};
}

// These tests cross the two version boundaries: valid GAM identities must not
// lose conditional/viewport/resize behavior, and viewport fixes must not undo escaping.
test('combined snapshot retains exact codes, category/GEO rules, lower-bound normalization and stored settings', () => {
  const snapshot = fixture(true), before = structuredClone(snapshot), normalized = input(snapshot);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(normalized.core.explicitUnits.map(unit => unit.id), codes);
  assert.deepEqual(normalized.sizeMapNormalization.emptyBaselineAdded, ['P2']);
  assert.deepEqual(normalized.core.sizeMapsRaw.P2[0], {viewport: [0, 0], sizes: []});
  for (const code of codes) {
    assert.equal(normalized.core.bidderAdUnitParams.ix[code].siteId, 'exact-' + code);
    assert.equal(normalized.core.bidderAdUnitParams.ix[code].unrelated, code);
    assert.equal(normalized.conditionalUnits[code].rules[0].conditions[0].key, 'category');
    assert(normalized.conditionalCss.includes(`@media(min-width:768px) and (min-height:1000px){${escapeCssId(code)}[data-ad-size-map="1"]{min-height:600px;}}`));
  }
  snapshot.rules[1].rule_json = JSON.stringify({conditionalMappings: [mapping({conditions: [{key: 'geo_country', operator: 'equals', value: 'rs'}]})]});
  assert.equal(input(snapshot).conditionalUnits[codes[0]].usesGeo, true);
});

test('inactive dotted and prototype-name overrides stay saved, reactivate, and missing targets still fail', () => {
  for (const code of ['m.box_3', '__proto__', 'constructor']) {
    const snapshot = fixture(true); snapshot.units = [...snapshot.units.filter(unit => unit.code === code), {code: 'Control', type: 'ATF', enabled: 1, media_type: 'banner', size_map_key: 'P2'}]; snapshot.rules = []; snapshot.overrides = snapshot.overrides.filter(row => row.scope_key === code);
    const override = structuredClone(snapshot.overrides);
    for (const mode of ['disabled', 'draft']) {
      snapshot.units[0].enabled = mode === 'disabled' ? 0 : 1; snapshot.units[0].type = mode === 'draft' ? 'DRAFT' : 'ATF';
      assert.deepEqual(input(snapshot).core.bidderAdUnitParams, {});
      assert.deepEqual(snapshot.overrides, override);
    }
    snapshot.units[0].enabled = 1; snapshot.units[0].type = 'ATF';
    assert.equal(input(snapshot).core.bidderAdUnitParams.ix[code].siteId, 'exact-' + code);
    snapshot.units = snapshot.units.filter(unit => unit.code === 'Control');
    assert.throws(() => input(snapshot), /references missing unit|Invalid bidder override key/);
  }
});

test('GAM and Prebid packages preserve exact public identities, escaped exports and complete content hashes', async () => {
  for (const prebid of [false, true]) {
    const snapshot = fixture(prebid), before = structuredClone(snapshot), normalized = input(snapshot);
    const candidate = await buildArtifactCandidate({snapshot, pin: pinRuntime(descriptor, {allowPreview: true}), buildTimestamp: stamp, prebid: await checked(snapshot, normalized)});
    assert.deepEqual(snapshot, before);
    const publicConfig = JSON.parse(decode(candidate.files['config.json']));
    assert.deepEqual(publicConfig.core.explicitUnits.map(unit => unit.id), codes);
    assert.deepEqual(publicConfig.sizeMapNormalization.emptyBaselineAdded, ['P2']);
    for (const name of ['ads.js', 'ads.min.js']) parse(decode(candidate.files[name]), {ecmaVersion: 2015});
    for (const code of codes) {
      assert(decode(candidate.files['implementation.html']).includes(`<div id="${escapeHtml(code)}"`));
      assert(decode(candidate.files['div-export.csv']).includes(`<div id="${escapeHtml(code)}"`.replaceAll('"', '""')));
      assert(decode(candidate.files['min-height.css']).includes(escapeCssId(code) + '[data-ad-size-map="1"]'));
    }
    for (const [name, bytes] of Object.entries(candidate.files)) {
      assert(!decode(bytes).includes('TesseraGamCode'), name);
      if (name === 'manifest.json') continue;
      assert.equal(candidate.manifest.files[name].sha256, createHash('sha256').update(bytes).digest('hex'), name);
    }
  }
});

test('actual compiled condition dictionaries resolve prototype names and use width-then-height precedence', () => {
  const normalized = input(fixture()), source = compileRuntime3201(normalized).adsJs;
  const tags = new Map(), context = vm.createContext({window: {innerWidth: 800, innerHeight: 900, adsKeywords: {category: 'Naslovna'}},
    document: {documentElement: {}, getElementById: code => ({setAttribute: (key, value) => tags.set(code + ':' + key, value)})},
    AD_GEO_STATE: {settled: true, country: 'RS'}, baseUnitConfigById: () => ({sizeMapName: 'P2', prebidSizeConfigName: 'P2'})});
  for (const name of ['AD_CONDITIONAL_UNITS', 'AD_CONDITIONAL_DECISIONS', 'AD_VIEWPORT_MAP_NAMES', 'SIZE_MAPS_RAW', 'PREBID_SIZE_CONFIGS_RAW']) vm.runInContext(variableSource(source, name), context);
  for (const name of ['adRuleMatches', 'adGeoKeywords', 'adGeoSelect', 'adConditionalConfig', 'getUnitConfigById', 'adViewportSizes', 'sizesFromSizeMapName', 'sizesFromPrebidConfigName']) vm.runInContext(functionSource(source, name), context);
  assert.equal(Object.getPrototypeOf(context.AD_CONDITIONAL_UNITS), null);
  assert.equal(Object.getPrototypeOf(context.AD_CONDITIONAL_DECISIONS), null);
  for (const code of codes) {
    const config = context.getUnitConfigById(code);
    assert.equal(config.sizeMapName, 'naslovna_P2', code);
    assert.deepEqual(plain(context.sizesFromPrebidConfigName(config.prebidSizeConfigName)), [[300, 100]], code);
    assert.equal(tags.get(code + ':data-ad-size-map'), '1', code);
  }
  context.window.innerHeight = 1000;
  assert.deepEqual(plain(context.sizesFromSizeMapName('naslovna_P2')), [[300, 600]]);
  context.window.innerWidth = 1440; context.window.innerHeight = 500;
  assert.deepEqual(plain(context.sizesFromSizeMapName('P2')), [[970, 90]], 'greater width precedes lesser width regardless of its height');
  context.window.innerWidth = 390;
  assert.deepEqual(plain(context.sizesFromSizeMapName('P2')), [], 'unmatched base map is explicitly empty');
});

test('compiled sticky lookup never interpolates a raw identifier into selectors', () => {
  for (const code of ['sticky"\\<:!()*', '__proto__']) {
    const snapshot = fixture(); snapshot.rules = []; snapshot.units = [{code, enabled: 1, type: 'ATF', media_type: 'banner', size_map_key: 'P2'}];
    configure(snapshot, config => {config.runtimeControls.sticky.bottomAdUnitId = code;});
    const source = compileRuntime3201(input(snapshot)).adsJs, expected = {};
    const context = vm.createContext({STICKY_TARGET_ID: code, document: {getElementById: id => {assert.equal(id, code); return null;},
      querySelectorAll: selector => {assert.equal(selector, '[data-ad], [data-slot]'); return [{getAttribute: key => key === 'data-ad' ? code : null, marker: expected}];},
      querySelector: () => {throw Error('Exact data-ad lookup did not win');}}});
    vm.runInContext(functionSource(source, 'getStickyHost'), context);
    assert.equal(context.getStickyHost().marker, expected);
  }
});

test('compiled resize recovery keeps prototype-name slots behind consent and never refreshes a served slot', () => {
  const source = compileRuntime3201(input(fixture())).adsJs;
  for (const code of ['__proto__', 'constructor', 'm.box_3']) {
    let eligible = false, timer = null; const listeners = new Map(), consent = [], sent = [];
    const slot = {getSlotElementId: () => code}, slots = Object.create(null); slots[code] = slot;
    const events = {addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name)};
    const context = vm.createContext({window: {...events, adSlots: slots}, document: {...events, documentElement: {}, body: {}},
      setTimeout: handler => {timer = handler; return 1;}, clearTimeout: () => {timer = null;},
      AD_VIEWPORT_INITIAL_LISTENER: null, _tesseraInitialScanDone: true, _tesseraInitialStarted: new WeakSet(), _tesseraLastRefreshSentAt: Object.create(null),
      EXPLICIT_UNITS: [{id: code, type: 'ATF'}], STICKY_TARGET_ID: '', _sticky: {closed: false}, TESSERA_OVERLAY: null,
      pageActive: () => true, slotHasCurrentViewportSizes: () => eligible, getUnitConfigById: () => ({type: 'ATF'}), tesseraLazyRule: () => null,
      HAS_PREBID: false, BIDDERS: [], _tesseraReady: {whenConsent: callback => consent.push(callback)}, startATFConfigured: batch => sent.push(...batch)});
    for (const name of ['adViewportInitialSlots', 'startATF', 'adViewportInstallInitialResume']) vm.runInContext(functionSource(source, name), context);
    context.adViewportInstallInitialResume(); context.startATF([slot]); assert.equal(consent.length, 0);
    eligible = true; listeners.get('resize')(); timer(); assert.equal(consent.length, 1); assert.equal(sent.length, 0);
    eligible = false; consent.shift()(); assert.equal(sent.length, 0);
    eligible = true; listeners.get('resize')(); timer(); consent.shift()(); assert.deepEqual(sent, [slot]);
    context._tesseraLastRefreshSentAt[code] = 0; context._tesseraInitialStarted.delete(slot);
    listeners.get('resize')(); timer(); assert.equal(consent.length, 0); assert.deepEqual(sent, [slot]);
  }
});

test('combined catalog guard retains both prior compatible versions without weakening unsupported-version checks', () => {
  const config = {enablePrebid: true, runtimeControls: {deals: {entries: [{enabled: true}]}}};
  for (const version of ['3.19.1', '3.20.0', '3.20.1']) assert.doesNotThrow(() => requireRevenueRuntime(config, {id: 'tessera-' + version, version}));
  assert.throws(() => requireRevenueRuntime(config, {id: 'unrelated', version: '3.20.1'}));
});
