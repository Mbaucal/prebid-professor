import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectVersion, auditIsolation, compareResources, PRODUCTION } from '../../scripts/cloudflare/audit-isolation.mjs';
import { WORKSPACE_IDENTITY } from '../../scripts/cloudflare/test-workspace-binding-profile.mjs';

const versionId = '22222222-2222-4222-8222-222222222222';
const prodVersionId = '11111111-1111-4111-8111-111111111111';
const deploymentId = '33333333-3333-4333-8333-333333333333';
const anotherId = '44444444-4444-4444-8444-444444444444';
const publicVars = {
  TEST_WORKSPACE_ENABLED: 'true',
  TEST_PUBLIC_ORIGIN: 'https://prebid-professor-test.mbaucal.workers.dev',
  TEST_WORKER_NAME: 'prebid-professor-test',
  TEST_DATABASE_ID: 'd27843e4-a53c-403a-baed-04a193f6d5c6',
  TEST_BUCKET_NAME: 'prebid-professor-test-builds',
};
const secretNames = ['TEST_ADMIN_EMAIL', 'TEST_ADMIN_PASSWORD', 'TEST_SESSION_SECRET'];
function target() {
  return { id: versionId, resources: { bindings: [
    { name: 'DB', type: 'd1', database_id: WORKSPACE_IDENTITY.databaseId },
    { name: 'BUILDS', type: 'r2_bucket', bucket_name: WORKSPACE_IDENTITY.bucket },
    ...Object.entries(publicVars).map(([name, text]) => ({ name, type: 'plain_text', text })),
    ...secretNames.map((name) => ({ name, type: 'secret_text', text: 'synthetic-secret-never-exported' })),
  ] } };
}
const inspect = (value) => inspectVersion(value, versionId, 'test');
function binding(value, name) { return value.resources.bindings.find((row) => row.name === name); }
const envelope = (value) => new Response(JSON.stringify({ success: true, result: value }));
function fixture() {
  const f = { target: target(), calls: [], hook: null, schedules: [],
    input: { accountId: WORKSPACE_IDENTITY.accountId, testWorker: WORKSPACE_IDENTITY.worker,
      testVersionId: versionId, token: 'synthetic-audit-token-never-exported' },
    prodDeployment: { deployments: [{ id: deploymentId, versions: [{ version_id: prodVersionId, percentage: 100 }] }] },
    testDeployment: { deployments: [{ id: anotherId, versions: [{ version_id: versionId, percentage: 100 }] }] },
  };
  const prod = { id: prodVersionId, resources: { bindings: [
    { name: 'DB', type: 'd1', database_id: PRODUCTION.databaseId },
    { name: 'BUILDS', type: 'r2_bucket', bucket_name: PRODUCTION.bucket },
  ] } };
  f.run = () => auditIsolation(f.input, { now: () => '2026-09-12T16:09:47.568Z', fetchImpl: async (url, options) => {
    f.calls.push(url);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.body, undefined);
    assert.equal(new URL(url).origin, 'https://api.cloudflare.com');
    assert.equal(options.headers.authorization, `Bearer ${f.input.token}`); assert(!url.includes(f.input.token));
    if (f.hook) { const response = f.hook(url); if (response) return response; }
    if (url.endsWith(`/${PRODUCTION.worker}/deployments`)) return envelope(f.prodDeployment);
    if (url.endsWith(`/${f.input.testWorker}/deployments`)) return envelope(f.testDeployment);
    if (url.endsWith(`/versions/${prodVersionId}`)) return envelope(prod);
    if (url.endsWith(`/versions/${versionId}`)) return envelope(f.target);
    if (url.endsWith('/schedules')) return envelope(f.schedules);
    assert.fail('Unexpected metadata path');
  } });
  return f;
}

