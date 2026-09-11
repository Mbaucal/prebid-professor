import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReferenceBuild, compileReferenceBuild } from '../../worker/runtime/reference-bridge.mjs';
import { fixture } from './bridge-fixture.mjs';
const prepare = (f) => prepareReferenceBuild(f.core, f.options);

test('maps normalized compiler values to reference settings without an uploaded template', () => {
  const f = fixture(), p = prepare(f);
  assert.equal(p.settings.GAM_PATH, f.core.gamPath);
  assert.deepEqual(p.settings.BIDDERS, [{ name: 'ix', params: { siteId: 'test' } }]);
  assert.deepEqual(p.settings.BIDDER_SLOT_PARAMS, f.core.bidderSlotParams);
  assert.deepEqual(p.settings.BIDDER_DEVICE_PARAMS, f.core.bidderDeviceParams);
  assert.deepEqual(p.settings.BIDDER_ADUNIT_PARAMS, f.core.bidderAdUnitParams);
  assert.deepEqual(p.settings.AD_UNITS, f.core.explicitUnits);
  assert.deepEqual(p.settings.AD_UNIT_RULES, f.core.adUnitRules);
  assert.deepEqual(p.settings.SIZE_MAPS, f.core.sizeMapsRaw);
  assert.deepEqual(p.settings.PREBID_SIZE_CONFIGS, f.core.prebidSizeConfigsRaw);
  assert.equal(p.settings.PREBID_TIMEOUT_ATF, 1800);
  assert.equal(p.settings.PREBID_TIMEOUT_BTF, 1400);
  assert.equal(p.settings.PREBID_TIMEOUT_STICKY, 1300);
  assert.equal(p.core.userSync.auctionDelay, 0);
});
test('does not mutate or retain references to caller configuration', () => {
  const f = fixture(), before = JSON.stringify(f), p = prepare(f);
  p.settings.AD_UNITS[0].id = 'Changed';
  p.core.userSync.userIds.push({ name: 'other' });
  assert.equal(JSON.stringify(f), before);
});
test('keeps floor controls and bidder floors distinct', () => {
  const p = prepare(fixture());
  assert.equal(p.settings.HARD_FLOOR_EUR, 0.08);
  assert.equal(p.settings.BIDDER_FLOORS.ix, 0.09);
});
test('disabled floors clear every enforcement value in generated settings', () => {
  const f = fixture(); f.options.floors.enabled = false;
  const p = prepare(f);
  assert.equal(p.settings.HARD_FLOOR_EUR, 0);
  assert.deepEqual(p.settings.BIDDER_FLOORS, {});
  assert.deepEqual(p.settings.PREBID_FLOORS, {});
  assert.equal(f.options.floors.hardFloor, 0.08);
});
test('maps TakeOver sizes, paths and separate timers', () => {
  const p = prepare(fixture());
  assert.equal(p.settings.TAKEOVER_ENABLED, true);
  assert.deepEqual(p.settings.TAKEOVER_DESKTOP_SIZE, [800, 600]);
  assert.deepEqual(p.settings.TAKEOVER_MOBILE_SIZE, [300, 250]);
  assert.equal(p.settings.TAKEOVER_AUTO_CLOSE_DESKTOP_SEC, 10);
  assert.equal(p.settings.TAKEOVER_AUTO_CLOSE_MOBILE_SEC, 5);
  assert.equal(p.settings.TAKEOVER_CODELESS_AD_UNIT_PATH, '/123/test/Interstitial');
  assert.equal('TAKEOVER_TEST_ONLY' in p.settings, false);
});
test('disabled and zero-auto-close TakeOver options remain explicit', () => {
  const f = fixture(); f.options.takeOver.enabled = false; f.options.takeOver.autoCloseMobileSec = 0;
  const p = prepare(f);
  assert.equal(p.settings.TAKEOVER_ENABLED, false);
  assert.equal(p.settings.TAKEOVER_AUTO_CLOSE_MOBILE_SEC, 0);
});
test('GPT-only mode does not erase configured bidders', () => {
  const f = fixture(); f.options.enablePrebid = false;
  const p = prepare(f);
  assert.equal(p.settings.ENABLE_PREBID, false);
  assert.equal(p.settings.BIDDERS.length, 1);
});
test('never inherits the reference publisher ID5 account', () => {
  const f = fixture(); assert.equal(prepare(f).id5Partner, 0);
  f.core.userSync.userIds = [{ name: 'id5Id', params: { partner: 42 }, storage: { type: 'html5', name: 'id5id', expires: 30 } }];
  const p = prepare(f); assert.equal(p.id5Partner, 42);
  assert.deepEqual(p.settings.USER_ID_MODULES, f.core.userSync.userIds);
});
test('accepts dots in valid GAM paths', () => {
  const f = fixture(); f.core.gamPath = '/123/publisher.example/';
  assert.equal(prepare(f).settings.GAM_PATH, f.core.gamPath);
});
test('preserves ranges, defaults, overrides, targeting and schain', () => {
  const f = fixture();
  f.options.unitRange = { prefix: 'P', start: 1, end: 10 };
  f.options.unitDefaults = { type: 'BTF', sizes: [[300, 250]] };
  f.options.unitOverrides = { P2: { sizes: [[300, 600]] } };
  f.options.adKeywords = { section: 'news' };
  f.options.schain = { ver: '1.0', complete: 1, nodes: [] };
  const p = prepare(f);
  assert.deepEqual(p.settings.AD_UNIT_RANGE, f.options.unitRange);
  assert.deepEqual(p.settings.AD_UNIT_DEFAULTS, f.options.unitDefaults);
  assert.deepEqual(p.settings.AD_UNIT_OVERRIDES, f.options.unitOverrides);
  assert.deepEqual(p.settings.ADS_KEYWORDS, f.options.adKeywords);
  assert.deepEqual(p.settings.SCHAIN, f.options.schain);
});
test('does not discard empty size-map breakpoints or fluid sizes', () => {
  const f = fixture(); f.core.sizeMapsRaw.billboard[0].sizes = [];
  f.core.explicitUnits[0].sizes = ['fluid', [300, 250]];
  const p = prepare(f);
  assert.deepEqual(p.settings.SIZE_MAPS.billboard[0].sizes, []);
  assert.deepEqual(p.settings.AD_UNITS[0].sizes, ['fluid', [300, 250]]);
});
const invalid = [
  ['raw template', (f) => { f.core.template = 'untrusted code'; }, /template/],
  ['GEO activation', (f) => { f.options.geo = { country: 'RS' }; }, /geo/],
  ['top sticky no-op', (f) => { f.options.sticky.topAdUnitId = 'Top'; }, /inactive/],
  ['missing sticky slot', (f) => { f.options.sticky.bottomAdUnitId = 'Missing'; }, /enabled explicit/],
  ['implicit floor', (f) => { delete f.options.floors.hardFloor; }, /hardFloor/],
  ['HTTP currency URL', (f) => { f.options.currencyConversion.url = 'http://example.com/rates'; }, /HTTPS/],
  ['credentials in URL', (f) => { f.options.currencyConversion.url = 'https://secret@example.com/rates'; }, /HTTPS/],
  ['undefined values', (f) => { f.core.userSync.bad = undefined; }, /JSON values/],
  ['non-finite timeout', (f) => { f.core.defaultTimeout = NaN; }, /JSON values/],
  ['function-valued config', (f) => { f.core.userSync.bad = () => {}; }, /JSON values/],
  ['prototype key', (f) => { f.options.schain = JSON.parse('{"__proto__":{}}'); }, /not allowed/],
  ['silent downgrade', (f) => { f.core.engine = 'legacy-frozen-v1'; }, /no silent fallback/],
  ['bad metadata ID', (f) => { f.core.siteId = '$&'; }, /safe immutable/],
  ['unknown schedule', (f) => { f.core.globalRefresh.schedule.mode = 'random'; }, /Unknown refresh/],
  ['empty sequence', (f) => { f.core.globalRefresh.schedule = { mode: 'sequence', sequenceSeconds: [] }; }, /must not be empty/],
  ['string boolean', (f) => { f.options.takeOver.enabled = 'false'; }, /boolean/],
  ['relative fallback path', (f) => { f.options.takeOver.codelessAdUnitPath = 'Interstitial'; }, /full, explicit/],
  ['missing userIds', (f) => { delete f.core.userSync.userIds; }, /userIds must be explicit/],
];
for (const [name, change, error] of invalid) test(`rejects ${name} rather than silently changing behavior`, () => {
  const f = fixture(); change(f); assert.throws(() => prepare(f), error);
});
test('trusted dependency requirement is explicit', () => {
  const f = fixture(); assert.throws(() => compileReferenceBuild(f.core, f.options, {}), /Trusted builder/);
});
