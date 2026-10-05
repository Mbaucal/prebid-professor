import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTestDeployment, checkTestDeploymentFiles } from '../../scripts/check-test-activation.mjs';

const { disabled, active } = await checkTestDeploymentFiles();
test('default configuration remains disabled with an empty origin', () => {
  assert.equal(disabled.vars.TEST_WORKSPACE_ENABLED, 'false');
  assert.equal(disabled.vars.TEST_PUBLIC_ORIGIN, '');
  assertTestDeployment(disabled);
});
test('explicit active configuration accepts only the owner-confirmed test origin and resources', () => {
  assertTestDeployment(active, { active: true });
  assert.equal(active.vars.TEST_PUBLIC_ORIGIN, 'https://prebid-professor-test.mbaucal.workers.dev');
});
test('only the activation switch and public origin differ from the disabled config', () => {
  const value = structuredClone(active);
  value.vars.TEST_WORKSPACE_ENABLED = 'false';
  value.vars.TEST_PUBLIC_ORIGIN = '';
  assert.deepEqual(value, disabled);
});
test('neither configuration is accepted under the other activation mode', () => {
  assert.throws(() => assertTestDeployment(active));
  assert.throws(() => assertTestDeployment(disabled, { active: true }));
});
const faults = [
  ['production worker', (c) => { c.name = 'prebid-professor'; }],
  ['other account', (c) => { c.account_id = '00000000000000000000000000000000'; }],
  ['legacy entrypoint', (c) => { c.main = '../../worker/index.ts'; }],
  ['production D1', (c) => { c.d1_databases[0].database_id = '7ef68f78-0fd8-4937-a774-d2fd1d5353e6'; }],
  ['extra D1 binding', (c) => { c.d1_databases.push({ binding: 'OTHER', database_id: 'other' }); }],
  ['production R2', (c) => { c.r2_buckets[0].bucket_name = 'prebid-professor-builds'; }],
  ['missing storage', (c) => { delete c.r2_buckets; }],
  ['production origin', (c) => { c.vars.TEST_PUBLIC_ORIGIN = 'https://prebid-professor.mbaucal.workers.dev'; }],
  ['version-preview hosts', (c) => { c.preview_urls = true; }],
  ['public routes', (c) => { c.routes = ['example.invalid/*']; }],
  ['scheduled events', (c) => { c.triggers.crons = ['0 * * * *']; }],
  ['extra service binding', (c) => { c.services = [{ binding: 'PROD', service: 'prebid-professor' }]; }],
  ['extra environment overrides', (c) => { c.env = { production: { name: 'prebid-professor' } }; }],
  ['plaintext test password', (c) => { c.vars.TEST_ADMIN_PASSWORD = 'synthetic-secret-must-not-be-in-config'; }],
  ['production credential fallback', (c) => { c.vars.ADMIN_PASSWORD = 'synthetic-secret-must-not-be-in-config'; }],
  ['unexpected initialization command', (c) => { c.build = { command: 'npm run db:migrate:remote' }; }],
];
for (const [label, change] of faults) {
  test('refuses ' + label + ' in both test configurations', () => {
    for (const [config, isActive] of [[disabled, false], [active, true]]) {
      const modified = structuredClone(config);
      change(modified);
      assert.throws(() => assertTestDeployment(modified, { active: isActive }), /reviewed allowlist/);
    }
  });
}
