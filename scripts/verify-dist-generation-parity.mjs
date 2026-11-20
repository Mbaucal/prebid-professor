import {applyBidderAccountD1Schema} from '../tests/support/bidder-account-schema.mjs';
/** Generated scripts from the compiled production Worker must equal a direct compile.
 *
 * Runs dist/prebid_professor/index.js (the module `npm run deploy` uploads with
 * no_bundle, built by scripts/isolated-toolchain.mjs build) in LOCAL Miniflare
 * with dist/client assets, local D1/R2 and all outbound requests refused. For
 * every runtime the site can select, GAM-only and Prebid, without TakeOver and
 * with an ad-position TakeOver at intervals 0 and 5, it saves a package with
 * Generate (builtin-releases), compiles the same saved snapshot with the
 * unbundled modules in Node at the same build timestamp, and requires ads.js,
 * ads.min.js and every other compiler file to be byte-identical (README.txt,
 * config.json, implementation.html and manifest.json are rewritten for saved
 * packages). A Generate error is a failure. Also checked the same way: the 3.9.1
 * default candidate (builtin-runtime-bundle, no saved selection; with and without
 * the legacy TakeOver), a 3.9.1 package with the saved legacy TakeOver, and one
 * review candidate (builtin-site-settings bundle) per configuration. The country
 * script the Worker builds from functions (/geo/v1/client.js) must equal the
 * unbundled route's response byte for byte.
 *
 * The Worker runs behind scripts/canonical-text-guard.mjs, with every module Vite
 * emitted for it: any Function.prototype.toString call on a non-native function
 * (a function serialized without installed canonical text, in any form) fails
 * the check even when the output happens to match.
 *
 * Site inventory (units, size map, rules, bidder, Prebid file) is seeded into
 * local D1/R2 as the other compiled-Worker checks do; selection, TakeOver,
 * Generate and downloads go through the Worker routes.
 *
 * Writes the generated programs for scripts/verify-generation-parity-browser.py.
 * Run after scripts/isolated-toolchain.mjs build: TESSERA_TEST_TOOLCHAIN=isolated node
 *   --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs scripts/verify-dist-generation-parity.mjs
 */
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtemp, readFile, readdir, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {unzipSync} from 'fflate';
import {Miniflare} from './local-miniflare.mjs';
import {guardedModules, guardCalls, describeCalls} from './canonical-text-guard.mjs';
import {countryResponse} from '../worker/geo-country.mjs';
import {readPreviewSnapshot, runtimeDescriptor} from '../worker/runtime/builtin-preview-service.mjs';
import {previewInput} from '../worker/runtime/preview-snapshot.mjs';
import {pinRuntime} from '../worker/runtime/version-pin.mjs';
import {prebidRequirements, inspectPrebidArtifact} from '../worker/runtime/prebid-artifact-check-v2.mjs';
import {buildArtifactCandidate as buildDefaultCandidate} from '../worker/runtime/artifact-candidate.mjs';
import {runtimeCatalog, readPinnedSiteRuntime, buildArtifactCandidate} from '../worker/test-workspace/runtime-catalog.mjs';
import {takeOverForBuild, defaultTakeOver} from '../worker/test-workspace/takeover-settings.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.argv[2] ?? '.generated/generation-parity');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const dist = resolve(root, 'dist/prebid_professor');
const script = await readFile(join(dist, 'index.js'), 'utf8');
const config = JSON.parse(await readFile(join(dist, 'wrangler.json'), 'utf8'));
assert.equal(config.no_bundle, true, 'Run scripts/isolated-toolchain.mjs build first: dist is not the deployed no_bundle Worker.');
assert.equal(config.main, 'index.js');
// Any other module Vite emitted (a chunk) is uploaded beside index.js at its own path.
const chunks = (await readdir(dist, {recursive: true})).filter(path => /\.m?js$/.test(path) && path !== 'index.js' && !path.startsWith('.vite')).sort();
const chunkModules = await Promise.all(chunks.map(async path => ({type: 'ESModule', path, contents: await readFile(join(dist, path), 'utf8')})));
const origin = 'https://generation-parity.example.invalid', email = 'parity@example.invalid', password = randomBytes(24).toString('hex');
// Synthetic Prebid file: the generated scripts only reference it; the browser check uses the repository mock.
const MODULES = ['adpod', 'adfBidAdapter', 'appnexusBidAdapter', 'consentManagementGpp', 'consentManagementTcf', 'consentManagementUsp', 'currency', 'dfpAdServerVideo',
  'gppControl_usnat', 'gppControl_usstates', 'gptPreAuction', 'id5IdSystem', 'criteoIdSystem', 'pubProvidedIdSystem', 'priceFloors', 'pubmaticBidAdapter',
  'rtdModule', 'schain', 'sharedIdSystem', 'tcfControl', 'userId', 'videoModule'].sort();
