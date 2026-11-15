/** tessera-ab-loader 1.0.0 in node:vm with a minimal fake page (document, googletag,
 * crypto). Every forbidden page API is a recording getter, so each case also proves
 * the loader never reads storage, cookies, CMP APIs or network calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';
import {AB_LOADER_CONFIG_SCHEMA, AB_LOADER_PLACEHOLDER, AB_LOADER_TEMPLATE, AB_LOADER_VERSION, renderAbLoader} from '../../worker/experiments/ab-loader-1.0.0.mjs';
import {AA_RELEASE, staticAALoader} from '../../worker/experiments/static-aa-v1.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = 'worker/experiments/ab-loader-registry.json';
const registry = JSON.parse(readFileSync(resolve(root, REGISTRY), 'utf8'));
const sha256 = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const hex = c => c.repeat(64);
const sri = byte => 'sha384-' + Buffer.alloc(48, byte).toString('base64');
const arm = (release, name, runtimeVersion, byte) => ({release, name, runtimeVersion, path: `r/${release}/ads.js`, sha256: hex(byte.toString(16).slice(-1)), integrity: sri(byte)});
const A = arm('builtin-draft-' + hex('a'), 'Bid cache off', '3.21.2', 1);
const B = arm('builtin-draft-' + hex('b'), 'Bid cache on', '3.23.0', 2);
const config = (over = {}) => ({schema: AB_LOADER_CONFIG_SCHEMA, id: 'abx-' + hex('c'), testId: 'test_site_1', name: 'Bid cache 3.23.0',
  trafficBPercent: 50, arms: {A, B}, loader: {version: AB_LOADER_VERSION, sha256: registry[AB_LOADER_VERSION].sha256}, ...over});
const loader = over => renderAbLoader(config(over));
const LOADER_URL = 'https://pub.example/ab/ads.js';
const urlOf = side => new URL(side.path, LOADER_URL).href;
const FORBIDDEN = ['localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest', '__tcfapi', '__gpp', '__uspapi'];
// Fields src/debug/experiment-inspect.mjs on MAIN reads from AdVariant.snapshot() (lines 48-66).
const INSPECTOR_FIELDS = ['release', 'variant', 'status', 'deliveryMode', 'scriptRelease', 'scriptName', 'testName', 'script', 'scriptSha256',
  'trafficBPercent', 'prebidVersion', 'blockedDuplicateLoaders'];
const SNAPSHOT_FIELDS = ['loader', 'release', 'testId', 'testName', 'variant', 'status', 'deliveryMode', 'scriptRelease', 'scriptName', 'script',
  'scriptSha256', 'armStatus', 'trafficBPercent', 'prebidVersion', 'blockedDuplicateLoaders', 'fallback', 'keyConflict', 'runtimeStarted'];

/** A fake page. `random` returns the uint32 the stubbed getRandomValues writes. */
function page({src = LOADER_URL, nonce, nonceAttribute, search = '', random = () => 0, crypto = true, googletag, globals = {}} = {}) {
  const log = [], touched = [], targeting = [], draws = [], scripts = [], tables = [];
  const tag = src => src === null ? null : {src, nonce, getAttribute: k => k === 'nonce' ? nonceAttribute ?? null : null};
  const element = () => { const attributes = {}; return {attributes, setAttribute(k, v) { attributes[k] = String(v); }}; };
  const document = {currentScript: tag(src), readyState: 'complete', scripts: [], baseURI: 'https://pub.example/', addEventListener() {},
    createElement(name) { assert.equal(name, 'script'); return element(); },
    head: {appendChild(el) { log.push('insert ' + el.src); scripts.push(el); return el; }}};
  Object.defineProperty(document, 'cookie', {get() { touched.push('document.cookie'); return ''; }, set() { touched.push('document.cookie'); }});
  const navigator = {};
  Object.defineProperty(navigator, 'sendBeacon', {get() { touched.push('navigator.sendBeacon'); }});
  const sandbox = {document, navigator, location: {search}, URL, console: {table: rows => tables.push(rows)}, setTimeout: () => 0, clearTimeout() {}, ...globals};
  for (const name of FORBIDDEN) Object.defineProperty(sandbox, name, {get() { touched.push(name); }});
  if (crypto === true) sandbox.crypto = {getRandomValues(array) { draws.push(Object.prototype.toString.call(array) + ':' + array.length); array[0] = random(); return array; }};
  else if (crypto) sandbox.crypto = crypto;
  if (googletag !== undefined) sandbox.googletag = googletag;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return {sandbox, log, touched, draws, scripts, tables,
    run(code, src_ = src) { document.currentScript = tag(src_); vm.runInContext(code, sandbox); return this; },
    /** Runs the queued GPT commands the way GPT drains its queue and returns page targeting. */
    labels() {
      sandbox.googletag.pubads = () => ({setTargeting: (k, v) => targeting.push([k, v])});
      for (const command of sandbox.googletag.cmd) command();
      return targeting;
    },
    snapshot: () => plain(sandbox.AdVariant.snapshot()),
    state: () => plain(sandbox.__tesseraAbLoader.snapshot()),
    clean() { assert.deepEqual(touched, [], 'The loader read a forbidden page API'); }};
}
const inserted = p => p.scripts.map(s => s.src);

