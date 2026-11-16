/** Generated scripts from the deployed TEST Worker bundle must equal a direct compile.
 *
 * Runs the sealed TEST Worker (.generated/test-workspace-active-dry-run/index.js,
 * the exact bytes test-deploy uploads with --no-bundle) in LOCAL Miniflare with
 * local D1/R2 and all outbound requests refused. For every runtime the site can
 * select, GAM-only and Prebid, without TakeOver and with an ad-position TakeOver at
 * intervals 0 and 5, it generates the package through the Worker routes, compiles
 * the same saved snapshot with the unbundled modules in Node at the same build
 * timestamp, and requires every package file to be byte-identical. The 3.9.1
 * Generate and Save path (/test-api/generate: without a saved selection, and with
 * 3.9.1 saved for GAM-only and Prebid; with and without the legacy TakeOver) and
 * one saved package per configuration are checked the same way, and so are the
 * other scripts the Worker serves from functions (/prebid-settings.js and
 * /geo/v1/client.js). For every Prebid configuration, each runtime with bid caching
 * (3.23.0) is also generated with bid caching saved through the TEST site's
 * Demand → Prebid route: on, on with a position Off, and off with a position On.
 * Each is checked as a site-runtime bundle and as a saved package, and its
 * config.json bidCache must equal the saved settings without the TakeOver position.
 *
 * The bundle runs behind scripts/canonical-text-guard.mjs: any
 * Function.prototype.toString call on a non-native function during these
 * requests (a function serialized without installed canonical text, in any form)
 * fails the check even when the output happens to match.
 *
 * Writes the generated programs for scripts/verify-generation-parity-browser.py.
 * Run after test-build: TESSERA_TEST_TOOLCHAIN=isolated node --experimental-strip-types
 *   --experimental-loader ./tests/support/ts-extension-loader.mjs scripts/verify-workerd-generation-parity.mjs
 */
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtemp, readFile, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {unzipSync} from 'fflate';
import {Miniflare} from './local-miniflare.mjs';
import {guardedModules, guardCalls, describeCalls} from './canonical-text-guard.mjs';
import {readPreviewSnapshot} from '../worker/runtime/builtin-preview-service.mjs';
import {runtimeCatalog, readPinnedSiteRuntime, buildArtifactCandidate} from '../worker/test-workspace/runtime-catalog.mjs';
import {takeOverForBuild} from '../worker/test-workspace/takeover-settings.mjs';
import {selectedWorkspaceRuntime} from '../worker/test-workspace/runtime-selection.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.argv[2] ?? '.generated/generation-parity');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const compiledPath = resolve(root, '.generated/test-workspace-active-dry-run/index.js');
const script = await readFile(compiledPath, 'utf8');
const seal = JSON.parse(await readFile(resolve(root, '.generated/toolchain-evidence/test-build.json'), 'utf8'));
assert.equal(sha(script), seal.compiled['.generated/test-workspace-active-dry-run'], 'Run test-build first: this is not the sealed TEST Worker.');
const config = JSON.parse(await readFile(resolve(root, 'ops/runtime-test/wrangler.active.jsonc'), 'utf8'));
const origin = config.vars.TEST_PUBLIC_ORIGIN;
const password = randomBytes(24).toString('hex');
const bindings = {...config.vars, TEST_ADMIN_EMAIL: 'tester@example.invalid', TEST_ADMIN_PASSWORD: password, TEST_SESSION_SECRET: randomBytes(48).toString('hex')};
// Synthetic Prebid file: the generated scripts only reference it; the browser check uses the repository mock.
const PREBID_FILE = '/* prebid.js v11.11.0\nModules: adfBidAdapter, adformBidAdapter, pubmaticBidAdapter, consentManagementTcf, tcfControl, currency, gptPreAuction, priceFloors, userId, sharedIdSystem, schain */\nwindow.fixtureOnly=true;';
const TAKEOVERS = {none: null, 'interval-0': 0, 'interval-5': 5};
// Only the reference runtime predates ad-position TakeOver and refuses it.
const reference = runtimeCatalog[1].version;
assert.match(reference, /^3\.9\.1/);

let outbound = 0, bidCaching = 0;
const entries = [], failures = [], served = [], guard = {};
await rm(output, {recursive: true, force: true});
await mkdir(output, {recursive: true});

