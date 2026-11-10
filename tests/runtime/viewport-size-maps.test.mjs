import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {fixture, configure, checkedFixture} from './artifact-fixture.mjs';
import {conditionalFixture, mapping} from '../support/conditional-maps-fixture.mjs';
import {descriptor} from '../../.generated/runtime-320-manifest.mjs';
import {browserSources} from '../../.generated/runtime-320-browser-source.mjs';
import {previewInput} from '../../worker/runtime-320/snapshot.mjs';
import {buildArtifactCandidate} from '../../worker/runtime-320/artifact-candidate.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {runtime319Source} from '../../scripts/prepare-runtime319.mjs';
const stamp = '20261109_220000';
const input = snapshot => previewInput(snapshot, descriptor, stamp);
const decode = bytes => new TextDecoder().decode(bytes);
const plain = value => JSON.parse(JSON.stringify(value));
const numeric = sizes => sizes.filter(Array.isArray);

function selectors(rows, width, height) {
  const context = vm.createContext({window: {innerWidth: width, innerHeight: height}, document: {documentElement: {clientWidth: width, clientHeight: height}},
    SIZE_MAPS_RAW: {map: rows}, PREBID_SIZE_CONFIGS_RAW: {explicit: rows.map(row => ({minViewPort: row.viewport, sizes: row.sizes}))}});
  vm.runInContext(Object.entries(browserSources).filter(([name]) => name !== 'getUnitConfigById').map(([, source]) => source).join('\n'), context);
  return [context.sizesFromSizeMapName('map'), context.sizesFromPrebidConfigName('map'), context.sizesFromPrebidConfigName('explicit')].map(plain);
}

test('both Prebid map paths use GPT width-first, then height priority including ties and reverse input', () => {
  const rows = [{viewport: [0, 0], sizes: [[320, 50]]}, {viewport: [768, 0], sizes: [[728, 90]]},
    {viewport: [768, 1000], sizes: [[970, 90]]}, {viewport: [1000, 500], sizes: [[970, 250]]}, {viewport: [900, 1100], sizes: [[300, 600]]}];
  for (const order of [rows, [...rows].reverse()]) for (const [width, height, expected] of [
    [390, 900, [[320, 50]]], [800, 900, [[728, 90]]], [800, 1000, [[970, 90]]],
    [1100, 1200, [[970, 250]]], [1100, 499, [[728, 90]]], [900, 1100, [[300, 600]]],
  ]) for (const actual of selectors(order, width, height)) assert.deepEqual(actual, expected, `${width}×${height}`);
});

test('empty, fluid-only and no-match rows never fall back to a larger numeric row', () => {
  const rows = [{viewport: [0, 0], sizes: ['fluid']}, {viewport: [768, 1000], sizes: []}, {viewport: [1024, 1200], sizes: [[970, 250]]}];
  for (const actual of selectors(rows, 1440, 900)) { assert.deepEqual(actual, ['fluid']); assert.deepEqual(numeric(actual), []); }
  for (const actual of selectors(rows, 1440, 1100)) assert.deepEqual(actual, []);
  for (const actual of selectors([{viewport: [768, 1000], sizes: [[728, 90]]}], 1440, 900)) assert.deepEqual(actual, []);
});

test('new snapshot preserves stored rows while adding an explicit empty lower bound', () => {
  const snapshot = configure(fixture(), config => {config.enablePrebid = false;});
  snapshot.maps[0].map_json = JSON.stringify([{minViewPort: [768, 1000], sizes: [[728, 90]]}]);
  const before = structuredClone(snapshot), normalized = input(snapshot);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(normalized.core.sizeMapsRaw.display, [{viewport: [0, 0], sizes: []}, {viewport: [768, 1000], sizes: [[728, 90]]}]);
  assert.deepEqual(normalized.sizeMapNormalization.emptyBaselineAdded, ['display']);
});

