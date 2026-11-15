/** composeAbBundle on real saved packages: each one is generated through the runtime catalog
 * (as scripts/prepare-bidcache323-browser.mjs does) for the synthetic, non-Tanjug bid cache
 * site, saved with saveDraftRelease in the isolated store and read back with readPackage. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {applyBidderAccountSchema} from '../support/bidder-account-schema.mjs';
import {isolatedStore} from '../support/isolated-draft-store.mjs';
import {workspaceStore} from '../support/test-workspace-store.mjs';
import {bidCacheSite} from './bid-cache323-site.mjs';
import {runtimeCatalog, buildArtifactCandidate, previewInput} from '../../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {prebidRequirements, inspectPrebidArtifact} from '../../worker/runtime/prebid-artifact-check.mjs';
import {saveDraftRelease, readDraftRelease} from '../../worker/runtime/draft-release-store.mjs';
import {readPackage, generatePackage} from '../../worker/site-runtime/releases.mjs';
import {siteRuntimeSettings, changeSiteRuntime} from '../../worker/site-runtime/service.mjs';
import {PAGES_HEADERS} from '../../scripts/pages-release-verification.mjs';
import {AB_LOADER_CONFIG_SCHEMA, AB_LOADER_VERSION, renderAbLoader} from '../../worker/experiments/ab-loader-1.0.0.mjs';
import {AB_BUNDLE_LAYOUT, AB_TEST_SCHEMA, abTestIdentity, checkAbCompatibility, composeAbBundle} from '../../worker/experiments/ab-bundle.mjs';

const STAMP = '20261115_120000', ACTOR = 'tester@example.invalid';
const vendor = new URL('../../vendor/prebid/tanjug-11.34.0/', import.meta.url);
const PREBID = readFileSync(new URL('prebid.js', vendor));
const PREBID_CONFIG = JSON.parse(readFileSync(new URL('prebid-config.json', vendor), 'utf8'));
const registry = JSON.parse(readFileSync(new URL('../../worker/experiments/ab-loader-registry.json', import.meta.url), 'utf8'));
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const text = bytes => new TextDecoder().decode(bytes);
const bytesOf = value => new TextEncoder().encode(value);
const CACHE_ON = {enabled: true, maxBidAgeSeconds: 60};
const store = isolatedStore(), env = {DB: store.db, BUILDS: store.bucket};
test.after(() => store.close());

/** The bid cache site as test-site (the only site TEST may save drafts for), changed by mutate(snapshot, config). */
function site({cache, siteId = 'test-site', prebid = true, takeOver = false, mutate} = {}) {
  const snapshot = bidCacheSite({cache, takeOver}), config = JSON.parse(snapshot.config.config_json);
  snapshot.site = {...snapshot.site, id: siteId};
  config.enablePrebid = prebid;
  mutate?.(snapshot, config);
  snapshot.config.config_json = JSON.stringify(config);
  return snapshot;
}
async function prebidFor(snapshot, descriptor, bytes) {
  const config = JSON.parse(snapshot.config.config_json);
  if (config.enablePrebid !== true) return null;
  const {version, modules} = PREBID_CONFIG, buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const requirements = prebidRequirements(previewInput(snapshot, descriptor, STAMP), config);
  const build = {id: 'synthetic-build', publisher_id: snapshot.site.id, status: 'current', version,
    file_key: `publishers/${snapshot.site.id}/prebid-builds/synthetic-build/prebid.js`, modules_json: JSON.stringify(modules)};
  const object = {size: buffer.byteLength, customMetadata: {sha256: hash(bytes), version}, async arrayBuffer() { return buffer; }};
  return {bytes: buffer, report: await inspectPrebidArtifact({siteId: snapshot.site.id, builds: [build], requirements}, {async get() { return object; }})};
}
/** Saves the candidate as a TEST draft and returns it exactly as readPackage gives it. */
async function saved(candidate, siteId, note) {
  const {draft} = await saveDraftRelease(store.store, {siteId, candidate, actor: ACTOR, note});
  if (siteId === 'test-site') return readPackage(env, siteId, draft.id, {testOnly: true});
  // readPackage serves only test-site on TEST; readDraftRelease is the call it makes.
  const p = await readDraftRelease(store.store, {siteId, releaseId: draft.id});
  return {files: p.files, release: p.draft};
}
async function generate({runtime = 'tessera-3.23.0', snapshot = site({cache: CACHE_ON}), prebid = PREBID, countryTarget = 'test', note = ''} = {}) {
  const descriptor = runtimeCatalog.find(r => r.id === runtime);
  const candidate = await buildArtifactCandidate({snapshot, pin: pinRuntime(descriptor), buildTimestamp: STAMP, countryTarget,
    prebid: await prebidFor(snapshot, descriptor, prebid)});
  return saved(candidate, snapshot.site.id, note);
}
/** Real package with one file replaced, its manifest updated and its draft id recomputed. */
async function replaced(pkg, name, bytes) {
  const files = {...pkg.files, [name]: bytes}, manifest = JSON.parse(text(files['manifest.json']));
  manifest.files[name] = {...manifest.files[name], byteSize: bytes.length, sha256: hash(bytes)};
  files['manifest.json'] = bytesOf(JSON.stringify(manifest, null, 2) + '\n');
  return saved({files}, 'test-site', 'Changed ' + name);
}

