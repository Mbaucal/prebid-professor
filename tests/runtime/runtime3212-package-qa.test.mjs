import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {unzipSync} from 'fflate';
import {runtimeCatalog, buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {prebidRequirements, inspectPrebidArtifact, sha256} from '../../worker/runtime/prebid-artifact-check.mjs';
import {describeCandidate, saveDraftRelease, readDraftRelease} from '../../worker/runtime/draft-release-store.mjs';
import {outstreamContext} from '../../shared/outstream/selected-settings.mjs';
import {previewInput} from '../../worker/runtime-3212/snapshot.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {defaultOverlay} from '../../worker/site-runtime/position-settings.mjs';
import {dealsRuntimeFixture} from '../support/deals-runtime-fixture.mjs';
import {isolatedStore} from '../support/isolated-draft-store.mjs';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore, ORIGIN, TEST_EMAIL, TEST_PASSWORD} from '../support/test-workspace-store.mjs';

// Package-level QA for 3.21.2 against 3.21.1 from the same saved settings and
// build stamp. Structural assertions only: no ad library, SSP or network is used.
const stamp = '20261113_120000', decoder = new TextDecoder();
const text = bytes => decoder.decode(bytes);
const V3211 = runtimeCatalog.find(r => r.id === 'tessera-3.21.1'), V3212 = runtimeCatalog.find(r => r.id === 'tessera-3.21.2');
const originalFetch = globalThis.fetch, fixtures = [];
test.before(() => { globalThis.fetch = () => assert.fail('Package QA must not fetch external resources'); });
test.after(() => { globalThis.fetch = originalFetch; });
test.afterEach(() => { while (fixtures.length) fixtures.pop().close(); });

function site(frequency, prebid) {
  const snapshot = positionFixture(prebid), config = JSON.parse(snapshot.config.config_json);
  config.runtimeControls.adPositions.Overlay.frequencyMinutes = frequency;
  snapshot.config.config_json = JSON.stringify(config);
  return snapshot;
}
async function checked(snapshot) {
  const requirements = prebidRequirements(previewInput(snapshot, V3212, stamp), JSON.parse(snapshot.config.config_json));
  if (!requirements.required) return null;
  const bytes = new TextEncoder().encode(`/* prebid.js v11.11.0\nModules: ${requirements.modules.join(', ')} */\nvoid 0;`).buffer;
  const build = {id: 'fixture-build', publisher_id: snapshot.site.id, status: 'current', version: '11.11.0', file_key: `publishers/${snapshot.site.id}/prebid-builds/fixture-build/prebid.js`, modules_json: JSON.stringify(requirements.modules)};
  const object = {size: bytes.byteLength, customMetadata: {sha256: await sha256(bytes), version: '11.11.0'}, async arrayBuffer() { return bytes; }};
  return {bytes, report: await inspectPrebidArtifact({siteId: snapshot.site.id, builds: [build], requirements}, {async get() { return object; }})};
}
const build = async (snapshot, descriptor) => buildArtifactCandidate({snapshot, pin: pinRuntime(descriptor), buildTimestamp: stamp, prebid: await checked(snapshot)});
function topFunctions(source) {
  const ast = parse(source, {ecmaVersion: 2015}), out = new Map();
  const iife = ast.body.filter(node => node.type === 'ExpressionStatement' && node.expression.callee?.type === 'FunctionExpression' &&
    node.expression.callee.body.body.some(inner => inner.type === 'FunctionDeclaration' && inner.id.name === 'defineAllSlots'));
  assert.equal(iife.length, 1, 'one ads.js IIFE');
  for (const node of iife[0].expression.callee.body.body) if (node.type === 'FunctionDeclaration') out.set(node.id.name, source.slice(node.start, node.end));
  return out;
}
const PATCHED = ['defineAllSlots', 'resolveTakeOverCap', 'init', 'initAfterTakeOverCap'];
const ADDED = ['tesseraTakeOverPending', 'tesseraTakeOverDecision', 'tesseraBootHoldServices', 'tesseraBootQueueDisplay', 'tesseraBootRelease', 'tesseraBootEnableHeldServices'];
const FIX = '\nFixed in 3.21.2\n';

