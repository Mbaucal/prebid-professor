import test from 'node:test';
import assert from 'node:assert/strict';
import { auditIsolation, activeDeployment, inspectVersion, PRODUCTION } from '../../scripts/cloudflare/audit-isolation.mjs';

const ids = { deployment: '10000000-0000-4000-8000-000000000001',
  prod1: '20000000-0000-4000-8000-000000000001', prod2: '20000000-0000-4000-8000-000000000002',
  test: '30000000-0000-4000-8000-000000000001', database: '40000000-0000-4000-8000-000000000001' };
const credentials = { accountId: 'a'.repeat(32), testWorker: 'prebid-professor-test',
  testVersionId: ids.test, token: 'synthetic-read-token-not-a-real-secret' };
const envelope = (result) => new Response(JSON.stringify({ success: true, result }), { headers: { 'content-type': 'application/json' } });
const version = (id, database, bucket) => ({ id, metadata: { author_email: 'should-not-appear@example.invalid' }, resources: { bindings: [
  { name: 'DB', type: 'd1', database_id: database }, { name: 'BUILDS', type: 'r2_bucket', bucket_name: bucket },
  { name: 'ASSETS', type: 'assets' }, { name: 'ADMIN_PASSWORD', type: 'secret_text', text: 'secret-do-not-emit' },
  { name: 'ADMIN_EMAIL', type: 'plain_text', text: 'hidden-admin@example.invalid' },
  { name: 'SESSION_SECRET', type: 'secret_text', text: 'another-secret-do-not-emit' },
] } });
function fixture() {
  const deployment = { deployments: [{ id: ids.deployment, versions: [{ version_id: ids.prod1, percentage: 100 }] }] };
  const prod = version(ids.prod1, PRODUCTION.databaseId, PRODUCTION.bucket);
  const target = version(ids.test, ids.database, 'prebid-professor-test-builds');
  const schedules = { schedules: [] }; const calls = [];
  const f = { input: { ...credentials }, deployment, prod, target, schedules, calls, hook: null };
  f.fetchImpl = async (url, options) => {
    calls.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, `Bearer ${f.input.token}`);
    assert.equal(new URL(url).origin, 'https://api.cloudflare.com');
    assert(!url.includes(f.input.token)); assert.equal(options.body, undefined);
    if (f.hook) { const intercepted = await f.hook(url, calls.length); if (intercepted) return intercepted; }
    if (url.endsWith('/deployments')) return envelope(deployment);
    if (url.endsWith(`/versions/${ids.prod1}`)) return envelope(prod);
    if (url.endsWith(`/versions/${ids.test}`)) return envelope(target);
    if (url.endsWith('/schedules')) return envelope(schedules);
    assert.fail(`Unexpected request: ${url}`);
  };
  f.run = () => auditIsolation(f.input, { fetchImpl: f.fetchImpl, now: () => '2026-09-11T00:00:00Z' });
  return f;
}