const P = {};
test.before(async () => {
  P.A = await generate({runtime: 'tessera-3.21.2', snapshot: site(), note: 'Bid cache off'});
  P.B = await generate({note: 'Bid cache on'});
  P.otherSite = await generate({snapshot: site({cache: CACHE_ON, siteId: 'other-site'})});
  P.otherPrebid = await generate({prebid: Buffer.concat([PREBID, Buffer.from('\n/* another build */\n')])});
  P.gamA = await generate({runtime: 'tessera-3.21.2', snapshot: site({prebid: false}), note: 'GAM only 3.21.2'});
  P.gamB = await generate({snapshot: site({prebid: false}), note: 'GAM only 3.23.0'});
  P.inventory = await generate({snapshot: site({cache: CACHE_ON, mutate: s => s.units.push({...s.units[1], code: 'P2', sort_order: 2})})});
  P.css = await generate({snapshot: site({cache: CACHE_ON, mutate: s => {
    s.maps[0].map_json = JSON.stringify([{viewport: [0, 0], sizes: [[300, 600]]}, {viewport: [1024, 0], sizes: [[300, 600], [970, 250]]}]);
  }})});
  P.sticky = await replaced(P.B, 'sticky.css', bytesOf(text(P.B.files['sticky.css']) + '/* changed */\n'));
  P.gamPath = await generate({snapshot: site({cache: CACHE_ON, mutate: s => { s.site.gam_path = '/999/other/'; }})});
  P.cmp = await generate({snapshot: site({cache: CACHE_ON, mutate: s => {
    const rule = JSON.parse(s.rules[0].rule_json); s.rules[0].rule_json = JSON.stringify({...rule, cmpTimeout: 3000});
  }})});
  P.userSync = await generate({snapshot: site({cache: CACHE_ON, mutate: (s, c) => {
    c.userSync = {syncEnabled: true, aliasSyncEnabled: false, syncsPerBidder: 2, syncDelay: 3000, auctionDelay: 0, filterSettings: {all: {bidders: '*', filter: 'include'}}, userIds: []};
  }})});
  P.country = await generate({countryTarget: 'main'});
  P.r3210 = await generate({runtime: 'tessera-3.21.0', snapshot: site(), note: 'Script 3.21.0'});
  const takeOver = minutes => site({takeOver: true, mutate: (s, c) => { c.runtimeControls.adPositions.Overlay.frequencyMinutes = minutes; }});
  P.takeOver0 = await generate({runtime: 'tessera-3.21.2', snapshot: takeOver(0), note: 'TakeOver every page'});
  P.takeOver5 = await generate({runtime: 'tessera-3.21.2', snapshot: takeOver(5), note: 'TakeOver every 5 minutes'});
  P.tuned = await generate({snapshot: site({cache: {enabled: true, maxBidAgeSeconds: 30, positionOverrides: {P1: false}}, mutate: (s, c) => {
    c.runtimeControls.floors = {enabled: true};
    s.bidders = [{...s.bidders[0], params_json: '{"publisherId":"2","adSlot":"a"}'}];
    const rule = JSON.parse(s.rules[0].rule_json);
    s.rules[0].rule_json = JSON.stringify({...rule, timeout: 1000, refresh: {...rule.refresh, minSeconds: 45}});
  }}), note: 'Tuned demand'});
});