const PREBID_FILE = new TextEncoder().encode(`/* prebid.js v11.34.0\nModules: ${MODULES.join(', ')} */\nwindow.fixtureOnly=true;`);
const TAKEOVERS = {none: null, 'interval-0': 0, 'interval-5': 5};
const UNITS = [['Billboard', 'ATF', 'display'], ['P1', 'BTF', 'display'], ['P2', 'BTF', 'display'], ['Overlay', 'ATF', 'modal']];
// A TakeOver unit's map has one size per width.
const MAPS = {display: [{viewport: [0, 0], sizes: [[300, 250]]}, {viewport: [768, 0], sizes: [[728, 90], [300, 250]]}],
  modal: [{viewport: [0, 0], sizes: [[300, 250]]}, {viewport: [768, 0], sizes: [[640, 480]]}, {viewport: [1200, 0], sizes: [[800, 600]]}]};
// Only the reference runtime predates ad-position TakeOver and refuses it.
const reference = runtimeCatalog[1].version;
assert.match(reference, /^3\.9\.1/);
assert.equal(runtimeDescriptor.version, reference);
// Saved packages rewrite these for staging; the compiler's files are kept as generated.
const REWRITTEN = new Set(['README.txt', 'config.json', 'implementation.html', 'manifest.json']);

let outbound = 0;
const entries = [], failures = [], served = [], guard = {};
await rm(output, {recursive: true, force: true});
await mkdir(output, {recursive: true});
const directory = await mkdtemp(join(tmpdir(), 'tessera-dist-generation-parity-'));
const mf = new Miniflare({modules: [...guardedModules(script), ...chunkModules], compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags, cf: false,
  host: '127.0.0.1', port: 0, resourcePersistencePath: directory, d1Databases: {DB: 'generation-parity-d1'}, r2Buckets: {BUILDS: 'generation-parity-r2'},
  bindings: {ADMIN_EMAIL: email, ADMIN_PASSWORD: password, SESSION_SECRET: randomBytes(48).toString('hex')},
  assets: {directory: resolve(root, 'dist/client'), binding: 'ASSETS', routerConfig: {has_user_worker: true, invoke_user_worker_ahead_of_assets: true},
    assetConfig: {not_found_handling: 'single-page-application'}},
  outboundService: () => { outbound++; return new Response('External requests disabled', {status: 503}); }});

const zipFiles = async response => unzipSync(new Uint8Array(await response.arrayBuffer()));
const manifestOf = files => JSON.parse(new TextDecoder().decode(files['manifest.json']));

async function record(entry, bundled, direct, skip = new Set()) {
  const names = [...new Set([...Object.keys(bundled), ...Object.keys(direct)])].filter(name => !skip.has(name)).sort();
  const differing = names.filter(name => !bundled[name] || !direct[name] || !Buffer.from(bundled[name]).equals(Buffer.from(direct[name])));
  for (const name of ['ads.js', 'ads.min.js']) if (!names.includes(name)) differing.push(`${name} (missing)`);
  const manifest = manifestOf(bundled);
  if (manifest.runtime.runtimeVersion !== entry.version) differing.push(`manifest.json (runtime ${manifest.runtime.runtimeVersion}, expected ${entry.version})`);
  entry.dir = `${entry.config}/${entry.path}/${entry.version}`;
  entry.files = {};
  await mkdir(join(output, entry.dir), {recursive: true});
  for (const name of ['ads.js', 'ads.min.js', 'implementation.html']) {
    assert(bundled[name], `${entry.dir}: ${name} missing from the package`);
    await writeFile(join(output, entry.dir, name), bundled[name]);
    entry.files[name] = sha(bundled[name]);
  }
  entry.compared = names;
  entry.identical = differing.length === 0;
  if (!entry.identical) {
    entry.differing = differing;
    failures.push(`${entry.dir}: bundled Worker output differs from the direct compile in ${differing.join(', ')}`);
  }
  entries.push(entry);
  console.log(`${entry.identical ? 'identical' : 'DIFFERS  '} ${entry.dir}${entry.identical ? '' : ' ' + differing.join(',')}`);
}
function failed(entry, error) {
  entry.error = String(error.message).slice(0, 300);
  failures.push(`${entry.config}/${entry.path}/${entry.version}: ${entry.error}`);
  console.log(`FAILED    ${entry.config}/${entry.path}/${entry.version}: ${entry.error}`);
}