test('same width at different heights is valid; exact duplicate viewport pairs name the map', () => {
  const snapshot = configure(fixture(), config => {config.enablePrebid = false;});
  snapshot.maps[2].map_json = JSON.stringify([{viewport: [0, 0], sizes: [[320, 50]]}, {viewport: [768, 0], sizes: [[728, 90]]}, {viewport: [768, 1000], sizes: [[970, 90]]}]);
  assert.doesNotThrow(() => input(snapshot));
  const rows = JSON.parse(snapshot.maps[2].map_json); rows.push({viewport: [768, 1000], sizes: []});
  snapshot.maps[2].map_json = JSON.stringify(rows);
  assert.throws(() => input(snapshot), /Size map sticky has duplicate viewport 768x1000/);
});

test('unreachable duplicate maps do not block generation; active prefix and conditional maps still reject ambiguity', () => {
  for (const kind of ['unused', 'disabled-unit', 'disabled-rule']) {
    const snapshot = conditionalFixture();
    const duplicate = {name: 'UnusedDraft', map_json: JSON.stringify([{viewport: [0, 0], sizes: [[320, 50]]}, {viewport: [0, 0], sizes: [[300, 250]]}])};
    snapshot.maps.push(duplicate);
    if (kind === 'disabled-unit') snapshot.units.push({code: 'Draft', type: 'ATF', enabled: 0, media_type: 'banner', size_map_key: duplicate.name});
    if (kind === 'disabled-rule') snapshot.rules.push({rule_key: '__ATF__', rule_json: JSON.stringify({conditionalMappings: [mapping({enabled: false, sizeMapKey: duplicate.name})]})});
    const before = structuredClone(snapshot);
    assert.doesNotThrow(() => input(snapshot), kind);
    assert.deepEqual(snapshot, before);
    duplicate.name = 'home_P2';
    if (kind === 'disabled-rule') snapshot.rules.pop();
    assert.throws(() => input(snapshot), /Size map home_P2 has duplicate viewport 0x0/);
  }
  const snapshot = conditionalFixture();
  const rows = JSON.parse(snapshot.maps[1].map_json); rows.push(rows[0]); snapshot.maps[1].map_json = JSON.stringify(rows);
  assert.throws(() => input(snapshot), /Size map naslovna_P2 has duplicate viewport 0x0/);
});

function initialSticky({prebid = false, globalLazy = false, lazy = null, code = 'Sticky', type = 'ATF'} = {}) {
  const slot = {getSlotElementId: () => code}, banner = {getSlotElementId: () => 'OtherBanner'};
  const listeners = new Map(), timers = new Map(), consent = [], readiness = [], sent = [], fallback = [];
  const target = prefix => ({addEventListener: (name, handler) => listeners.set(prefix + name, handler), removeEventListener: name => listeners.delete(prefix + name)});
  let timerId = 0, eligible = false, active = true, wired = 0;
  const context = vm.createContext({window: {...target('window.'), adSlots: {[code]: slot}, pageYOffset: 0},
    document: {...target('document.'), documentElement: {scrollTop: 0}, body: {scrollTop: 0}},
    setTimeout: fn => {timers.set(++timerId, fn); return timerId;}, clearTimeout: id => timers.delete(id),
    STICKY_TARGET_ID: 'Sticky', _sticky: {closed: false}, _tesseraInitialStarted: new WeakSet(), _tesseraLastRefreshSentAt: {}, _tesseraInitialScanDone: true,
    AD_VIEWPORT_INITIAL_LISTENER: null, EXPLICIT_UNITS: [{id: code, type}], TESSERA_OVERLAY: null, STICKY_LAZY_ENABLED: globalLazy, STICKY_LAZY_SCROLL_PX: 400, TESSERA_LAZY_STARTED: true,
    slotHasCurrentViewportSizes: id => id === 'OtherBanner' || eligible, pageActive: () => active, getUnitConfigById: () => ({type}),
    tesseraLazyRule: () => lazy, tesseraWireConfiguredLazy: () => {wired++;}, HAS_PREBID: prebid, BIDDERS: [{bidder: 'fixture'}],
    startATFConfigured: slots => sent.push(...slots), fetchBidsAndRefresh: () => {throw Error('Sticky bypassed its readiness gate');},
    _tesseraReady: {whenConsent: fn => consent.push(fn), prebid: (ok, fail) => readiness.push({ok, fail}), dispatch: (pa, slots) => fallback.push(...slots)},
    googletag: {cmd: {push: fn => fn()}, pubads: () => ({enableSingleRequest() {}}), enableServices() {}}});
  for (const name of ['adViewportInitialSlots', 'startATF', 'requestInitialSticky', 'adViewportInstallInitialResume']) vm.runInContext(browserSources[name], context);
  context.adViewportInstallInitialResume();
  const event = (name = 'window.resize') => {listeners.get(name)?.(); for (const [id, fn] of [...timers]) {timers.delete(id); fn();}};
  return {context, slot, banner, consent, readiness, sent, fallback, listeners, event, eligible: value => {eligible = value;}, active: value => {active = value;}, wired: () => wired};
}