const compose = (a, b, over = {}) => composeAbBundle({site: 'test-site', a, b, trafficBPercent: 50, testId: 'test_site_1', name: 'Bid cache 3.23.0', ...over});
const refused = (promise, code, check, message) => assert.rejects(promise, error => {
  assert.equal(error.status, 422); assert.equal(error.code, code); assert.equal(error.check, check); assert.match(error.message, message);
  return true;
});
const armPath = pkg => `r/${pkg.release.id}/ads.js`;

test('the inputs are real saved packages: 3.21.2 without and 3.23.0 with bid cache, one Prebid.js', () => {
  assert.match(P.A.release.id, /^builtin-draft-[a-f0-9]{64}$/);
  assert.equal(P.A.release.runtime.runtimeVersion, '3.21.2');
  assert.equal(P.B.release.runtime.runtimeVersion, '3.23.0');
  assert.equal(JSON.parse(text(P.A.files['config.json'])).bidCache, undefined);
  assert.deepEqual(JSON.parse(text(P.B.files['config.json'])).bidCache, {defaultEnabled: true, maxAgeSeconds: 60, positions: {Billboard: true, P1: true}});
  assert.deepEqual(P.A.files['prebid.js'], P.B.files['prebid.js']);
  assert.equal(hash(P.A.files['prebid.js']), hash(PREBID));
});

test('the same inputs give the same bytes and the same id, whatever the key order', async () => {
  const first = await compose(P.A, P.B);
  const second = await composeAbBundle({name: 'Bid cache 3.23.0', testId: 'test_site_1', trafficBPercent: 50, b: P.B, a: P.A, site: 'test-site'});
  assert.match(first.id, /^abx-[a-f0-9]{64}$/);
  assert.equal(second.id, first.id);
  assert.deepEqual(second.zip, first.zip);
  assert.deepEqual(second.files, first.files);
  assert.equal(JSON.stringify(second.record), JSON.stringify(first.record));
  assert.equal(first.zipSha256, hash(first.zip));
  assert.equal(first.record.id, first.id);
  assert.equal(first.id, 'abx-' + hash(abTestIdentity(first.record)));
  // Who saved the test and when never changes its id.
  assert.equal(abTestIdentity({...first.record, createdBy: 'someone@example.invalid', createdAt: '2026-11-15T12:00:00.000Z'}), abTestIdentity(first.record));
  for (const over of [{name: 'Another name'}, {testId: 'test_site_2'}, {trafficBPercent: 10}])
    assert.notEqual((await compose(P.A, P.B, over)).id, first.id, JSON.stringify(over));
  assert.notEqual((await compose(P.B, P.A)).id, first.id, 'A and B swapped');
});