test('template is one ES5 literal with exactly one config placeholder', () => {
  assert.equal(AB_LOADER_TEMPLATE.split(AB_LOADER_PLACEHOLDER).length, 2);
  assert.match(AB_LOADER_TEMPLATE, /^[\x09\x0a\x20-\x7e]*$/, 'ASCII text keeps the registry hash independent of encoding');
  assert(!AB_LOADER_TEMPLATE.includes('\\'), 'No escape sequences: the literal value equals the source text');
  for (const source of [AB_LOADER_TEMPLATE, loader()]) {
    const program = parse(source, {ecmaVersion: 5});
    assert.equal(program.body.length, 1);
    assert.equal(program.body[0].type, 'ExpressionStatement');
  }
  const source = readFileSync(resolve(root, 'worker/experiments/ab-loader-1.0.0.mjs'), 'utf8');
  assert(source.includes('`' + AB_LOADER_TEMPLATE + '`'), 'The template is stored as written, not built from function text');
});

test('template never touches storage, cookies, CMP APIs, network calls or Prebid', () => {
  for (const word of ['localStorage', 'sessionStorage', 'document.cookie', 'cookie', '__tcfapi', '__gpp', '__uspapi', 'fetch',
    'XMLHttpRequest', 'sendBeacon', 'prebid.js', 'eval', 'Function('])
    assert(!AB_LOADER_TEMPLATE.toLowerCase().includes(word.toLowerCase()), word);
});

test('registry sha256 equals the template', () => {
  assert.equal(registry[AB_LOADER_VERSION].sha256, sha256(AB_LOADER_TEMPLATE));
  for (const [version, entry] of Object.entries(registry)) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(Object.keys(entry).sort(), ['created', 'sha256']);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.match(entry.created, /^\d{4}-\d{2}-\d{2}$/);
  }
});

function assertInsertOnly(current, earlier, where) {
  for (const [version, entry] of Object.entries(earlier))
    assert.deepEqual(current[version], entry, `A/B loader ${version} changed or disappeared since ${where}. Register a new loader version instead.`);
}

test('registry is insert-only against git history', () => {
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  const commits = git('log', '--format=%H', '--', REGISTRY).split('\n').filter(Boolean);
  for (const commit of commits) {
    // A commit that deleted the file has nothing to compare.
    if (!git('ls-tree', '--name-only', commit, '--', REGISTRY).trim()) continue;
    assertInsertOnly(registry, JSON.parse(git('show', `${commit}:${REGISTRY}`)), commit.slice(0, 12));
  }
  // The check itself: a new version passes, a changed or removed one fails.
  const old = {'1.0.0': {sha256: hex('1'), created: '2026-11-15'}};
  assertInsertOnly({...old, '1.1.0': {sha256: hex('2'), created: '2026-12-01'}}, old, 'synthetic');
  assert.throws(() => assertInsertOnly({'1.0.0': {sha256: hex('3'), created: '2026-11-15'}}, old, 'synthetic'), /Register a new loader version/);
  assert.throws(() => assertInsertOnly({}, old, 'synthetic'), /changed or disappeared/);
});

