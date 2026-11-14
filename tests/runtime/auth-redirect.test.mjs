import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLogin, renderLoginPage } from '../../worker/auth.ts';

import { loginStore } from '../support/login-store.mjs';

const origin = 'https://tessera.invalid';
const env = { ADMIN_EMAIL: 'tester@example.invalid', ADMIN_PASSWORD: 'synthetic-password-only', SESSION_SECRET: 'synthetic-session-secret-not-used-outside-tests' };
async function login(next, json = false) {
  const body = { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD, next };
  const store=loginStore();
  try { return await handleLogin(new Request(origin + '/api/auth/login', {
    method: 'POST', headers: { origin, 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
    body: json ? JSON.stringify(body) : new URLSearchParams(body),
  }), {...env,DB:store.DB}); } finally {store.close();}
}
for (const next of ['/\\external.invalid', '//external.invalid', '/\n/external.invalid', '/\t/external.invalid', 'https://external.invalid', '/%5cexternal.invalid', '/%2fexternal.invalid', '/x/../login', '/%61pi/auth/login', '/api/auth/logout', '/bad%zz']) {
  test(`login rejects unsafe or authentication-loop next ${JSON.stringify(next)}`, async () => {
    for (const json of [false, true]) {
      const response = await login(next, json);
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/');
      assert.equal(new URL(response.headers.get('location'), origin).origin, origin);
      assert.match(response.headers.get('set-cookie'), /; HttpOnly;/);
      assert.match(response.headers.get('set-cookie'), /; Secure;/);
    }
    const page = renderLoginPage(new Request(origin + '/login?' + new URLSearchParams({ next })), env);
    assert.match(await page.text(), /name="next" value="\/"/);
  });
}
for (const [next, expected] of [['/?section=publishers&publisher=publisher-a&site=site-a2&tab=config&agency=north', '/?section=publishers&publisher=publisher-a&site=site-a2&tab=config&agency=north'], ['/config?site=example#units', '/config?site=example#units'], ['/releases?url=https%3A%2F%2Fexample.invalid', '/releases?url=https%3A%2F%2Fexample.invalid'], ['/old/../config', '/config'], ['/', '/']]) {
  test(`login preserves internal destination ${next}`, async () => {
    assert.equal((await login(next)).headers.get('location'), expected);
  });
}