test('the bundle holds exactly the publisher-ab-v1 files, in a deterministic stored ZIP', async () => {
  const bundle = await compose(P.A, P.B);
  const paths = ['_headers', 'ads.js', armPath(P.A), armPath(P.B), 'prebid.js'].sort();
  assert.deepEqual(Object.keys(bundle.files), paths);
  assert.equal(text(bundle.files._headers), PAGES_HEADERS);
  assert.deepEqual(bundle.files['prebid.js'], P.A.files['prebid.js']);
  assert.deepEqual(bundle.record.bundle, {layout: AB_BUNDLE_LAYOUT, zipSha256: hash(bundle.zip),
    files: paths.map(path => ({path, sha256: hash(bundle.files[path]), bytes: bundle.files[path].length}))});
  const unzipped = unzipSync(bundle.zip);
  assert.deepEqual(Object.keys(unzipped), paths, 'entries are sorted');
  for (const path of paths) assert.deepEqual(unzipped[path], bundle.files[path]);
  // Every local header: version 20, no flags, stored, DOS time 00:00:00 and date 1980-01-01.
  const view = new DataView(bundle.zip.buffer, bundle.zip.byteOffset, bundle.zip.byteLength);
  let offset = 0, entries = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.deepEqual([view.getUint16(offset + 6, true), view.getUint16(offset + 8, true), view.getUint16(offset + 10, true), view.getUint16(offset + 12, true)], [0, 0, 0, 0x21]);
    const name = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
    assert.equal(extra, 0);
    offset += 30 + name + view.getUint32(offset + 18, true); entries++;
  }
  assert.equal(entries, paths.length);
});

test('each arm is the saved ads.min.js byte for byte, and its SRI is the sha384 of those bytes', async () => {
  const bundle = await compose(P.A, P.B, {trafficBPercent: 10});
  for (const [side, pkg] of [['A', P.A], ['B', P.B]]) {
    const bytes = pkg.files['ads.min.js'], arm = bundle.record.arms[side];
    assert.deepEqual(bundle.files[armPath(pkg)], bytes);
    assert.equal(Buffer.compare(Buffer.from(bundle.files[armPath(pkg)]), Buffer.from(bytes)), 0);
    assert.deepEqual(arm, {release: pkg.release.id, name: pkg.release.note, runtimeVersion: pkg.release.runtime.runtimeVersion,
      path: armPath(pkg), sha256: hash(bytes), integrity: 'sha384-' + hash(bytes, 'sha384', 'base64')});
  }
  const {record} = bundle;
  assert.deepEqual(Object.keys(record), ['schema', 'id', 'site', 'name', 'testId', 'trafficBPercent', 'arms', 'prebid', 'loader',
    'compatibility', 'configDiff', 'bundle', 'createdBy', 'createdAt']);
  assert.equal(record.schema, AB_TEST_SCHEMA);
  assert.deepEqual([record.site, record.name, record.testId, record.trafficBPercent, record.createdBy, record.createdAt], ['test-site', 'Bid cache 3.23.0', 'test_site_1', 10, null, null]);
  assert.deepEqual(record.prebid, {sha256: hash(PREBID), version: PREBID_CONFIG.version});
  assert.deepEqual(record.loader, {version: AB_LOADER_VERSION, sha256: registry[AB_LOADER_VERSION].sha256});
  // ads.js is the registered loader with exactly this test's configuration.
  assert.equal(text(bundle.files['ads.js']), renderAbLoader({schema: AB_LOADER_CONFIG_SCHEMA, id: record.id, testId: 'test_site_1',
    name: 'Bid cache 3.23.0', trafficBPercent: 10, arms: record.arms, loader: record.loader}));
});

test('A/A uses one arm file for both arms', async () => {
  const bundle = await compose(P.A, P.A, {name: 'A/A 3.21.2'});
  assert.deepEqual(Object.keys(bundle.files), ['_headers', 'ads.js', 'prebid.js', armPath(P.A)]);
  assert.deepEqual(bundle.record.arms.A, bundle.record.arms.B);
  assert.deepEqual(bundle.record.configDiff, []);
  assert.deepEqual(bundle.record.compatibility.warnings, []);
  assert.deepEqual(Object.keys(unzipSync(bundle.zip)), Object.keys(bundle.files));
});

