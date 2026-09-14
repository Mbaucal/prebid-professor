import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { decodeBuilder, adaptBuilder, MODULE_SHA256 } from '../../scripts/prepare-builtin-runtime.mjs';
import { sha256 } from '../../scripts/extract-reference391.mjs';
import { previewInput, digest, assertReview } from '../../worker/runtime/preview-snapshot.mjs';
import { pinRuntime } from '../../worker/runtime/version-pin.mjs';
import { generatePreview, handleBuiltinPreview, runtimeDescriptor } from '../../worker/runtime/builtin-preview-service.mjs';

const TS = '20260911_120000';
const fixture = () => ({
  site: { id: 'test-site', name: 'Test site', domain: 'example.invalid', gam_path: '/123/test/' },
  config: { config_json: JSON.stringify({ enablePrebid: false, runtimeControls: { sticky: { bottomAdUnitId: 'Sticky', topAdUnitId: '' }, floors: { enabled: false, hardFloor: 0, currency: 'EUR', bidderFloors: {}, rules: {} } } }) },
  units: [{ code: 'Billboard', type: 'ATF', media_type: 'banner', size_map_key: 'display', enabled: 1 }, { code: 'Sticky', type: 'ATF', media_type: 'banner', size_map_key: 'display', enabled: 1 }],
  bidders: [], overrides: [], rules: [],
  maps: [{ name: 'display', map_json: JSON.stringify([{ minViewPort: [0, 0], sizes: [[320, 100]] }, { minViewPort: [1024, 0], sizes: [[728, 90]] }]) }],
});
function configure(snapshot, patch) {
  const config = JSON.parse(snapshot.config.config_json);
  patch(config); snapshot.config.config_json = JSON.stringify(config); return snapshot;
}
const pin = () => pinRuntime(runtimeDescriptor, { allowPreview: true });
const generate = (snapshot = fixture(), takeOver = { enabled: false }) => generatePreview(snapshot, takeOver, pin(), TS);
const base = 'https://preview.example.invalid/api/publishers/test-site/builtin-runtime-preview';
function env(snapshot) {
  return { get BUILDS() { throw new Error('R2 must not be accessed by source preview.'); }, DB: {
    prepare(sql) {
      assert.match(sql, /^SELECT /); assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE|CREATE|ALTER/i);
      return { bind(id) { assert.equal(id, 'test-site'); return { sql }; } };
    },
    async batch(statements) {
      assert.equal(statements.length, 7);
      return [[snapshot.site], [snapshot.config], snapshot.units, snapshot.bidders, snapshot.overrides, snapshot.maps, snapshot.rules].map((results) => ({ success: true, results }));
    },
  } };
}
async function request(snapshot, overrides = {}) {
  const body = { reviewHash: await digest(snapshot), runtimeVersion: runtimeDescriptor.version, runtimeSha256: runtimeDescriptor.codeSha256, allowPreview: true, takeOver: { enabled: false }, ...overrides };
  return new Request(base, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://preview.example.invalid' }, body: JSON.stringify(body) });
}

test('vendored archive reproduces the previously verified readable module', async () => {
  const parts = await Promise.all([0,1,2,3].map((i) => readFile(new URL(`../../vendor/reference391/builder.part${i}.b64`, import.meta.url), 'utf8')));
  assert.equal(sha256(adaptBuilder(decodeBuilder(parts))), MODULE_SHA256);
  assert.throws(() => decodeBuilder(parts.slice(0, 3)));
  assert.throws(() => decodeBuilder(['wrong', ...parts.slice(1)]));
});
test('generated builder contains no Apps Script clock APIs', async () => {
  const source = await readFile(new URL('../../.generated/reference391.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Utilities\.formatDate|Session\.getScriptTimeZone|SpreadsheetApp/);
});
test('bundled source identity is explicit Preview, not Stable', () => {
  assert.equal(runtimeDescriptor.channel, 'preview'); assert.match(runtimeDescriptor.codeSha256, /^[a-f0-9]{64}$/);
  assert.throws(() => pinRuntime(runtimeDescriptor));
});
test('no template upload or R2 profile is required to generate', () => {
  const output = generate(); new vm.Script(output.adsJs); new vm.Script(output.adsMinJs);
  assert.equal(output.requiresReleasePostprocessing, true);
  assert.match(output.adsJs, /HAS_PREBID = false/);
});
test('source preview is deterministic at an exact build timestamp', () => assert.equal(generate().adsJs, generate().adsJs));
test('preview keeps disabled ID5 and floors explicit', () => {
  const output = generate().adsJs;
  assert.match(output, /ID5_PARTNER_ID = 0/); assert.match(output, /HARD_FLOOR_EUR = 0/);
});
test('TakeOver is separately generated and accepts zero auto-close', () => {
  const output = generate(fixture(), { enabled: true, codelessAdUnitPath: '/123/test/Interstitial', autoCloseDesktopSec: 0 }).adsJs;
  new vm.Script(output); assert.match(output, /TAKEOVER_ENABLED = true/); assert.match(output, /TAKEOVER_AUTO_CLOSE_DESKTOP_SEC = 0/);
});
test('TakeOver collision with regular ad units is rejected', () => {
  const snapshot = fixture(); snapshot.units[0].code = 'TakeOver';
  assert.throws(() => generate(snapshot, { enabled: true, codelessAdUnitPath: '/123/test/Interstitial' }), /TakeOver/);
});
test('disabled sticky cannot inherit an automatic Sticky panel', () => {
  const snapshot = configure(fixture(), (config) => { config.runtimeControls.sticky.bottomAdUnitId = null; });
  assert.match(generate(snapshot).adsJs, /STICKY_TARGET_ID = ""/);
});
test('unsupported top sticky fails explicitly', () => {
  assert.throws(() => generate(configure(fixture(), (c) => { c.runtimeControls.sticky.topAdUnitId = 'Billboard'; })), /Top sticky/);
});
test('contextual consent mode is not silently reset', () => {
  assert.throws(() => generate(configure(fixture(), (c) => { c.runtimeControls.consent = { mode: 'contextual-test' }; })), /CMP mode/);
});
test('per-slot lazy overlay is not silently dropped', () => {
  const snapshot = fixture(); snapshot.rules = [{ rule_key: '__BTF__', rule_json: '{"lazy":{"enabled":true}}' }];
  assert.throws(() => generate(snapshot), /lazy settings/);
});
test('conditional mapping overlay is not silently dropped', () => {
  const snapshot = fixture(); snapshot.rules = [{ rule_key: '__ATF__', rule_json: '{"conditionalMappings":[{}]}' }];
  assert.throws(() => generate(snapshot), /Conditional mapping/);
});
test('invalid size map and duplicate units fail', () => {
  const snapshot = fixture(); snapshot.maps[0].map_json = 'not json'; assert.throws(() => generate(snapshot), /JSON/);
  const duplicate = fixture(); duplicate.units.push({ ...duplicate.units[0] }); assert.throws(() => generate(duplicate), /unique/);
});
test('unsafe config properties fail before merging', () => {
  const snapshot = fixture(); snapshot.config.config_json = '{"advancedUnitRules":{"__proto__":{"x":1}}}';
  assert.throws(() => generate(snapshot), /unsafe/); assert.equal({}.x, undefined);
});
test('review checksum detects settings changed in a second tab', async () => {
  const snapshot = fixture(); const hash = await digest(snapshot); await assertReview(snapshot, hash);
  snapshot.units[0].code = 'Other'; await assert.rejects(() => assertReview(snapshot, hash), /changed after review/);
});
test('wrong runtime source pin never falls back', () => {
  assert.throws(() => generatePreview(fixture(), { enabled: false }, { ...pin(), runtimeSha256: '0'.repeat(64) }, TS), /Pinned runtime/);
});
test('GET reads current site and supplies an explicit review checksum', async () => {
  const response = await handleBuiltinPreview(new Request(base), env(fixture()), 'test-site');
  const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.site.id, 'test-site');
  assert.match(body.reviewHash, /^[a-f0-9]{64}$/); assert.equal(body.takeOver.enabled, false);
  assert.equal(body.validationIssue, null); assert.match(response.headers.get('cache-control'), /no-store/);
});
test('POST returns generated source without any R2 or database mutation', async () => {
  const snapshot = fixture(); const before = JSON.stringify(snapshot);
  const response = await handleBuiltinPreview(await request(snapshot), env(snapshot), 'test-site');
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
  new vm.Script(body.content); assert.equal(body.completeRelease, false); assert.equal(body.checksum, await digest(body.content));
  assert.equal(JSON.stringify(snapshot), before);
});
test('POST rejects stale snapshot', async () => {
  const snapshot = fixture(); const req = await request(snapshot); snapshot.site.gam_path = '/123/changed/';
  const response = await handleBuiltinPreview(req, env(snapshot), 'test-site'); assert.equal(response.status, 409);
});
test('POST rejects unknown source/template fields', async () => {
  const snapshot = fixture(); const response = await handleBuiltinPreview(await request(snapshot, { template: 'alert(1)' }), env(snapshot), 'test-site');
  assert.equal(response.status, 422);
});
test('POST requires explicit preview consent', async () => {
  const snapshot = fixture(); const response = await handleBuiltinPreview(await request(snapshot, { allowPreview: false }), env(snapshot), 'test-site');
  assert.equal(response.status, 422);
});
test('POST rejects an out-of-date engine version', async () => {
  const snapshot = fixture(); const response = await handleBuiltinPreview(await request(snapshot, { runtimeVersion: 'latest' }), env(snapshot), 'test-site');
  assert.equal(response.status, 409);
});
test('POST reports malformed JSON', async () => {
  const response = await handleBuiltinPreview(new Request(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }), env(fixture()), 'test-site');
  assert.equal(response.status, 400);
});
test('no active ad units prevents generation', () => {
  const snapshot = fixture(); snapshot.units = []; assert.throws(() => previewInput(snapshot, runtimeDescriptor, TS), /enabled ad unit/);
});