try {
  const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('BUILDS');
  // Schema DDL only, as the other compiled-Worker checks apply it; no publisher seed content.
  for (const [file, stop] of [['0001_initial.sql', 'INSERT OR IGNORE INTO publishers'], ['0002_publisher_accounts.sql', '-- Politika.rs']]) {
    for (const statement of (await readFile(resolve(root, 'migrations', file), 'utf8')).split(stop)[0].split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
 await applyBidderAccountD1Schema(db);
  const login = await mf.dispatchFetch(origin + '/api/auth/login', {method: 'POST', redirect: 'manual', headers: {origin, 'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({email, password}).toString()});
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (path, body) => mf.dispatchFetch(origin + path, {method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: {cookie, ...(body === undefined ? {} : {origin, 'content-type': 'application/json'})}, body: body === undefined ? undefined : JSON.stringify(body)});
  const json = async (path, body, status = 200) => {
    const response = await call(path, body), data = await response.json();
    if (response.status !== status) throw Error(`${path} ${response.status}: ${data.error ?? ''}`);
    return data;
  };
  const readConfig = async site => JSON.parse((await db.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id=?').bind(site).first()).config_json);
  const writeConfig = (site, value) => db.prepare('UPDATE publisher_configs SET config_json=? WHERE publisher_id=?').bind(JSON.stringify(value), site).run();

  async function createSite(site, demand, frequency) {
    assert.equal((await call('/api/sites', {id: site, name: 'Generation parity ' + site, domain: site + '.example.invalid', gamPath: '/123/parity/'})).status, 201);
    for (const [name, rows] of Object.entries(MAPS)) await db.prepare('INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES(?,?,?,?)').bind(`${site}-${name}`, site, name, JSON.stringify(rows)).run();
    for (const [index, [code, type, map]] of UNITS.entries()) await db.prepare("INSERT INTO ad_units(id,publisher_id,code,type,media_type,size_map_key,enabled,sort_order) VALUES(?,?,?,?,'banner',?,1,?)").bind(`${site}-${code}`, site, code, type, map, index).run();
    for (const key of ['__ATF__', '__BTF__']) await db.prepare('INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES(?,?,?,?)').bind(`${site}-${key}`, site, key, JSON.stringify({timeout: 300})).run();
    const value = await readConfig(site);
    value.runtimeControls = {...value.runtimeControls, sticky: {bottomAdUnitId: ''}};
    if (demand === 'gam') value.enablePrebid = false;
    else {
      await db.prepare('INSERT INTO bidders(id,publisher_id,bidder,params_json,enabled) VALUES(?,?,?,?,1)').bind(site + '-pubmatic', site, 'pubmatic', JSON.stringify({publisherId: 'parity-publisher', adSlot: 'default'})).run();
      if (frequency !== null) await db.prepare("INSERT INTO bidder_overrides(id,publisher_id,bidder,scope_type,scope_key,params_json,enabled) VALUES(?,?,'pubmatic','adunit','Overlay',?,1)").bind(site + '-overlay', site, JSON.stringify({adSlot: 'overlay-slot'})).run();
      const id = site + '-prebid', key = `publishers/${site}/prebid-builds/${id}/prebid.js`;
      await bucket.put(key, PREBID_FILE, {customMetadata: {sha256: sha(PREBID_FILE), version: '11.34.0'}});
      await db.prepare("INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES(?,?,'11.34.0',?,?,'current')").bind(id, site, key, JSON.stringify(MODULES)).run();
    }
    await writeConfig(site, value);
  }
  async function setLegacyTakeOver(site, enabled) {
    const value = await readConfig(site);
    value.runtimeControls = {...value.runtimeControls, takeOver: {...defaultTakeOver(), enabled}};
    await writeConfig(site, value);
  }
  const settingsPath = site => `/api/publishers/${site}/builtin-site-settings`;
  async function select(site, runtime, prebid) {
    const state = await json(settingsPath(site));
    const body = {action: state.selected ? 'version' : 'setup', revision: state.revision, runtime: runtime.pin, allowPreview: true};
    if (!state.selected) body.enablePrebid = prebid;
    await json(settingsPath(site), body);
  }
  async function addTakeOver(site, demand, frequencyMinutes) {
    const state = await json(settingsPath(site));
    await json(settingsPath(site), {action: 'position', revision: state.revision, position: {code: 'Overlay', display: 'takeover', lazy: null,
      overlay: {demand: demand === 'prebid' ? 'site' : 'gam', desktopMinWidth: 1024, desktopSeconds: 10, mobileSeconds: 5, countdown: true, frequencyMinutes}}});
  }
  const saved = site => readPreviewSnapshot(db, site, {includePrebid: true});
  // Unbundled equivalent of build() in worker/site-runtime/releases.mjs and siteRuntimeBundle in service.mjs.
  async function directSiteRuntime(site, buildTimestamp) {
    const snapshot = await saved(site);
    const selected = await readPinnedSiteRuntime({siteId: site, snapshot, catalog: runtimeCatalog}, bucket);
    return (await buildArtifactCandidate({snapshot: selected.snapshot, pin: selected.pin, prebid: selected.prebid,
      takeOver: takeOverForBuild(snapshot), buildTimestamp, countryTarget: 'main'})).files;
  }
  // Unbundled equivalent of handleArtifactBundle in worker/runtime/artifact-bundle-service.mjs.
  async function directDefault(site, buildTimestamp, takeOver) {
    const {prebidBuilds, ...snapshot} = await saved(site);
    const requirements = prebidRequirements(previewInput(snapshot, runtimeDescriptor, buildTimestamp, takeOver), JSON.parse(snapshot.config.config_json));
    let prebid = null;
    if (requirements.required) {
      let bytes = null;
      const readOnly = {async get(key) { const object = await bucket.get(key); return object && {size: object.size, customMetadata: object.customMetadata,
        async arrayBuffer() { bytes = await object.arrayBuffer(); return bytes; }}; }};
      const report = await inspectPrebidArtifact({siteId: site, builds: prebidBuilds, requirements}, readOnly);
      assert.equal(report.status, 'checked', 'Direct compile: the synthetic Prebid file did not verify');
      prebid = {report, bytes};
    }
    return (await buildDefaultCandidate({snapshot, pin: pinRuntime(runtimeDescriptor, {allowPreview: true}), takeOver, buildTimestamp, prebid})).files;
  }

  // Generate (SitePackagesPanel): save a package, then read its files as the dashboard does.
  async function savedPackage(site, entry) {
    try {
      const state = await json(`/api/publishers/${site}/builtin-releases`);
      if (!state.ready) throw Error(`Generate is not ready: ${state.error}`);
      const generated = await json(`/api/publishers/${site}/builtin-releases`, {action: 'generate', notes: 'Generation parity', revision: state.revision}, 201);
      const bundled = {};
      for (const name of ['manifest.json', 'ads.js', 'ads.min.js', 'implementation.html']) {
        const response = await call(`/api/publishers/${site}/builtin-releases/${generated.release.id}/files/${name}`);
        assert.equal(response.status, 200, `${name} download ${response.status}`);
        bundled[name] = new Uint8Array(await response.arrayBuffer());
      }
      for (const name of Object.keys(manifestOf(bundled).files)) if (!bundled[name] && !REWRITTEN.has(name)) {
        const response = await call(`/api/publishers/${site}/builtin-releases/${generated.release.id}/files/${name}`);
        assert.equal(response.status, 200, `${name} download ${response.status}`);
        bundled[name] = new Uint8Array(await response.arrayBuffer());
      }
      await record(entry, bundled, await directSiteRuntime(site, manifestOf(bundled).buildTimestamp), REWRITTEN);
    } catch (error) { failed(entry, error); }
  }

  // Scripts the Worker builds from functions outside packages, against the unbundled route.
  for (const path of ['/geo/v1/client.js']) {
    const response = await mf.dispatchFetch(origin + path), text = await response.text();
    const unbundled = countryResponse(new Request(origin + path)), direct = await unbundled.text();
    const entry = {path, file: 'served/' + path.slice(1).replaceAll('/', '-'), endpoint: origin + '/geo/v1/country', status: response.status,
      contentType: response.headers.get('content-type'), servedSha256: sha(text), directSha256: sha(direct)};
    entry.identical = response.status === 200 && unbundled.status === 200 && entry.contentType === unbundled.headers.get('content-type') && text === direct;
    await mkdir(join(output, 'served'), {recursive: true});
    await writeFile(join(output, entry.file), text);
    served.push(entry);
    if (!entry.identical) failures.push(`${path}: the compiled Worker serves ${response.status} ${entry.servedSha256}, the unbundled route gives ${unbundled.status} ${entry.directSha256}`);
    console.log(`${entry.identical ? 'identical' : 'DIFFERS  '} ${path}`);
  }

  for (const demand of ['gam', 'prebid']) for (const [takeover, frequency] of Object.entries(TAKEOVERS)) {
    const configName = `${demand}-${takeover}`, site = `parity-${configName}`;
    await createSite(site, demand, frequency);
    // No saved selection: the 3.9.1 default candidate, with and without the legacy TakeOver.
    if (takeover === 'none') for (const enabled of [false, true]) {
      const entry = {config: `${demand}-${enabled ? 'legacy-takeover' : 'none'}`, demand, takeover: enabled ? 'legacy' : 'none', path: 'default-bundle', version: reference};
      try {
        const preview = await json(`/api/publishers/${site}/builtin-runtime-preview`);
        assert.equal(preview.runtime.version, reference);
        const takeOver = {...preview.takeOver, enabled};
        const response = await call(`/api/publishers/${site}/builtin-runtime-bundle`, {reviewHash: preview.reviewHash, runtimeVersion: preview.runtime.version,
          runtimeSha256: preview.runtime.codeSha256, allowPreview: true, takeOver});
        if (response.status !== 200) throw Error(`Candidate ${response.status}: ${(await response.json()).error}`);
        const bundled = await zipFiles(response);
        await record(entry, bundled, await directDefault(site, manifestOf(bundled).buildTimestamp, takeOver));
      } catch (error) { failed(entry, error); }
    }
    const runtimes = (await json(settingsPath(site))).runtimes;
    assert.deepEqual(runtimes.map(r => r.version), runtimeCatalog.map(r => r.version), 'The Worker offers a different runtime catalog');
    // The first saved selection (setup) starts from 3.9.1, as in the dashboard.
    await select(site, runtimes.find(r => r.version === reference), demand === 'prebid');
    // 3.9.1 saved with the legacy TakeOver (it predates ad positions).
    if (takeover === 'none') {
      await setLegacyTakeOver(site, true);
      await savedPackage(site, {config: `${demand}-legacy-takeover`, demand, takeover: 'legacy', path: 'saved-package', version: reference});
      await setLegacyTakeOver(site, false);
    }
    let positioned = false, latest = null;
    for (const runtime of runtimes) {
      const entry = {config: configName, demand, takeover, path: 'saved-package', version: runtime.version};
      try {
        try { await select(site, runtime, demand === 'prebid'); }
        catch (error) {
          if (frequency !== null && runtime.version === reference) { console.log(`refused   ${configName}/${runtime.version} (no ad-position TakeOver before 3.10.0)`); continue; }
          throw error;
        }
        if (frequency !== null && !positioned) { await addTakeOver(site, demand, frequency); positioned = true; }
        const state = await json(settingsPath(site));
        assert.equal(JSON.stringify(state.selected), JSON.stringify(runtime.pin));
        assert.equal(state.positions.some(p => p.display === 'takeover'), frequency !== null, 'TakeOver position state differs from the configuration');
      } catch (error) { failed(entry, error); continue; }
      await savedPackage(site, entry);
      if (entry.dir) latest = runtime;
    }
    if (frequency !== null) assert(positioned, `${configName}: no runtime accepted the TakeOver position`);
    // A review candidate (builtin-site-settings bundle) of the last runtime that saved a package.
    if (latest) {
      const entry = {config: configName, demand, takeover, path: 'candidate-bundle', version: latest.version};
      try {
        await select(site, latest, demand === 'prebid');
        const state = await json(settingsPath(site));
        const response = await call(settingsPath(site), {action: 'bundle', revision: state.revision, acknowledge: true});
        if (response.status !== 200) throw Error(`Candidate ${response.status}: ${(await response.json()).error}`);
        const bundled = await zipFiles(response);
        await record(entry, bundled, await directSiteRuntime(site, manifestOf(bundled).buildTimestamp));
      } catch (error) { failed(entry, error); }
    }
    // Every serialization in the Worker since the last report (startup included in the first).
    const calls = await guardCalls(mf, origin);
    guard[configName] = describeCalls(calls);
    if (calls.length) failures.push(`${configName}: Function.prototype.toString ran on ${calls.length} non-native functions in the compiled Worker: ${guard[configName].join('; ')}`);
    console.log(`${calls.length ? 'GUARD    ' : 'guard ok '} ${configName}${calls.length ? ': ' + guard[configName].join('; ') : ''}`);
  }
  // Exercise account compilation through the actual bundled save/download path,
  // with TakeOver timing as well as inherited, custom and omitted upstream chains.
  for (const version of ['3.22.1','3.22.2','3.24.0','3.25.0','3.25.1','3.26.0']) {
    const site='parity-accounts-'+version.replaceAll('.','-');
    await createSite(site,'prebid',5);
    for (const [bidder,mid,schain] of [
      ['adf_smn',999991,{mode:'inherit'}], ['adf_ag',999992,{mode:'none'}],
      ['adf_other',999993,{mode:'custom',config:{ver:'1.0',complete:1,nodes:[{asi:'other.example',sid:'other',hp:1}]}}],
    ]) await json(`/api/publishers/${site}/bidders`,{bidder,baseAdapter:'adf',params:{mid},schain},201);
    const config=await readConfig(site);
    config.runtimeControls.schain={enabled:true,version:'1.0',complete:1,nodes:[{asi:'seller.example',sid:'site',hp:1}]};
    if (version === '3.24.0' || version === '3.25.0' || version === '3.25.1' || version === '3.26.0') {
      config.prebidBidCache={enabled:true,maxBidAgeSeconds:45};
      config.runtimeControls.bidderRules={schemaVersion:1,enabled:true,rules:[{
        id:'account-scope',name:'Agency account eligibility',enabled:true,bidder:'adf_ag',positions:['P1'],
        countries:{mode:'exclude',values:['DE'],unknown:'allow'},devices:['desktop','mobile'],
      }]};
    }
    await writeConfig(site,config);
    const runtime=(await json(settingsPath(site))).runtimes.find(row=>row.version===version);
    assert(runtime,'The reviewed account runtime must be selectable explicitly');
    await select(site,runtime,true);
    await addTakeOver(site,'prebid',5);
    if(version==='3.26.0'){
      const state=await json(settingsPath(site));
      await json(settingsPath(site),{action:'auction-timeout',revision:state.revision,policy:{enabled:true,minMs:800,maxMs:4000}});
      assert.equal((await json(settingsPath(site))).adaptiveTimeout.policy.enabled,true,'Compiled MAIN service must persist the explicit adaptive policy');
    }
    await savedPackage(site,{config:'prebid-accounts-'+version,demand:'prebid',takeover:'interval-5',path:'saved-package',version,accountCase:true});
    const calls=await guardCalls(mf,origin);
    guard['prebid-accounts-'+version]=describeCalls(calls);
    if(calls.length)failures.push('prebid-accounts: non-canonical function serialization: '+guard['prebid-accounts-'+version].join('; '));
  }
} finally {
  await mf.dispose();
  await rm(directory, {recursive: true, force: true});
}
const report = {scope: 'LOCAL Miniflare/workerd with local D1/R2; compiled production Worker (dist) vs unbundled Node compile; NOT hosted',
  compiledSha256: sha(script), chunks: Object.fromEntries(chunkModules.map(chunk => [chunk.path, sha(chunk.contents)])), outbound,
  runtimes: runtimeCatalog.map(r => r.version), served, guard, entries, failures, passed: failures.length === 0 && outbound === 0};
await writeFile(join(output, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({entries: entries.length, identical: entries.filter(e => e.identical).length, served: served.filter(e => e.identical).length,
  guardCalls: Object.values(guard).flat().length, failures: failures.length, outbound}));
assert.equal(outbound, 0, 'The Worker attempted an outbound request');
assert.deepEqual(failures, [], `${failures.length} checks failed: output differs from the direct compile, a function was serialized without canonical text, or generation failed`);