test('configDiff and warnings for 3.21.2 against 3.23.0 with bid cache on', async () => {
  const {record} = await compose(P.A, P.B);
  assert.deepEqual(record.configDiff, [
    {field: 'runtimeVersion', a: '3.21.2', b: '3.23.0'},
    {field: 'capabilities', a: [], b: ['bid-cache']},
    {field: 'bidCache.enabled', a: false, b: true},
    {field: 'bidCache.maxAgeSeconds', a: null, b: 60},
    {field: 'bidCache.positions', a: [], b: ['Billboard', 'P1']},
  ]);
  assert.deepEqual(record.compatibility.warnings.map(w => [w.code, w.a, w.b]), [['runtime-differs', '3.21.2', '3.23.0'], ['capabilities-differ', [], ['bid-cache']]]);
  assert.deepEqual(record.compatibility.checks, [{check: 'site', result: 'same'}, {check: 'prebid', result: 'same'}, {check: 'div-export.csv', result: 'same'},
    {check: 'min-height.css', result: 'same'}, {check: 'sticky.css', result: 'same'}, {check: 'gamPath', result: 'same'}, {check: 'consent', result: 'same'}]);
  const dry = await checkAbCompatibility({site: 'test-site', a: P.A, b: P.B});
  assert.deepEqual(dry, {compatible: true, refusal: null, checks: record.compatibility.checks, warnings: record.compatibility.warnings, configDiff: record.configDiff});
});

test('configDiff reports bid cache age and positions, refresh, floors, bidders and timeouts as data', async () => {
  const {record} = await compose(P.B, P.tuned);
  const B = JSON.parse(text(P.B.files['config.json'])), T = JSON.parse(text(P.tuned.files['config.json']));
  assert.deepEqual(record.configDiff, [
    {field: 'bidCache.maxAgeSeconds', a: 60, b: 30},
    {field: 'bidCache.positions', a: ['P1'], b: []},
    {field: 'refresh.default', a: B.core.globalRefresh, b: T.core.globalRefresh},
    {field: 'refresh.rules', a: {__ATF__: B.core.adUnitRules.__ATF__.refresh}, b: {__ATF__: T.core.adUnitRules.__ATF__.refresh}},
    {field: 'floors', a: B.options.floors, b: T.options.floors},
    {field: 'bidders', a: ['openx'], b: []},
    {field: 'bidderParams', a: {pubmatic: {params: [{publisherId: '1', adSlot: 'a'}], slot: null, device: null, adUnit: null}},
      b: {pubmatic: {params: [{publisherId: '2', adSlot: 'a'}], slot: null, device: null, adUnit: null}}},
    {field: 'timeouts', a: {default: 2500, atf: 800, btf: 2500, sticky: 2500}, b: {default: 2500, atf: 1000, btf: 2500, sticky: 2500}},
    {field: 'timeouts.rules', a: {__ATF__: 800}, b: {__ATF__: 1000}},
  ]);
  assert.equal(T.core.globalRefresh.minSeconds, 45);
  assert.equal(T.options.floors.enabled, true);
  assert.equal(record.compatibility.warnings.length, 0);
});

test('different storage use is a warning, not a refusal', async () => {
  // 3.21.0 still names localStorage (its debug switch); 3.21.1 removed it.
  const older = await compose(P.r3210, P.A);
  assert.deepEqual(older.record.compatibility.warnings.find(w => w.code === 'storage-differs'), {code: 'storage-differs',
    a: {apis: ['localStorage'], takeOverIntervalMinutes: 0}, b: {apis: [], takeOverIntervalMinutes: 0},
    message: 'Versions A and B use browser storage differently. Each version keeps its own consent handling; check that this is expected.'});
  // Both TakeOver scripts carry the sessionStorage cap code; only the saved interval says whether it runs.
  const {record} = await compose(P.takeOver0, P.takeOver5);
  assert.deepEqual(record.compatibility.warnings, [{code: 'storage-differs', a: {apis: ['sessionStorage'], takeOverIntervalMinutes: 0}, b: {apis: ['sessionStorage'], takeOverIntervalMinutes: 5},
    message: 'Versions A and B use browser storage differently. Each version keeps its own consent handling; check that this is expected.'}]);
  assert.deepEqual(record.configDiff, [], 'the summary of differences does not list the TakeOver interval');
});

