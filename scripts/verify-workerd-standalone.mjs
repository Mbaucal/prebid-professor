/** Every registered generator is exercised inside the actual compiled TEST
 * Worker. Local Miniflare storage only; all outbound traffic is refused.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from './local-miniflare.mjs';
import { assertGeneratedBundleStandalone } from '../worker/test-workspace/bundle-syntax-guard.mjs';

const origin = 'https://prebid-professor-test.mbaucal.workers.dev';
const compiled = '.generated/test-workspace-active-dry-run';
const names = (await readdir(compiled)).filter(name => /\.m?js$/.test(name));
assert.equal(names.length, 1);
const script = await readFile(join(compiled, names[0]), 'utf8');
const config = JSON.parse(await readFile('ops/runtime-test/wrangler.jsonc', 'utf8'));
assert.equal(config.keep_names, false);
assert.equal(config.vars.TEST_WORKSPACE_ENABLED, 'false');
const directory = await mkdtemp(join(tmpdir(), 'tessera-standalone-workerd-'));
const password = randomBytes(24).toString('hex');
const bindings = { ...config.vars, TEST_WORKSPACE_ENABLED: 'true', TEST_PUBLIC_ORIGIN: origin,
  TEST_ADMIN_EMAIL: 'tester@example.invalid', TEST_ADMIN_PASSWORD: password, TEST_SESSION_SECRET: randomBytes(48).toString('hex') };
let mf, cookie = '', externalAttempts = 0;
const checks = [];
async function json(path, body) {
  const response = await mf.dispatchFetch(origin + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { cookie, ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  assert.equal(response.status, 200, `${path}: ${value.error || response.status}`);
  return value;
}
try {
  mf = new Miniflare({ name: 'local-standalone-test', modules: true, script, compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags ?? [],
    host: '127.0.0.1', port: 0, cf: false, bindings, resourcePersistencePath: directory,
    d1Databases: { DB: 'local-standalone-d1' }, r2Buckets: { BUILDS: 'local-standalone-r2' },
    outboundService: () => { externalAttempts++; return new Response('External requests disabled', { status: 503 }); } });
  await mf.ready;
  const login = await mf.dispatchFetch(origin + '/api/auth/login', { method: 'POST', redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: bindings.TEST_ADMIN_EMAIL, password }).toString() });
  assert.equal(login.status, 303);
  cookie = login.headers.get('set-cookie').split(';')[0];
  await json('/test-api/setup', { confirm: 'prepare-empty-test-database' });
  const db = await mf.getD1Database('DB');
  for (const [id, code, type, order] of [['standalone-btf', 'P1', 'BTF', 2], ['standalone-overlay', 'Overlay', 'ATF', 3]]) {
    await db.prepare('INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,sort_order) VALUES (?,?,?,?,?,?)')
      .bind(id, 'test-site', code, type, 'display', order).run();
  }
  const initial = await json('/test-api/runtime-selection');
  for (const runtime of initial.runtimes) {
    const saved = await db.prepare("SELECT config_json FROM publisher_configs WHERE publisher_id='test-site'").first();
    const next = JSON.parse(saved.config_json);
    delete next.builtinRuntimeSelection;
    next.enablePrebid = false;
    const supportsPositions = runtime.pin.capabilities.includes('per-unit-lazy');
    next.runtimeControls = { ...next.runtimeControls, adPositions: supportsPositions ? { Overlay: {
      demand: 'gam', desktopMinWidth: 1024, desktopSeconds: 10, mobileSeconds: 5, countdown: true, frequencyMinutes: 0,
    } } : {} };
    next.advancedUnitRules = supportsPositions ? { __BTF__: { lazy: { enabled: true, fetchMarginPx: 500, renderMarginPx: 0 } } } : {};
    await db.prepare("UPDATE publisher_configs SET config_json=? WHERE publisher_id='test-site'").bind(JSON.stringify(next)).run();
    const state = await json('/test-api/runtime-selection');
    await json('/test-api/runtime-selection', { expectedRevision: state.revision, selection: {
      runtime: runtime.pin, allowPreview: true, enablePrebid: false, prebidBuildId: null,
    } });
    const generated = await json('/test-api/generate', { acknowledge: true });
    assert.equal(generated.descriptor.runtime.runtimeSha256, runtime.pin.runtimeSha256);
    // Save then download both real outputs; do not trust only the response preview.
    const stored = await json('/test-api/save', { receipt: generated.receipt, acknowledge: true, note: 'Local standalone output verification' });
    const response = await mf.dispatchFetch(origin + '/test-api/releases/' + stored.draft.id + '/download', { headers: { cookie } });
    assert.equal(response.status, 200);
    const { unzipSync } = await import('fflate');
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    assertGeneratedBundleStandalone({ files });
    assert.equal(new TextDecoder().decode(files['ads.js']), generated.adsJs);
    checks.push({ version: runtime.version, exactHash: runtime.pin.runtimeSha256, lazyAndOverlay: supportsPositions, passed: true });
    if (runtime.version.startsWith('3.10.')) {
      await mkdir('.generated/test-workspace-evidence', { recursive: true });
      await writeFile('.generated/test-workspace-evidence/runtime-310-lazy-overlay.js', generated.adsJs);
    }
  }
  assert.equal(externalAttempts, 0);
  const report = { scope: 'LOCAL compiled workerd, local D1/R2; not hosted or paid ad traffic',
    compiledSha256: createHash('sha256').update(script).digest('hex'), checks, externalAttempts, passed: true };
  await mkdir('.generated/test-workspace-evidence', { recursive: true });
  await writeFile('.generated/test-workspace-evidence/standalone-workerd.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (mf) await mf.dispose();
  await rm(directory, { recursive: true, force: true });
}
