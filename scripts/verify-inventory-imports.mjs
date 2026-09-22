// Real compiled application Worker, disposable local D1, no remote traffic.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { sizeMapsTemplateCsv, adUnitsTemplateCsv } from '../src/shared/inventory-csv-templates.ts';

const origin = 'https://inventory.example.invalid';
const password = randomBytes(24).toString('base64url');
const mf = new Miniflare({
  modules: true, script: await readFile('dist/prebid_professor/index.js', 'utf8'),
  compatibilityDate: '2026-07-15', compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'local-inventory-check' }, r2Buckets: { BUILDS: 'local-inventory-files' },
  bindings: { ADMIN_EMAIL: 'test@example.invalid', ADMIN_PASSWORD: password, SESSION_SECRET: randomBytes(48).toString('hex') },
  outboundService() { throw Error('Unexpected external request'); },
});
try {
  const db = await mf.getD1Database('DB');
  const ddl = (await readFile('migrations/0001_initial.sql', 'utf8')).split('INSERT OR IGNORE INTO publishers')[0];
  for (const statement of ddl.split(';').map(x => x.trim()).filter(Boolean)) await db.prepare(statement).run();
  await db.prepare("INSERT INTO publishers(id,name,domain,gam_path) VALUES ('fixture','Example','example.invalid','/123/Example/')").run();
  const login = await mf.dispatchFetch(origin + '/api/auth/login', { method: 'POST', redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'test@example.invalid', password }).toString() });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function call(action, kind, csv) {
    const r = await mf.dispatchFetch(`${origin}/api/publishers/fixture/imports/${action}`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ kind, csv }),
    });
    const data = await r.json();
    assert.equal(r.status, 200, JSON.stringify(data));
    return data;
  }
  const maps = await call('preview', 'size-maps', sizeMapsTemplateCsv);
  assert.equal(maps.preview.errorCount, 0);
  assert.equal(maps.preview.createCount, 11);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM size_maps').first()).n, 0, 'Preview must not write');
  assert.equal((await call('apply', 'size-maps', sizeMapsTemplateCsv)).imported, 11);
  const savedMaps = (await db.prepare('SELECT name,map_json FROM size_maps').all()).results;
  const names = new Set(savedMaps.map(m => m.name));
  assert.deepEqual(JSON.parse(savedMaps.find(m => m.name === 'Native').map_json)[0].sizes, ['fluid']);
  assert.deepEqual(JSON.parse(savedMaps.find(m => m.name === 'Branding_Left').map_json).find(b => b.minViewPort[0] === 0).sizes, []);
  const units = await call('preview', 'ad-units', adUnitsTemplateCsv);
  assert.equal(units.preview.errorCount, 0);
  assert.equal(units.preview.createCount, 36);
  for (const row of units.preview.rows) assert(names.has(row.data.sizeMapKey), `Unresolved map: ${row.key}`);
  assert.equal((await call('apply', 'ad-units', adUnitsTemplateCsv)).imported, 36);
  assert.equal((await db.prepare("SELECT type FROM ad_units WHERE code='TakeOver'").first()).type, 'DRAFT');
  assert.equal((await call('preview', 'ad-units', adUnitsTemplateCsv)).preview.updateCount, 36);
  await call('apply', 'ad-units', 'code,type,mediaType,sizeMapKey,enabled,sortOrder,notes\nP1,ATF,banner,P_MAP,true,1,Updated');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM ad_units').first()).n, 36, 'Partial imports must preserve other positions');
  assert.equal((await db.prepare("SELECT notes FROM ad_units WHERE code='P1'").first()).notes, 'Updated');
  console.log('PASS: 11 maps, fluid and empty breakpoints, 36 matched units, preview without writes, real apply, repeat updates and partial-import preservation.');
} finally { await mf.dispose(); }