test('never-requested Sticky resumes once through consent after an eligible resize; served and closed slots stay untouched', () => {
  const state = initialSticky();
  state.context.startATF([state.slot]); assert.equal(state.consent.length, 0);
  state.eligible(true); state.event(); assert.equal(state.consent.length, 1);
  state.event('window.orientationchange'); assert.equal(state.consent.length, 1);
  assert.equal(state.sent.length, 0); state.consent.shift()(); assert.deepEqual(state.sent, [state.slot]);
  state.context._tesseraLastRefreshSentAt.Sticky = 0;
  state.context._tesseraInitialStarted.delete(state.slot); state.event();
  assert.equal(state.sent.length, 1); assert.equal(state.consent.length, 0); assert.equal(state.listeners.size, 0);
  const closed = initialSticky(); closed.context._sticky.closed = true; closed.eligible(true); closed.event();
  assert.equal(closed.consent.length, 0); assert.equal(closed.listeners.size, 0);
});

test('Sticky eligibility is rechecked after consent and Prebid success/error without consuming its first request', () => {
  for (const branch of ['consent', 'prebid-success', 'prebid-error']) {
    const state = initialSticky({prebid: branch !== 'consent'}); state.eligible(true); state.context.startATF([state.slot]);
    if (branch === 'consent') {state.eligible(false); state.consent.shift()();}
    else {state.consent.shift()(); state.eligible(false); const callbacks = state.readiness.shift(); callbacks[branch === 'prebid-success' ? 'ok' : 'fail']();}
    assert.equal(state.sent.length + state.fallback.length, 0, branch);
    assert.equal(state.context._tesseraInitialStarted.has(state.slot), false, branch);
    state.eligible(true); state.event('window.orientationchange'); state.consent.shift()();
    if (branch !== 'consent') state.readiness.shift().ok();
    assert.deepEqual(state.sent, [state.slot], branch);
  }
});

test('Sticky resume preserves scroll and explicit lazy gates, page visibility and pending consent', () => {
  const scroll = initialSticky({globalLazy: true}); scroll.eligible(true); scroll.event(); assert.equal(scroll.consent.length, 0);
  scroll.context.window.pageYOffset = 401; scroll.event(); assert.equal(scroll.consent.length, 1); assert.equal(scroll.sent.length, 0);
  scroll.eligible(false); scroll.consent.shift()(); scroll.eligible(true); scroll.event(); assert.equal(scroll.consent.length, 1);
  scroll.consent.shift()(); assert.deepEqual(scroll.sent, [scroll.slot]);
  const lazy = initialSticky({lazy: {enabled: true}}); lazy.eligible(true); lazy.event();
  assert.equal(lazy.wired(), 1); assert.equal(lazy.consent.length, 0);
  const disabledLazy = initialSticky({lazy: {enabled: false}}); disabledLazy.eligible(true); disabledLazy.event();
  assert.equal(disabledLazy.consent.length, 1); assert.equal(disabledLazy.wired(), 0);
  const inactive = initialSticky(); inactive.eligible(true); inactive.active(false); inactive.event(); assert.equal(inactive.consent.length, 0);
  inactive.active(true); inactive.event('document.visibilitychange'); assert.equal(inactive.consent.length, 1);
});

