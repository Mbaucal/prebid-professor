import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {getPrebidMode, updatePrebidMode} from '../../worker/prebid-mode.ts';
import {runtimeCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime, validateRuntimeDescriptor} from '../../worker/runtime/version-pin.mjs';
import {BID_CACHE_RUNTIME_VERSION, bidCacheEligibleCodes} from '../../shared/bid-cache/eligibility.mjs';
import {CACHE_POSITIONS} from '../../worker/experiments/position-cache-settings.mjs';
import {MAX_POSITION_OVERRIDES, bidCacheOverrides, bidCacheSettings, requireEligibleOverrides} from '../../worker/site-runtime/prebid-cache-settings.mjs';

// A synthetic site that is not Tanjug: its own inventory, its own GAM path.
const SITE = 'audit-site';
const TANJUG = {id: 'tanjug', domain: 'tanjug.rs', gamPath: '/22852026051/Tanjug.rs-Display/'};
const fixtures = [];
test.afterEach(() => { while (fixtures.length) fixtures.pop().close(); });

const units = [
  ['Home_Top', 'ATF', 'banner', 1],
  ['Billboard', 'ATF', 'banner', 1],
  ['In_Article', 'BTF', 'banner', 1],
  ['Video_Slot', 'BTF', 'video', 1],
  ['Off_Unit', 'BTF', 'banner', 0],
  ['Draft_Unit', 'DRAFT', 'banner', 1],
  ['Takeover_Unit', 'ATF', 'banner', 1],
  ['Interstitial', 'ATF', 'banner', 1],
  ['Outstream_Unit', 'BTF', 'banner', 1],
  ['__proto__', 'BTF', 'banner', 1],
];
// Takeover_Unit is the TakeOver ad position; Outstream_Unit plays Outstream video.
const runtimeControls = {sticky: {bottomAdUnitId: ''}, adPositions: {Takeover_Unit: {display: 'takeover'}}, outstream: {schemaVersion: 1, units: {Outstream_Unit: {format: 'outstream'}}}};
const ELIGIBLE = ['Billboard', 'Home_Top', 'In_Article', 'P1', '__proto__'];

function seedUnits(sqlite, site) {
  const insert = sqlite.prepare('INSERT INTO ad_units(id,publisher_id,code,type,media_type,enabled,size_map_key) VALUES(?,?,?,?,?,?,?)');
  for (const [code, type, media, enabled] of units) insert.run(`${site}-${code}`, site, code, type, media, enabled, 'display');
}
function setup(config = {}) {
  const f = adminAuditStore({config: {runtimeControls, ...config}});
  fixtures.push(f);
  f.sqlite.prepare("UPDATE publishers SET name='Example', domain='example.invalid', gam_path='/123/example/' WHERE id=?").run(SITE);
  seedUnits(f.sqlite, SITE);
  return f;
}
function addTanjug(f) {
  f.sqlite.prepare('INSERT INTO publishers(id,name,domain,gam_path) VALUES(?,?,?,?)').run(TANJUG.id, 'Tanjug', TANJUG.domain, TANJUG.gamPath);
  f.sqlite.prepare("INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES('tanjug-config',?,?)").run(TANJUG.id, JSON.stringify(f.readConfig()));
  f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key) VALUES('tanjug-P1',?,'P1','BTF','display')").run(TANJUG.id);
  seedUnits(f.sqlite, TANJUG.id);
}
const put = (body, f, site = SITE) => updatePrebidMode(new Request('https://tessera.invalid/api/prebid-mode', {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}), f.env, site);
async function read(f, site = SITE) { const response = await getPrebidMode(f.env, site); assert.equal(response.status, 200, await response.clone().text()); return response.json(); }
const audits = f => f.sqlite.prepare("SELECT details_json FROM audit_log WHERE action='prebid_mode.updated' ORDER BY created_at").all().map(row => JSON.parse(row.details_json));
async function refused(f, bidCache, status = 422) {
  const before = f.readConfig(), state = await read(f), count = audits(f).length;
  const response = await put({enabled: true, revision: state.revision, bidCache}, f);
  assert.equal(response.status, status, JSON.stringify(bidCache));
  assert.deepEqual(f.readConfig(), before, 'a refused save writes nothing');
  assert.equal(audits(f).length, count, 'a refused save writes no audit entry');
  return (await response.json()).error;
}

