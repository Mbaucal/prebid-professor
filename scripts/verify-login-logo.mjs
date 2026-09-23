/** Regression against the compiled production Worker and its real static assets. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Miniflare } from 'miniflare';

const config = JSON.parse(await readFile('dist/prebid_professor/wrangler.json', 'utf8'));
const logo = await readFile('public/tessera-logo.png');
const origin = 'https://login-test.example.invalid';
const mf = new Miniflare({
  modules: true,
  script: await readFile('dist/prebid_professor/index.js', 'utf8'),
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  cf: false,
  host: '127.0.0.1',
  port: 0,
  bindings: {
    ADMIN_EMAIL: 'admin@example.invalid',
    ADMIN_PASSWORD: randomBytes(24).toString('hex'),
    SESSION_SECRET: randomBytes(48).toString('hex'),
  },
  assets: {
    directory: 'dist/client',
    binding: 'ASSETS',
    routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
    assetConfig: { not_found_handling: config.assets.not_found_handling },
  },
  outboundService: () => { throw Error('Login must not make outbound requests.'); },
});
const request = (path, options = {}) => mf.dispatchFetch(origin + path, { redirect: 'manual', ...options });
async function verifyLogin(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-security-policy'), /img-src 'self'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  assert.match(html, /<strong>Tessera<\/strong>/);
  const image = html.match(/<img src="([^"]+)"/)[1];
  const favicon = html.match(/<link rel="icon"[^>]*href="([^"]+)"/)[1];
  for (const path of new Set([image, favicon])) {
    const asset = await request(path);
    assert.equal(asset.status, 200, `Anonymous ${path} must return the logo, not a login redirect`);
    assert.equal(asset.headers.get('content-type'), 'image/png');
    assert.equal(asset.headers.get('location'), null);
    assert.equal(asset.headers.get('set-cookie'), null);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), logo);
  }
}
try {
  await verifyLogin(await request('/login?next=%2F'), 200);
  for (const query of ['', '?v=19', '?v=20']) {
    const path = '/tessera-logo.png' + query;
    const get = await request(path, { headers: { cookie: '__Host-pp_session=invalid' } });
    assert.equal(get.status, 200);
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), logo);
    const head = await request(path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'image/png');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
  const invalidLogin = await request('/api/auth/login', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'wrong@example.invalid', password: 'invalid' }),
  });
  await verifyLogin(invalidLogin, 401);
  for (const path of ['/', '/index.html', '/tessera-logo.svg', '/tessera-logo.png/extra', '/tessera-logo.png.bak', '/assets/private.js']) {
    const response = await request(path);
    assert.equal(response.status, 303, `${path} must still require authentication`);
    assert.equal(new URL(response.headers.get('location')).pathname, '/login');
  }
  assert.equal((await request('/api/auth/me')).status, 401);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await request('/tessera-logo.png', { method })).status, 303);
  }
  console.log('PASS: anonymous login logo and favicon return exact PNG bytes; GET/HEAD, old cache keys, invalid session and failed login; other routes remain protected.');
} finally {
  await mf.dispose();
}