test('eligible Banner startup remains unchanged when an ineligible Sticky shares its initial batch', () => {
  const state = initialSticky(); state.context.startATF([state.banner, state.slot]);
  assert.equal(state.consent.length, 1); state.consent.shift()(); assert.deepEqual(state.sent, [state.banner]);
});

test('never-requested ATF Banner resumes once after resize and rechecks pending consent, without starting BTF', () => {
  const state = initialSticky({code: 'P2'}); state.context.startATF([state.slot]); assert.equal(state.consent.length, 0);
  state.eligible(true); state.event(); assert.equal(state.consent.length, 1);
  state.eligible(false); state.consent.shift()(); assert.equal(state.sent.length, 0);
  state.eligible(true); state.event(); state.event(); assert.equal(state.consent.length, 1);
  state.consent.shift()(); assert.deepEqual(state.sent, [state.slot]);
  state.context._tesseraLastRefreshSentAt.P2 = 100; state.context._tesseraInitialStarted.delete(state.slot); state.event();
  assert.equal(state.consent.length, 0); assert.equal(state.listeners.size, 0);
  const btf = initialSticky({code: 'P2', type: 'BTF'}); btf.eligible(true); btf.event();
  assert.equal(btf.consent.length, 0); assert.equal(btf.listeners.size, 0);
});

test('2D CSS order follows GPT priority and reservation derives only from fixed creative sizes', () => {
  const snapshot = conditionalFixture();
  snapshot.maps[0].map_json = JSON.stringify([{viewport: [0, 0], sizes: [[300, 250], 'fluid']}, {viewport: [768, 1000], sizes: [[728, 90]]}, {viewport: [1000, 500], sizes: []}]);
  snapshot.maps[1].map_json = JSON.stringify([{viewport: [0, 0], sizes: ['fluid']}, {viewport: [768, 1000], sizes: [[970, 250]]}]);
  const normalized = input(snapshot), css = normalized.conditionalCss;
  assert(css.includes('@media(min-width:768px) and (min-height:1000px){#P2{min-height:90px;}}'));
  assert(css.indexOf('(min-width:768px)') < css.indexOf('(min-width:1000px)'));
  assert(css.includes('#P2[data-ad-size-map="1"]{min-height:0;}'));
  assert(css.includes('#P2[data-ad-size-map="1"]{min-height:250px;}'));
  assert(css.includes('#P2[data-ad-rule-map="disabled"]{min-height:0;}'));
  assert(!css.includes('max-height:'));
  assert(!css.includes('{min-height:1000px;}'));
});

test('category and reserved GEO rules can select height maps without visitor values at generation', () => {
  const snapshot = conditionalFixture();
  snapshot.maps[1].map_json = JSON.stringify([{viewport: [0, 0], sizes: [[320, 50]]}, {viewport: [768, 1000], sizes: [[728, 90]]}]);
  const category = input(snapshot); assert.equal(category.conditionalUnits.P2.usesGeo, false);
  snapshot.rules[1].rule_json = JSON.stringify({conditionalMappings: [mapping({conditions: [{key: 'geo_country', operator: 'equals', value: 'rs'}]})]});
  const geo = input(snapshot);
  assert.equal(geo.conditionalUnits.P2.usesGeo, true); assert.equal(geo.conditionalUnits.P2.rules[0].conditions[0].value, 'RS');
  assert.deepEqual(geo.core.sizeMapsRaw.naslovna_P2[1].viewport, [768, 1000]);
});