test('split boundaries follow x < 2^32*(100-b)/100 for A', () => {
  const clamp = x => Math.min(4294967295, Math.max(0, x));
  const cases = {
    0: [[4294967295, 'A'], [0, 'A']],
    10: [[3865470565, 'A'], [3865470566, 'A'], [3865470567, 'B'], [3865470568, 'B']],
    50: [[2147483647, 'A'], [2147483648, 'B'], [2147483649, 'B']],
    100: [[0, 'B'], [1, 'B'], [4294967295, 'B']]};
  for (const [b, expected] of Object.entries(cases)) {
    const t = 4294967296 * (100 - Number(b)) / 100;
    const probes = [Math.floor(t) - 1, Math.floor(t), Math.ceil(t), Math.ceil(t) + 1].map(clamp);
    const all = [...new Map([...probes.map(x => [x, x < t ? 'A' : 'B']), ...expected])];
    for (const [x, side] of expected) assert.equal(x < t ? 'A' : 'B', side, `b=${b} x=${x}`);
    for (const [x, side] of all) {
      const p = page({random: () => x}).run(loader({trafficBPercent: Number(b)}));
      assert.deepEqual(p.draws, ['[object Uint32Array]:1']);
      assert.deepEqual(inserted(p), [urlOf(side === 'A' ? A : B)], `b=${b} x=${x}`);
      assert.deepEqual(p.labels(), [['Variant', side], ['TestId', 'test_site_1']]);
      const s = p.snapshot();
      assert.equal(s.variant, side); assert.equal(s.status, 'assigned'); assert.equal(s.trafficBPercent, Number(b));
      p.clean();
    }
  }
});

test('without crypto the page loads A with no labels', () => {
  for (const crypto of [false, {getRandomValues() { throw Error('unavailable'); }}]) {
    const p = page({crypto}).run(loader());
    assert.deepEqual(inserted(p), [urlOf(A)]);
    assert.equal(p.sandbox.googletag, undefined);
    const s = p.snapshot();
    assert.equal(s.status, 'random-unavailable'); assert.equal(s.variant, null); assert.equal(s.scriptRelease, A.release);
    p.scripts[0].onerror();
    assert.deepEqual(inserted(p), [urlOf(A)], 'No retry without an assignment');
    p.clean();
  }
});

test('a duplicate tag is counted and changes nothing', () => {
  const p = page({random: () => 4294967295, googletag: {cmd: []}}).run(loader()).run(loader(), 'https://pub.example/other/ads.js');
  assert.deepEqual(inserted(p), [urlOf(B)]);
  assert.equal(p.sandbox.googletag.cmd.length, 1);
  assert.deepEqual(p.draws, ['[object Uint32Array]:1'], 'One assignment per pageview');
  const s = p.snapshot();
  assert.equal(s.blockedDuplicateLoaders, 1); assert.equal(s.variant, 'B');
  p.run(loader({trafficBPercent: 0, id: 'abx-' + hex('d')}));
  assert.equal(p.snapshot().blockedDuplicateLoaders, 2, 'Another test on the same page is blocked too');
  assert.equal(p.scripts.length, 1);
  p.clean();
});

