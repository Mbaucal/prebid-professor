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
import {previewInput as input3212} from '../../worker/runtime-3212/snapshot.mjs';
import {previewInput as input323, savedBidCache} from '../../worker/runtime-323/snapshot.mjs';
import {compileRuntime323} from '../../worker/runtime-323/compiler.mjs';
import {applyBidCache, activeBidCache} from '../../worker/runtime-323/bid-cache-compiler.mjs';
import {compileRuntime3212} from '../../worker/runtime-3212/compiler.mjs';
import {browserSources} from '../../.generated/runtime-323-browser-source.mjs';
import {BID_CACHE_GENERATOR_MESSAGE} from '../../worker/site-runtime/prebid-cache-settings.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {dealsRuntimeFixture} from '../support/deals-runtime-fixture.mjs';
import {isolatedStore} from '../support/isolated-draft-store.mjs';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore, ORIGIN, TEST_EMAIL, TEST_PASSWORD} from '../support/test-workspace-store.mjs';

// Package-level QA for 3.23.0 against 3.21.2 from the same saved settings and
// build stamp. Structural assertions only: no ad library, SSP or network is used.
// The browser behavior of the bid cache is covered by bid-cache323.test.mjs.
const stamp = '20261115_120000', decoder = new TextDecoder();
const text = bytes => decoder.decode(bytes);
const V3212 = runtimeCatalog.find(r => r.id === 'tessera-3.21.2'), V323 = runtimeCatalog.find(r => r.id === 'tessera-3.23.0');
const originalFetch = globalThis.fetch, fixtures = [];
test.before(() => { globalThis.fetch = () => assert.fail('Package QA must not fetch external resources'); });
test.after(() => { globalThis.fetch = originalFetch; });
test.afterEach(() => { while (fixtures.length) fixtures.pop().close(); });

const CONTEXTUAL = {schemaVersion: 1, enabled: true, sourceKey: 'category', gam: {enabled: true},
  bidders: [{bidder: 'pubmatic', taxonomy: 'iab-content-2.2'}], mappings: [{value: 'Sports', taxonomies: {'iab-content-2.2': ['483']}}]};