test('different explicit resources are observed, never an authorization to write', async () => {
  const f = fixture(); const report = await f.run();
  assert.equal(report.status, 'resource_separation_observed'); assert.equal(report.remoteWritesAuthorized, false);
  assert.equal(report.launchApproved, false); assert.equal(f.calls.length, 6); assert.equal(report.test.versionId, ids.test);
  assert.equal(report.production.deployment.id, ids.deployment);
});
test('secret values, raw bindings and author emails are absent from serialized report', async () => {
  const f = fixture(); const result = JSON.stringify(await f.run());
  for (const text of [f.input.token, 'secret-do-not-emit', 'hidden-admin@example.invalid', 'should-not-appear', 'SESSION_SECRET', 'ADMIN_PASSWORD']) assert(!result.includes(text));
});
for (const name of ['shared D1', 'shared R2', 'same Worker']) test(`${name} cannot pass`, async () => {
  const f = fixture();
  if (name === 'shared D1') f.target.resources.bindings[0].database_id = PRODUCTION.databaseId;
  if (name === 'shared R2') f.target.resources.bindings[1].bucket_name = PRODUCTION.bucket;
  if (name === 'same Worker') f.input.testWorker = PRODUCTION.worker;
  const report = await f.run(); assert.equal(report.status, 'blocked'); assert.equal(report.remoteWritesAuthorized, false);
});
test('R2 jurisdiction difference does not excuse reusing a production bucket name', async () => {
  const f = fixture(); f.target.resources.bindings[1].bucket_name = PRODUCTION.bucket;
  f.target.resources.bindings[1].jurisdiction = 'eu'; assert((await f.run()).issues.includes('shared_production_r2'));
});
test('a renamed extra binding cannot hide production storage reuse', async () => {
  const f = fixture(); f.target.resources.bindings.push({ name: 'OLD_DB', type: 'd1', database_id: PRODUCTION.databaseId });
  const report = await f.run(); assert.equal(report.status, 'blocked'); assert(report.issues.includes('shared_production_d1'));
});
test('known production baseline still protected if current production switched databases', async () => {
  const f = fixture(); f.prod.resources.bindings[0].database_id = '50000000-0000-4000-8000-000000000001';
  f.target.resources.bindings[0].database_id = PRODUCTION.databaseId;
  assert((await f.run()).issues.includes('shared_production_d1'));
});
test('all weighted production versions are inspected, not just the first', async () => {
  const f = fixture(); f.deployment.deployments[0].versions = [{ version_id: ids.prod1, percentage: 90 }, { version_id: ids.prod2, percentage: 10 }];
  f.hook = (url) => url.endsWith(`/versions/${ids.prod2}`) ? envelope(version(ids.prod2, ids.database, 'prod-second-bucket')) : null;
  assert((await f.run()).issues.includes('shared_production_d1')); assert.equal(f.calls.length, 7);
});
test('latest actively serving deployment is the first API entry, not an arbitrary old one', () => {
  const f = fixture(); f.deployment.deployments.push({ id: ids.test, versions: [{ version_id: ids.prod2, percentage: 100 }] });
  assert.equal(activeDeployment(f.deployment).id, ids.deployment);
});
for (const mutate of [
  (d) => d.deployments.splice(0),
  (d) => { d.deployments[0].versions[0].percentage = 90; },
  (d) => { d.deployments[0].versions[0].percentage = '100'; },
  (d) => { d.deployments[0].versions[0].percentage = 0; },
  (d) => { d.deployments[0].versions = Array(2).fill({ version_id: ids.prod1, percentage: 50 }); },
]) test('incomplete/ambiguous deployment metadata fails closed', async () => {
  const f = fixture(); mutate(f.deployment); assert.equal((await f.run()).status, 'unverified');
});
for (const type of ['inherit', 'service', 'kv_namespace', 'queue', 'durable_object_namespace']) test(`unresolved/additional ${type} requires review`, async () => {
  const f = fixture(); f.target.resources.bindings.push({ name: 'EXTRA', type, text: 'do-not-emit' });
  const result = await f.run(); assert.equal(result.status, 'blocked'); assert(!JSON.stringify(result).includes('do-not-emit'));
});
test('CMS/Gmail/deploy configuration is flagged without exposing its values', async () => {
  const f = fixture(); f.target.resources.bindings.push({ name: 'GMAIL_TOKEN_ENCRYPTION_KEY', type: 'secret_text', text: 'sensitive-production-key' });
  const result = await f.run(); assert(result.issues.includes('test_integration_binding_needs_review'));
  assert(!JSON.stringify(result).includes('sensitive-production-key'));
});
test('missing expected DB binding cannot pass even when another DB exists', async () => {
  const f = fixture(); f.target.resources.bindings[0].name = 'OTHER';
  assert((await f.run()).issues.includes('required_resource_binding_missing'));
});
test('missing bindings array is unknown, not empty isolated storage', async () => {
  const f = fixture(); delete f.target.resources.bindings; assert.equal((await f.run()).error, 'bindings_not_available');
});
test('duplicate binding name fails closed', async () => {
  const f = fixture(); f.target.resources.bindings.push({ name: 'DB', type: 'assets' });
  assert.equal((await f.run()).error, 'duplicate_binding_name');
});
test('deprecated d1 id is accepted when unambiguous', async () => {
  const f = fixture(); const db = f.target.resources.bindings[0]; db.id = db.database_id; delete db.database_id;
  assert.equal((await f.run()).status, 'resource_separation_observed');
});
test('conflicting legacy/current D1 ids fail closed', async () => {
  const f = fixture(); f.target.resources.bindings[0].id = PRODUCTION.databaseId;
  assert.equal((await f.run()).error, 'unreadable_d1_identity');
});
test('exact requested version must match response', async () => {
  const f = fixture(); f.target.id = ids.prod1; assert.equal((await f.run()).error, 'version_identity_mismatch');
});
test('cron enabled in test is flagged, never removed by this tool', async () => {
  const f = fixture(); f.schedules.schedules.push({ cron: '0 6 * * *' });
  const result = await f.run(); assert.equal(result.status, 'blocked'); assert.equal(result.testScheduleCount, 1);
});
test('unavailable schedule metadata is unverified', async () => {
  const f = fixture(); delete f.schedules.schedules; assert.equal((await f.run()).error, 'schedules_not_available');
});
test('production deployment changes while checking are rejected', async () => {
  const f = fixture(); f.hook = (url, index) => { if (index === 5) f.deployment.deployments[0].id = ids.test; };
  assert.equal((await f.run()).error, 'deployment_or_schedule_changed_during_audit');
});
test('test schedule changes while checking are rejected', async () => {
  const f = fixture(); f.hook = (url, index) => { if (index === 6) f.schedules.schedules.push({ cron: '* * * * *' }); };
  assert.equal((await f.run()).error, 'deployment_or_schedule_changed_during_audit');
});
for (const [field, value] of [['accountId', '../secrets'], ['accountId', ''], ['testWorker', '../prebid-professor'],
  ['testWorker', 'https://other.invalid/'], ['testVersionId', 'feature-branch-alias'], ['token', ''], ['token', 'bad token with spaces']]) {
  test(`invalid ${field} does not call the network`, async () => {
    const f = fixture(); f.input[field] = value; assert.equal((await f.run()).status, 'unverified'); assert.equal(f.calls.length, 0);
  });
}
for (const status of [401, 403, 404, 429, 500]) test(`HTTP ${status} never leaks API error body`, async () => {
  const f = fixture(); f.hook = () => new Response('secret-error-payload', { status });
  const result = JSON.stringify(await f.run()); assert(result.includes('unverified')); assert(!result.includes('secret-error-payload'));
});
test('network/redirect failures are sanitized', async () => {
  const f = fixture(); f.hook = () => { throw new Error(`sensitive ${credentials.token}`); };
  const result = await f.run(); assert.equal(result.error, 'cloudflare_metadata_request_failed');
  assert(!JSON.stringify(result).includes(credentials.token));
});
test('malformed JSON fails closed', async () => {
  const f = fixture(); f.hook = () => new Response('not-json'); assert.equal((await f.run()).error, 'invalid_metadata_json');
});
test('API success must be explicit', async () => {
  const f = fixture(); f.hook = () => new Response(JSON.stringify({ success: false, result: f.deployment, errors: [{ message: 'private' }] }));
  assert.equal((await f.run()).error, 'unsuccessful_metadata_response');
});
test('metadata body is size-limited', async () => {
  const f = fixture(); f.hook = () => new Response('x'.repeat(512 * 1024 + 1));
  assert.equal((await f.run()).error, 'metadata_response_too_large');
});
test('output only whitelists storage identities from JSON binding replies', () => {
  const data = version(ids.test, ids.database, 'test-bucket');
  data.resources.bindings.push({ name: 'EXT_CONFIG', type: 'json', json: { password: 'never-export' } });
  const result = inspectVersion(data, ids.test, 'test');
  assert(!JSON.stringify(result).includes('never-export')); assert(result.issues.length > 0);
});
