import test from 'node:test';
import assert from 'node:assert/strict';
import { serveReleaseCdn } from '../../worker/releases.ts';

for (const channel of ['current', 'staging', 'releases/20260929_120000']) {
  for (const method of ['GET', 'HEAD']) {
    test(`legacy ${channel} ${method} isolates HTML and preserves stored bytes`, async () => {
      const body = '<script>window.publisherCode=true</script>';
      const metadata = { httpEtag: '"original"', writeHttpMetadata(headers) { headers.set('content-type', 'text/html; charset=utf-8'); } };
      const keys = [];
      const env = { BUILDS: {
        async get(key) { keys.push(key); return { ...metadata, body }; },
        async head(key) { keys.push(key); return metadata; },
      } };
      const response = await serveReleaseCdn(new Request(`https://tessera.invalid/cdn/example/${channel}/implementation.html`, { method }), env);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-security-policy'), /^sandbox allow-scripts allow-popups;/);
      assert.doesNotMatch(response.headers.get('content-security-policy'), /allow-same-origin|allow-top-navigation|allow-popups-to-escape-sandbox/);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('etag'), '"original"');
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal(await response.text(), method === 'HEAD' ? '' : body);
      assert.equal(keys.length, 1);
    });
  }
}
test('legacy JavaScript keeps its MIME type, immutable cache policy and exact bytes', async () => {
  const env = { BUILDS: { async get() { return {
    httpEtag: '"js-hash"', body: 'window.original=true;',
    writeHttpMetadata(headers) { headers.set('content-type', 'application/javascript'); },
  }; } } };
  const response = await serveReleaseCdn(new Request('https://tessera.invalid/cdn/example/releases/20260929_120000/ads.js'), env);
  assert.equal(response.headers.get('content-security-policy'), null);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(response.headers.get('content-type'), 'application/javascript');
  assert.equal(await response.text(), 'window.original=true;');
});