test('a site that is not Tanjug lists its own eligible positions and can save cache settings', async () => {
  const f = setup();
  const state = await read(f);
  assert.equal(state.bidCacheAvailable, true);
  assert.deepEqual(state.bidCachePositions, ELIGIBLE);
  const rows = f.sqlite.prepare('SELECT code,type,media_type,enabled FROM ad_units WHERE publisher_id=?').all(SITE);
  assert.deepEqual(state.bidCachePositions, bidCacheEligibleCodes(rows, f.readConfig()), 'the payload uses the shared eligibility rule');
  assert.equal(state.bidCacheRuntimeVersion, BID_CACHE_RUNTIME_VERSION);
  assert.equal(state.namedScriptLibrary, false);
  assert.equal(state.selectedRuntime, null);
  assert.equal(state.runtimeSupportsBidCache, false);
  assert.deepEqual(state.prebidMode.bidCache, {enabled: false, maxBidAgeSeconds: 60});

  // Sent as JSON text, as the browser does, so __proto__ is an own key.
  const bidCache = JSON.parse('{"enabled":true,"maxBidAgeSeconds":45,"positionOverrides":{"__proto__":true,"In_Article":true,"Home_Top":false}}');
  const response = await put({enabled: true, revision: state.revision, bidCache}, f);
  assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json();
  const expected = {enabled: true, maxBidAgeSeconds: 45, positionOverrides: JSON.parse('{"Home_Top":false,"In_Article":true,"__proto__":true}')};
  assert.deepEqual(saved.prebidMode.bidCache, expected);
  assert.deepEqual(f.readConfig().prebidBidCache, expected);
  assert.equal(Object.hasOwn(f.readConfig().prebidBidCache.positionOverrides, '__proto__'), true, 'an ad unit named __proto__ is an ordinary code');
  assert.deepEqual(audits(f).at(-1), {bidCache: expected, previousEnabled: true, enabled: true, mode: 'gam-prebid', savedBidderConfigurationPreserved: true});
  assert.deepEqual((await read(f)).prebidMode.bidCache, expected, 'the saved settings round-trip');
});

test('Tanjug positions, ineligible positions and malformed overrides are refused for this site', async () => {
  const f = setup();
  const supported = /^Choose bid caching on or off for a supported ad position\./;
  for (const code of ['Billboard_2', 'Sticky', 'InText_1']) {
    assert(CACHE_POSITIONS.includes(code));
    assert.match(await refused(f, {enabled: false, maxBidAgeSeconds: 60, positionOverrides: {[code]: true}}), new RegExp(`${supported.source} ${code} is not an enabled ATF or BTF banner position on this site\\.`));
  }
  for (const code of ['Video_Slot', 'Off_Unit', 'Draft_Unit', 'Takeover_Unit', 'Interstitial', 'Outstream_Unit', 'Deleted_Unit']) {
    assert.match(await refused(f, {enabled: true, maxBidAgeSeconds: 60, positionOverrides: {Billboard: true, [code]: false}}), new RegExp(`${code} is not an`));
  }
  const many = await refused(f, {enabled: true, maxBidAgeSeconds: 60, positionOverrides: {Sticky: true, P8: true, Off_Unit: false, Video_Slot: true}});
  assert.match(many, / Off_Unit, P8, Sticky and 1 more are not enabled ATF or BTF banner positions on this site\./);
  const tooMany = Object.fromEntries(Array.from({length: MAX_POSITION_OVERRIDES + 1}, (_, i) => [`Unit_${i}`, true]));
  for (const positionOverrides of [{Billboard: 'true'}, {'/Billboard': true}, {'Bill board': true}, {['x'.repeat(101)]: true}, {'': true}, [], null, tooMany]) {
    assert.match(await refused(f, {enabled: true, maxBidAgeSeconds: 60, positionOverrides}), /^Choose bid caching on or off for a supported ad position\.$/);
  }
  for (const bidCache of [{enabled: true, maxBidAgeSeconds: 0}, {enabled: true, maxBidAgeSeconds: 301}, {enabled: 'yes', maxBidAgeSeconds: 60}, {enabled: true, maxBidAgeSeconds: 60, extra: 1}]) {
    assert.match(await refused(f, bidCache), /maximum bid age of 1–300 seconds/);
  }
});