test('an existing runtime, owner or AdVariant blocks labels and arms', () => {
  for (const globals of [{__TESSERA_RUNTIME_STARTED: true}, {__tesseraExperimentOwner: 'other-owner'}]) {
    const p = page({globals}).run(loader());
    assert.deepEqual(p.scripts, []); assert.equal(p.sandbox.googletag, undefined); assert.deepEqual(p.draws, []);
    const s = p.snapshot();
    assert.equal(s.status, 'existing-runtime-conflict'); assert.equal(s.variant, null); assert.equal(s.script, null);
    assert.equal(p.sandbox.__tesseraExperimentOwner, globals.__tesseraExperimentOwner, 'Another owner marker is never replaced');
    p.clean();
  }
  const foreign = Object.freeze({snapshot: () => ({release: 'other'})});
  const p = page({globals: {AdVariant: foreign}}).run(loader());
  assert.equal(p.sandbox.AdVariant, foreign);
  assert.equal(p.state().status, 'existing-runtime-conflict');
  assert.deepEqual(p.scripts, []); assert.equal(p.sandbox.googletag, undefined);
  p.clean();
});

const pilot = staticAALoader({release: AA_RELEASE, baseRuntime: '3.9.1', prebidVersion: '11.34.0', prebidPath: 'prebid.js', prebidIntegrity: sri(9),
  armSha256: hex('e'), positions: ['P1'], arms: {A: {path: 'releases/aa/runtime.js', integrity: sri(8)}, B: {path: 'releases/aa/runtime.js', integrity: sri(8)}}});

test('the pilot loader and this loader refuse each other in either order', () => {
  const first = page({random: () => 0}).run(loader()).run(pilot, 'https://pub.example/pilot/ads.js');
  assert.equal(first.sandbox.__tesseraExperimentOwner, 'tessera-ab-loader-1.0.0');
  assert.equal(first.sandbox.__adVariantDelivery.snapshot().error, 'existing-runtime-conflict');
  assert.deepEqual(inserted(first), [urlOf(A)], 'The pilot inserts neither Prebid nor an arm');
  assert.equal(first.sandbox.googletag.cmd.length, 1, 'Only this loader queued labels');
  assert.equal(first.snapshot().deliveryMode, 'ab');
  first.clean();

  const second = page({random: () => 0}).run(pilot, 'https://pub.example/pilot/ads.js').run(loader());
  assert.equal(second.sandbox.AdVariant.snapshot().release, AA_RELEASE, 'The pilot keeps its own AdVariant');
  assert.equal(second.state().status, 'existing-runtime-conflict');
  assert.equal(second.state().variant, null);
  assert.deepEqual(inserted(second), ['https://pub.example/pilot/prebid.js'], 'Only the pilot inserted a script');
  assert.equal(second.sandbox.googletag.cmd.length, 1, 'Only the pilot queued a command');
  assert.equal(second.sandbox.__tesseraExperimentOwner, undefined);
  second.clean();
});

test('forced QA loads the named arm with no labels and no draw', () => {
  for (const [search, b, side] of [['?tessera_ab=B', 0, B], ['?x=1&tessera_ab=A', 100, A], ['?tessera_ab=A&y=2', 100, A]]) {
    const p = page({search}).run(loader({trafficBPercent: b}));
    assert.deepEqual(inserted(p), [urlOf(side)]);
    assert.deepEqual(p.draws, []); assert.equal(p.sandbox.googletag, undefined);
    const s = p.snapshot();
    assert.equal(s.status, 'forced'); assert.equal(s.variant, side === A ? 'A' : 'B');
    p.scripts[0].onerror();
    assert.equal(p.scripts.length, 1, 'A forced arm that fails stays failed for QA');
    assert.equal(p.snapshot().armStatus, 'error');
    p.clean();
  }
  for (const search of ['?tessera_ab=b', '?tessera_ab=AB', '?xtessera_ab=B', '?tessera_ab=']) {
    const p = page({search, random: () => 0}).run(loader({trafficBPercent: 100}));
    assert.equal(p.snapshot().status, 'assigned', search);
    assert.deepEqual(inserted(p), [urlOf(B)]);
  }
});

