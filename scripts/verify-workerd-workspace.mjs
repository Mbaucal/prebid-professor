/** Executes the compiled Worker in LOCAL workerd with Miniflare D1/R2.
 * No Cloudflare account access, production records, remote bindings or deployment.
 * Temporary storage and random fixture credentials are never included in evidence.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import { unzipSync } from 'fflate';

const root = resolve('.');
const compiled = join(root, '.generated/test-workspace-dry-run');
const names = (await readdir(compiled)).filter((name) => name.endsWith('.js') || name.endsWith('.mjs'));
assert.equal(names.length, 1, 'Expected one compiled Worker module from the credential-free dry-run');
const script = await readFile(join(compiled, names[0]), 'utf8');
const sourceSha256 = createHash('sha256').update(script).digest('hex');
const config = JSON.parse(await readFile('ops/runtime-test/wrangler.jsonc', 'utf8'));
assert.equal(config.name, 'prebid-professor-test');
assert.equal(config.vars.TEST_WORKSPACE_ENABLED, 'false', 'Verification must not activate the committed deployment');
const origin = 'https://prebid-professor-test.mbaucal.workers.dev'; // dispatchFetch stays local
const directory = await mkdtemp(join(tmpdir(), 'tessera-workerd-local-'));
const password = randomBytes(24).toString('base64url');
const bindings = { ...config.vars, TEST_WORKSPACE_ENABLED: 'true', TEST_PUBLIC_ORIGIN: origin,
  TEST_ADMIN_EMAIL: 'tester@example.invalid', TEST_ADMIN_PASSWORD: password,
  TEST_SESSION_SECRET: randomBytes(48).toString('base64url') };
const checks = [];
const events = [];
let externalAttempts = 0;
let mf;
let cookie = '';
let phase = 'start';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function checked(name, condition = true) { assert(condition, name); checks.push({ name, passed: true }); }
function start() {
  return new Miniflare({
    name: 'local-tessera-workspace-verification', modules: true, script,
    compatibilityDate: config.compatibility_date, host: '127.0.0.1', port: 0,
    cf: false, bindings,
    // These identifiers select LOCAL storage only; no API token or remote connector exists.
    d1Databases: { DB: 'local-workspace-database' }, d1Persist: join(directory, 'd1'),
    r2Buckets: { BUILDS: 'local-workspace-files' }, r2Persist: join(directory, 'r2'),
    outboundService: () => { externalAttempts++; return new Response('External requests are disabled in local verification.', { status: 503 }); },
  });
}
async function call(path, { method = 'GET', body, authenticated = true, requestOrigin = origin, headers = {} } = {}) {
  const response = await mf.dispatchFetch(origin + path, { method, redirect: 'manual',
    headers: { ...(authenticated && cookie ? { cookie } : {}), ...(method === 'POST' ? { origin: requestOrigin, 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  events.push({ phase, method, path, status: response.status, local: true });
  return response;
}
async function json(path, options, expected = 200) {
  const response = await call(path, options);
  const body = await response.json();
  assert.equal(response.status, expected, `${phase}: ${path} returned ${response.status}: ${body.error || 'unexpected status'}`);
  return body;
}
async function login() {
  const response = await call('/api/auth/login', { method: 'POST', authenticated: false,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: bindings.TEST_ADMIN_EMAIL, password }).toString() });
  assert.equal(response.status, 303, 'Test login must issue a local redirect');
  const setCookie = response.headers.get('set-cookie');
  assert(setCookie && /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie), 'Secure test cookie required');
  cookie = setCookie.split(';')[0];
}
async function zip(id) {
  const response = await call(`/test-api/releases/${id}/download`);
  assert.equal(response.status, 200, 'Stored ZIP download');
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { digest: sha256(bytes), files: unzipSync(bytes), header: response.headers.get('x-tessera-package-sha256') };
}

try {
  mf = start();
  await mf.ready;
  phase = 'authentication';
  await json('/test-api/status', { authenticated: false }, 401);
  const localDb = await mf.getD1Database('DB');
  const appTables = await localDb.prepare("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'").all();
  checked('Unauthenticated request leaves local D1 uninitialized', appTables.results.length === 0);
  await login();
  checked('Compiled Worker performs real signed-session login in workerd');
  await json('/test-api/setup', { method: 'POST', requestOrigin: 'https://foreign.invalid', body: { confirm: 'prepare-empty-test-database' } }, 403);
  checked('Foreign Origin cannot initialize local D1');
  const empty = await json('/test-api/status');
  checked('Authenticated status reports empty storage without initialization', empty.ready === false && empty.empty === true);

  phase = 'setup';
  const setup = await json('/test-api/setup', { method: 'POST', body: { confirm: 'prepare-empty-test-database' } });
  checked('Atomic schema preparation works with Miniflare D1', setup.ready === true && setup.created === true);
  const again = await json('/test-api/setup', { method: 'POST', body: { confirm: 'prepare-empty-test-database' } });
  checked('Repeated preparation does not replace existing test data', again.ready === true && again.created === false);
  const allSites = await localDb.prepare('SELECT id,domain FROM publishers').all();
  checked('Only the synthetic site is seeded', allSites.results.length === 1 && allSites.results[0].id === 'test-site' && allSites.results[0].domain === 'example.invalid');

  phase = 'generate';
  const generated = await json('/test-api/generate', { method: 'POST', body: { acknowledge: true, takeOverEnabled: true } });
  const before = await json('/test-api/releases');
  checked('Real workerd generation does not save a release', before.releases.length === 0 && generated.descriptor.files.length === 9);
  assert.equal(generated.publishable, false);
  const input = { receipt: generated.receipt, acknowledge: true, note: 'Local workerd verification' };
  phase = 'save';
  const saved = await json('/test-api/save', { method: 'POST', body: input });
  checked('Reviewed Save writes through Miniflare D1 and R2', saved.created === true);
  const repeated = await json('/test-api/save', { method: 'POST', body: input });
  checked('Conditional R2 puts and repeated Save are idempotent', repeated.created === false);
  const list = await json('/test-api/releases');
  checked('One exact package is listed after two Save requests', list.releases.length === 1 && list.releases[0].storageState === 'stored');
  const id = list.releases[0].id;
  const reopened = await json(`/test-api/releases/${id}`);
  checked('Read verifies saved bytes without making them publishable', reopened.verified === true && reopened.draft.publishable === false);
  const firstZip = await zip(id);
  checked('Downloaded ads.js matches the original reviewed source', new TextDecoder().decode(firstZip.files['ads.js']) === generated.adsJs);
  checked('Nine-file package omits Prebid in GPT-only mode', Object.keys(firstZip.files).length === 9 && !firstZip.files['prebid.js']);

  phase = 'restart';
  await mf.dispose(); mf = null;
  mf = start(); await mf.ready;
  const afterRestart = await json('/test-api/releases');
  checked('Local D1 survives a full workerd restart', afterRestart.releases.length === 1 && afterRestart.releases[0].id === id);
  const secondZip = await zip(id);
  checked('Local R2 preserves the byte-identical ZIP after restart', secondZip.digest === firstZip.digest && secondZip.header === firstZip.header);
  for (const [name, bytes] of Object.entries(firstZip.files)) assert.deepEqual(secondZip.files[name], bytes, `Changed stored file after restart: ${name}`);
  checked('Every saved file is byte-identical after restart');

  phase = 'guards';
  await json('/api/publishers/test-site/publish', { method: 'POST', body: {} }, 404);
  await json(`/cdn/test-site/${id}/ads.js`, {}, 404);
  checked('Legacy publish and public draft CDN routes remain unavailable');
  const db = await mf.getD1Database('DB');
  await db.prepare('DROP TRIGGER test_draft_quota').run(); // Deliberate local-only fault
  await json('/test-api/status', {}, 409);
  checked('Actual D1 schema drift fails closed rather than trusting the marker');
  await call('/api/auth/logout', { method: 'POST' });
  cookie = '';
  await json('/test-api/status', {}, 401);
  checked('Signed-out access to stored data is rejected');
  checked('No outbound application fetch was attempted', externalAttempts === 0);

  const report = { scope: 'LOCAL workerd + Miniflare D1/R2 persisted to temporary disk; NOT hosted Cloudflare',
    compiledSha256: sourceSha256, checks, events, externalAttempts, passed: checks.length, failed: 0,
    productionChanged: false, hostedTest: false, credentialsInArtifact: false };
  await mkdir('.generated/test-workspace-evidence', { recursive: true });
  await writeFile('.generated/test-workspace-evidence/workerd.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  // Fixtures contain random secrets and review receipts. Emit only safe operation context.
  console.error(JSON.stringify({ scope: 'LOCAL workerd verification', phase, failed: 1,
    error: String(error?.message || 'verification failed').slice(0, 500), events, externalAttempts }));
  process.exitCode = 1;
} finally {
  if (mf) await mf.dispose();
  await rm(directory, { recursive: true, force: true });
}
