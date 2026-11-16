import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../../worker/test-workspace/index.mjs';
import { reviewJs, reviewCss } from '../../.generated/ads-versions-preview.mjs';
import { workspaceStore, ORIGIN, TEST_EMAIL, TEST_PASSWORD } from '../support/test-workspace-store.mjs';

test('UI review is authenticated, GET-only, isolated and cannot access storage', async () => {
  const f = workspaceStore();
  try {
    const paths = ['/preview/ads-versions', '/preview/ads-versions.js'];
    for (const path of paths) assert.equal((await worker.fetch(new Request(ORIGIN + path), f.env)).status, 303);
    const login = await worker.fetch(new Request(ORIGIN + '/api/auth/login', { method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: TEST_EMAIL, password: TEST_PASSWORD }) }), f.env);
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const forbidden = new Proxy({}, { get() { assert.fail('UI review touched storage'); } });
    const env = { ...f.env, DB: forbidden, BUILDS: forbidden };
    for (const path of paths) {
      const response = await worker.fetch(new Request(ORIGIN + path, { headers: { cookie } }), env);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
      assert.match(response.headers.get('x-robots-tag'), /noindex/);
      if (path.endsWith('.js')) assert.equal(await response.text(), reviewJs);
      else assert.match(await response.text(), /<script src="\/preview\/ads-versions.js" defer><\/script>/);
      assert.equal((await worker.fetch(new Request(ORIGIN + path + '?site=k1info', { headers: { cookie } }), env)).status, 404);
      assert.equal((await worker.fetch(new Request(ORIGIN + path, { method: 'POST', headers: { cookie, origin: ORIGIN } }), env)).status, 404);
      assert.equal((await worker.fetch(new Request('https://production.invalid' + path, { headers: { cookie } }), env)).status, 404);
      assert.equal((await worker.fetch(new Request(ORIGIN + path, { headers: { cookie } }), { ...env, TEST_WORKSPACE_ENABLED: 'false' })).status, 503);
    }
  } finally { f.close(); }
});

test('review includes real shared UI, frozen notes and no independent copy of the panel', () => {
  const entry = readFileSync(new URL('../../src/preview/ads-versions.tsx', import.meta.url), 'utf8');
  assert.match(entry, /import BuiltinRuntimePreviewPanel/);
  assert.match(entry, /displayFixture=/);
  assert(!entry.includes('fetch('));
  assert.match(reviewJs, /example\.invalid/);
  assert.match(reviewJs, /Version history and earlier files/);
  assert.match(reviewJs, /Technical details/);
  assert.match(reviewJs, /History only/);
  assert.match(reviewCss, /@media/);
  const panel = readFileSync(new URL('../../src/components/BuiltinRuntimePreviewPanel.tsx', import.meta.url), 'utf8');
  assert.equal((panel.match(/if \(displayFixture \|\| !settings/g) || []).length, 2);
  assert.equal((panel.match(/disabled=\{Boolean\(displayFixture\)/g) || []).length, 2);
  assert.match(panel, /if \(displayFixture\) \{[\s\S]*?return;[\s\S]*?jsonRequest<Settings>/);
});