test('an arm error loads control A once before the runtime starts', () => {
  for (const [x, side] of [[4294967295, 'B'], [0, 'A']]) {
    const p = page({random: () => x}).run(loader());
    p.scripts[0].onerror();
    assert.deepEqual(inserted(p), [urlOf(side === 'A' ? A : B), urlOf(A)]);
    let s = p.snapshot();
    assert.equal(s.status, 'fallback-control'); assert.equal(s.fallback, true); assert.equal(s.variant, side, 'The assigned label stays');
    assert.equal(s.scriptRelease, A.release); assert.equal(s.armStatus, 'loading');
    assert.deepEqual(p.labels(), [['Variant', side], ['TestId', 'test_site_1']], 'Labels are queued once');
    p.scripts[1].onerror();
    assert.equal(p.scripts.length, 2, 'Control is retried exactly once');
    s = p.snapshot();
    assert.equal(s.status, 'fallback-control'); assert.equal(s.armStatus, 'error');
    p.clean();
  }
  const loaded = page({random: () => 4294967295}).run(loader());
  loaded.scripts[0].onerror(); loaded.scripts[1].onload();
  assert.equal(loaded.snapshot().armStatus, 'loaded');
  const started = page({random: () => 4294967295}).run(loader());
  started.sandbox.__TESSERA_RUNTIME_STARTED = true;
  started.scripts[0].onerror();
  assert.deepEqual(inserted(started), [urlOf(B)], 'No arm after the runtime started');
  const s = started.snapshot();
  assert.equal(s.status, 'assigned'); assert.equal(s.fallback, false); assert.equal(s.armStatus, 'error'); assert.equal(s.runtimeStarted, true);
  started.clean();
});

test('labels are queued in googletag.cmd before the arm is inserted', () => {
  const log = [], cmd = [];
  cmd.push = function (fn) { log.push('labels'); return Array.prototype.push.call(this, fn); };
  const p = page({random: () => 4294967295, googletag: {cmd}});
  p.log.push = entry => log.push(entry);
  p.run(loader());
  assert.deepEqual(log, ['labels', 'insert ' + urlOf(B)]);
  assert.deepEqual(p.labels(), [['Variant', 'B'], ['TestId', 'test_site_1']]);
  // GPT already loaded: its queue runs commands at once, still before the insert.
  const ready = [], order = [];
  const live = page({random: () => 0, googletag: {cmd: {push: fn => fn()}}});
  live.log.push = entry => order.push(entry);
  live.sandbox.googletag.pubads = () => ({setTargeting: (k, v) => { order.push(k); ready.push([k, v]); }});
  live.run(loader());
  assert.deepEqual(ready, [['Variant', 'A'], ['TestId', 'test_site_1']]);
  assert.deepEqual(order, ['Variant', 'TestId', 'insert ' + urlOf(A)]);
  // A googletag object without a queue gets one.
  const bare = page({random: () => 0, googletag: {}}).run(loader());
  assert.equal(bare.sandbox.googletag.cmd.length, 1);
});

test('the arm is async, SRI-checked, anonymous CORS and resolved against the loader URL', () => {
  const p = page({src: 'https://cdn.example/site/ads.js?v=2', random: () => 0}).run(loader());
  const [s] = p.scripts;
  assert.equal(s.src, `https://cdn.example/site/r/${A.release}/ads.js`);
  assert.equal(s.async, true); assert.equal(s.integrity, A.integrity); assert.equal(s.crossOrigin, 'anonymous');
  assert.equal(s.nonce, undefined); assert.deepEqual(s.attributes, {});
  assert.equal(p.snapshot().script, s.src); assert.equal(p.snapshot().scriptSha256, A.sha256);
});

test('the CSP nonce is copied from the loader tag', () => {
  for (const options of [{nonce: 'n0nce-prop'}, {nonceAttribute: 'n0nce-prop'}]) {
    const p = page({...options, random: () => 0}).run(loader());
    assert.equal(p.scripts[0].nonce, 'n0nce-prop'); assert.equal(p.scripts[0].attributes.nonce, 'n0nce-prop');
    p.scripts[0].onerror();
    assert.equal(p.scripts[1].nonce, 'n0nce-prop', 'The control retry keeps the nonce');
  }
});