test('a stale revision is refused before anything is saved', async () => {
  const f = setup();
  const first = await read(f);
  assert.equal((await put({enabled: true, revision: first.revision, bidCache: {enabled: true, maxBidAgeSeconds: 60}}, f)).status, 200);
  const before = f.readConfig(), count = audits(f).length;
  const stale = await put({enabled: true, revision: first.revision, bidCache: {enabled: false, maxBidAgeSeconds: 60, positionOverrides: {Billboard: true}}}, f);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'Prebid settings changed. Reload before saving.');
  // The revision is checked first, so a stale form never learns about another tab's positions.
  assert.equal((await put({enabled: true, revision: first.revision, bidCache: {enabled: false, maxBidAgeSeconds: 60, positionOverrides: {Sticky: true}}}, f)).status, 409);
  assert.deepEqual(f.readConfig(), before);
  assert.equal(audits(f).length, count);
});

test('an override kept from an earlier save never blocks an unrelated save, and can be removed', async () => {
  const f = setup();
  let state = await read(f);
  assert.equal((await put({enabled: true, revision: state.revision, bidCache: {enabled: false, maxBidAgeSeconds: 60, positionOverrides: {Billboard: true, Home_Top: false}}}, f)).status, 200);
  // The unit is disabled later, and a second one is renamed (another tab, or the Ad units board).
  f.sqlite.prepare("UPDATE ad_units SET enabled=0 WHERE publisher_id=? AND code='Billboard'").run(SITE);
  f.sqlite.prepare("UPDATE ad_units SET code='Home_Top_2' WHERE publisher_id=? AND code='Home_Top'").run(SITE);
  state = await read(f);
  assert.deepEqual(state.bidCachePositions, ['Home_Top_2', 'In_Article', 'P1', '__proto__']);
  assert.deepEqual(state.prebidMode.bidCache.positionOverrides, {Billboard: true, Home_Top: false}, 'the saved overrides are still reported');
  // Unrelated change: the unchanged, no longer eligible overrides are sent back and kept.
  let response = await put({enabled: true, revision: state.revision, bidCache: {...state.prebidMode.bidCache, enabled: true, maxBidAgeSeconds: 30}}, f);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(f.readConfig().prebidBidCache, {enabled: true, maxBidAgeSeconds: 30, positionOverrides: {Billboard: true, Home_Top: false}});
  // Changing such an override is a new choice for an ineligible position.
  assert.match(await refused(f, {enabled: true, maxBidAgeSeconds: 30, positionOverrides: {Billboard: false, Home_Top: false}}), /Billboard is not an/);
  // Removing one, and adding the renamed unit, is allowed.
  state = await read(f);
  response = await put({enabled: true, revision: state.revision, bidCache: {enabled: true, maxBidAgeSeconds: 30, positionOverrides: {Home_Top: false, Home_Top_2: true}}}, f);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(f.readConfig().prebidBidCache.positionOverrides, {Home_Top: false, Home_Top_2: true});
  state = await read(f);
  response = await put({enabled: true, revision: state.revision, bidCache: {enabled: true, maxBidAgeSeconds: 30}}, f);
  assert.equal(response.status, 200);
  assert.deepEqual(f.readConfig().prebidBidCache, {enabled: true, maxBidAgeSeconds: 30});
});

test('Prebid off keeps cache settings and positions editable, as before', async () => {
  const f = setup();
  const state = await read(f);
  const response = await put({enabled: false, revision: state.revision, bidCache: {enabled: true, maxBidAgeSeconds: 90, positionOverrides: {In_Article: false}}}, f);
  assert.equal(response.status, 200, await response.clone().text());
  const off = await response.json();
  assert.equal(off.prebidMode.enabled, false);
  assert.deepEqual(off.bidCachePositions, ELIGIBLE, 'eligibility does not depend on Prebid being on');
  assert.deepEqual(f.readConfig().prebidBidCache, {enabled: true, maxBidAgeSeconds: 90, positionOverrides: {In_Article: false}});
  assert.equal(f.readConfig().enablePrebid, false);
  // Turning Prebid on again without sending bidCache keeps the saved choice.
  const on = await put({enabled: true}, f);
  assert.equal(on.status, 200, await on.clone().text());
  assert.deepEqual((await on.json()).prebidMode.bidCache, {enabled: true, maxBidAgeSeconds: 90, positionOverrides: {In_Article: false}});
});

