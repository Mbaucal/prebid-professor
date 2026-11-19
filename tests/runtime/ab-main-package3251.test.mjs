/** Current MAIN Generate/readPackage boundary, with local SQLite/R2 and synthetic inventory only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {workspaceStore} from '../support/test-workspace-store.mjs';
import {applyBidderAccountSchema} from '../support/bidder-account-schema.mjs';
import {memoryR2} from '../support/memory-r2.mjs';
import {bidCacheSite} from './bid-cache323-site.mjs';
import {siteRuntimeSettings, changeSiteRuntime} from '../../worker/site-runtime/service.mjs';
import {generatePackage, readPackage} from '../../worker/site-runtime/releases.mjs';
import {checkAbCompatibility, composeAbBundle} from '../../worker/experiments/ab-bundle.mjs';

const SITE = 'main-ab-example', ACTOR = 'tester@example.invalid';
const vendor = new URL('../../vendor/prebid/tanjug-11.34.0/', import.meta.url);
const PREBID = new Uint8Array(readFileSync(new URL('prebid.js', vendor)));
const PREBID_CONFIG = JSON.parse(readFileSync(new URL('prebid-config.json', vendor), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = bytes => JSON.parse(new TextDecoder().decode(bytes));

async function mainFixture() {
  const f = workspaceStore(), s = bidCacheSite();
  try {
    f.sqlite.exec(readFileSync(new URL('../../migrations/0001_initial.sql', import.meta.url), 'utf8').split('INSERT OR IGNORE INTO publishers')[0]);
    applyBidderAccountSchema(f.sqlite);
    const sql = (text, ...args) => f.sqlite.prepare(text).run(...args);
    sql('INSERT INTO publishers(id,name,domain,gam_path) VALUES(?,?,?,?)', SITE, 'Synthetic MAIN A/B', 'main-ab.example.invalid', s.site.gam_path);
    sql('INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES(?,?,?)', 'config', SITE, s.config.config_json);
    for (const u of s.units) sql('INSERT INTO ad_units(id,publisher_id,code,type,media_type,size_map_key,enabled,sort_order) VALUES(?,?,?,?,?,?,?,?)', u.code, SITE, u.code, u.type, u.media_type, u.size_map_key, u.enabled, u.sort_order);
    for (const m of s.maps) sql('INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES(?,?,?,?)', m.name, SITE, m.name, m.map_json);
    for (const b of s.bidders) sql('INSERT INTO bidders(id,publisher_id,bidder,params_json,enabled) VALUES(?,?,?,?,?)', b.bidder, SITE, b.bidder, b.params_json, b.enabled);
    for (const r of s.rules) sql('INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES(?,?,?,?)', r.rule_key, SITE, r.rule_key, r.rule_json);
    const r2 = memoryR2({prefix: `publishers/${SITE}/`});
    f.env.BUILDS = r2.bucket;
    const prebidKey = `publishers/${SITE}/prebid-builds/ab-fixture/prebid.js`;
    sql('INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES(?,?,?,?,?,?)', 'ab-fixture', SITE, PREBID_CONFIG.version, prebidKey, JSON.stringify(PREBID_CONFIG.modules), 'current');
    await r2.bucket.put(prebidKey, PREBID, {onlyIf: new Headers({'If-None-Match': '*'}), httpMetadata: {cacheControl: 'private, no-store'}, customMetadata: {sha256: hash(PREBID), version: PREBID_CONFIG.version}});
    const settings = await siteRuntimeSettings(f.env, SITE), selected = settings.runtimes.find(r => r.version === '3.25.1');
    assert(selected, 'MAIN must explicitly offer 3.25.1');
    await changeSiteRuntime(f.env, SITE, ACTOR, {action: 'version', revision: settings.revision, runtime: selected.pin, allowPreview: true});
    async function generate(notes) {
      const {release} = await generatePackage(f.env, SITE, ACTOR, {notes, revision: (await siteRuntimeSettings(f.env, SITE)).revision});
      return readPackage(f.env, SITE, release.id);
    }
    const a = await generate('3.25.1 cache OFF');
    const config = JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id=?').get(SITE).config_json);
    config.prebidBidCache = {enabled: true, maxBidAgeSeconds: 60};
    sql('UPDATE publisher_configs SET config_json=? WHERE publisher_id=?', JSON.stringify(config), SITE);
    const b = await generate('3.25.1 cache ON');
    return {a, b, close: f.close};
  } catch (error) { f.close(); throw error; }
}

test('complete MAIN 3.25.1 cache OFF/ON packages retain exact arm and Prebid bytes', async () => {
  const {a, b, close} = await mainFixture();
  try {
    const original = [a, b].map(p => Object.fromEntries(Object.entries(p.files).map(([name, bytes]) => [name, hash(bytes)])));
    for (const p of [a, b]) {
      assert.match(p.release.id, /^builtin-release-[a-f0-9]{64}$/);
      assert.equal(p.manifest.runtime.runtimeVersion, '3.25.1');
      assert.equal(p.manifest.completeRelease, true);
      assert(p.files['gam-reporting.json']);
      assert(p.files['deals-plan.json']);
      assert.deepEqual(p.files['prebid.js'], PREBID);
    }
    assert.equal(json(a.files['config.json']).bidCache, null);
    assert.deepEqual(Object.keys(json(b.files['config.json']).bidCache.positions).sort(), ['Billboard', 'P1']);
    const input = {site: SITE, a, b, trafficBPercent: 10, testId: 'main_ab_1', name: '3.25.1 bid cache'};
    assert.equal((await checkAbCompatibility(input)).compatible, true);
    const bundle = await composeAbBundle(input), unpacked = unzipSync(bundle.zip);
    assert.deepEqual(bundle.files['prebid.js'], PREBID);
    for (const [side, p] of [['A', a], ['B', b]]) {
      const arm = bundle.record.arms[side];
      assert.equal(arm.runtimeVersion, '3.25.1');
      assert.equal(arm.sha256, hash(p.files['ads.min.js']));
      assert.deepEqual(unpacked[arm.path], p.files['ads.min.js']);
    }
    assert(bundle.record.configDiff.some(row => row.field === 'bidCache.enabled' && row.a === false && row.b === true));
    assert(!bundle.record.configDiff.some(row => row.field === 'runtimeVersion'));
    assert.deepEqual([a, b].map(p => Object.fromEntries(Object.entries(p.files).map(([name, bytes]) => [name, hash(bytes)]))), original);
    assert.deepEqual((await composeAbBundle(input)).zip, bundle.zip);
  } finally { close(); }
});