test('without a current script nothing runs', () => {
  for (const src of [null, '']) {
    const p = page({src}).run(loader());
    assert.deepEqual(p.scripts, []); assert.deepEqual(p.draws, []); assert.equal(p.sandbox.googletag, undefined);
    assert.equal(p.sandbox.__tesseraAbLoader, undefined); assert.equal(p.sandbox.__tesseraExperimentOwner, undefined);
    assert.equal(p.snapshot().status, 'no-current-script');
    p.clean();
  }
});

test('Variant or TestId in publisher keywords is reported as a key conflict', () => {
  for (const [globals, conflict] of [[{adsKeywords: {Variant: 'X'}}, true], [{ADS_KEYWORDS: {TestId: '1'}}, true],
    [{adsKeywords: {section: 'news'}}, false], [{adsKeywords: Object.create({Variant: 'X'})}, false], [{}, false]]) {
    const p = page({globals, random: () => 0}).run(loader());
    assert.equal(p.snapshot().keyConflict, conflict, JSON.stringify(globals));
    assert.equal(p.sandbox.googletag.cmd.length, 1, 'Labels are still queued');
    p.clean();
  }
  const late = page({random: () => 0}).run(loader());
  late.sandbox.adsKeywords = {TestId: 'x'};
  assert.equal(late.snapshot().keyConflict, true, 'Keywords set after the loader are still seen');
});

test('AdVariant keeps the Debug inspector fields; unknown values are null', () => {
  const p = page({random: () => 0}).run(loader());
  const raw = p.sandbox.AdVariant.snapshot();
  assert(Object.isFrozen(raw)); assert(Object.isFrozen(p.sandbox.AdVariant));
  assert.deepEqual(Object.keys(raw), SNAPSHOT_FIELDS);
  for (const field of INSPECTOR_FIELDS) assert(field in raw, field);
  assert.deepEqual(plain(raw), {loader: '1.0.0', release: 'abx-' + hex('c'), testId: 'test_site_1', testName: 'Bid cache 3.23.0', variant: 'A',
    status: 'assigned', deliveryMode: 'ab', scriptRelease: A.release, scriptName: A.name, script: urlOf(A), scriptSha256: A.sha256,
    armStatus: 'loading', trafficBPercent: 50, prebidVersion: null, blockedDuplicateLoaders: 0, fallback: false, keyConflict: false, runtimeStarted: false});
  p.sandbox.pbjs = {version: 'v10.9.0'};
  assert.equal(p.snapshot().prebidVersion, '10.9.0');
  const inspected = plain(p.sandbox.AdVariant.inspect());
  assert.equal(p.tables.length, 1); assert.equal(inspected.prebidVersion, '10.9.0');
  const none = page({src: null}).run(loader()).snapshot();
  for (const field of ['variant', 'scriptRelease', 'scriptName', 'script', 'scriptSha256', 'armStatus', 'prebidVersion']) assert.equal(none[field], null, field);
  p.clean();
});

test('renderAbLoader keeps hostile names inside the JSON', () => {
  const name = '</script><script>x()</script><!--\u2028\u2029&>';
  const out = loader({name});
  assert(!/<\/script|<!--/i.test(out)); assert(!/[\u2028\u2029]/.test(out));
  const json = out.slice(AB_LOADER_TEMPLATE.indexOf(AB_LOADER_PLACEHOLDER), out.length - (AB_LOADER_TEMPLATE.length - AB_LOADER_TEMPLATE.indexOf(AB_LOADER_PLACEHOLDER) - AB_LOADER_PLACEHOLDER.length));
  assert(!/[<>&]/.test(json));
  assert.equal(JSON.parse(json).name, name);
  parse(out, {ecmaVersion: 5});
  assert.equal(page({random: () => 0}).run(out).snapshot().testName, name);
});

