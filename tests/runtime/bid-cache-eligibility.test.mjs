import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BID_CACHE_CAPABILITY, BID_CACHE_RUNTIME_VERSION, runtimeSupportsBidCache, bidCacheEligibleCodes, bidCacheEligibleInputCodes} from '../../shared/bid-cache/eligibility.mjs';
import {BID_CACHE_GENERATOR_MESSAGE, requireSupportedCacheGenerator} from '../../worker/site-runtime/prebid-cache-settings.mjs';
import {runtimeCatalog, previewInput, buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {defaultTakeOver} from '../../worker/test-workspace/takeover-settings.mjs';

const unit = (code, extra = {}) => ({code, type: 'BTF', media_type: 'banner', size_map_key: 'display', enabled: 1, sort_order: 0, ...extra});
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
const capable = Object.freeze({id: 'tessera-3.23.0', version: '3.23.0', capabilities: Object.freeze(['bid-cache', 'config-preview'])});
const runtime3212 = runtimeCatalog.find(release => release.id === 'tessera-3.21.2' && release.version === '3.21.2');
const outstreamUnit = format => ({format, playerSize: [640, 360], minDuration: 1, maxDuration: 30, playbackMethod: 2, placement: 3, plcmt: 4,
  partner: {bidder: 'pubmatic', adapter: 'pubmatic', outstreamAU: 'synthetic-au', activationConfirmed: true}, cacheUrl: 'https://prebid.adnxs.com/pbc/v1/cache'});
const STAMP = '20261115_120000';

test('constants name the capability and the first runtime version that has it', () => {
  assert.equal(BID_CACHE_CAPABILITY, 'bid-cache');
  assert.equal(BID_CACHE_RUNTIME_VERSION, '3.23.0');
});

test('the shared module has no imports, so it can sit inside a runtime closure', () => {
  const source = readFileSync(new URL('../../shared/bid-cache/eligibility.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s|\bimport\s*\(|\brequire\s*\(/m);
  assert.doesNotMatch(source, /Date\b|Math\.random|localeCompare|Intl\b|toString/);
});

test('runtimeSupportsBidCache is true only when the capabilities list bid-cache', () => {
  assert.equal(runtimeSupportsBidCache(capable), true);
  assert.equal(runtimeSupportsBidCache({capabilities: ['bid-cache']}), true);
  assert.ok(runtime3212, '3.21.2 is in the catalog');
  assert.equal(runtimeSupportsBidCache(runtime3212), false);
  for (const descriptor of runtimeCatalog) assert.equal(runtimeSupportsBidCache(descriptor), false, `${descriptor.id} has no bid-cache capability today`);
  for (const value of [undefined, null, {}, [], 'bid-cache', ['bid-cache'], {capabilities: 'bid-cache'}, {capabilities: ['bid-cache-v2']},
    {capabilities: [['bid-cache']]}, {capabilities: null}, {version: '3.23.0'}, {id: 'tessera-3.23.0', version: '3.23.0', capabilities: []}]) {
    assert.equal(runtimeSupportsBidCache(value), false, JSON.stringify(value));
  }
});

test('eligible codes: enabled ATF/BTF banner units, sorted by code unit order and unique', () => {
  const units = [unit('P2'), unit('Billboard', {type: 'ATF'}), unit('P10'), unit('a_lower'), unit('Sticky'),
    unit('Off', {enabled: 0}), unit('Draft', {type: 'DRAFT'}), unit('Video', {media_type: 'video'}), unit('Native', {media_type: 'native'}),
    unit('Spaced', {media_type: ' banner'}), unit('Bool', {enabled: true}), unit('Other', {type: 'OOP'}), unit(''), {code: 7, type: 'BTF', media_type: 'banner', enabled: 1},
    null, 'P3', unit('P2')];
  const config = deepFreeze({enablePrebid: true});
  assert.deepEqual(bidCacheEligibleCodes(deepFreeze(units), config), ['Billboard', 'P10', 'P2', 'Sticky', 'a_lower']);
  assert.deepEqual(bidCacheEligibleCodes([...units].reverse(), config), ['Billboard', 'P10', 'P2', 'Sticky', 'a_lower']);
  assert.deepEqual(bidCacheEligibleCodes(units, {}), ['Billboard', 'P10', 'P2', 'Sticky', 'a_lower'], 'a config without runtime controls');
});

test('eligible codes do not depend on whether Prebid is on', () => {
  const units = [unit('Billboard'), unit('P1')];
  assert.deepEqual(bidCacheEligibleCodes(units, {enablePrebid: false}), ['Billboard', 'P1']);
  assert.deepEqual(bidCacheEligibleCodes(units, {enablePrebid: true}), ['Billboard', 'P1']);
});

test('a TakeOver ad position and its Interstitial fallback are never eligible', () => {
  const units = [unit('Billboard'), unit('Overlay'), unit('Interstitial'), unit('TakeOver')];
  const config = {runtimeControls: {adPositions: {Overlay: {demand: 'site'}}}};
  assert.deepEqual(bidCacheEligibleCodes(units, config), ['Billboard', 'TakeOver']);
  // The ad position replaces the legacy control, as in takeOverForBuild.
  const legacy = {...defaultTakeOver(), enabled: true};
  assert.deepEqual(bidCacheEligibleCodes(units, {runtimeControls: {adPositions: {Overlay: {}}, takeOver: legacy}}), ['Billboard', 'TakeOver']);
  // Without a TakeOver, a regular unit named Interstitial is an ordinary banner position.
  assert.deepEqual(bidCacheEligibleCodes(units, {runtimeControls: {adPositions: {}}}), ['Billboard', 'Interstitial', 'Overlay', 'TakeOver']);
  assert.deepEqual(bidCacheEligibleCodes(units, {runtimeControls: {adPositions: null}}), ['Billboard', 'Interstitial', 'Overlay', 'TakeOver']);
});

test('the legacy TakeOver control excludes its code and the Interstitial fallback only while it is on', () => {
  const units = [unit('Billboard'), unit('Interstitial'), unit('TakeOver'), unit('Takeover_2')];
  assert.deepEqual(bidCacheEligibleCodes(units, {runtimeControls: {takeOver: {...defaultTakeOver(), enabled: true}}}), ['Billboard', 'Takeover_2']);
  assert.deepEqual(bidCacheEligibleCodes(units, {runtimeControls: {takeOver: {...defaultTakeOver(), enabled: true, adUnitCode: 'Takeover_2'}}}), ['Billboard', 'TakeOver']);
  assert.deepEqual(bidCacheEligibleCodes(units, {runtimeControls: {takeOver: {...defaultTakeOver(), enabled: false}}}), ['Billboard', 'Interstitial', 'TakeOver', 'Takeover_2']);
});

test('Outstream positions (outstream and banner + outstream) stay fresh-only; a banner format does not', () => {
  const units = [unit('P1'), unit('P2'), unit('P3'), unit('P4'), unit('P5')];
  const config = {runtimeControls: {outstream: {schemaVersion: 1, units: {P1: {format: 'banner'}, P2: outstreamUnit('outstream'), P3: outstreamUnit('banner-outstream'), P4: {}, P6: outstreamUnit('outstream')}}}};
  assert.deepEqual(bidCacheEligibleCodes(units, config), ['P1', 'P5']);
  assert.deepEqual(bidCacheEligibleCodes(units, {runtimeControls: {outstream: null}}), ['P1', 'P2', 'P3', 'P4', 'P5']);
  assert.deepEqual(bidCacheEligibleCodes(units, {runtimeControls: {outstream: {schemaVersion: 1}}}), ['P1', 'P2', 'P3', 'P4', 'P5']);
});

test('codes that match Object.prototype names are ordinary codes', () => {
  const units = [unit('constructor'), unit('toString'), unit('__proto__'), unit('hasOwnProperty')];
  const config = JSON.parse('{"runtimeControls":{"adPositions":{"__proto__":{}},"outstream":{"schemaVersion":1,"units":{"toString":{"format":"outstream"},"constructor":{"format":"banner"}}}}}');
  assert.deepEqual(bidCacheEligibleCodes(units, config), ['constructor', 'hasOwnProperty']);
  assert.deepEqual(bidCacheEligibleCodes(units, {}), ['__proto__', 'constructor', 'hasOwnProperty', 'toString']);
  assert.equal(Object.prototype.polluted, undefined);
});

test('malformed saved containers fail closed: no position is eligible', () => {
  const units = [unit('Billboard'), unit('P1')];
  for (const config of [null, undefined, [], 'config', {runtimeControls: []}, {runtimeControls: 'x'}, {runtimeControls: {adPositions: []}},
    {runtimeControls: {adPositions: 'Overlay'}}, {runtimeControls: {takeOver: null}}, {runtimeControls: {takeOver: []}},
    {runtimeControls: {outstream: []}}, {runtimeControls: {outstream: {schemaVersion: 1, units: []}}}, {runtimeControls: {outstream: 'x'}}]) {
    assert.deepEqual(bidCacheEligibleCodes(units, config), [], JSON.stringify(config));
  }
  for (const rows of [null, undefined, {}, 'Billboard', {0: unit('Billboard'), length: 1}]) assert.deepEqual(bidCacheEligibleCodes(rows, {}), [], JSON.stringify(rows));
});

test('the result is a new array and inputs are not changed', () => {
  const units = deepFreeze([unit('P1'), unit('Billboard')]), config = deepFreeze({runtimeControls: {adPositions: {}, outstream: {schemaVersion: 1, units: {}}}});
  const first = bidCacheEligibleCodes(units, config);
  first.push('X');
  assert.deepEqual(bidCacheEligibleCodes(units, config), ['Billboard', 'P1']);
});

/** Saved snapshots that the 3.21.2 previewInput accepts with Prebid on. */
function snapshots() {
  const takeOverPosition = positionFixture(true);
  // 3.21.2 accepts a regular Interstitial unit beside a TakeOver ad position; it shares the fallback's GAM path.
  takeOverPosition.units = [...takeOverPosition.units, unit('Interstitial', {sort_order: 3})];
  const plain = positionFixture(true);
  const plainConfig = JSON.parse(plain.config.config_json);
  delete plainConfig.runtimeControls.adPositions;
  plain.config.config_json = JSON.stringify(plainConfig);
  plain.units = [...plain.units, unit('Interstitial', {sort_order: 3}), unit('Sticky', {sort_order: 4}), unit('P2', {enabled: 0, sort_order: 5}), unit('P3', {type: 'DRAFT', sort_order: 6})];
  plain.overrides = [];
  const legacy = positionFixture(true);
  const legacyConfig = JSON.parse(legacy.config.config_json);
  delete legacyConfig.runtimeControls.adPositions;
  legacyConfig.runtimeControls.takeOver = {...defaultTakeOver(), enabled: true};
  legacy.config.config_json = JSON.stringify(legacyConfig);
  legacy.units = legacy.units.filter(row => row.code !== 'Overlay');
  legacy.overrides = [];
  const outstream = positionFixture(true);
  const outstreamConfig = JSON.parse(outstream.config.config_json);
  outstreamConfig.runtimeControls.outstream = {schemaVersion: 1, units: {P2: outstreamUnit('outstream'), P3: outstreamUnit('banner-outstream'), P1: {format: 'banner'}}};
  outstreamConfig.builtinRuntimeSelection = {runtime: {runtimeId: 'tessera-3.21.2', runtimeVersion: '3.21.2'}};
  outstream.config.config_json = JSON.stringify(outstreamConfig);
  outstream.units = [...outstream.units, unit('P2', {size_map_key: 'video', sort_order: 3}), unit('P3', {size_map_key: 'video', sort_order: 4})];
  outstream.maps = [...outstream.maps, {name: 'video', map_json: JSON.stringify([{viewport: [0, 0], sizes: [[640, 360], [300, 250]]}])}];
  outstream.prebidBuilds = [{id: 'synthetic', publisher_id: 'test-site', version: '11.34.0', file_key: 'synthetic', modules_json: '["pubmaticBidAdapter"]', status: 'current', uploaded_at: '2026-11-15T00:00:00.000Z'}];
  const unsafe = positionFixture(true);
  const unsafeConfig = JSON.parse(unsafe.config.config_json);
  delete unsafeConfig.runtimeControls.adPositions;
  unsafe.config.config_json = JSON.stringify(unsafeConfig);
  unsafe.units = [unit('constructor', {type: 'ATF'}), unit('Billboard'), unit('toString', {sort_order: 2})];
  unsafe.overrides = [];
  return {takeOverPosition, plain, legacy, outstream, unsafe};
}

test('compiled 3.21.2 input gives the same codes as the saved snapshot when Prebid is on', () => {
  const expected = {takeOverPosition: ['Billboard', 'P1'], plain: ['Billboard', 'Interstitial', 'Overlay', 'P1', 'Sticky'], legacy: ['Billboard', 'P1'],
    outstream: ['Billboard', 'P1'], unsafe: ['Billboard', 'constructor', 'toString']};
  for (const [name, snapshot] of Object.entries(snapshots())) {
    const config = JSON.parse(snapshot.config.config_json);
    const input = previewInput(snapshot, runtime3212, STAMP);
    assert.deepEqual(bidCacheEligibleCodes(snapshot.units, config), expected[name], `${name}: saved shape`);
    assert.deepEqual(bidCacheEligibleInputCodes(input), expected[name], `${name}: compiled shape`);
  }
});

test('a GAM-only compiled input has no eligible codes, while saved settings stay editable', () => {
  const snapshot = positionFixture(false);
  const input = previewInput(snapshot, runtime3212, STAMP);
  assert.equal(input.options.enablePrebid, false);
  assert.deepEqual(bidCacheEligibleInputCodes(input), []);
  assert.deepEqual(bidCacheEligibleCodes(snapshot.units, JSON.parse(snapshot.config.config_json)), ['Billboard', 'P1']);
});

test('malformed compiled input fails closed', () => {
  const input = previewInput(positionFixture(true), runtime3212, STAMP);
  const variants = [null, {}, {...input, core: null}, {...input, core: {...input.core, explicitUnits: null}}, {...input, options: null},
    {...input, outstream: undefined}, {...input, outstream: {...input.outstream, units: null}}, {...input, outstream: {...input.outstream, disabledRefreshCodes: {}}},
    {...input, overlay: {code: ''}}, {...input, overlay: 'Overlay'}, {...input, options: {...input.options, takeOver: 'on'}}];
  for (const value of variants) assert.deepEqual(bidCacheEligibleInputCodes(value), []);
  // Each TakeOver signal on its own excludes the TakeOver code and the Interstitial fallback.
  const withInterstitial = {...input, core: {...input.core, explicitUnits: [...input.core.explicitUnits, {...input.core.explicitUnits[0], id: 'Interstitial'}]}};
  assert.deepEqual(bidCacheEligibleInputCodes(withInterstitial), ['Billboard', 'P1']);
  assert.deepEqual(bidCacheEligibleInputCodes({...withInterstitial, options: {...input.options, takeOver: {enabled: false}}}), ['Billboard', 'P1']);
  assert.deepEqual(bidCacheEligibleInputCodes({...withInterstitial, overlay: null}), ['Billboard', 'P1']);
  assert.deepEqual(bidCacheEligibleInputCodes({...withInterstitial, overlay: null, options: {...input.options, takeOver: {enabled: false}}}), ['Billboard', 'Interstitial', 'Overlay', 'P1']);
  const widened = {...input, core: {...input.core, explicitUnits: input.core.explicitUnits.map(row => row.id === 'P1' ? {...row, formats: ['banner', 'video']} : row.id === 'Billboard' ? {...row, video: {}} : row)}};
  assert.deepEqual(bidCacheEligibleInputCodes(widened), []);
});

test('requireSupportedCacheGenerator refuses saved cache settings unless the runtime has bid-cache', () => {
  assert.equal(BID_CACHE_GENERATOR_MESSAGE, 'Bid caching needs script version 3.23.0. Select 3.23.0 in Script setup and save; your bid cache settings are kept.');
  const on = {enablePrebid: true, prebidBidCache: {enabled: true, maxBidAgeSeconds: 60}};
  const overridesOnly = {enablePrebid: true, prebidBidCache: {enabled: false, maxBidAgeSeconds: 60, positionOverrides: {Billboard: false}}};
  const overrideOn = {enablePrebid: true, prebidBidCache: {enabled: false, maxBidAgeSeconds: 30, positionOverrides: {Sticky: true}}};
  for (const config of [on, overridesOnly, overrideOn]) {
    for (const descriptor of [undefined, null, runtime3212, {capabilities: []}, {capabilities: 'bid-cache'}]) {
      assert.throws(() => requireSupportedCacheGenerator(config, descriptor), error => error.status === 409 && error.message === BID_CACHE_GENERATOR_MESSAGE);
    }
    assert.doesNotThrow(() => requireSupportedCacheGenerator(config, capable));
  }
  // Nothing saved, or Prebid off: every generator may continue.
  for (const config of [{enablePrebid: true}, {enablePrebid: true, prebidBidCache: {enabled: false, maxBidAgeSeconds: 60}},
    {enablePrebid: false, prebidBidCache: {enabled: true, maxBidAgeSeconds: 60, positionOverrides: {Sticky: true}}}]) {
    assert.doesNotThrow(() => requireSupportedCacheGenerator(config));
    assert.doesNotThrow(() => requireSupportedCacheGenerator(config, runtime3212));
    assert.doesNotThrow(() => requireSupportedCacheGenerator(config, capable));
  }
  // Invalid saved settings are still reported, even for a capable runtime.
  for (const descriptor of [undefined, capable]) {
    assert.throws(() => requireSupportedCacheGenerator({enablePrebid: true, prebidBidCache: {enabled: true, maxBidAgeSeconds: 0}}, descriptor), error => error.status === 422);
  }
});

test('the existing Generate path still refuses saved cache settings with 3.21.2 selected', async () => {
  const snapshot = positionFixture(true);
  const config = JSON.parse(snapshot.config.config_json);
  config.prebidBidCache = {enabled: true, maxBidAgeSeconds: 60};
  snapshot.config.config_json = JSON.stringify(config);
  await assert.rejects(buildArtifactCandidate({snapshot, pin: pinRuntime(runtime3212), buildTimestamp: STAMP}), error => error.status === 409 && error.message === BID_CACHE_GENERATOR_MESSAGE);
});