test('approved three test secrets and five public values pass without any legacy auth name', () => {
  const report = inspect(target());
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.testConfiguration, { profile: 'isolated_workspace_v1', requiredSecretsPresent: true,
    publicConfigurationMatches: true, expectedStorageMatches: true, unexpectedBindingCount: 0,
    invalidBindingCount: 0, secretValuesInspected: false });
});
test('metadata-only profile never grants remote writes or launch approval', async () => {
  const f = fixture(); const report = await f.run();
  assert.equal(report.status, 'resource_separation_observed'); assert.equal(f.calls.length, 8);
  assert.equal(report.remoteWritesAuthorized, false); assert.equal(report.launchApproved, false);
  assert.equal(report.test.requestedVersionServingAllTraffic, true);
  assert.deepEqual(report.sharedDatabaseIds, []); assert.deepEqual(report.sharedBucketNames, []);
  assert.equal(report.testScheduleCount, 0);
});
for (const name of [...secretNames, ...Object.keys(publicVars)]) test(`missing required ${name} blocks`, () => {
  const value = target(); value.resources.bindings = value.resources.bindings.filter((row) => row.name !== name);
  assert(inspect(value).issues.includes('test_workspace_profile_incomplete'));
});
for (const name of secretNames) for (const type of ['plain_text', 'json', 'inherit']) test(`${name} as ${type} does not count as a secret`, () => {
  const value = target(); binding(value, name).type = type;
  assert(inspect(value).issues.includes('test_workspace_binding_mismatch'));
});
for (const name of Object.keys(publicVars)) for (const change of ['wrong-value', 'secret_text', 'json']) test(`${name}: ${change} blocks`, () => {
  const value = target(); const row = binding(value, name);
  if (change === 'wrong-value') row.text = 'unreviewed-value-must-not-be-exported';
  else row.type = change;
  const report = inspect(value); assert(report.issues.includes('test_workspace_binding_mismatch'));
  assert(!JSON.stringify(report).includes('unreviewed-value'));
});
for (const name of ['TEST_CMS_TOKEN', 'GMAIL_TOKEN_ENCRYPTION_KEY', 'CLOUDFLARE_API_TOKEN', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SESSION_SECRET', '__proto__', 'toString']) {
  test(`extra scalar ${name} is still blocked and redacted`, () => {
    const value = target(); value.resources.bindings.push({ name, type: 'secret_text', text: 'do-not-print-extra' });
    const report = inspect(value); assert(report.issues.includes('test_integration_binding_needs_review'));
    assert.equal(report.testConfiguration.unexpectedBindingCount, 1);
    assert(!JSON.stringify(report).includes(name)); assert(!JSON.stringify(report).includes('do-not-print-extra'));
  });
}
for (const type of ['assets', 'inherit', 'service', 'queue', 'kv_namespace', 'durable_object_namespace', 'workflow']) test(`extra ${type} cannot hide behind a valid workspace profile`, () => {
  const value = target(); value.resources.bindings.push({ name: 'EXTRA', type });
  assert(inspect(value).issues.includes('test_integration_binding_needs_review'));
});
test('TEST_ detects stricter profile; it never authorizes arbitrary prefixed bindings', () => {
  const value = target(); value.resources.bindings = value.resources.bindings.slice(0, 2);
  value.resources.bindings.push({ name: 'TEST_UNKNOWN', type: 'secret_text' });
  const report = inspect(value);
  assert(report.issues.includes('test_workspace_profile_incomplete'));
  assert(report.issues.includes('test_integration_binding_needs_review'));
});
test('secret text/json/value getters are not touched, even for known secret names', () => {
  const value = target();
  for (const row of value.resources.bindings.filter((row) => secretNames.includes(row.name))) {
    for (const key of ['text', 'json', 'value']) Object.defineProperty(row, key, { get() { assert.fail('Secret value accessed'); } });
  }
  assert.deepEqual(inspect(value).issues, []);
});
test('report contains no raw configuration names, unknown values, passwords or token', async () => {
  const f = fixture(); const text = JSON.stringify(await f.run());
  for (const needle of [...secretNames, ...Object.keys(publicVars), 'synthetic-secret-never-exported', f.input.token, 'https://prebid-professor-test']) assert(!text.includes(needle));
});
for (const field of ['database', 'bucket']) test(`different unreviewed non-production ${field} does not satisfy the workspace profile`, () => {
  const value = target();
  if (field === 'database') binding(value, 'DB').database_id = anotherId;
  else binding(value, 'BUILDS').bucket_name = 'some-other-test-bucket';
  assert(inspect(value).issues.includes('test_workspace_binding_mismatch'));
});
test('workspace profile cannot excuse shared production storage', () => {
  const value = target(); binding(value, 'DB').database_id = PRODUCTION.databaseId;
  binding(value, 'BUILDS').bucket_name = PRODUCTION.bucket;
  const production = [{ databaseIds: [PRODUCTION.databaseId], bucketNames: [PRODUCTION.bucket], issues: [] }];
  const report = compareResources(production, inspect(value), WORKSPACE_IDENTITY.worker, 0);
  assert.equal(report.status, 'blocked');
  assert(report.issues.includes('shared_production_d1')); assert(report.issues.includes('shared_production_r2'));
});
test('duplicate binding names are still rejected before profile matching', () => {
  const value = target(); value.resources.bindings.push({ name: 'TEST_ADMIN_EMAIL', type: 'plain_text', text: 'hidden' });
  assert.throws(() => inspect(value), /duplicate_binding_name/);
});
test('legacy resource-only bootstrap has no workspace/profile or credential assertion', () => {
  const value = target(); value.resources.bindings = value.resources.bindings.slice(0, 2);
  const report = inspect(value); assert.deepEqual(report.issues, []); assert.equal(report.testConfiguration, undefined);
});
for (const field of ['accountId', 'testWorker']) test(`workspace ${field} must be the reviewed identity`, async () => {
  const f = fixture(); f.input[field] = field === 'accountId' ? 'a'.repeat(32) : 'other-test-worker';
  assert((await f.run()).issues.includes('test_workspace_identity_mismatch'));
});
test('requested historical workspace version not serving traffic is blocked', async () => {
  const f = fixture(); f.testDeployment.deployments[0].versions[0].version_id = anotherId;
  const report = await f.run(); assert.equal(report.status, 'blocked');
  assert(report.issues.includes('test_selected_version_not_sole_active'));
  assert.equal(report.test.requestedVersionServingAllTraffic, false);
});
test('requested workspace sharing traffic with another version is blocked', async () => {
  const f = fixture(); f.testDeployment.deployments[0].versions = [
    { version_id: versionId, percentage: 90 }, { version_id: anotherId, percentage: 10 }];
  assert((await f.run()).issues.includes('test_selected_version_not_sole_active'));
});
test('test deployment drift during this workspace audit is unverified', async () => {
  const f = fixture(); let count = 0;
  f.hook = (url) => { if (url.endsWith(`/${f.input.testWorker}/deployments`) && ++count === 2) f.testDeployment.deployments[0].id = deploymentId; };
  assert.equal((await f.run()).error, 'deployment_or_schedule_changed_during_audit');
});
test('malformed test deployment is not treated as an active workspace', async () => {
  const f = fixture(); f.testDeployment = {};
  assert.equal((await f.run()).status, 'unverified');
});
test('workspace cron remains blocked', async () => {
  const f = fixture(); f.schedules = [{ cron: '0 6 * * *' }];
  assert((await f.run()).issues.includes('test_cron_enabled'));
});
test('workspace metadata read failure remains redacted and unverified', async () => {
  const f = fixture(); f.hook = (url) => url.endsWith(`/${f.input.testWorker}/deployments`) ? new Response('private-api-error', { status: 403 }) : null;
  const report = await f.run(); assert.equal(report.status, 'unverified');
  assert.equal(report.error, 'cloudflare_read_permission_required'); assert(!JSON.stringify(report).includes('private-api-error'));
});
