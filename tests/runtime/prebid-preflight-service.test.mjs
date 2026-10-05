import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePrebidPreflight } from '../../worker/runtime/prebid-preflight-service.mjs';
import { sha256 } from '../../worker/runtime/prebid-artifact-check.mjs';
const digest = async (value) => sha256(new TextEncoder().encode(JSON.stringify(value)));
const runtime = { codeSha256: 'a'.repeat(64) };
const configuration = () => ({ site: { id: 'test-site' }, config: { config_json: '{"enablePrebid":false}' }, units: [], bidders: [], overrides: [], maps: [], rules: [] });
async function setup() {
  const value = configuration();
  const snapshot = { ...value, prebidBuilds: [] };
  let reads = 0;
  const env = { DB: { marker: true }, get BUILDS() { assert.fail('GPT-only should not touch R2'); } };
  const deps = { runtime, digest, normalizeInput() { return { core: {}, options: { enablePrebid: false } }; },
    async readSnapshot(db, id, options) { assert.equal(db, env.DB); assert.equal(id, 'test-site'); assert.deepEqual(options, { includePrebid: true }); reads++; return structuredClone(snapshot); } };
  const url = new URL('https://preview.example.invalid/api/publishers/test-site/builtin-runtime-prebid-check');
  url.searchParams.set('reviewHash', await digest(value)); url.searchParams.set('runtimeSha256', runtime.codeSha256);
  return { value, snapshot, env, deps, url, reads: () => reads, run: () => handlePrebidPreflight(new Request(url), env, 'test-site', deps) };
}
test('GPT-only preflight performs two stable reads and no R2 access', async () => {
  const f = await setup(); const res = await f.run(); const data = await res.json();
  assert.equal(res.status, 200); assert.equal(data.report.status, 'not_required'); assert.equal(data.report.completeRelease, false); assert.equal(f.reads(), 2);
  assert.match(res.headers.get('cache-control'), /private, no-store/);
});
test('missing review token fails before reading any saved settings', async () => {
  const f = await setup(); f.url.searchParams.delete('reviewHash'); assert.equal((await f.run()).status, 409); assert.equal(f.reads(), 0);
});
test('changed runtime source is refused', async () => {
  const f = await setup(); f.url.searchParams.set('runtimeSha256', 'b'.repeat(64)); assert.equal((await f.run()).status, 409); assert.equal(f.reads(), 0);
});
test('configuration changed in another tab is refused before R2', async () => {
  const f = await setup(); f.snapshot.site = { id: 'test-site', name: 'changed' }; assert.equal((await f.run()).status, 409); assert.equal(f.reads(), 1);
});
test('build change during inspection cannot return a stale report', async () => {
  const f = await setup(); const original = f.deps.readSnapshot;
  f.deps.readSnapshot = async (...args) => { const snapshot = await original(...args); if (f.reads() > 1) snapshot.prebidBuilds = [{ id: 'new' }]; return snapshot; };
  assert.equal((await f.run()).status, 409);
});
test('different site from reader fails closed', async () => {
  const f = await setup(); f.snapshot.site = { id: 'other-site' }; assert.equal((await f.run()).status, 409);
});
test('unsupported mutations do not reach storage', async () => {
  const f = await setup(); const res = await handlePrebidPreflight(new Request(f.url, { method: 'POST' }), f.env, 'test-site', f.deps);
  assert.equal(res.status, 405); assert.equal(f.reads(), 0);
});
test('underlying failures are sanitized', async () => {
  const f = await setup(); f.deps.readSnapshot = () => { throw new Error('secret-internal-details'); };
  const res = await f.run(); assert.equal(res.status, 422); assert(!(await res.text()).includes('secret-internal-details'));
});
