import test from 'node:test';
import assert from 'node:assert/strict';
import { auditIsolation, discoverVersions, readSchedules, runOperation, PRODUCTION } from '../../scripts/cloudflare/audit-isolation.mjs';
const p = '11111111-1111-4111-8111-111111111111';
const t = '22222222-2222-4222-8222-222222222222';
const d = '33333333-3333-4333-8333-333333333333';
const envelope = (result) => new Response(JSON.stringify({ success: true, result }));
function fixture() {
  const input = { accountId: 'a'.repeat(32), token: 'synthetic-only-not-real-token', testWorker: 'test-worker', testVersionId: t };
  const deployment = { deployments: [{ id: d, versions: [{ version_id: p, percentage: 100 }] }] };
  const bindings = (id, db, bucket) => ({ id, resources: { bindings: [
    { type: 'd1', name: 'DB', database_id: db }, { type: 'r2_bucket', name: 'BUILDS', bucket_name: bucket },
  ] } });
  const listing = { items: [{ id: p, number: 1, metadata: { created_on: '2026-09-11T01:00:00Z', hasPreview: true,
    author_email: 'private@example.invalid' }, annotations: { secret: 'do-not-print' } }] };
  const f = { input, calls: [], schedules: [], deployment, listing, hook: null };
  f.fetchImpl = async (url, options) => {
    f.calls.push(url);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.body, undefined);
    assert.equal(new URL(url).origin, 'https://api.cloudflare.com'); assert(!url.includes(input.token));
    assert.equal(options.headers.authorization, `Bearer ${input.token}`);
    if (f.hook) { const res = await f.hook(url); if (res) return res; }
    if (url.endsWith('/deployments')) return envelope(f.deployment);
    if (url.endsWith('/versions')) return envelope(f.listing);
    if (url.endsWith(`/versions/${p}`)) return envelope(bindings(p, PRODUCTION.databaseId, PRODUCTION.bucket));
    if (url.endsWith(`/versions/${t}`)) return envelope(bindings(t, d, 'test-only-bucket'));
    if (url.endsWith('/schedules')) return envelope(f.schedules);
    assert.fail('Unexpected API path');
  };
  f.options = { fetchImpl: f.fetchImpl, now: () => '2026-09-11T02:00:00Z' };
  f.audit = () => auditIsolation(input, f.options);
  f.discover = () => discoverVersions(input, f.options);
  return f;
}
for (const shape of ['array', 'wrapped']) {
  test(`${shape} empty schedules allow resource comparison without permission to write`, async () => {
    const f = fixture(); f.schedules = shape === 'array' ? [] : { schedules: [] };
    const result = await f.audit(); assert.equal(result.status, 'resource_separation_observed');
    assert.equal(result.remoteWritesAuthorized, false); assert.equal(f.calls.length, 6);
  });
  test(`${shape} enabled cron blocks, with no returned cron/metadata value`, async () => {
    const f = fixture(); const rows = [{ cron: '* * * * *', private: 'do-not-print' }];
    f.schedules = shape === 'array' ? rows : { schedules: rows };
    const result = await f.audit(); assert.equal(result.status, 'blocked'); assert.equal(result.testScheduleCount, 1);
    assert(!JSON.stringify(result).includes('do-not-print')); assert(!JSON.stringify(result).includes('* * * * *'));
  });
}
test('array schedule change during audit cannot pass', async () => {
  const f = fixture(); f.hook = (url) => { if (f.calls.length === 6) f.schedules.push({ cron: '* * * * *' }); };
  assert.equal((await f.audit()).error, 'deployment_or_schedule_changed_during_audit');
});
for (const shape of [null, {}, { schedules: null }, { schedules: '[]' }, '[]', [null], [{}], [{ cron: 1 }], [{ cron: '' }], [{ cron: '  ' }]]) {
  test(`invalid schedule payload rejected: ${JSON.stringify(shape)}`, async () => {
    const f = fixture(); f.schedules = shape; assert.equal((await f.audit()).error, 'schedules_not_available');
  });
}
test('too many schedule rows are rejected', () => assert.throws(() => readSchedules(Array(1001).fill({ cron: '* * * * *' })), /schedules_not_available/));
for (const suffix of ['/deployments', `/versions/${p}`]) {
  test(`${suffix} must still use an object response`, async () => {
    const f = fixture(); f.hook = (url) => url.endsWith(suffix) ? envelope([]) : null;
    assert.equal((await f.audit()).error, 'unsuccessful_metadata_response');
  });
}
test('a false success flag cannot pass even with valid schedules array', async () => {
  const f = fixture(); f.hook = (url) => url.endsWith('/schedules') ? new Response(JSON.stringify({ success: false, result: [] })) : null;
  assert.equal((await f.audit()).error, 'unsuccessful_metadata_response');
});
test('discovery reads only deployment/list/deployment and does not select a test version', async () => {
  const f = fixture(); delete f.input.testVersionId;
  const result = await f.discover(); assert.equal(result.status, 'versions_discovered'); assert.equal(f.calls.length, 3);
  assert.equal(result.versions[0].versionId, p); assert.equal(result.versions[0].servingTraffic, true);
  assert.equal(result.isolationChecked, false); assert.equal(result.remoteWritesAuthorized, false);
  assert.equal(result.launchApproved, false); assert.equal(result.completeVersionInventory, false);
  assert(f.calls.every((url) => /\/(versions|deployments)$/.test(url)));
});
test('discovery never exports authors, annotations, tokens or binding values', async () => {
  const f = fixture(); f.listing.items[0].resources = { bindings: [{ text: 'sensitive-value' }] };
  const text = JSON.stringify(await f.discover());
  for (const secret of ['private@example.invalid', 'do-not-print', 'sensitive-value', f.input.token]) assert(!text.includes(secret));
});
test('discovery does not invent preview availability', async () => {
  const f = fixture(); delete f.listing.items[0].metadata.hasPreview;
  assert.equal((await f.discover()).versions[0].previewAvailable, null);
});
test('a listed newer version is not marked as serving unless deployed', async () => {
  const f = fixture(); f.listing.items.unshift({ id: t, number: 2, metadata: {} });
  const result = await f.discover(); assert.equal(result.versions[0].servingTraffic, false);
  assert.equal(result.versions[1].servingTraffic, true);
});
test('discovery drift is unverified', async () => {
  const f = fixture(); f.hook = () => { if (f.calls.length === 3) f.deployment.deployments[0].id = t; };
  assert.equal((await f.discover()).error, 'deployment_changed_during_discovery');
});
for (const mutate of [
  (f) => { f.input.token = ''; },
  (f) => { f.input.accountId = 'wrong'; },
  (f) => { f.input.testWorker = 'https://elsewhere.invalid'; },
]) test('invalid discovery inputs do not use the network', async () => {
  const f = fixture(); mutate(f); assert.equal((await f.discover()).status, 'unverified'); assert.equal(f.calls.length, 0);
});
for (const mutate of [
  (f) => { f.listing = []; },
  (f) => { f.listing = {}; },
  (f) => { f.listing.items[0].id = 'short-prefix'; },
  (f) => { f.listing.items[0].number = '1'; },
  (f) => { f.listing.items[0].metadata.created_on = 'sensitive:not-a-date'; },
  (f) => { f.listing.items.push(f.listing.items[0]); },
]) test('invalid discovery metadata never creates a selection', async () => {
  const f = fixture(); mutate(f); const result = await f.discover(); assert.equal(result.status, 'unverified');
  assert.equal(result.versions, undefined); assert(!JSON.stringify(result).includes('sensitive:'));
});
test('unknown operation never makes a network call', async () => {
  const f = fixture(); assert.equal((await runOperation('deploy', f.input, f.options)).error, 'invalid_operation'); assert.equal(f.calls.length, 0);
});
test('audit mode still requires a complete explicit UUID', async () => {
  const f = fixture(); delete f.input.testVersionId;
  assert.equal((await runOperation('audit', f.input, f.options)).error, 'exact_test_version_required'); assert.equal(f.calls.length, 0);
});
test('discovery API failure is sanitized', async () => {
  const f = fixture(); f.hook = () => new Response('private-error-detail', { status: 403 });
  const result = await f.discover(); assert.equal(result.error, 'cloudflare_read_permission_required'); assert(!JSON.stringify(result).includes('private-error'));
});