test('a version of another site is refused', async () => {
  await refused(compose(P.A, P.otherSite), 'site-differs', 'site', /^Version B belongs to site other-site\. Choose two saved versions of test-site\.$/);
  await refused(composeAbBundle({site: 'other-site', a: P.A, b: P.otherSite, trafficBPercent: 50, testId: 'x', name: 'x'}), 'site-differs', 'site', /^Version A belongs to site test-site\./);
});

test('different Prebid.js files, or Prebid against GAM only, are refused; two GAM-only versions are not', async () => {
  await refused(compose(P.A, P.otherPrebid), 'prebid-differs', 'prebid', /^Versions A and B use different Prebid\.js files\. Generate both versions with the same Prebid build/);
  await refused(compose(P.A, P.gamB), 'prebid-differs', 'prebid', /^Version A loads Prebid\.js and version B is GAM only\./);
  await refused(compose(P.gamA, P.B), 'prebid-differs', 'prebid', /^Version B loads Prebid\.js and version A is GAM only\./);
  const bundle = await compose(P.gamA, P.gamB);
  assert.deepEqual(Object.keys(bundle.files), ['_headers', 'ads.js', armPath(P.gamA), armPath(P.gamB)].sort());
  assert.equal(bundle.record.prebid, null);
  assert.deepEqual(bundle.record.compatibility.checks[1], {check: 'prebid', result: 'gam-only'});
});

test('different ad positions, reserved space or sticky styling are refused', async () => {
  await refused(compose(P.A, P.inventory), 'inventory-differs', 'div-export.csv', /^Versions A and B differ in ad positions \(div-export\.csv\)\. Both versions must lay out the page the same way/);
  await refused(compose(P.A, P.css), 'css-differs', 'min-height.css', /reserved ad space \(min-height\.css\)/);
  assert.deepEqual(P.css.files['div-export.csv'], P.B.files['div-export.csv'], 'only the CSS differs');
  await refused(compose(P.A, P.sticky), 'css-differs', 'sticky.css', /sticky position styling \(sticky\.css\)/);
});

test('a different GAM ad unit path is refused', async () => {
  await refused(compose(P.A, P.gamPath), 'gam-path-differs', 'gamPath', /^Versions A and B use different GAM ad unit paths \(\/999\/bidcache\/ and \/999\/other\/\)\. Choose two versions with the same GAM path\.$/);
});

test('different CMP timeout, user sync or country lookup is refused', async () => {
  for (const [pkg, what] of [[P.cmp, 'the CMP timeout \\(core\\.maxCmpTimeout\\)'], [P.userSync, 'user sync \\(core\\.userSync\\)'], [P.country, 'the country lookup \\(countrySignal\\)']]) {
    await refused(compose(P.A, pkg), 'consent-differs', 'consent', new RegExp(`^Versions A and B differ in ${what}\\. Consent, user sync and country lookup must be the same in both groups: generate both versions with the same setting`));
    const dry = await checkAbCompatibility({site: 'test-site', a: P.A, b: pkg});
    assert.equal(dry.compatible, false);
    assert.equal(dry.refusal.code, 'consent-differs');
    assert.equal(dry.configDiff[0].field, 'runtimeVersion', 'the summary of differences is still shown');
  }
});

test('a package without ads.min.js or its manifest, or with a changed byte, is refused', async () => {
  for (const name of ['ads.min.js', 'manifest.json']) {
    const files = {...P.B.files}; delete files[name];
    await refused(compose(P.A, {...P.B, files}), 'package-incomplete', 'packages', new RegExp(`^Version B has no ${name.replace('.', '\\.')}\\. Generate that version again`));
  }
  const files = {...P.A.files, 'ads.min.js': P.A.files['ads.min.js'].slice()};
  files['ads.min.js'][100] ^= 1;
  await refused(compose({...P.A, files}, P.B), 'package-unverified', 'packages', /^Version A does not match its saved manifest\./);
  await refused(compose({...P.A, release: {...P.A.release, id: P.B.release.id}}, P.B), 'package-unverified', 'packages', /^Version A does not match/);
  await refused(compose({files: P.A.files, release: {id: 'tanjug-script-1.0.0-' + '0'.repeat(64)}}, P.B), 'package-unverified', 'packages', /^Version A is not a saved built-in version\./);
  const dry = await checkAbCompatibility({site: 'test-site', a: P.A, b: {files: P.B.files}});
  assert.deepEqual(dry, {compatible: false, refusal: {code: 'package-incomplete', check: 'packages', message: 'Version B is not a saved package. Choose a saved version under Releases.'}, checks: [], warnings: [], configDiff: null});
});

