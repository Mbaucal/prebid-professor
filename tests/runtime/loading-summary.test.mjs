import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { positionFixture } from '../support/position-runtime-fixture.mjs';
import { previewInput, runtimeCatalog } from '../../worker/test-workspace/runtime-catalog.mjs';
import { tesseraLazyRule } from '../../worker/runtime-next/browser-functions.mjs';
import { describeUnitLoading, loadingSummary } from '../../worker/site-runtime/loading-summary.mjs';

function fixture(prebid = false) {
  const saved = positionFixture(prebid);
  saved.rules = [];
  const config = JSON.parse(saved.config.config_json);
  config.runtimeControls.adPositions = {};
  return { saved, config };
}
function input(f) {
  f.saved.config.config_json = JSON.stringify(f.config);
  return previewInput(f.saved, runtimeCatalog[0], '20260922_120000');
}
function describe(f, code) { return describeUnitLoading(input(f), f.saved.units.find(u => u.code === code)); }

test('missing rules use built-in ATF/BTF defaults, not an invented Disabled value', () => {
  const f = fixture();
  assert.equal(describe(f, 'Billboard').label, 'Automatic · ATF');
  assert.equal(describe(f, 'P1').label, 'Automatic · BTF lazy load');
  f.config.runtimeControls.sticky.bottomAdUnitId = 'Billboard';
  assert.equal(describe(f, 'Billboard').label, 'Automatic · Sticky');
});

test('display overrides and null inheritance agree with the actual compiler and browser resolver', () => {
  const f = fixture(true);
  f.saved.rules = [
    { rule_key: '__DEFAULT__', rule_json: '{"lazy":{"enabled":false}}' },
    { rule_key: '__BTF__', rule_json: '{"lazy":{"enabled":true,"fetchMarginPx":600,"renderMarginPx":100}}' },
    { rule_key: 'P1', rule_json: '{"lazy":{"enabled":true,"fetchMarginPx":900,"renderMarginPx":200}}' },
  ];
  for (const override of [null, { enabled: false }, { enabled: true, fetchMarginPx: 700, renderMarginPx: 0 }]) {
    f.config.advancedUnitRules = { P1: { lazy: override } };
    const prepared = input(f);
    const actual = vm.runInNewContext(`(${tesseraLazyRule.toString()})('P1')`, {
      TESSERA_LAZY: prepared.lazyRules, getUnitConfigById: () => ({ type: 'BTF' }),
    });
    const result = describeUnitLoading(prepared, f.saved.units[1]);
    assert.equal(result.label, actual.enabled ? 'Lazy load' : 'Immediately after consent');
    assert.equal(result.source, override === null ? 'BTF group' : 'Ad unit override');
    if (actual.enabled) assert.match(result.detail, new RegExp(`Bid prefetch: ${actual.fetchMarginPx}px`));
  }
});

test('GAM-only lazy loading shows the GAM threshold without an imaginary Prebid auction', () => {
  const f = fixture();
  f.config.advancedUnitRules = { P1: { lazy: { enabled: true, fetchMarginPx: 800, renderMarginPx: 0 } } };
  const result = describe(f, 'P1');
  assert.match(result.detail, /GAM request: on entry to the viewport/);
  assert.match(result.detail, /Prebid is off/);
  assert.doesNotMatch(result.detail, /800/);
});

test('TakeOver uses its own request flow even when group rules specify lazy loading', () => {
  const saved = positionFixture(false), prepared = previewInput(saved, runtimeCatalog[0], '20260922_120000');
  assert.equal(describeUnitLoading(prepared, saved.units[2]).label, 'TakeOver · after consent');
});

test('disabled units and unresolved runtime settings are not presented as active defaults', () => {
  const f = fixture(), prepared = input(f), unit = { ...f.saved.units[1], enabled: 0 };
  assert.equal(describeUnitLoading(prepared, unit).label, 'Not requested');
  assert.equal(loadingSummary(null, f.saved.units, null, null).units[0].label, 'Script setup required');
  const invalid = loadingSummary(null, f.saved.units, { runtimeVersion: 'invalid' }, 'Invalid saved version');
  assert.equal(invalid.units[0].label, 'Review script settings');
  assert.equal(invalid.issue, 'Invalid saved version');
});

test('read-only descriptions retain all saved settings and normalized compiler inputs', () => {
  const f = fixture(), prepared = input(f), before = structuredClone({ prepared, saved: f.saved });
  loadingSummary(prepared, f.saved.units, { runtimeVersion: runtimeCatalog[0].version }, null);
  assert.deepEqual({ prepared, saved: f.saved }, before);
});
