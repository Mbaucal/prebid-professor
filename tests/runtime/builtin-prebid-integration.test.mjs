import test from 'node:test';
import assert from 'node:assert/strict';
import { readPreviewSnapshot, runtimeDescriptor } from '../../worker/runtime/builtin-preview-service.mjs';
import { previewInput, digest } from '../../worker/runtime/preview-snapshot.mjs';
import { handlePrebidPreflight } from '../../worker/runtime/prebid-preflight-service.mjs';
import { sha256 } from '../../worker/runtime/prebid-artifact-check.mjs';

async function fixture(enablePrebid = true) {
  const siteId = 'test-site';
  const modules = ['openxBidAdapter', 'consentManagementTcf', 'tcfControl', 'currency'];
  const snapshot = {
    site: { id: siteId, name: 'Local test only', domain: 'example.invalid', gam_path: '/123/test/' },
    config: { config_json: JSON.stringify({ enablePrebid, runtimeControls: { sticky: { bottomAdUnitId: '' }, floors: { enabled: false } } }) },
    units: [{ code: 'Billboard', type: 'ATF', media_type: 'banner', enabled: 1, size_map_key: 'display' }],
    bidders: [{ bidder: 'openx', enabled: 1, params_json: '{"unit":"test","delDomain":"example.invalid"}' }],
    maps: [{ name: 'display', map_json: '[{"minViewPort":[0,0],"sizes":[[300,250]]}]' }],
    overrides: [], rules: [],
  };
  const builds = [{ id: 'build-1', publisher_id: siteId, version: '11.11.0', status: 'current',
    file_key: 'publishers/test-site/prebid-builds/build-1/prebid.js', modules_json: JSON.stringify(modules), uploaded_at: '2026-09-11T00:00:00Z' }];
  const bytes = new TextEncoder().encode(`/* prebid.js v11.11.0\nModules: ${modules.join(', ')} */\nvoid 0;`).buffer;
  let reads = 0; let storageReads = 0;
  const db = {
    prepare(sql) {
      assert.match(sql, /^SELECT /); assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE|CREATE|ALTER/i);
      return { bind(id) { assert.equal(id, siteId); return { sql }; } };
    },
    async batch(statements) {
      reads++;
      assert([7, 8].includes(statements.length));
      const values = [[snapshot.site], [snapshot.config], snapshot.units, snapshot.bidders, snapshot.overrides, snapshot.maps, snapshot.rules];
      if (statements.length === 8) { assert.match(statements[7].sql, /publisher_id = \? AND status = 'current'/); values.push(builds); }
      return structuredClone(values.map((results) => ({ success: true, results })));
    },
  };
  const object = { size: bytes.byteLength, customMetadata: { sha256: await sha256(bytes), version: '11.11.0' }, async arrayBuffer() { return bytes; } };
  const bucket = { async get(key) { storageReads++; assert.equal(key, builds[0].file_key); return object; }, put() { assert.fail('No R2 writes'); }, delete() { assert.fail('No deletion'); } };
  const env = { DB: db, get BUILDS() { if (!enablePrebid) assert.fail('GPT-only must not access R2'); return bucket; } };
  const url = new URL(`https://preview.example.invalid/api/publishers/${siteId}/builtin-runtime-prebid-check`);
  url.searchParams.set('reviewHash', await digest(snapshot)); url.searchParams.set('runtimeSha256', runtimeDescriptor.codeSha256);
  return { snapshot, builds, db, env, bucket, object, reads: () => reads, storageReads: () => storageReads,
    run: () => handlePrebidPreflight(new Request(url), env, siteId, { readSnapshot: readPreviewSnapshot, normalizeInput: previewInput, digest, runtime: runtimeDescriptor }) };
}

test('real snapshot reader stays seven SELECTs by default', async () => {
  const f = await fixture(); assert.deepEqual(await readPreviewSnapshot(f.db, 'test-site'), f.snapshot); assert.equal(f.reads(), 1);
});
test('real optional snapshot adds only a scoped current-build SELECT', async () => {
  const f = await fixture(); const value = await readPreviewSnapshot(f.db, 'test-site', { includePrebid: true });
  assert.deepEqual(value.prebidBuilds, f.builds); const { prebidBuilds, ...base } = value;
  assert.equal(await digest(base), await digest(f.snapshot));
});
test('real generator adapter + snapshot reader verify artifact without writes', async () => {
  const f = await fixture(); const res = await f.run(); const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data)); assert.equal(data.report.status, 'checked', JSON.stringify(data));
  assert.equal(data.report.completeRelease, false); assert.equal(f.storageReads(), 1); assert.equal(f.reads(), 2);
});
test('real GPT-only normalization skips the artifact entirely', async () => {
  const f = await fixture(false); const res = await f.run(); assert.equal(res.status, 200);
  assert.equal((await res.json()).report.status, 'not_required'); assert.equal(f.storageReads(), 0);
});
test('real snapshot reader rejects a build change during R2 inspection', async () => {
  const f = await fixture(); f.bucket.get = async () => { f.builds[0].uploaded_at = '2026-09-11T01:00:00Z'; return f.object; };
  const res = await f.run(); assert.equal(res.status, 409); assert.match((await res.json()).error, /changed during/);
});
