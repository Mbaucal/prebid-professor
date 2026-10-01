/** Exercise the shipped Worker, real HTTP headers and R2, without live services. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Miniflare } from 'miniflare';

const config = JSON.parse(await readFile('dist/prebid_professor/wrangler.json', 'utf8'));
const origin = 'https://security-test.example.invalid';
const credentials = { ADMIN_EMAIL: 'admin@example.invalid', ADMIN_PASSWORD: randomBytes(24).toString('hex'), SESSION_SECRET: randomBytes(48).toString('hex') };
const mf = new Miniflare({
  modules: true, script: await readFile('dist/prebid_professor/index.js', 'utf8'),
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  cf: false, host: '127.0.0.1', port: 0, bindings: credentials, d1Databases: ['DB'], r2Buckets: ['BUILDS'],
  outboundService: () => { throw Error('Security regression must not make outbound requests.'); },
});
const request = (path, options = {}) => mf.dispatchFetch(origin + path, { redirect: 'manual', ...options });
try {
  const bucket = await mf.getR2Bucket('BUILDS');
  const html = '<script>window.exampleAd=true;</script>';
  await bucket.put('publishers/example/releases/20260929_120000/implementation.html', html, { httpMetadata: { contentType: 'text/html' } });
  for (const method of ['GET', 'HEAD']) {
    const response = await request('/cdn/example/releases/20260929_120000/implementation.html', { method });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /^sandbox allow-scripts allow-popups;/);
    assert.doesNotMatch(response.headers.get('content-security-policy'), /allow-same-origin|allow-top-navigation|allow-popups-to-escape-sandbox/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(await response.text(), method === 'GET' ? html : '');
  }
  for (const next of ['/\\external.invalid', '/\t/external.invalid', '/%5cexternal.invalid', '/config?site=example']) {
    const login = await request('/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: credentials.ADMIN_EMAIL, password: credentials.ADMIN_PASSWORD, next }),
    });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), next === '/config?site=example' ? next : '/');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    // A sandboxed HTML request cannot mutate an authenticated session.
    const logout = await request('/api/auth/logout', { method: 'POST', headers: { cookie, origin: 'null', 'sec-fetch-site': 'cross-site' } });
    assert.equal(logout.status, 403);
    assert.equal(logout.headers.get('set-cookie'), null);
    const me = await request('/api/auth/me', { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.email, credentials.ADMIN_EMAIL);
  }
  console.log('PASS: compiled Worker/R2 HTML isolation, redirect normalization and opaque-origin mutation denial; no external requests.');
} finally {
  await mf.dispose();
}