test('the payload says whether the selected script version applies bid caching', async () => {
  const runtime3212 = runtimeCatalog.find(runtime => runtime.id === 'tessera-3.21.2' && runtime.version === '3.21.2');
  const selection = runtime => ({schemaVersion: 1, runtime: pinRuntime(runtime, {allowPreview: true}), prebid: null});
  let f = setup({builtinRuntimeSelection: selection(runtime3212)});
  let state = await read(f);
  assert.deepEqual(state.selectedRuntime, {id: 'tessera-3.21.2', version: '3.21.2'});
  assert.equal(state.runtimeSupportsBidCache, false);
  // Saving is allowed either way: Generate refuses with 3.21.2 instead of ignoring the setting.
  assert.equal((await put({enabled: true, revision: state.revision, bidCache: {enabled: true, maxBidAgeSeconds: 60}}, f)).status, 200);

  // A pin whose engine no longer matches the catalog is not trusted.
  const changed = selection(runtime3212);
  f = setup({builtinRuntimeSelection: {...changed, runtime: {...changed.runtime, runtimeSha256: 'f'.repeat(64)}}});
  state = await read(f);
  assert.equal(state.selectedRuntime, null);
  assert.equal(state.runtimeSupportsBidCache, false);

  // Any catalog runtime with the bid-cache capability, not only 3.23.0, applies the settings.
  const fake = validateRuntimeDescriptor({id: 'fixture-bid-cache', version: '0.0.1-fixture.1', codeSha256: 'b'.repeat(64), configSchemaVersion: 1, channel: 'preview', capabilities: ['bid-cache', 'config-preview']});
  runtimeCatalog.push(fake);
  try {
    f = setup({builtinRuntimeSelection: selection(fake)});
    state = await read(f);
    assert.deepEqual(state.selectedRuntime, {id: 'fixture-bid-cache', version: '0.0.1-fixture.1'});
    assert.equal(state.runtimeSupportsBidCache, true);
    assert.deepEqual(state.bidCachePositions, ELIGIBLE, 'the runtime does not change which positions are eligible');
    const response = await put({enabled: true, revision: state.revision, bidCache: {enabled: false, maxBidAgeSeconds: 60, positionOverrides: {Billboard: true}}}, f);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).runtimeSupportsBidCache, true);
  } finally {
    runtimeCatalog.splice(runtimeCatalog.indexOf(fake), 1);
  }
  // The registered 3.23.0 runtime reports the capability.
  const registered = runtimeCatalog.find(runtime => runtime.id === 'tessera-3.23.0' && runtime.version === BID_CACHE_RUNTIME_VERSION);
  assert(registered, '3.23.0 is in the runtime catalog');
  f = setup({builtinRuntimeSelection: selection(registered)});
  state = await read(f);
  assert.deepEqual(state.selectedRuntime, {id: 'tessera-3.23.0', version: '3.23.0'});
  assert.equal(state.runtimeSupportsBidCache, true);
});

test('Tanjug gets the same cache fields; only the named-script library sentence differs', async () => {
  const f = setup({prebidBidCache: {enabled: true, maxBidAgeSeconds: 60, positionOverrides: {Billboard: false}}});
  addTanjug(f);
  const example = await read(f), tanjug = await read(f, TANJUG.id);
  assert.equal(example.namedScriptLibrary, false);
  assert.equal(tanjug.namedScriptLibrary, true);
  // The position dialog says "use it too" only for positions named scripts include (the reviewed Tanjug inventory).
  assert.deepEqual(example.namedScriptPositions, []);
  assert.deepEqual(tanjug.namedScriptPositions, [...CACHE_POSITIONS]);
  assert(tanjug.bidCachePositions.includes('Home_Top') && !tanjug.namedScriptPositions.includes('Home_Top'), 'an eligible Tanjug position outside the named-script inventory');
  // Bidder counts and Prebid builds differ between the two fixtures; every cache field is equal.
  const cacheFields = state => ({revision: state.revision, bidCacheAvailable: state.bidCacheAvailable, bidCachePositions: state.bidCachePositions,
    bidCacheRuntimeVersion: state.bidCacheRuntimeVersion, selectedRuntime: state.selectedRuntime, runtimeSupportsBidCache: state.runtimeSupportsBidCache, prebidMode: state.prebidMode});
  assert.deepEqual(cacheFields(tanjug), cacheFields(example));
  assert.deepEqual(Object.keys(tanjug).sort(), Object.keys(example).sort());
  // The same save is accepted or refused the same way for both sites.
  for (const [positionOverrides, status] of [[{Home_Top: true}, 200], [{Sticky: true}, 422], [{Off_Unit: true}, 422]]) {
    for (const site of [SITE, TANJUG.id]) {
      const state = await read(f, site);
      assert.equal((await put({enabled: true, revision: state.revision, bidCache: {enabled: true, maxBidAgeSeconds: 60, positionOverrides}}, f, site)).status, status, `${site} ${JSON.stringify(positionOverrides)}`);
    }
  }
});

