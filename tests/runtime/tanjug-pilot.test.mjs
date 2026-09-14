import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { parse } from 'acorn';
import { metadata, zipBase64, previewHtml, prebidConfig } from '../../.generated/tanjug-pilot.mjs';
import { generatedLiteral } from '../support/generated-literal.mjs';
import { parsePrebidHeader, sha256 } from '../../worker/runtime/prebid-artifact-check.mjs';
import worker from '../../worker/test-workspace/index.mjs';
import { workspaceStore, ORIGIN, TEST_EMAIL, TEST_PASSWORD } from '../support/test-workspace-store.mjs';

const files = unzipSync(Buffer.from(zipBase64, 'base64'));
const text = (name) => new TextDecoder().decode(files[name]);
const source = JSON.parse(readFileSync(new URL('../../docs/pilots/tanjug-observed.json', import.meta.url)));
test('Tanjug package preserves all approved GAM, bidder and responsive mapping data', async () => {
  const config = JSON.parse(text('config.json'));
  assert.equal(config.siteId, 'tanjug-test');
  assert.equal(config.core.gamPath, source.observedSiteDraft.site.gamPath);
  assert.deepEqual(config.core.bidders, source.bidders);
  assert.deepEqual(config.core.explicitUnits.map((u) => u.id), source.observedSiteDraft.units.map((u) => u.code));
  assert.equal(config.options.takeOver.enabled, false);
  assert.equal(config.options.sticky.bottomAdUnitId, 'Sticky');
  for (const m of source.observedSiteDraft.maps) assert.deepEqual(config.core.sizeMapsRaw[m.name], m.breakpoints.map((b) => ({ viewport: [b.minWidth, 0], sizes: b.sizes })).sort((a,b)=>a.viewport[0]-b.viewport[0]));
  for (const name of ['ads.js', 'ads.min.js']) {
    assert.equal(generatedLiteral(text(name), 'adUnitPath'), config.core.gamPath);
    assert.equal(generatedLiteral(text(name), 'TAKEOVER_ENABLED'), false);
    assert.deepEqual(generatedLiteral(text(name), 'EXPLICIT_UNITS'), config.core.explicitUnits);
    const sync = [];
    function visit(n) {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.name === 'pbjs' && n.callee.property.name === 'setConfig') {
        const p = n.arguments[0]?.properties?.find((p) => (p.key.name ?? p.key.value) === 'userSync');
        if (p) sync.push(p.value);
      }
      for (const child of Object.values(n)) if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child);
    }
    visit(parse(text(name), {ecmaVersion:'latest'}));
    assert.equal(sync.length, 1);
    const delay = sync[0].properties.find((p) => (p.key.name ?? p.key.value) === 'auctionDelay').value;
    assert.equal(delay.value, config.core.userSync.auctionDelay);
    assert.equal(delay.value, 50); // compiler.patchUserSync replaces the reference's 150.
  }
  assert.equal((text('implementation.html').match(/id="Billboard"/g) || []).length, 1);
  assert.equal((text('implementation.html').match(/class="wrapperAd/g) || []).length, 18);
  assert(!text('implementation.html').includes('LOCAL-MOCK'));
  assert(!text('ads.js').includes('gdprApplies: false'));
  assert(previewHtml.includes(text('ads.min.js').replace(/<\/script/gi, '<\\/script')));
});
test('frozen ZIP encoding is identical in UTC and timezones east and west of UTC', () => {
  const originalZone = process.env.TZ;
  try {
    for (const zone of ['UTC', 'Pacific/Honolulu', 'Asia/Tokyo']) {
      process.env.TZ = zone;
      const entries = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, [bytes, {level:0,mtime:new Date(1980,0,1,0,0,0)}]]));
      assert.deepEqual(Buffer.from(zipSync(entries, {level:0})), Buffer.from(zipBase64, 'base64'), zone);
    }
  } finally { if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone; }
});
test('ZIP contains exact original builder bytes and verifies every candidate file', async () => {
  assert.equal(Object.keys(files).length, 10);
  assert.deepEqual(parsePrebidHeader(text('prebid.js')), prebidConfig);
  assert.equal(await sha256(files['prebid.js']), '384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b');
  assert.deepEqual(Buffer.from(files['prebid.js']), readFileSync(new URL('../../vendor/prebid/tanjug-11.34.0/prebid.js', import.meta.url)));
  for (const [name, pin] of Object.entries(metadata.manifest.files)) {
    assert.equal(files[name].length, pin.byteSize); assert.equal(await sha256(files[name]), pin.sha256);
  }
  assert.equal(metadata.manifest.completeRelease, false);
  assert.equal(await sha256(Buffer.from(zipBase64, 'base64')), metadata.zipSha256);
});
test('pilot routes require TEST authentication, cannot mutate saved settings, and isolate script execution', async () => {
  const f = workspaceStore();
  try {
    const paths = ['/pilot/tanjug', '/pilot/tanjug/preview', '/pilot/tanjug/ui.js', '/test-api/pilots/tanjug/download', '/test-api/pilots/tanjug/prebid-config'];
    for (const path of paths) assert.equal((await worker.fetch(new Request(ORIGIN + path), f.env)).status, path.startsWith('/test-api/') ? 401 : 303);
    const login = await worker.fetch(new Request(ORIGIN + '/api/auth/login', { method: 'POST', headers: {origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD}) }), f.env);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    // Any storage access fails the test, including reads: this must remain separate
    // from the user's saved synthetic TEST site and its accepted packages.
    const env = {...f.env, DB: new Proxy({}, {get(){assert.fail('Pilot touched saved DB');}}), BUILDS: new Proxy({}, {get(){assert.fail('Pilot touched saved R2');}})};
    for (const path of paths) {
      const r = await worker.fetch(new Request(ORIGIN + path, {headers:{cookie}}), env);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.get('cache-control'), 'private, no-store');
      if (path.endsWith('/download')) assert.deepEqual(Buffer.from(await r.arrayBuffer()), Buffer.from(zipBase64, 'base64'));
      if (path.endsWith('/preview')) {
        const csp = r.headers.get('content-security-policy');
        assert.match(csp, /sandbox allow-scripts;/); assert(!csp.includes('allow-same-origin'));
        assert.match(csp, /connect-src 'none'/); assert.match(csp, /default-src 'none'/);
      }
      assert.equal((await worker.fetch(new Request(ORIGIN + path + '?site=other', {headers:{cookie}}), env)).status, 404);
      assert.equal((await worker.fetch(new Request(ORIGIN + path, {method:'POST',headers:{cookie,origin:ORIGIN}}), env)).status, 404);
      assert.equal((await worker.fetch(new Request('https://example.invalid' + path, {headers:{cookie}}), env)).status, 404);
    }
    const page = await worker.fetch(new Request(ORIGIN + '/pilot/tanjug', {headers:{cookie}}), env);
    assert.match(await page.text(), /sandbox="allow-scripts"/);
    assert(!page.headers.get('content-security-policy').includes("script-src 'unsafe-inline'"));
  } finally { f.close(); }
});