async function start(name) {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-generation-parity-'));
  const mf = new Miniflare({name: 'generation-parity-' + name, modules: guardedModules(script), compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags ?? [], host: '127.0.0.1', port: 0, cf: false, bindings, resourcePersistencePath: directory,
    d1Databases: {DB: 'generation-parity-d1'}, r2Buckets: {BUILDS: 'generation-parity-r2'},
    outboundService: () => { outbound++; return new Response('External requests disabled', {status: 503}); }});
  await mf.ready;
  const session = {mf, directory, cookie: ''};
  session.call = (path, body) => mf.dispatchFetch(origin + path, {method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: {cookie: session.cookie, ...(body === undefined ? {} : {origin, 'content-type': 'application/json'})},
    body: body === undefined ? undefined : JSON.stringify(body)});
  session.json = async (path, body, status = 200) => {
    const response = await session.call(path, body), data = await response.json();
    if (response.status !== status) throw Object.assign(Error(`${path} ${response.status}: ${data.error ?? ''}`), {data});
    return data;
  };
  const login = await mf.dispatchFetch(origin + '/api/auth/login', {method: 'POST', redirect: 'manual', headers: {origin, 'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({email: bindings.TEST_ADMIN_EMAIL, password}).toString()});
  assert.equal(login.status, 303);
  session.cookie = login.headers.get('set-cookie').split(';')[0];
  await session.json('/test-api/setup', {confirm: 'prepare-empty-test-database'});
  const db = await mf.getD1Database('DB');
  // The same storage objects the Worker reads, for the direct compile.
  session.env = {DB: {withSession: () => db}, BUILDS: await mf.getR2Bucket('BUILDS')};
  return session;
}
async function addUnits(s) {
  const state = await s.json('/test-api/site-settings');
  state.draft.units.push({code: 'P1', type: 'BTF', sizeMap: 'display', enabled: true}, {code: 'P2', type: 'BTF', sizeMap: 'display', enabled: true},
    {code: 'Overlay', type: 'ATF', sizeMap: 'display', enabled: true});
  await s.json('/test-api/site-settings', {expectedRevision: state.revision, acknowledge: true, draft: state.draft});
}
async function setLegacyTakeOver(s, enabled) {
  const state = await s.json('/test-api/site-settings');
  state.draft.takeOver = {...state.draft.takeOver, enabled};
  await s.json('/test-api/site-settings', {expectedRevision: state.revision, acknowledge: true, draft: state.draft});
}
async function enablePrebid(s) {
  const response = await s.mf.dispatchFetch(origin + '/test-api/prebid/upload', {method: 'POST',
    headers: {cookie: s.cookie, origin, 'content-type': 'application/javascript', 'x-tessera-upload': 'prebid-test-file'}, body: PREBID_FILE});
  const upload = await response.json();
  assert.equal(response.status, 200, upload.error);
  const before = await s.json('/test-api/prebid-settings');
  await s.json('/test-api/prebid-settings', {expectedRevision: before.revision, acknowledge: true,
    draft: {...before.draft, enablePrebid: true, buildId: upload.file.id, bidders: [{bidder: 'adform', params: {mid: 123}, enabled: true}]}});
}
async function select(s, runtime, prebid) {
  const state = await s.json('/test-api/site-runtime');
  const body = {action: state.selected ? 'version' : 'setup', revision: state.revision, runtime: runtime.pin, allowPreview: true};
  if (!state.selected) body.enablePrebid = prebid;
  await s.json('/test-api/site-runtime', body);
}
async function addTakeOver(s, demand, frequencyMinutes) {
  const state = await s.json('/test-api/site-runtime');
  await s.json('/test-api/site-runtime', {action: 'position', revision: state.revision, position: {code: 'Overlay', display: 'takeover', lazy: null,
    overlay: {demand: demand === 'prebid' ? 'site' : 'gam', desktopMinWidth: 1024, desktopSeconds: 10, mobileSeconds: 5, countdown: true, frequencyMinutes}}});
}
const saved = s => readPreviewSnapshot(s.env.DB.withSession('first-primary'), 'test-site', {includePrebid: true});
// Bid caching through the TEST site's Demand → Prebid route (PUT), as the Bid caching view saves it.
const PREBID_MODE = '/api/publishers/test-site/prebid-mode';
async function saveBidCache(s, bidCache) {
  const mode = await s.json(PREBID_MODE);
  const response = await s.mf.dispatchFetch(origin + PREBID_MODE, {method: 'PUT', redirect: 'manual',
    headers: {cookie: s.cookie, origin, 'content-type': 'application/json'}, body: JSON.stringify({enabled: true, revision: mode.revision, bidCache})});
  const data = await response.json();
  if (response.status !== 200) throw Error(`${PREBID_MODE} ${response.status}: ${data.error ?? ''}`);
}
// Unbundled equivalent of siteRuntimeBundle and the saved-package route (worker/site-runtime/*).
async function directSiteRuntime(s, buildTimestamp) {
  const snapshot = await saved(s);
  const selected = await readPinnedSiteRuntime({siteId: 'test-site', snapshot, catalog: runtimeCatalog}, s.env.BUILDS);
  return (await buildArtifactCandidate({snapshot: selected.snapshot, pin: selected.pin, prebid: selected.prebid,
    takeOver: takeOverForBuild(snapshot), buildTimestamp, countryTarget: 'test'})).files;
}
// Unbundled equivalent of candidate() in worker/test-workspace/index.mjs (/test-api/generate and /test-api/save).
async function directGenerate(s, buildTimestamp, takeOverEnabled) {
  const settings = await saved(s);
  const resolved = await selectedWorkspaceRuntime(settings, s.env.BUILDS);
  const {prebidBuilds, ...configuration} = settings;
  return (await buildArtifactCandidate({snapshot: configuration, pin: resolved.pin, buildTimestamp, countryTarget: 'test',
    takeOver: takeOverForBuild(settings, takeOverEnabled), prebid: resolved.prebid})).files;
}
// Scripts the Worker builds from functions outside packages, against the unbundled modules.
async function servedScripts(s) {
  const {prebidScript} = await import('../worker/test-workspace/prebid-page.mjs');
  const {countryClientSource} = await import('../shared/geo-country.mjs');
  for (const [path, direct] of [['/prebid-settings.js', prebidScript], ['/geo/v1/client.js', countryClientSource(new URL(origin).origin + '/geo/v1/country')]]) {
    const response = await s.call(path), text = await response.text();
    const entry = {path, status: response.status, identical: response.status === 200 && text === direct, servedSha256: sha(text), directSha256: sha(direct)};
    served.push(entry);
    if (!entry.identical) failures.push(`${path}: the sealed Worker serves ${response.status} ${entry.servedSha256}, the unbundled module gives ${entry.directSha256}`);
    console.log(`${entry.identical ? 'identical' : 'DIFFERS  '} ${path}`);
  }
}
const zipFiles = async response => unzipSync(new Uint8Array(await response.arrayBuffer()));
const stampOf = files => JSON.parse(new TextDecoder().decode(files['manifest.json'])).buildTimestamp;

async function record(entry, bundled, direct) {
  const names = [...new Set([...Object.keys(bundled), ...Object.keys(direct)])].sort();
  const differing = names.filter(name => !bundled[name] || !direct[name] || !Buffer.from(bundled[name]).equals(Buffer.from(direct[name])));
  const manifest = JSON.parse(new TextDecoder().decode(bundled['manifest.json']));
  if (manifest.runtime.runtimeVersion !== entry.version) differing.push(`manifest.json (runtime ${manifest.runtime.runtimeVersion}, expected ${entry.version})`);
  entry.dir = `${entry.config}/${entry.path}/${entry.version}`;
  entry.files = {};
  await mkdir(join(output, entry.dir), {recursive: true});
  for (const name of ['ads.js', 'ads.min.js', 'implementation.html']) {
    assert(bundled[name], `${entry.dir}: ${name} missing from the package`);
    await writeFile(join(output, entry.dir, name), bundled[name]);
    entry.files[name] = sha(bundled[name]);
  }
  entry.identical = differing.length === 0;
  if (!entry.identical) {
    entry.differing = differing;
    failures.push(`${entry.dir}: bundled Worker output differs from the direct compile in ${differing.join(', ')}`);
  }
  entries.push(entry);
  console.log(`${entry.identical ? 'identical' : 'DIFFERS  '} ${entry.dir}${entry.identical ? '' : ' ' + differing.join(',')}`);
}
// The saved bid caching in the package: every eligible position with its effective setting, never the TakeOver.
function checkBidCache(entry, bundled, expected) {
  const decode = name => new TextDecoder().decode(bundled[name]);
  const actual = JSON.parse(decode('config.json')).bidCache;
  const problems = [];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`config.json bidCache ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (entry.takeover !== 'none' && actual && Object.hasOwn(actual.positions ?? {}, 'Overlay')) problems.push('config.json bidCache lists the TakeOver position');
  for (const name of ['ads.js', 'ads.min.js']) if (!decode(name).includes('createTesseraBidCache')) problems.push(`${name} has no bid cache helper`);
  if (problems.length) failures.push(`${entry.dir}: ${problems.join('; ')}`);
  entry.bidCache = {expected, matches: problems.length === 0};
}
async function bidCacheVariants(s, configName, takeover, runtime) {
  const eligible = (await s.json(PREBID_MODE)).bidCachePositions;
  if (takeover !== 'none' && eligible.includes('Overlay')) failures.push(`${configName}: the TakeOver position is offered for bid caching`);
  const [first] = eligible.filter(code => code !== 'Overlay');
  const variants = {'bidcache-on': {enabled: true, maxBidAgeSeconds: 45}, 'bidcache-position-off': {enabled: true, maxBidAgeSeconds: 30, positionOverrides: {[first]: false}},
    'bidcache-position-on': {enabled: false, maxBidAgeSeconds: 120, positionOverrides: {[first]: true}}};
  for (const [variant, bidCache] of Object.entries(variants)) {
    const expected = {defaultEnabled: bidCache.enabled, maxAgeSeconds: bidCache.maxBidAgeSeconds,
      positions: Object.fromEntries(eligible.map(code => [code, bidCache.positionOverrides?.[code] ?? bidCache.enabled]))};
    const config = `${configName}-${variant}`;
    for (const path of ['site-runtime', 'saved-package']) {
      const entry = {config, demand: 'prebid', takeover, path, version: runtime.version};
      try {
        await saveBidCache(s, bidCache);
        const state = await s.json('/test-api/site-runtime');
        let response;
        if (path === 'site-runtime') response = await s.call('/test-api/site-runtime', {action: 'bundle', revision: state.revision, acknowledge: true});
        else {
          const generated = await s.json('/test-api/site-packages', {action: 'generate', notes: 'Generation parity ' + config, revision: state.revision}, 201);
          response = await s.call('/test-api/site-packages', {action: 'download', releaseId: generated.release.id});
        }
        if (response.status !== 200) throw Error(`Generate ${response.status}: ${(await response.json()).error}`);
        const bundled = await zipFiles(response);
        await record(entry, bundled, await directSiteRuntime(s, stampOf(bundled)));
        checkBidCache(entry, bundled, expected);
      } catch (error) { refused(entry, error); }
    }
  }
  // Off again, so the older runtimes after this one in the catalog still generate.
  await saveBidCache(s, {enabled: false, maxBidAgeSeconds: 60});
}
function refused(entry, error) {
  entry.error = String(error.message).slice(0, 300);
  failures.push(`${entry.config}/${entry.path}/${entry.version}: ${entry.error}`);
  console.log(`FAILED    ${entry.config}/${entry.path}/${entry.version}: ${entry.error}`);
}

// /test-api/generate, /test-api/save and download: the default (legacy) Generate path.
async function generatePath(s, entry, takeOverEnabled) {
  try {
    const generated = await s.json('/test-api/generate', {acknowledge: true, takeOverEnabled});
    assert.equal(generated.descriptor.runtime.runtimeVersion, entry.version);
    const stored = await s.json('/test-api/save', {receipt: generated.receipt, acknowledge: true, note: 'Generation parity ' + entry.config});
    const bundled = await zipFiles(await s.call(`/test-api/releases/${stored.draft.id}/download`));
    assert.equal(new TextDecoder().decode(bundled['ads.js']), generated.adsJs, 'Save regenerated a different ads.js than Generate');
    await record(entry, bundled, await directGenerate(s, stampOf(bundled), takeOverEnabled));
  } catch (error) { refused(entry, error); }
}

for (const demand of ['gam', 'prebid']) for (const [takeover, frequency] of Object.entries(TAKEOVERS)) {
  const configName = `${demand}-${takeover}`;
  const s = await start(configName);
  try {
    if (!served.length) await servedScripts(s);
    const legacy = takeover === 'none' ? [false, true] : [];
    // No saved runtime selection yet: the seeded GAM-only site uses the default runtime.
    if (demand === 'gam') for (const takeOverEnabled of legacy) {
      await generatePath(s, {config: `gam-${takeOverEnabled ? 'legacy-takeover' : 'none'}`, demand, takeover: takeOverEnabled ? 'legacy' : 'none',
        path: 'default-generate', version: reference}, takeOverEnabled);
    }
    // Editing the site requires a saved selection; start from 3.9.1 (it predates ad positions).
    await select(s, (await s.json('/test-api/site-runtime')).runtimes.find(r => r.version === reference), false);
    await addUnits(s);
    if (demand === 'prebid') await enablePrebid(s);
    // The same Generate path with 3.9.1 explicitly saved, GAM-only and Prebid. Once
    // site settings are saved, the legacy TakeOver follows the saved setting.
    for (const takeOverEnabled of legacy) {
      if (takeOverEnabled) await setLegacyTakeOver(s, true);
      await generatePath(s, {config: `${demand}-${takeOverEnabled ? 'legacy-takeover' : 'none'}`, demand, takeover: takeOverEnabled ? 'legacy' : 'none',
        path: 'generate', version: reference}, takeOverEnabled);
      if (takeOverEnabled) await setLegacyTakeOver(s, false);
    }
    const runtimes = (await s.json('/test-api/site-runtime')).runtimes;
    assert.deepEqual(runtimes.map(r => r.version), runtimeCatalog.map(r => r.version), 'The Worker offers a different runtime catalog');
    let positioned = false, latest = null;
    for (const runtime of runtimes) {
      const entry = {config: configName, demand, takeover, path: 'site-runtime', version: runtime.version};
      try {
        try { await select(s, runtime, demand === 'prebid'); }
        catch (error) {
          if (takeover !== 'none' && runtime.version === reference) { console.log(`refused   ${configName}/${runtime.version} (no ad-position TakeOver before 3.10.0)`); continue; }
          throw error;
        }
        if (frequency !== null && !positioned) { await addTakeOver(s, demand, frequency); positioned = true; }
        const state = await s.json('/test-api/site-runtime');
        assert.equal(JSON.stringify(state.selected), JSON.stringify(runtime.pin));
        assert.equal(state.positions.some(p => p.display === 'takeover'), frequency !== null, 'TakeOver position state differs from the configuration');
        const response = await s.call('/test-api/site-runtime', {action: 'bundle', revision: state.revision, acknowledge: true});
        if (response.status !== 200) throw Error(`Generate ${response.status}: ${(await response.json()).error}`);
        const bundled = await zipFiles(response);
        await record(entry, bundled, await directSiteRuntime(s, stampOf(bundled)));
        latest = runtime;
      } catch (error) { refused(entry, error); }
      if (demand === 'prebid' && runtimeCatalog.find(r => r.version === runtime.version).capabilities.includes('bid-cache')) {
        bidCaching++;
        try { await bidCacheVariants(s, configName, takeover, runtime); }
        catch (error) { refused({config: `${configName}-bidcache`, path: 'site-runtime', version: runtime.version}, error); }
      }
    }
    if (frequency !== null) assert(positioned, `${configName}: no runtime accepted the TakeOver position`);
    // A saved package (site-packages generate and download) of the last catalog runtime that generated.
    if (latest) {
      const entry = {config: configName, demand, takeover, path: 'saved-package', version: latest.version};
      try {
        await select(s, latest, demand === 'prebid');
        const state = await s.json('/test-api/site-runtime');
        const generated = await s.json('/test-api/site-packages', {action: 'generate', notes: 'Generation parity', revision: state.revision}, 201);
        const response = await s.call('/test-api/site-packages', {action: 'download', releaseId: generated.release.id});
        assert.equal(response.status, 200);
        const bundled = await zipFiles(response);
        await record(entry, bundled, await directSiteRuntime(s, stampOf(bundled)));
      } catch (error) { refused(entry, error); }
    }
    // Every serialization in this Worker instance, from startup to the last package.
    const calls = await guardCalls(s.mf, origin);
    guard[configName] = describeCalls(calls);
    if (calls.length) failures.push(`${configName}: Function.prototype.toString ran on ${calls.length} non-native functions in the sealed Worker: ${guard[configName].join('; ')}`);
    console.log(`${calls.length ? 'GUARD    ' : 'guard ok '} ${configName}${calls.length ? ': ' + guard[configName].join('; ') : ''}`);
  } finally {
    await s.mf.dispose();
    await rm(s.directory, {recursive: true, force: true});
  }
}
// The account path is a saved package from the sealed TEST Worker, including
// capped TakeOver plus independent site/custom/omitted upstream chains.
{
  const s = await start('prebid-accounts');
  const entry = {config:'prebid-accounts',demand:'prebid',takeover:'interval-5',path:'saved-package',version:'3.22.1',accountCase:true};
  try {
    const runtime=(await s.json('/test-api/site-runtime')).runtimes.find(r=>r.version===entry.version);
    assert(runtime, 'The account runtime must be selectable explicitly');
    await select(s,runtime,false);
    await addUnits(s);
    await enablePrebid(s);
    const state=await s.json('/test-api/prebid-settings');
    const bidders=[
      {bidder:'pubmatic',params:{publisherId:'999990',adSlot:'fixture'},enabled:true},
      ...[
        ['adf_smn',999991,{mode:'inherit'}],
        ['adf_ag',999992,{mode:'none'}],
        ['adf_other',999993,{mode:'custom',config:{ver:'1.0',complete:1,nodes:[{asi:'other.example',sid:'other',hp:1}]}}]
      ].map(([bidder,mid,schain])=>({bidder,baseAdapter:'adf',params:{mid},schain,enabled:true}))
    ];
    await s.json('/test-api/prebid-settings',{expectedRevision:state.revision,acknowledge:true,draft:{...state.draft,bidders}});
    const db=await s.mf.getD1Database('DB');
    const row=await db.prepare("SELECT config_json FROM publisher_configs WHERE publisher_id='test-site'").first();
    const savedConfig=JSON.parse(row.config_json);
    savedConfig.runtimeControls??={};
    savedConfig.runtimeControls.schain={enabled:true,version:'1.0',complete:1,nodes:[{asi:'seller.example',sid:'site',hp:1}]};
    await db.prepare("UPDATE publisher_configs SET config_json=? WHERE publisher_id='test-site'").bind(JSON.stringify(savedConfig)).run();
    await addTakeOver(s,'prebid',5);
    const selected=await s.json('/test-api/site-runtime');
    const generated=await s.json('/test-api/site-packages',{action:'generate',notes:'Account generation parity',revision:selected.revision},201);
    const response=await s.call('/test-api/site-packages',{action:'download',releaseId:generated.release.id});
    assert.equal(response.status,200);
    const bundled=await zipFiles(response);
    await record(entry,bundled,await directSiteRuntime(s,stampOf(bundled)));
    const calls=await guardCalls(s.mf,origin);
    guard['prebid-accounts']=describeCalls(calls);
    if(calls.length)failures.push('prebid-accounts: non-canonical serialization: '+guard['prebid-accounts'].join('; '));
  } catch(error) {refused(entry,error);}
  finally {await s.mf.dispose();await rm(s.directory,{recursive:true,force:true});}
}
const report = {scope: 'LOCAL Miniflare/workerd with local D1/R2; sealed TEST Worker bundle vs unbundled Node compile; NOT hosted',
  compiledSha256: sha(script), outbound, runtimes: runtimeCatalog.map(r => r.version), served, guard, entries, failures, passed: failures.length === 0 && outbound === 0};
await writeFile(join(output, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({entries: entries.length, identical: entries.filter(e => e.identical).length, bidCache: entries.filter(e => e.bidCache?.matches).length, served: served.filter(e => e.identical).length,
  guardCalls: Object.values(guard).flat().length, failures: failures.length, outbound}));
assert.equal(outbound, 0, 'The Worker attempted an outbound request');
// Every Prebid configuration generated bid caching with each runtime that has it.
assert.equal(bidCaching, Object.keys(TAKEOVERS).length * runtimeCatalog.filter(r => r.capabilities.includes('bid-cache')).length, 'No runtime with bid caching was generated with bid caching on');
assert.deepEqual(failures, [], `${failures.length} checks failed: output differs from the direct compile, a function was serialized without canonical text, or generation failed`);