for (const prebid of [false, true]) for (const frequency of [0, 30]) {
  test(`3.21.2 package equals 3.21.1 outside the boot fix (${prebid ? 'Prebid' : 'GAM only'}, interval ${frequency})`, async () => {
    const snapshot = site(frequency, prebid), old = await build(snapshot, V3211), next = await build(snapshot, V3212);
    assert.deepEqual(Object.keys(next.files).sort(), Object.keys(old.files).sort());
    const versioned = ['ads.js', 'ads.min.js', 'README.txt', 'manifest.json', 'config.json', 'implementation.html'];
    for (const name of Object.keys(old.files)) if (!versioned.includes(name)) assert.deepEqual(next.files[name], old.files[name], name + ' is byte-identical');
    assert.equal(next.manifest.runtime.runtimeVersion, '3.21.2'); assert.equal(next.manifest.runtime.runtimeId, 'tessera-3.21.2');
    const config = JSON.parse(text(next.files['config.json'])), oldConfig = JSON.parse(text(old.files['config.json']));
    assert.deepEqual(config.runtime, next.manifest.runtime); assert.equal(config.core.generatorProfileId, 'tessera-3.21.2');
    assert.deepEqual({...config, runtime: null, core: {...config.core, generatorProfileId: null}}, {...oldConfig, runtime: null, core: {...oldConfig.core, generatorProfileId: null}});
    assert.equal(text(next.files['implementation.html']), text(old.files['implementation.html']).replaceAll('Tessera 3.21.1', 'Tessera 3.21.2'));
    const readme = text(next.files['README.txt']), oldReadme = text(old.files['README.txt']);
    assert(readme.startsWith('Tessera 3.21.2\n')); assert.equal(readme.split(FIX).length, 2, 'one Fixed in 3.21.2 section');
    assert.equal(readme.slice(0, readme.indexOf(FIX)), oldReadme.replace('Tessera 3.21.1\n', 'Tessera 3.21.2\n').replace('Runtime: 3.21.1\n', 'Runtime: 3.21.2\n')
      .replace(`Source SHA-256: ${old.manifest.runtime.runtimeSha256}\n`, `Source SHA-256: ${next.manifest.runtime.runtimeSha256}\n`));
    assert.match(readme.slice(readme.indexOf(FIX)), /window\.TAKEOVER_ACTIVE_FOR_PAGE is null and the TakeOver status is waiting-consent/);
    assert.deepEqual(next.manifest.patches.filter(patch => !old.manifest.patches.includes(patch)).map(patch => patch.slice(0, 7)), ['3.21.2:', '3.21.2:']);
    assert.deepEqual(next.manifest.warnings, old.manifest.warnings);
    const js = text(next.files['ads.js']), min = text(next.files['ads.min.js']), oldJs = text(old.files['ads.js']), oldMin = text(old.files['ads.min.js']);
    for (const source of [js, min]) assert.doesNotThrow(() => parse(source, {ecmaVersion: 2015}));
    if (frequency === 0) {
      // Only the generator profile line names the version.
      const a = js.split('\n'), b = oldJs.split('\n');
      assert.equal(a.length, b.length);
      const changed = a.map((line, index) => line === b[index] ? null : [line, b[index]]).filter(Boolean);
      assert.equal(changed.length, 1, JSON.stringify(changed.slice(0, 3)));
      assert.match(changed[0][0], /ADOPS_GENERATOR_PROFILE = ["']tessera-3\.21\.2["']/); assert.match(changed[0][1], /ADOPS_GENERATOR_PROFILE = ["']tessera-3\.21\.1["']/);
      assert.equal(min.replace('tessera-3.21.2', 'tessera-3.21.1'), oldMin);
      assert(!min.includes('tesseraBootRelease'));
    } else {
      assert(min.includes('tesseraBootRelease')); assert.match(min, /whenConsent\(tesseraBootRelease\)/);
      assert.match(min, /["']waiting-consent["']/); assert.match(min, /["']cap-error["']/);
      const next30 = topFunctions(js), old30 = topFunctions(oldJs);
      assert.deepEqual([...next30.keys()].filter(name => !old30.has(name)).sort(), [...ADDED].sort());
      for (const [name, source] of old30) if (!PATCHED.includes(name)) assert.equal(next30.get(name).replaceAll('tessera-3.21.2', 'tessera-3.21.1'), source, name);
      // Option E in the shipped (minified) file: the link-block gate is the unchanged 3.21.1 code.
      const nextMin = topFunctions(min), oldMinFns = topFunctions(oldMin);
      assert.equal(nextMin.get('applyTakeOverCodelessLinkBlock'), oldMinFns.get('applyTakeOverCodelessLinkBlock'));
      assert.match(nextMin.get('applyTakeOverCodelessLinkBlock'), /!TAKEOVER_ACTIVE_FOR_PAGE/);
    }
  });
}

test('3.21.2 drafts with and without deals pass describeCandidate and are stored with an exact roundtrip', async (t) => {
  const store = isolatedStore(); t.after(() => store.close());
  for (const snapshot of [dealsRuntimeFixture(true), site(30, false)]) {
    const candidate = await build(snapshot, V3212);
    assert(candidate.files['deals-plan.json'], '3.21.2 always writes deals-plan.json');
    const {descriptor} = await describeCandidate('test-site', candidate);
    assert.equal(descriptor.runtime.runtimeVersion, '3.21.2');
    const saved = await saveDraftRelease(store.store, {siteId: 'test-site', candidate, actor: 'test@example.invalid', note: '3.21.2 QA'});
    assert.equal(saved.created, true); assert.equal(saved.draft.runtime.runtimeId, 'tessera-3.21.2');
    const read = await readDraftRelease(store.store, {siteId: 'test-site', releaseId: saved.draft.id});
    for (const [name, bytes] of Object.entries(candidate.files)) assert.deepEqual(read.files[name], bytes, name);
  }
  const deals = JSON.parse(text((await build(dealsRuntimeFixture(true), V3212)).files['deals-plan.json']));
  assert(JSON.stringify(deals).includes('0000199'), 'configured deal is planned');
});

test('Outstream context for a 3.21.2 pin equals the 3.21.1 context', () => {
  const pinned = descriptor => { const snapshot = positionFixture(true), config = JSON.parse(snapshot.config.config_json);
    config.builtinRuntimeSelection = {runtime: pinRuntime(descriptor)}; snapshot.config.config_json = JSON.stringify(config); return snapshot; };
  const next = outstreamContext(pinned(V3212)), old = outstreamContext(pinned(V3211));
  assert.deepEqual(next, old); assert.equal(next.gamCodeCompatibility, true); assert.equal(next.responsiveSizing, true);
});

// TEST workspace HTTP flow with its saved site fixture: select, save, generate, store and reopen.
async function req(f, path, cookie, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await worker.fetch(new Request(ORIGIN + path, {method, headers: {cookie, ...(method === 'GET' ? {} : {origin: ORIGIN, 'content-type': 'application/json'})}, body: body === undefined ? undefined : JSON.stringify(body)}), f.env);
  return {response, data: response.headers.get('content-type')?.includes('json') ? await response.json() : null};
}
function ok(result, status = 200) { assert.equal(result.response.status, status, JSON.stringify(result.data)); return result.data; }
async function select(f, cookie, version) {
  const state = ok(await req(f, '/test-api/runtime-selection', cookie));
  const runtime = state.runtimes.find(item => item.version === version); assert(runtime, `Runtime ${version} must be registered`);
  ok(await req(f, '/test-api/runtime-selection', cookie, {expectedRevision: state.revision, selection: {runtime: runtime.pin, allowPreview: true, enablePrebid: state.enablePrebid, prebidBuildId: state.prebidBuildId}}));
  return runtime.pin;
}
async function packaged(f, cookie, note) {
  const generated = ok(await req(f, '/test-api/generate', cookie, {acknowledge: true}));
  const stored = ok(await req(f, '/test-api/save', cookie, {receipt: generated.receipt, acknowledge: true, note}));
  const download = await req(f, '/test-api/releases/' + stored.draft.id + '/download', cookie); assert.equal(download.response.status, 200);
  const files = unzipSync(new Uint8Array(await download.response.arrayBuffer()));
  return {files, manifest: JSON.parse(text(files['manifest.json'])), adsJs: generated.adsJs};
}

test('TEST workspace: a 3.21.2 package with a TakeOver interval saves and reopens; a saved 3.21.1 pin still generates 3.21.1', async () => {
  const f = workspaceStore(); fixtures.push(f);
  const login = await worker.fetch(new Request(ORIGIN + '/api/auth/login', {method: 'POST', headers: {origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({email: TEST_EMAIL, password: TEST_PASSWORD})}), f.env);
  assert.equal(login.status, 303); const cookie = login.headers.get('set-cookie').split(';')[0];
  ok(await req(f, '/test-api/setup', cookie, {confirm: 'prepare-empty-test-database'}));
  const catalog = ok(await req(f, '/test-api/runtime-selection', cookie));
  assert.equal(catalog.runtimes.filter(runtime => runtime.version === '3.21.2').length, 1);
  const pin = await select(f, cookie, '3.21.2'), state = ok(await req(f, '/test-api/site-settings', cookie));
  const positions = state.draft.units.length;
  state.draft.units.push({code: 'Overlay', type: 'ATF', enabled: true, sizeMap: 'modal', display: 'takeover', overlay: {...defaultOverlay(), frequencyMinutes: 30}});
  state.draft.maps.push({name: 'modal', breakpoints: [{minWidth: 0, sizes: [[300, 250]]}, {minWidth: 1024, sizes: [[800, 600]]}]});
  ok(await req(f, '/test-api/site-settings', cookie, {expectedRevision: state.revision, acknowledge: true, draft: state.draft}));
  const current = await packaged(f, cookie, '3.21.2 package');
  assert.deepEqual(current.manifest.runtime, pin); assert.equal(text(current.files['ads.js']), current.adsJs);
  const config = JSON.parse(text(current.files['config.json'])); assert.equal(config.adPosition.frequencyMinutes, 30);
  assert(positions > 1); assert.equal(config.core.explicitUnits.length, positions + 1);
  const min = text(current.files['ads.min.js']); assert.doesNotThrow(() => parse(min, {ecmaVersion: 2015}));
  const functions = topFunctions(min);
  for (const name of ['createConsentStorage', 'tesseraBootRelease', 'tesseraBootEnableHeldServices']) assert(functions.has(name), name);
  await select(f, cookie, '3.21.1');
  const previous = await packaged(f, cookie, '3.21.1 package');
  assert.equal(previous.manifest.runtime.runtimeVersion, '3.21.1'); assert(text(previous.files['README.txt']).startsWith('Tessera 3.21.1\n'));
  assert(!text(previous.files['ads.min.js']).includes('tesseraBootRelease'));
  assert.equal(ok(await req(f, '/test-api/runtime-selection', cookie)).selected.runtime.runtimeVersion, '3.21.1', 'no implicit upgrade');
});

test('the current recommendation is the newest stable runtime and carries the 3.21.1 storage and 3.21.2 boot fixes', async () => {
  const current = runtimeReleaseHistory.find(release => release.channel === 'stable');
  const descriptor = runtimeCatalog.find(entry => entry.id === current.id && entry.version === current.version && entry.codeSha256 === current.codeSha256);
  assert(descriptor, 'the current recommendation is bundled');
  const candidate = await build(site(30, true), descriptor), min = text(candidate.files['ads.min.js']);
  for (const name of ['createConsentStorage', 'resolveTakeOverCap', 'tesseraBootRelease', 'tesseraBootEnableHeldServices']) assert(topFunctions(min).has(name), name);
  assert.doesNotMatch(min, /localStorage\.(?:getItem|setItem|removeItem)\(["']ADOPS_DEBUG/);
});
