import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseDeletionFixture, id, otherId} from '../support/release-deletion-fixture.mjs';
import {TEST_EMAIL} from '../support/test-workspace-store.mjs';
const active = [];
test.afterEach(() => { while (active.length) active.pop().close(); });
async function fixture(options) { const f = await releaseDeletionFixture(options); active.push(f); return f; }

for (const status of ['draft', 'failed', 'archived']) test(`actual MAIN route deletes an inactive built-in ${status} package and only its files`, async () => {
  const f = await fixture({status}); f.addDeployment();
  const preserved = new Map([...f.objects].filter(([key]) => !key.startsWith(`publishers/first/releases/${id}/`)));
  const result = await f.request();
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.deleted, {id, version: id, status, objectsDeleted: 2, bytesFreed: 5, externalDeploymentsDeleted: 1});
  assert.equal(f.exists(), false);
  assert.deepEqual(f.objects, preserved);
  assert.equal(f.listed.length, 2, 'R2 pagination is handled');
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM external_deployments').get().n, 0);
  const audit = f.sqlite.prepare("SELECT actor,entity_id,details_json FROM audit_log WHERE action='release.deleted'").get();
  assert.equal(audit.actor, TEST_EMAIL); assert.equal(audit.entity_id, id);
  assert.equal(JSON.parse(audit.details_json).objectsDeleted, 2);
  assert.equal((await f.request()).status, 404);
});

for (const [status, guidance] of [['staging', /Stage another release in Releases/], ['production', /Publish or restore another release in Releases/]]) test(`${status} explains the channel blocking deletion without touching files`, async () => {
  const f = await fixture({status}), result = await f.request();
  assert.equal(result.status, 409); assert.match(result.data.error, guidance);
  assert.equal(f.exists(), true); assert.equal(f.listed.length, 0);
});

for (const column of ['current_release_id', 'current_version']) test(`current-site ${column} reference blocks deletion even when status is stale`, async () => {
  const f = await fixture(); f.sqlite.prepare(`UPDATE publishers SET ${column}=? WHERE id='first'`).run(id);
  const result = await f.request(); assert.equal(result.status, 409); assert.match(result.data.error, /current site release.*Publish or restore/);
  assert.equal(f.exists(), true); assert.equal(f.listed.length, 0);
});

for (const status of ['queued', 'running']) test(`${status} external deployment identifies the blocker and where to find it`, async () => {
  const f = await fixture(); f.addDeployment(status); const result = await f.request();
  assert.equal(result.status, 409); assert.match(result.data.error, new RegExp(status)); assert.match(result.data.error, /deployment history/);
  assert.equal(f.exists(), true); assert.equal(f.listed.length, 0);
});

test('exact confirmation, correct site, authentication and same-origin checks still precede deletion', async () => {
  const f = await fixture();
  for (const [options, expected] of [[{cookie: ''}, 401], [{requestOrigin: 'https://other.invalid'}, 403], [{confirmation: ''}, 422], [{confirmation: otherId}, 422], [{site: 'second'}, 404]]) {
    const result = await f.request(options); assert.equal(result.status, expected, JSON.stringify(result));
    assert.equal(f.exists(), true); assert.equal(f.listed.length, 0);
  }
});

test('channel POSTs and DELETE sub-routes remain blocked by the verified package workflow', async () => {
  const f = await fixture();
  for (const options of [{method: 'POST'}, {method: 'PATCH'}, {method: 'POST', suffix: '/staging'}, {method: 'POST', suffix: '/production'}, {method: 'POST', suffix: '/rollback'}, {suffix: '/staging'}, {suffix: '/'}]) {
    const result = await f.request(options); assert.equal(result.status, 409); assert.match(result.data.error, /Use Generate and releases/);
  }
  assert.equal(f.exists(), true); assert.equal(f.listed.length, 0);
});

test('reserved TEST drafts keep their dedicated workflow guard', async () => {
  const f = await fixture({releaseId: 'builtin-draft-' + 'c'.repeat(64)}), result = await f.request();
  assert.equal(result.status, 409); assert.match(result.data.error, /review package/); assert.equal(f.listed.length, 0);
});

test('legacy release deletion still works without the optional deployment table', async () => {
  const f = await fixture({releaseId: '20261114_123000', deployments: false});
  assert.equal((await f.request()).status, 200); assert.equal(f.exists(), false);
});

test('storage failure retains the release and allows an explicit retry', async () => {
  const f = await fixture(); f.failStorage = true;
  const failed = await f.request(); assert.equal(failed.status, 500); assert.match(failed.data.error, /files could not be removed/);
  assert.equal(f.exists(), true); assert.equal(f.deleted.length, 0);
  f.failStorage = false; assert.equal((await f.request()).status, 200); assert.equal(f.exists(), false);
});

test('metadata failure rolls back registration cleanup and retry completes it', async () => {
  const f = await fixture(); f.faults.batchAt = 1;
  const failed = await f.request(); assert.equal(failed.status, 500); assert.match(failed.data.error, /Retry the delete action/);
  assert.equal(f.exists(), true);
  f.faults.batchAt = -1; assert.equal((await f.request()).status, 200); assert.equal(f.exists(), false);
});