function site({frequency = 0, prebid = true, contextual = false, cache} = {}) {
  const snapshot = positionFixture(prebid), config = JSON.parse(snapshot.config.config_json);
  config.runtimeControls.adPositions.Overlay.frequencyMinutes = frequency;
  if (contextual) config.runtimeControls.contextualSignals = {...CONTEXTUAL, bidders: prebid ? CONTEXTUAL.bidders : []};
  if (cache !== undefined) config.prebidBidCache = cache;
  snapshot.config.config_json = JSON.stringify(config);
  return snapshot;
}
async function checked(snapshot) {
  const requirements = prebidRequirements(input3212(snapshot, V3212, stamp), JSON.parse(snapshot.config.config_json));
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
const SECTION = '\nBid caching in 3.23.0\n';
const CACHE_ON = {enabled: true, maxBidAgeSeconds: 45, positionOverrides: {P1: false}};
const HOOKS = ['cacheAuction', 'cacheExtend', 'cacheApplied', 'cacheConsent'];

/** Same package as 3.21.2 except the runtime identity and the plain-English bid cache notes. */
async function assertSameAs3212(snapshot, label) {
  const old = await build(snapshot, V3212), next = await build(snapshot, V323);
  assert.deepEqual(Object.keys(next.files).sort(), Object.keys(old.files).sort(), label);
  const versioned = ['ads.js', 'ads.min.js', 'README.txt', 'manifest.json', 'config.json', 'implementation.html'];
  for (const name of Object.keys(old.files)) if (!versioned.includes(name)) assert.deepEqual(next.files[name], old.files[name], `${label}: ${name} is byte-identical`);
  assert.equal(next.manifest.runtime.runtimeVersion, '3.23.0'); assert.equal(next.manifest.runtime.runtimeId, 'tessera-3.23.0');
  const config = JSON.parse(text(next.files['config.json'])), oldConfig = JSON.parse(text(old.files['config.json']));
  assert.deepEqual(config.runtime, next.manifest.runtime); assert.equal(config.core.generatorProfileId, 'tessera-3.23.0');
  assert.equal(config.bidCache, null, label); assert.deepEqual(config.bidCacheExclusions, [], label);
  const {bidCache, bidCacheExclusions, ...rest} = config;
  assert.deepEqual({...rest, runtime: null, core: {...rest.core, generatorProfileId: null}}, {...oldConfig, runtime: null, core: {...oldConfig.core, generatorProfileId: null}}, label);
  assert.deepEqual(Object.keys(rest), Object.keys(oldConfig), `${label}: config.json keeps the 3.21.2 key order`);
  const html = text(next.files['implementation.html']).split('\n'), oldHtml = text(old.files['implementation.html']).replaceAll('Tessera 3.21.2', 'Tessera 3.23.0').split('\n');
  const note = html.findIndex(line => line.startsWith('<!-- Bid caching'));
  assert.equal(html[note], '<!-- Bid caching is off in this package: every Prebid auction uses fresh bids only. -->');
  assert.deepEqual(html.filter((_, index) => index !== note), oldHtml, `${label}: implementation.html`);
  const readme = text(next.files['README.txt']), oldReadme = text(old.files['README.txt']);
  assert(readme.startsWith('Tessera 3.23.0\n')); assert.equal(readme.split(SECTION).length, 2, 'one bid caching section');
  assert.equal(readme.slice(0, readme.indexOf(SECTION)), oldReadme.replace('Tessera 3.21.2\n', 'Tessera 3.23.0\n').replace('Runtime: 3.21.2\n', 'Runtime: 3.23.0\n')
    .replace(`Source SHA-256: ${old.manifest.runtime.runtimeSha256}\n`, `Source SHA-256: ${next.manifest.runtime.runtimeSha256}\n`), label);
  assert.match(readme.slice(readme.indexOf(SECTION)), /This package: Off\./);
  assert.deepEqual(next.manifest.patches, old.manifest.patches, label); assert.deepEqual(next.manifest.warnings, old.manifest.warnings, label);
  const js = text(next.files['ads.js']), min = text(next.files['ads.min.js']), oldJs = text(old.files['ads.js']), oldMin = text(old.files['ads.min.js']);
  for (const source of [js, min]) assert.doesNotThrow(() => parse(source, {ecmaVersion: 2015}));
  // Only the generator profile line names the version.
  const a = js.split('\n'), b = oldJs.split('\n');
  assert.equal(a.length, b.length, label);
  const changed = a.map((line, index) => line === b[index] ? null : [line, b[index]]).filter(Boolean);
  assert.equal(changed.length, 1, `${label}: ${JSON.stringify(changed.slice(0, 3))}`);
  assert.match(changed[0][0], /ADOPS_GENERATOR_PROFILE = ["']tessera-3\.23\.0["']/); assert.match(changed[0][1], /ADOPS_GENERATOR_PROFILE = ["']tessera-3\.21\.2["']/);
  assert.equal(min.split('tessera-3.23.0').length, 2, label); assert.equal(min.replace('tessera-3.23.0', 'tessera-3.21.2'), oldMin, label);
  for (const name of ['createTesseraBidCache', '__tesseraBidCache', 'useBidCache:!0', 'bidCacheFilterFunction', ...HOOKS]) assert(!min.includes(name), `${label}: ${name}`);
  return {old, next};
}

for (const prebid of [false, true]) for (const frequency of [0, 30]) for (const contextual of [false, true]) {
  test(`3.23.0 without bid caching equals 3.21.2 except its version (${prebid ? 'Prebid' : 'GAM only'}, interval ${frequency}, contextual ${contextual ? 'on' : 'off'})`, async () => {
    await assertSameAs3212(site({frequency, prebid, contextual}), 'never saved');
    // Saved off, and saved on while the package is GAM-only, change nothing either.
    await assertSameAs3212(site({frequency, prebid, contextual, cache: {enabled: false, maxBidAgeSeconds: 60}}), 'saved off');
    if (!prebid) await assertSameAs3212(site({frequency, prebid, contextual, cache: CACHE_ON}), 'saved on, GAM only');
  });
}

for (const frequency of [0, 30]) for (const contextual of [false, true]) {
  test(`3.23.0 with bid caching adds only the bid cache policy and four readiness hooks (interval ${frequency}, contextual ${contextual ? 'on' : 'off'})`, async () => {
    const off = await build(site({frequency, contextual}), V323), on = await build(site({frequency, contextual, cache: CACHE_ON}), V323);
    assert.deepEqual(Object.keys(on.files).sort(), Object.keys(off.files).sort());
    for (const name of ['sticky.css', 'min-height.css', 'gam-reporting.json', 'deals-plan.json', 'prebid.js', 'div-export.csv']) assert.deepEqual(on.files[name], off.files[name], name);
    const js = text(on.files['ads.js']), min = text(on.files['ads.min.js']);
    for (const source of [js, min]) assert.doesNotThrow(() => parse(source, {ecmaVersion: 2015}));
    const next = topFunctions(js), old = topFunctions(text(off.files['ads.js']));
    assert.deepEqual([...next.keys()].filter(name => !old.has(name)), ['createTesseraBidCache']);
    const patched = [...old.keys()].filter(name => next.get(name) !== old.get(name));
    assert.deepEqual(patched.sort(), ['configurePrebidReady', 'createTesseraReadiness']);
    for (const hook of HOOKS) assert.equal(js.split(`options.${hook}`).length - 1, hook === 'cacheExtend' ? 4 : 2, hook);
    assert.match(js, /_tesseraBidCache\.install\(pbjs\);\s*_tesseraConfiguredPb = pbjs;/);
    const config = JSON.parse(text(on.files['config.json']));
    assert.deepEqual(config.bidCache, {defaultEnabled: true, maxAgeSeconds: 45, positions: {Billboard: true, P1: false}});
    assert.deepEqual(config.bidCacheExclusions, []);
    const literal = js.match(/var TESSERA_BID_CACHE = (\{[\s\S]*?\});\n/);
    assert(literal, 'TESSERA_BID_CACHE literal');
    assert.deepEqual(Function(`return ${literal[1]}`)(), {version: '3.23.0', defaultEnabled: true, maxAgeSeconds: 45, positions: [['Billboard', true], ['P1', false]]});
    const readme = text(on.files['README.txt']);
    assert.match(readme, /This package: On for Billboard, with a maximum bid age of 45 seconds\. Off for P1\. Every other position uses fresh bids only\.\n/);
    assert.match(text(on.files['implementation.html']), /<!-- Bid caching is on for 1 position \(see README\.txt\)\. Nothing else is needed on the page\. -->/);
    assert.deepEqual(on.manifest.patches.slice(0, off.manifest.patches.length - 3), off.manifest.patches.slice(0, -3));
    assert.deepEqual(on.manifest.patches.filter(patch => !off.manifest.patches.includes(patch)).map(patch => patch.slice(0, 7)), ['3.23.0:', '3.23.0:', '3.23.0:']);
    assert.deepEqual(on.manifest.warnings, off.manifest.warnings);
    if (frequency) assert(min.includes('tesseraBootRelease'), 'the 3.21.2 boot fix stays'); else assert(!min.includes('tesseraBootRelease'));
  });
}

test('the emitted policy is the exact browser-bid-cache.mjs function and the raw compile is the 3.21.2 compile plus seven anchored edits', () => {
  const snapshot = site({cache: {enabled: true, maxBidAgeSeconds: 300}}), input = input323(snapshot, V323, stamp);
  const raw = compileRuntime323(input).adsJs, base = compileRuntime3212(input).adsJs;
  assert.equal(raw.split(browserSources.createTesseraBidCache).length, 2, 'policy emitted once, byte-for-byte');
  assert(base.length < raw.length);
  // Removing the inserted text gives back the 3.21.2 program.
  const removed = raw.replace(browserSources.createTesseraBidCache + '\n', '')
    .replace(/  var TESSERA_BID_CACHE=.*\n/, '')
    .replace(/  var _tesseraBidCache=createTesseraBidCache\(window,TESSERA_BID_CACHE,\{sizes:function\(code\)\{\n.*\n.*\n  \}\}\);\n/, '')
    .replace('    cacheAuction:_tesseraBidCache.auction,cacheExtend:_tesseraBidCache.extend,cacheApplied:_tesseraBidCache.applied,cacheConsent:_tesseraBidCache.consent,\n', '')
    .replace('    _tesseraBidCache.install(pbjs);\n', '')
    .replace('if(options.cacheConsent)options.cacheConsent(consent.ready,consent.epoch); ', '')
    .replace('        if (completed && options.cacheAuction) { try { options.cacheAuction(codes, bids, auctionId, epoch); } catch (_) {} }\n', '')
    .replace('              if (options.cacheExtend) candidate = options.cacheExtend(pb, code, candidate, allowed);\n', '')
    .replace('      if (options.cacheExtend) candidate = options.cacheExtend(pb, code, candidate, record.allowed);\n', '')
    .replace('          var appliedTargeting = targeting(options.code(slot));\n          options.apply(slot, appliedTargeting);\n          if (options.cacheApplied) { try { options.cacheApplied(options.code(slot), appliedTargeting); } catch (_) {} }\n',
      '          options.apply(slot, targeting(options.code(slot)));\n');
  assert.equal(removed, base);
});

test('a missing or repeated anchor fails generation instead of emitting a partial patch', () => {
  const input = input323(site({cache: CACHE_ON}), V323, stamp), base = compileRuntime3212(input).adsJs;
  // The exact anchors of bid-cache-compiler.mjs, in patch order.
  for (const anchor of ['  var _tesseraReady=createTesseraReadiness(window,{\n', '    _adContext.configurePrebid(pbjs);\n    _tesseraConfiguredPb=pbjs;\n',
    '    if (changed) { if(options.discard)options.discard(Object.keys(targets)); targets = Object.create(null); ',
    "        var completed = started && consent.ready && consent.epoch === epoch && id === auctionId && bids && typeof bids === 'object' && typeof timedOut === 'boolean';\n",
    '            try {\n              var candidate = pb.getAdserverTargetingForAdUnitCode(code) || {};\n',
    "      if (!pb || typeof pb.getAdserverTargetingForAdUnitCode !== 'function') return {};\n      var candidate = pb.getAdserverTargetingForAdUnitCode(code) || {};\n",
    '          options.apply(slot, targeting(options.code(slot)));\n']) {
    assert.equal(base.split(anchor).length, 2, anchor);
    assert.throws(() => applyBidCache(base.replace(anchor, anchor.replace(/[a-z]/, 'Q')), input), /3\.23\.0 bid cache expected one anchor, found 0/, anchor);
    assert.throws(() => applyBidCache(base.replace(anchor, anchor + anchor), input), /3\.23\.0 bid cache expected one anchor, found 2/, anchor);
  }
});

test('saved overrides for positions this package cannot cache become warnings, never applied settings', async () => {
  // P2 is a saved override with no such unit; Billboard is turned off.
  const snapshot = site({cache: {enabled: false, maxBidAgeSeconds: 10, positionOverrides: {Billboard: false, P1: true, P2: true}}});
  const candidate = await build(snapshot, V323), config = JSON.parse(text(candidate.files['config.json']));
  assert.deepEqual(config.bidCache, {defaultEnabled: false, maxAgeSeconds: 10, positions: {Billboard: false, P1: true}});
  assert.deepEqual(config.bidCacheExclusions, [{code: 'P2', enabled: true}]);
  assert.equal(candidate.manifest.warnings.filter(warning => warning.startsWith('P2: saved bid cache setting not applied.')).length, 1);
  const readme = text(candidate.files['README.txt']);
  assert.match(readme, /This package: On for P1, with a maximum bid age of 10 seconds\. Off for Billboard\./);
  assert.match(readme, /Saved settings not applied in this package: P2 \(on\)\./);
  // The TakeOver position and its Interstitial fallback are not eligible even when they have an override.
  const input = input323(site(), V323, stamp);
  Object.assign(input, {bidCache: {defaultEnabled: true, maxAgeSeconds: 60, positions: {Billboard: true, Overlay: true}}});
  assert.throws(() => compileRuntime323(input), /3\.23\.0 bid cache cannot apply to position "Overlay" in this package/);
  const direct = input323(site({cache: {enabled: true, maxBidAgeSeconds: 60, positionOverrides: {Overlay: true, Interstitial: false}}}), V323, stamp);
  assert.deepEqual(direct.bidCache.positions, {Billboard: true, P1: true});
  assert.deepEqual(direct.bidCacheExclusions, [{code: 'Interstitial', enabled: false}, {code: 'Overlay', enabled: true}]);
});

test('bid caching on with every eligible position overridden off keeps the fresh-only program and says so', async () => {
  const snapshot = site({cache: {enabled: true, maxBidAgeSeconds: 60, positionOverrides: {Billboard: false, P1: false}}});
  const candidate = await build(snapshot, V323), plain = await build(site(), V323);
  assert.equal(text(candidate.files['ads.min.js']), text(plain.files['ads.min.js']));
  assert(candidate.manifest.warnings.includes('Bid caching is on in Demand → Prebid, but no position in this package can reuse bids; every position uses fresh bids.'));
  assert.match(text(candidate.files['README.txt']), /This package: Bid caching is on for this site, but no position in this package can reuse bids/);
  assert.equal(activeBidCache(input323(snapshot, V323, stamp)), null);
});

test('the README and warnings say where each setting lives and what a saved override alone does', async () => {
  // Site default off with only a stale override on (no such unit): nothing caches, and nothing is "on in Demand → Prebid".
  const stale = await build(site({cache: {enabled: false, maxBidAgeSeconds: 60, positionOverrides: {Gone: true}}}), V323);
  const warnings = stale.manifest.warnings, readme = text(stale.files['README.txt']);
  assert(warnings.includes('A saved position override asks for bid caching, but no position in this package can reuse bids; every position uses fresh bids.'), warnings.join('\n'));
  assert(!warnings.some(warning => /on in Demand → Prebid/.test(warning)));
  assert.match(readme, /This package: A saved position override asks for bid caching, but no position in this package can reuse bids, so every auction uses fresh bids only\.\n/);
  assert.doesNotMatch(readme, /Bid caching is on for this site/);
  assert.match(readme, /Set in Config → Demand → Prebid \(site setting and maximum bid age from 1 to 300 seconds\) and Config → Ad units → Bid cache \(optional on or off per position\)\.\n/);
  // Draft positions are named with the other exclusions.
  assert.match(readme, /TakeOver, its Interstitial fallback, Outstream, Draft, disabled and removed positions use fresh bids only/);
  assert.equal(warnings.filter(warning => warning.startsWith('Gone: saved bid cache setting not applied.') && /Outstream, Draft, disabled and removed positions/.test(warning)).length, 1);
  // Consent: only what Prebid really sends is compared (TCF; US privacy only with its module; GPP is off in Prebid).
  assert.match(readme, /the same TCF decision and the same consent data that Prebid sent to bidders\. A TCF change drops every earlier bid\. Tessera turns Prebid's GPP module off, and US privacy reaches Prebid only when the site's Prebid\.js includes the US privacy module, so a GPP change, or a US privacy change without that module, does not stop reuse\./);
  assert.doesNotMatch(readme, /TCF, US privacy and GPP data|A CMP change drops/);
  // Deals: a fresh deal keeps its place.
  assert.match(readme, /A bidder with a fresh deal bid keeps that deal: none of its earlier bids competes in that auction\./);
});

test('invalid saved bid cache settings stop Generate with the saved-settings message', () => {
  for (const value of [{enabled: 'yes', maxBidAgeSeconds: 60}, {enabled: true, maxBidAgeSeconds: 0}, {enabled: true, maxBidAgeSeconds: 301},
    {enabled: true, maxBidAgeSeconds: 60, extra: 1}, {enabled: true, maxBidAgeSeconds: 60, positionOverrides: {P1: 'on'}}, {enabled: true, maxBidAgeSeconds: 60, positionOverrides: []}, null]) {
    assert.throws(() => savedBidCache({prebidBidCache: value}), /Saved bid cache settings are invalid\. Open Config → Demand → Prebid and save them again/, JSON.stringify(value));
  }
  assert.deepEqual(savedBidCache({}), {enabled: false, maxBidAgeSeconds: 60, overrides: []});
  // Own data properties only: __proto__ is an ordinary saved code, never a prototype.
  const odd = JSON.parse('{"prebidBidCache":{"enabled":false,"maxBidAgeSeconds":5,"positionOverrides":{"__proto__":true,"b":false,"A":true}}}');
  assert.deepEqual(savedBidCache(odd).overrides, [['A', true], ['__proto__', true], ['b', false]]);
});

test('saved bid cache settings generate only with a runtime that has the bid-cache capability', async () => {
  const snapshot = site({cache: CACHE_ON});
  assert.deepEqual(V323.capabilities.filter(capability => !V3212.capabilities.includes(capability)), ['bid-cache']);
  await assert.rejects(build(snapshot, V3212), error => error.message === BID_CACHE_GENERATOR_MESSAGE && error.status === 409);
  assert.equal((await build(snapshot, V323)).manifest.runtime.runtimeVersion, '3.23.0');
});

test('3.23.0 drafts with and without deals or bid caching pass describeCandidate and are stored with an exact roundtrip', async (t) => {
  const store = isolatedStore(); t.after(() => store.close());
  const deals = dealsRuntimeFixture(true), dealsConfig = JSON.parse(deals.config.config_json);
  dealsConfig.prebidBidCache = {enabled: true, maxBidAgeSeconds: 120};
  deals.config.config_json = JSON.stringify(dealsConfig);
  for (const snapshot of [deals, site({frequency: 30, prebid: false}), site({cache: CACHE_ON})]) {
    const candidate = await build(snapshot, V323);
    assert(candidate.files['deals-plan.json'], '3.23.0 always writes deals-plan.json');
    const {descriptor} = await describeCandidate('test-site', candidate);
    assert.equal(descriptor.runtime.runtimeVersion, '3.23.0');
    const saved = await saveDraftRelease(store.store, {siteId: 'test-site', candidate, actor: 'test@example.invalid', note: '3.23.0 QA'});
    assert.equal(saved.created, true); assert.equal(saved.draft.runtime.runtimeId, 'tessera-3.23.0');
    const read = await readDraftRelease(store.store, {siteId: 'test-site', releaseId: saved.draft.id});
    for (const [name, bytes] of Object.entries(candidate.files)) assert.deepEqual(read.files[name], bytes, name);
  }
  const plan = JSON.parse(text((await build(deals, V323)).files['deals-plan.json']));
  assert(JSON.stringify(plan).includes('0000199'), 'configured deal is planned');
});

test('Outstream context for a 3.23.0 pin equals the 3.21.2 context', () => {
  const pinned = descriptor => { const snapshot = positionFixture(true), config = JSON.parse(snapshot.config.config_json);
    config.builtinRuntimeSelection = {runtime: pinRuntime(descriptor)}; snapshot.config.config_json = JSON.stringify(config); return snapshot; };
  assert.deepEqual(outstreamContext(pinned(V323)), outstreamContext(pinned(V3212)));
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

test('TEST workspace: a 3.23.0 package saves and reopens; a saved 3.21.2 pin still generates 3.21.2', async () => {
  const f = workspaceStore(); fixtures.push(f);
  const login = await worker.fetch(new Request(ORIGIN + '/api/auth/login', {method: 'POST', headers: {origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({email: TEST_EMAIL, password: TEST_PASSWORD})}), f.env);
  assert.equal(login.status, 303); const cookie = login.headers.get('set-cookie').split(';')[0];
  ok(await req(f, '/test-api/setup', cookie, {confirm: 'prepare-empty-test-database'}));
  const catalog = ok(await req(f, '/test-api/runtime-selection', cookie));
  assert.equal(catalog.runtimes.filter(runtime => runtime.version === '3.23.0').length, 1);
  assert.equal(catalog.selected, null, 'nothing is selected implicitly');
  const pin = await select(f, cookie, '3.23.0');
  const current = await packaged(f, cookie, '3.23.0 package');
  assert.deepEqual(current.manifest.runtime, pin); assert.equal(text(current.files['ads.js']), current.adsJs);
  const config = JSON.parse(text(current.files['config.json']));
  assert.equal(config.bidCache, null); assert.deepEqual(config.bidCacheExclusions, []);
  assert(text(current.files['README.txt']).startsWith('Tessera 3.23.0\n'));
  assert.doesNotThrow(() => parse(text(current.files['ads.min.js']), {ecmaVersion: 2015}));
  await select(f, cookie, '3.21.2');
  const previous = await packaged(f, cookie, '3.21.2 package');
  assert.equal(previous.manifest.runtime.runtimeVersion, '3.21.2'); assert(text(previous.files['README.txt']).startsWith('Tessera 3.21.2\n'));
  assert.equal(JSON.parse(text(previous.files['config.json'])).bidCache, undefined);
  assert.equal(ok(await req(f, '/test-api/runtime-selection', cookie)).selected.runtime.runtimeVersion, '3.21.2', 'no implicit upgrade');
});

test('the retained historical 3.23.0 stable record carries the 3.21.1 storage and 3.21.2 boot fixes', async () => {
  const current = runtimeReleaseHistory.find(release => release.channel === 'stable');
  assert.equal(current.id, 'tessera-3.23.0');
  const descriptor = runtimeCatalog.find(entry => entry.id === current.id && entry.version === current.version && entry.codeSha256 === current.codeSha256);
  assert(descriptor, 'the current recommendation is bundled');
  const candidate = await build(site({frequency: 30}), descriptor), min = text(candidate.files['ads.min.js']);
  for (const name of ['createConsentStorage', 'resolveTakeOverCap', 'tesseraBootRelease', 'tesseraBootEnableHeldServices']) assert(topFunctions(min).has(name), name);
  assert.doesNotMatch(min, /localStorage\.(?:getItem|setItem|removeItem)\(["']ADOPS_DEBUG/);
  assert(!topFunctions(min).has('createTesseraBidCache'), 'bid caching is never on unless saved');
});

test('the 3.23.0 version notes describe what 3.23.0 does', () => {
  // Shown in Script setup → Version history and frozen with the record, so they must match the shipped behaviour.
  const notes = runtimeReleaseHistory.find(release => release.id === 'tessera-3.23.0').changes.join('\n');
  assert.match(notes, /Config → Demand → Prebid, and an optional on or off per position in Config → Ad units → Bid cache/);
  assert.match(notes, /a bidder with a fresh deal bid keeps that deal, and none of its earlier bids competes in that auction/);
  assert.match(notes, /the same TCF decision and the same consent data that Prebid sent to bidders\. A TCF change drops every earlier bid\. Prebid's GPP module is off, and US privacy reaches Prebid only with its module, so a GPP or US privacy change alone does not stop reuse\./);
  assert.match(notes, /recorded as warnings in the package manifest and README and listed as Not applied in Config → Demand → Prebid/);
  assert.match(notes, /Older versions refuse saved bid cache settings that would reuse bids, and Generate says how to continue: select 3\.23\.0, or turn those settings off\./);
  assert.doesNotMatch(notes, /Generate warnings|TCF, US privacy and GPP data|A CMP change drops|presetGPTTargeting/);
});