test('selected-map marker follows resolved legacy/conditional map and never changes the selection', () => {
  const values = [], config = {sizeMapName: 'home_P2', prebidSizeConfigName: 'home_P2'};
  const context = vm.createContext({AD_VIEWPORT_MAP_NAMES: ['P2', 'home_P2'], document: {getElementById: () => ({setAttribute: (key, value) => values.push([key, value])})},
    baseUnitConfigById: () => config, adConditionalConfig: (id, base) => base});
  vm.runInContext(browserSources.getUnitConfigById, context);
  assert.equal(context.getUnitConfigById('P2'), config);
  assert.deepEqual(values, [['data-ad-size-map', '1']]);
  context.adConditionalConfig = () => null;
  assert.equal(context.getUnitConfigById('P2'), null); assert.equal(values.length, 1, 'pending GEO does not clear the base reservation');
});

test('legacy prefixed map reserves from its actual map and Sticky stays excluded from placeholders', () => {
  const snapshot = conditionalFixture({sticky: true}); snapshot.rules = [];
  snapshot.maps.push({name: 'home_P2', map_json: JSON.stringify([{viewport: [0, 0], sizes: [[300, 250]]}, {viewport: [768, 1000], sizes: [[970, 250]]}])});
  const normalized = input(snapshot);
  assert(normalized.conditionalCss.includes('#P2[data-ad-size-map="2"]{min-height:250px;}'));
  assert(!normalized.conditionalCss.includes('#Sticky'));
});

test('inactive exact overrides are omitted only from compilation and restored when re-enabled', () => {
  const snapshot = fixture(), before = structuredClone(snapshot);
  snapshot.units[0].enabled = 0;
  const disabled = input(snapshot);
  assert.deepEqual(disabled.core.bidderAdUnitParams, {});
  assert.deepEqual(snapshot.overrides, before.overrides);
  snapshot.units[0].enabled = 1;
  assert.deepEqual(input(snapshot).core.bidderAdUnitParams.ix.Billboard, {siteId: 'exact'});
  snapshot.units[0].type = 'DRAFT';
  assert.deepEqual(input(snapshot).core.bidderAdUnitParams, {});
  snapshot.units.shift();
  assert.throws(() => input(snapshot), /references missing unit Billboard/);
});

test('inactive overrides do not hide unsafe keys or malformed active-unit parameters', () => {
  const snapshot = fixture(); snapshot.units[0].enabled = 0; snapshot.overrides[0].bidder = '__proto__';
  assert.throws(() => input(snapshot), /Invalid bidder override key/);
  snapshot.units[0].enabled = 1; snapshot.overrides[0].bidder = 'ix'; snapshot.overrides[0].params_json = 'bad';
  assert.throws(() => input(snapshot), /Bidder override/);
});

test('complete 3.20 readable/minified packages retain exact file hashes and document normalization', async () => {
  for (const enabled of [false, true]) {
    const snapshot = configure(fixture(), config => {config.enablePrebid = enabled;});
    snapshot.maps[0].map_json = JSON.stringify([{viewport: [768, 1000], sizes: [[728, 90]]}]);
    const prebid = enabled ? await checkedFixture(snapshot) : null;
    const result = await buildArtifactCandidate({snapshot, pin: pinRuntime(descriptor), buildTimestamp: stamp, prebid});
    for (const name of ['ads.js', 'ads.min.js']) { parse(decode(result.files[name]), {ecmaVersion: 2015}); assert(decode(result.files[name]).includes('data-ad-size-map')); }
    for (const [name, entry] of Object.entries(result.manifest.files)) assert.equal(createHash('sha256').update(result.files[name]).digest('hex'), entry.sha256);
    const config = JSON.parse(decode(result.files['config.json']));
    assert.deepEqual(config.sizeMapNormalization.emptyBaselineAdded, ['display']);
    assert.equal(config.countrySignal.targetingKey, 'geo_country');
    assert(decode(result.files['README.txt']).includes('Viewport size maps in 3.20.0'));
    assert(decode(result.files['README.txt']).includes('Responsive Outstream keeps its reviewed width-only restriction'));
  }
});

test('all frozen 3.19 source inputs retain their released identity', async () => {
  const result = await runtime319Source(process.cwd());
  assert.equal(result.codeSha256, 'a93924a8f0b800dc109bbe68c6fe61cd387b3e84c04db97fabeb15e23659be95');
});