test('invalid test fields are refused before any package is read', async () => {
  for (const [over, message] of [[{name: ''}, /^Give the test a name of 1 to 60 characters\.$/], [{name: 'x'.repeat(61)}, /name of 1 to 60/],
    [{testId: 'Test-1'}, /^Use a TestId of 1 to 24 lowercase letters/], [{testId: null}, /TestId/], [{trafficBPercent: 101}, /0 to 100/],
    [{trafficBPercent: 12.5}, /whole number/], [{site: '../x'}, /^Choose a site/], [{a: null}, /both A and B/]])
    await assert.rejects(compose(P.A, P.B, over), error => error.status === 400 && error.code === 'invalid-request' && message.test(error.message));
});

test('a complete MAIN release, as readPackage returns it with its row and manifest, is accepted', async () => {
  const f = workspaceStore();
  try {
    f.sqlite.exec(readFileSync(new URL('../../migrations/0001_initial.sql', import.meta.url), 'utf8').split('INSERT OR IGNORE INTO publishers')[0]);
    applyBidderAccountSchema(f.sqlite);
    f.sqlite.prepare("INSERT INTO publishers(id,name,domain,gam_path) VALUES('first','First','first.invalid','/123/first/')").run();
    f.sqlite.prepare("INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES('cfg','first',?)").run(JSON.stringify({enablePrebid: false, runtimeControls: {sticky: {bottomAdUnitId: ''}, floors: {enabled: false}, output: {cleanComments: true}}}));
    f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,sort_order) VALUES('unit','first','Billboard','ATF','display',0)").run();
    f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('map','first','display',?)").run('[{"viewport":[0,0],"sizes":[[300,250]]}]');
    f.sqlite.prepare("INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES('rule','first','__DEFAULT__',?)").run('{"timeout":1500,"refresh":{"enabled":false}}');
    const objects = new Map();
    f.env.BUILDS = {async get(k) { const o = objects.get(k); return o ? {size: o.bytes.length, customMetadata: o.meta, arrayBuffer: async () => o.bytes.slice().buffer} : null; },
      async put(k, b, opt) { if (objects.has(k)) return null; objects.set(k, {bytes: new Uint8Array(b).slice(), meta: opt.customMetadata}); return {}; }};
    const settings = await siteRuntimeSettings(f.env, 'first');
    await changeSiteRuntime(f.env, 'first', 'tester', {action: 'version', revision: settings.revision, runtime: settings.runtimes[0].pin, allowPreview: true});
    const {release} = await generatePackage(f.env, 'first', 'tester', {revision: (await siteRuntimeSettings(f.env, 'first')).revision, notes: 'Saved on MAIN'});
    const p = await readPackage(f.env, 'first', release.id);
    assert.match(p.release.id, /^builtin-release-[a-f0-9]{64}$/);
    const bundle = await composeAbBundle({site: 'first', a: p, b: p, trafficBPercent: 0, testId: 'first_1', name: 'MAIN A/A'});
    assert.deepEqual(Object.keys(bundle.files), ['_headers', 'ads.js', armPath(p)]);
    assert.deepEqual(bundle.files[armPath(p)], p.files['ads.min.js']);
    assert.equal(bundle.record.arms.A.name, 'Saved on MAIN');
    const files = {...p.files, 'README.txt': bytesOf(text(p.files['README.txt']) + 'x')};
    await refused(composeAbBundle({site: 'first', a: p, b: {...p, files}, trafficBPercent: 0, testId: 'first_1', name: 'MAIN A/A'}), 'package-unverified', 'packages', /^Version B does not match/);
  } finally { f.sqlite.close(); }
});