test('saved malformed settings are still reported for review', async () => {
  const f = setup({prebidBidCache: {enabled: true, maxBidAgeSeconds: 60, positionOverrides: {Billboard: 'yes'}}});
  const response = await getPrebidMode(f.env, SITE);
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, 'Saved Prebid settings need review.');
});

test('override shape: any valid ad unit code, booleans only, code-unit order', () => {
  assert.deepEqual(Object.keys(bidCacheOverrides({b: true, Interstitial: false, InText_1: true, A: false})), ['A', 'InText_1', 'Interstitial', 'b']);
  assert.deepEqual(bidCacheOverrides(JSON.parse('{"__proto__":true,"constructor":false}')), JSON.parse('{"__proto__":true,"constructor":false}'));
  assert.deepEqual(bidCacheOverrides({'Početna_1': true, 'a-b.c:d(1)': false}), {'Početna_1': true, 'a-b.c:d(1)': false});
  assert.deepEqual(bidCacheSettings({enabled: false, maxBidAgeSeconds: 60, positionOverrides: {}}), {enabled: false, maxBidAgeSeconds: 60});
  for (const value of [{a: 1}, {'a b': true}, {'/a': true}, 'a', 1, true]) assert.throws(() => bidCacheOverrides(value), error => error.status === 422);
  // The per-site rule: new or changed keys must be eligible; unchanged saved keys stay.
  assert.doesNotThrow(() => requireEligibleOverrides({positionOverrides: {Old: true, New: false}}, {positionOverrides: {Old: true}}, ['New']));
  assert.throws(() => requireEligibleOverrides({positionOverrides: {Old: false}}, {positionOverrides: {Old: true}}, ['New']), error => error.status === 422);
  assert.throws(() => requireEligibleOverrides({positionOverrides: {constructor: true}}, {positionOverrides: {}}, []), error => error.status === 422);
  assert.throws(() => requireEligibleOverrides({positionOverrides: {Old: true}}, 'not saved', []), error => error.status === 422);
  assert.doesNotThrow(() => requireEligibleOverrides({}, undefined, []));
});

test('saving bid caching leaves the saved user sync setting as it is', async () => {
  // Prebid is already on and the site has no saved userSync, which compiles to user sync off.
  const f = setup();
  assert.equal(f.readConfig().enablePrebid, true);
  assert.equal(Object.hasOwn(f.readConfig(), 'userSync'), false);
  const state = await read(f);
  const response = await put({enabled: true, revision: state.revision, bidCache: {enabled: true, maxBidAgeSeconds: 45}}, f);
  assert.equal(response.status, 200, await response.clone().text());
  const saved = f.readConfig();
  assert.deepEqual(saved.prebidBidCache, {enabled: true, maxBidAgeSeconds: 45});
  assert.equal(Object.hasOwn(saved, 'userSync'), false, 'a bid cache save must not turn on user sync');
  assert.equal(Object.hasOwn(saved, 'userIdConfig'), false);
  // An explicitly saved setting is kept too.
  const g = setup({userSync: {syncEnabled: false, userIds: []}});
  const again = await put({enabled: true, revision: (await read(g)).revision, bidCache: {enabled: false, maxBidAgeSeconds: 60}}, g);
  assert.equal(again.status, 200, await again.clone().text());
  assert.deepEqual(g.readConfig().userSync, {syncEnabled: false, userIds: []});
});
