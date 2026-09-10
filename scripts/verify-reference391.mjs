/** Offline equivalence proof. The browser ad script is parsed, NEVER executed. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { extractReference391, sha256 } from './extract-reference391.mjs';

const [input, reportPath] = process.argv.slice(2);
if (!input) throw new Error('Usage: node scripts/verify-reference391.mjs <original-reference.txt> [report.json]');
const bytes = await readFile(input);
const extracted = extractReference391(bytes);
const source = bytes.toString('utf8');
const start = source.indexOf('function buildScript(st) {');
const endMarker = "    return out.replace('__SCHAIN_CONFIG_LINE__', SCHAIN_CONFIG_LINE);\n}";
const end = source.indexOf(endMarker, start) + endMarker.length;
const referenceBuilder = source.slice(start, end);
const buildTimestamp = '20260911_090000';

const base = {
  GAM_PATH: '/1234567/tessera-fixture/', AD_CONTAINER_SELECTOR: '.wrapperAd', STICKY_TARGET_ID: 'Sticky',
  PREBID_TIMEOUT: '1500', HARD_FLOOR_EUR: '0.08',
  AD_UNITS: [
    { id: 'Billboard', type: 'ATF', formats: ['banner'], sizes: [[970, 250], [728, 90]] },
    { id: 'Sticky', type: 'ATF', formats: ['banner'], sizes: [[320, 100], [300, 50]] },
  ],
};
const scenarios = [
  ['standard', {}],
  ['takeover-default', { TAKEOVER_ENABLED: true }],
  ['takeover-custom', { TAKEOVER_ENABLED: true, TAKEOVER_DESKTOP_SIZE: [750, 560], TAKEOVER_MOBILE_SIZE: [320, 250],
    TAKEOVER_AUTO_CLOSE_DESKTOP_SEC: 12, TAKEOVER_AUTO_CLOSE_MOBILE_SEC: 7, TAKEOVER_SHOW_COUNTDOWN: false,
    TAKEOVER_CODELESS_AD_UNIT_PATH: '/1234567/tessera-fixture/Interstitial', TAKEOVER_CLOSE_LABEL: 'Close' }],
  ['gpt-only', { ENABLE_PREBID: false, TAKEOVER_ENABLED: true }],
  ['bidders-overrides', { BIDDERS: [{ name: 'ix', params: { siteId: 'test-id' } }],
    BIDDER_DEVICE_PARAMS: { ix: { mobile: { siteId: 'mobile-test' } } },
    BIDDER_ADUNIT_PARAMS: { ix: { Billboard: { siteId: 'billboard-test' } } },
    AD_UNIT_RULES: { __DEFAULT__: { timeout: 1200 }, Sticky: { refresh: { minSeconds: 45 } } } }],
  ['maps-and-range', { AD_UNIT_RANGE: { prefix: 'P', start: 1, end: 5 },
    AD_UNIT_DEFAULTS: { type: 'BTF', formats: ['banner'], sizes: [[300, 250]] },
    SIZE_MAPS: { banner: [{ viewport: [1024, 0], sizes: [[970, 250]] }, { viewport: [0, 0], sizes: [[300, 250]] }] } }],
  ['schain-userids', { SCHAIN: { ver: '1.0', complete: 1, nodes: [{ asi: 'example.com', sid: 'fixture', hp: 1 }] },
    USER_ID_MODULES: [{ name: 'fixtureId', params: { params: { partner: 1 }, storage: { type: 'html5', name: 'fixture-id' } } }] }],
  ['floors-refresh', { PREBID_FLOORS: { 'banner|320x100': 0.12 }, BIDDER_FLOORS: { ix: 0.1 },
    DWELL_MIN_VIEW_SEC: 30, REFRESH_BATCH_WINDOW_MS: 0, MAX_REFRESHES_PER_SLOT: 10, STICKY_LAZY_ENABLED: true }],
];
const invalid = [
  ['takeover-in-regular-units', { TAKEOVER_ENABLED: true, AD_UNITS: [{ id: 'TakeOver' }] }],
  ['invalid-takeover-size', { TAKEOVER_DESKTOP_SIZE: [0, 600] }],
  ['missing-gam-path', { GAM_PATH: '' }],
  ['invalid-currency', { AD_SERVER_CURRENCY: 'INVALID' }],
];
const temporary = await mkdtemp(join(tmpdir(), 'tessera-reference391-'));
const results = [];
try {
  const modulePath = join(temporary, 'reference391.mjs');
  await writeFile(modulePath, extracted.code);
  const { buildReference391 } = await import(pathToFileURL(modulePath).href);
  function original(settings) {
    // Only the approved builder executes; no SpreadsheetApp, browser, network or secrets exist here.
    return vm.runInNewContext(referenceBuilder + '\nbuildScript(settings);', {
      settings, Utilities: { formatDate: () => buildTimestamp }, Session: { getScriptTimeZone: () => 'UTC' },
    }, { timeout: 2000 });
  }
  for (const [name, changes] of scenarios) {
    const settings = { ...structuredClone(base), ...structuredClone(changes) };
    const before = JSON.stringify(settings);
    const expected = original(structuredClone(settings));
    const actual = buildReference391(settings, { buildTimestamp });
    assert.equal(actual, expected, `${name}: browser output changed`);
    assert.equal(JSON.stringify(settings), before, `${name}: input mutated`);
    assert.equal(buildReference391(settings, { buildTimestamp }), actual, `${name}: not deterministic`);
    new vm.Script(actual, { filename: `${name}.ads.js` });
    assert.equal(actual.includes('${'), false, `${name}: unresolved interpolation`);
    results.push({ name, pass: true, byteParity: true, syntax: true, deterministic: true, sha256: sha256(actual) });
  }
  for (const [name, changes] of invalid) {
    const settings = { ...structuredClone(base), ...structuredClone(changes) };
    let expectedError;
    try { original(structuredClone(settings)); } catch (error) { expectedError = error.message; }
    assert.ok(expectedError, `${name}: reference did not reject invalid input`);
    assert.throws(() => buildReference391(settings, { buildTimestamp }), (error) => error.message === expectedError);
    results.push({ name, pass: true, sameValidationError: true });
  }
  const report = {
    ...extracted.manifest, buildTimestamp, node: process.version,
    testScope: 'Approved reference: generator byte equivalence, determinism, input integrity, syntax and validation only.',
    browserExecuted: false, adRequestsSent: 0, cloudflareWrites: 0, productionReady: false,
    passed: results.length, failed: 0, results,
  };
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
