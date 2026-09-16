/** Offline guard for the explicitly selected TEST deployment configuration.
 * No credentials, network, D1/R2 access, migrations, or deployment.
 * Declared bindings are verified here; hosted bindings still require inspection.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
export function assertTestDeployment(config, { active = false } = {}) {
  const expected = {
    $schema: '../../node_modules/wrangler/config-schema.json',
    name: 'prebid-professor-test',
    account_id: 'b5e5e6f70b811e8f97af71df1af46308',
    main: '../../worker/test-workspace/index.mjs',
    compatibility_date: '2026-07-15', workers_dev: true, preview_urls: false,
    routes: [], triggers: { crons: [] },
    d1_databases: [{ binding: 'DB', database_name: 'prebid-professor-test-db', database_id: 'd27843e4-a53c-403a-baed-04a193f6d5c6' }],
    r2_buckets: [{ binding: 'BUILDS', bucket_name: 'prebid-professor-test-builds' }],
    vars: {
      TEST_WORKSPACE_ENABLED: active ? 'true' : 'false',
      TEST_PUBLIC_ORIGIN: active ? 'https://prebid-professor-test.mbaucal.workers.dev' : '',
      TEST_WORKER_NAME: 'prebid-professor-test',
      TEST_DATABASE_ID: 'd27843e4-a53c-403a-baed-04a193f6d5c6',
      TEST_BUCKET_NAME: 'prebid-professor-test-builds',
    },
    observability: { enabled: false },
  };
  try { assert.deepEqual(config, expected); }
  catch { throw new Error('Test deployment configuration differs from the reviewed allowlist. Stop; do not deploy.'); }
  return true;
}
export async function checkTestDeploymentFiles() {
  const disabled = JSON.parse(await readFile(new URL('ops/runtime-test/wrangler.jsonc', root), 'utf8'));
  const active = JSON.parse(await readFile(new URL('ops/runtime-test/wrangler.active.jsonc', root), 'utf8'));
  assertTestDeployment(disabled);
  assertTestDeployment(active, { active: true });
  return { disabled, active };
}
async function bundle(directory) {
  const location = new URL(directory + '/', root);
  const entries = (await readdir(location)).filter((name) => /\.(?:mjs|js)$/.test(name));
  assert.equal(entries.length, 1, 'Expected exactly one compiled Worker module');
  return readFile(new URL(entries[0], location));
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--compare-bundles')) throw new Error('Only --compare-bundles is supported. This script cannot deploy.');
  const { active } = await checkTestDeploymentFiles();
  const report = {
    scope: 'Offline test activation configuration check; NOT hosted Cloudflare verification',
    worker: active.name, origin: active.vars.TEST_PUBLIC_ORIGIN,
    databaseId: active.d1_databases[0].database_id, bucket: active.r2_buckets[0].bucket_name,
    defaultConfigurationDisabled: true, noRoutesOrCrons: true,
    credentialsRead: false, hostedTest: false, deploymentPerformed: false,
  };
  if (args.length) {
    const disabledBytes = await bundle('.generated/test-workspace-dry-run');
    const activeBytes = await bundle('.generated/test-workspace-active-dry-run');
    assert(disabledBytes.equals(activeBytes), 'Active deployment must compile to the same Worker bytes verified by the local workerd tests');
    report.compiledBundlesIdentical = true;
    report.compiledSha256 = createHash('sha256').update(activeBytes).digest('hex');
    await mkdir(new URL('.generated/test-workspace-evidence/', root), { recursive: true });
    await writeFile(new URL('.generated/test-workspace-evidence/activation.json', root), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
