import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../../ops/test-worker/worker.mjs';

const config = JSON.parse(await readFile(new URL('../../ops/test-worker/wrangler.jsonc', import.meta.url), 'utf8'));
const noAccess = new Proxy({}, { get() { assert.fail('Bootstrap must not access bindings, secrets or context'); } });
const call = (path = '/', method = 'GET') => worker.fetch(new Request(`https://bootstrap.example.invalid${path}`, { method }), noAccess, noAccess);

test('uses only the separate test Worker/account/D1/R2 identities', () => {
  assert.equal(config.name, 'prebid-professor-test');
  assert.equal(config.account_id, 'b5e5e6f70b811e8f97af71df1af46308');
  assert.deepEqual(config.d1_databases, [{ binding: 'DB', database_name: 'prebid-professor-test-db', database_id: 'd27843e4-a53c-403a-baed-04a193f6d5c6' }]);
  assert.deepEqual(config.r2_buckets, [{ binding: 'BUILDS', bucket_name: 'prebid-professor-test-builds' }]);
  assert.notEqual(config.d1_databases[0].database_id, '7ef68f78-0fd8-4937-a774-d2fd1d5353e6');
});
test('has no cron, custom routes, inheritance, build hook, assets, integration or credential bindings', () => {
  assert.deepEqual(config.triggers, { crons: [] });
  assert.deepEqual(config.routes, []);
  assert.equal(config.preview_urls, false);
  assert.equal(config.main, './worker.mjs');
  assert.deepEqual(Object.keys(config).sort(), ['$schema', 'name', 'account_id', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'routes', 'triggers', 'd1_databases', 'r2_buckets', 'observability'].sort());
  assert.deepEqual(Object.keys(worker), ['fetch']);
});
test('root serves only the bootstrap notice and no application or ad scripts', async () => {
  const response = call(); const text = await response.text();
  assert.equal(response.status, 200); assert.match(text, /još nisu uključeni/);
  assert.doesNotMatch(text, /<script|<iframe|<img/i);
});
test('health does not claim isolation, data access or publication approval', async () => {
  const response = call('/health'); const json = await response.json();
  assert.equal(response.status, 200); assert.equal(json.stage, 'bootstrap_only');
  for (const field of ['applicationEnabled', 'isolationChecked', 'remoteWritesEnabled', 'publisherDeploymentEnabled']) assert.equal(json[field], false);
  assert.equal(json.service, 'tessera-test-bootstrap');
});
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
  test(`rejects ${method} without using the environment`, async () => {
    const response = call('/api/publishers', method);
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.match((await response.json()).error, /not enabled/);
  });
}
for (const path of ['/login', '/api/publishers', '/cdn/site/ads.js', '/api/monitoring/send', '/api/publishers/a/releases', '/%61pi/publishers']) {
  test(`does not delegate ${path} to the production application`, async () => {
    const response = call(path); assert.equal(response.status, 404);
    assert.match((await response.json()).error, /not enabled/);
  });
}
test('HEAD has no response body', async () => {
  for (const path of ['/', '/health', '/missing']) assert.equal(await call(path, 'HEAD').text(), '');
});
test('does not reflect URLs, credentials, request headers or query strings', async () => {
  const response = worker.fetch(new Request('https://bootstrap.example.invalid/health?token=DO-NOT-REFLECT', {
    headers: { authorization: 'Bearer DO-NOT-REFLECT', cookie: 'DO-NOT-REFLECT' },
  }), noAccess, noAccess);
  assert.doesNotMatch(await response.text(), /DO-NOT-REFLECT/);
});
test('all responses have no-store, noindex, nosniff and restrictive CSP', () => {
  for (const response of [call(), call('/health'), call('/missing'), call('/', 'POST')]) {
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(response.headers.get('x-robots-tag'), /noindex/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
});
test('bootstrap performs no external fetch', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => assert.fail('No external requests');
  try { for (const path of ['/', '/health', '/api/publishers']) await call(path).text(); }
  finally { globalThis.fetch = original; }
});