test('renderAbLoader is deterministic and only fills the placeholder', () => {
  const out = loader();
  assert.equal(loader(), out);
  const reordered = {loader: {sha256: registry[AB_LOADER_VERSION].sha256, version: '1.0.0'}, arms: {B: {...B}, A: Object.fromEntries(Object.entries(A).reverse())},
    trafficBPercent: 50, name: 'Bid cache 3.23.0', testId: 'test_site_1', id: 'abx-' + hex('c'), schema: AB_LOADER_CONFIG_SCHEMA};
  assert.equal(renderAbLoader(reordered), out);
  const normalized = {schema: AB_LOADER_CONFIG_SCHEMA, id: 'abx-' + hex('c'), testId: 'test_site_1', name: 'Bid cache 3.23.0', trafficBPercent: 50,
    arms: {A, B}, loader: {version: '1.0.0', sha256: registry[AB_LOADER_VERSION].sha256}};
  assert.equal(out, AB_LOADER_TEMPLATE.replace(AB_LOADER_PLACEHOLDER, () => JSON.stringify(normalized)));
  // A/A: one release serves both arms.
  const same = page({random: () => 4294967295}).run(loader({arms: {A, B: {...A}}}));
  assert.deepEqual(inserted(same), [urlOf(A)]); assert.equal(same.snapshot().variant, 'B');
});

test('renderAbLoader refuses an invalid configuration with a plain reason', () => {
  const armWith = (side, over) => ({arms: {A, B, [side]: {...(side === 'A' ? A : B), ...over}}});
  const cases = [
    [{schema: 'tessera-ab-test-1'}, /unknown schema/],
    [{extra: 1}, /missing or unexpected fields/],
    [{id: 'abx-' + hex('C')}, /"abx-" followed by 64/], [{id: 'builtin-draft-' + hex('a')}, /"abx-"/],
    [{testId: 'Test'}, /TestId of 1 to 24/], [{testId: 'a'.repeat(25)}, /TestId/], [{testId: ''}, /TestId/], [{testId: null}, /TestId/],
    [{name: 'x'.repeat(61)}, /test a name of 1 to 60/], [{name: '  '}, /1 to 60/], [{name: 7}, /1 to 60/],
    [{trafficBPercent: 101}, /0 to 100/], [{trafficBPercent: -1}, /0 to 100/], [{trafficBPercent: 12.5}, /0 to 100/], [{trafficBPercent: '50'}, /0 to 100/],
    [{arms: {A}}, /exactly two versions/], [{arms: {A, B, C: B}}, /exactly two versions/],
    [armWith('B', {release: '../x'}), /Version B has an invalid release id/], [armWith('A', {release: 'Builtin'}), /Version A has an invalid release id/],
    [armWith('B', {path: 'r/other/ads.js'}), /served from r\/<release id>\/ads.js/], [armWith('B', {path: `/r/${B.release}/ads.js`}), /served from/],
    [armWith('A', {sha256: hex('A')}), /sha256/], [armWith('A', {integrity: 'sha256-' + Buffer.alloc(32).toString('base64')}), /sha384 integrity/],
    [armWith('B', {name: ''}), /version B a name of 1 to 160/], [armWith('B', {name: 'n'.repeat(161)}), /1 to 160/],
    [armWith('B', {runtimeVersion: 'latest'}), /runtime version/], [armWith('B', {extra: true}), /Version B has missing or unexpected fields/],
    [{arms: {A, B: {...A, sha256: hex('f')}}}, /same release with different details/],
    [{loader: {version: '1.1.0', sha256: registry[AB_LOADER_VERSION].sha256}}, /needs A\/B loader 1.0.0/],
    [{loader: {version: '1.0.0', sha256: hex('0')}}, /checksum does not match/], [{loader: {version: '1.0.0'}}, /needs A\/B loader/]];
  for (const [over, message] of cases) {
    const error = (() => { try { renderAbLoader(config(over)); } catch (e) { return e; } })();
    assert(error instanceof Error, JSON.stringify(over));
    assert.match(error.message, message); assert.equal(error.status, 400);
    assert.match(error.message, /^[A-Z].*\.$/, 'A plain sentence');
  }
  for (const value of [null, [], 'config']) assert.throws(() => renderAbLoader(value), /missing or unexpected fields/);
});
