import test from 'node:test';
import assert from 'node:assert/strict';
import { blockStoredDraftCdn } from '../../worker/runtime/stored-draft-safety.mjs';
for (const method of ['GET','HEAD']) for (const version of ['builtin-draft-abc','%62uiltin-draft-abc']) {
  test(`public ${method} refuses ${version} without downstream access`, async()=>{
    const response=blockStoredDraftCdn(new Request(`https://test.invalid/cdn/test-site/releases/${version}/ads.js`,{method}));
    assert.equal(response.status,404);assert.equal(response.headers.get('cache-control'),'private, no-store');
    if(method==='HEAD') assert.equal(await response.text(),'');
  });
}
for(const path of ['/cdn/site/releases/20260911_120000/ads.js','/cdn/site/current/ads.js','/cdn/site/staging/ads.js','/api/publishers/site/builtin-runtime-preview']) {
  test(`legacy or API path remains delegated: ${path}`,()=>assert.equal(blockStoredDraftCdn(new Request('https://test.invalid'+path)),null));
}
test('malformed CDN version cannot throw past the request boundary',()=>{
  assert.equal(blockStoredDraftCdn(new Request('https://test.invalid/cdn/site/releases/%FF/ads.js')).status,404);
});
