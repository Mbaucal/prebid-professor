import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {parse} from 'acorn';
import {unzipSync} from 'fflate';
import {DEFAULT_PACKAGE_SETTINGS, validatePackageSettings} from '../../worker/experiments/package-settings-v1.mjs';
import {configuredCacheArm, configuredCacheLoader} from '../../worker/experiments/configurable-cache-v1.mjs';
import {cacheArm, CACHE_RELEASE} from '../../worker/experiments/full-cache-v2.mjs';
import {buildConfigurableABPackage} from '../../scripts/configurable-ab-package.mjs';
import {sha256, integrity} from '../../scripts/static-aa-package.mjs';

const base = readFileSync('.generated/tanjug-pilot/ads.js');
const previousArchive = readFileSync('.generated/tanjug-cmp/tanjug-aa-1.0.2.zip');
const settings = () => structuredClone(DEFAULT_PACKAGE_SETTINGS);
const release = 'tanjug-ab-2.0.0-' + 'a'.repeat(64);

test('settings are strict, canonical and do not silently clamp a ten-second interval', () => {
  const s = settings(); s.arms.A.refreshSeconds = 10; s.arms.B.refreshSeconds = 10;
  const result = validatePackageSettings(s);
  assert.equal(result.arms.A.refreshSeconds, 10);
  assert.equal(result.arms.B.refreshSeconds, 10);
  assert(Object.isFrozen(result.arms.A));
  s.arms.A.refreshSeconds = 99;
  assert.equal(result.arms.A.refreshSeconds, 10);
  for (const patch of [
    s => {s.trafficBPercent = '50';}, s => {s.trafficBPercent = 101;},
    s => {s.arms.A.refreshSeconds = 0;}, s => {s.arms.B.refreshSeconds = 1.5;},
    s => {s.arms.A.refreshSeconds = Infinity;}, s => {delete s.arms.A.refreshSeconds;},
    s => {s.arms.B.maxBidAgeSeconds = 301;}, s => {s.arms.B.maxBidAgeSeconds = 0;},
    s => {s.arms.A.maxBidAgeSeconds = 60;}, s => {s.arms.B.mode = 'cache-first';},
    s => {s.arms.B.readyBidRefreshSeconds = 10;}, s => {s.publish = true;},
  ]) {const bad = settings(); patch(bad); assert.throws(() => validatePackageSettings(bad));}
});

test('preserve-schedule mode retains reviewed runtime behavior outside the new release guard', () => {
  for (const v of ['A','B']) assert.equal(configuredCacheArm(base.toString(), v, settings(), release),
    cacheArm(base.toString(), v).replaceAll(CACHE_RELEASE, release));
});

function declarations(source) {
  const functions = new Map(), variables = new Map();
  function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'FunctionDeclaration') functions.set(n.id.name, source.slice(n.start, n.end));
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) variables.set(n.id.name, source.slice(n.init.start, n.init.end));
    for (const c of Object.values(n)) if (Array.isArray(c)) c.forEach(walk); else if (c && typeof c === 'object') walk(c);
  }
  walk(parse(source, {ecmaVersion:'latest'}));
  return {functions, variables};
}

test('manual refresh overrides conflicting inherited schedules and aligns mobile/sticky timers', () => {
  for (const interval of [1,10,45,7200]) for (const v of ['A','B']) {
    const s = settings(); s.arms[v].refreshSeconds = interval;
    const {functions, variables} = declarations(configuredCacheArm(base.toString(), v, s, release));
    const rule = {refresh:{enabled:false,minSeconds:90,minGapSeconds:120,minViewPct:70,maxRefreshes:7,
      schedule:{mode:'sequence',sequenceSeconds:[120,180]}}};
    const context = vm.createContext({getAdUnitRuntimeRule:()=>rule,isMobile:()=>true,_refreshCounts:{P1:3},REFRESH_EXIT_PCT:10});
    for (const name of ['STICKY_TOP_REFRESH_SEC','STICKY_REFRESH_SEC','DWELL_MIN_VIEW_SEC',
      'MIN_SECONDS_BETWEEN_REFRESHES','MOBILE_MIN_SECONDS_BETWEEN_REFRESHES']) {
      assert.equal(Number(variables.get(name)), interval, name);
      context[name] = Number(variables.get(name));
    }
    vm.runInContext(functions.get('getAdUnitRefreshRule'), context);
    const applied = vm.runInContext('getAdUnitRefreshRule("P1")', context);
    assert.equal(applied.minSeconds, interval); assert.equal(applied.minGapSeconds, interval);
    assert.equal(applied.enabled, false); assert.equal(applied.minViewPct, 70); assert.equal(applied.maxRefreshes, 7);
    assert.equal(rule.refresh.minSeconds, 90, 'Reading settings cannot mutate inherited source rules.');
  }
});

test('either variant can enable the validated cache cap', () => {
  const s = settings(); s.arms.A = {mode:'auction-with-cache',refreshSeconds:null,maxBidAgeSeconds:45};
  s.arms.B = {mode:'fresh-only',refreshSeconds:null};
  assert.match(configuredCacheArm(base.toString(),'A',s,release), /mode:'auction-with-cache',maxAgeSeconds:45,/);
  assert.doesNotMatch(configuredCacheArm(base.toString(),'B',s,release), /function ensureCacheLifecycle/);
});

function loaderState(config, sample, code = configuredCacheLoader(config)) {
  const inserted = [], tag = {src:'https://cdn.example.com/ads.js'};
  const window = {__tcfapi(){},pbjs:{version:'11.34.0'},crypto:{getRandomValues(a){a[0]=sample;return a;}},
    googletag:{cmd:[],pubads:()=>({getSlots:()=>[]})}};
  const document = {currentScript:tag,readyState:'complete',scripts:[tag],baseURI:'https://www.tanjug.rs/',
    createElement:()=>({}),head:{appendChild:s=>inserted.push(s)}};
  const context = vm.createContext({window,document,URL,Uint32Array,WeakSet,Date,console,setTimeout:()=>1,clearTimeout(){}});
  vm.runInContext(code, context); vm.runInContext(code, context);
  return {snapshot: window.AdVariant.snapshot(), inserted};
}

test('allocation boundaries, stop allocations and reversed cache arms select one matching script', () => {
  for (const traffic of [0,10,50,90,100]) {
    const s = settings(); s.trafficBPercent = traffic;
    s.arms.A = {mode:'auction-with-cache',refreshSeconds:10,maxBidAgeSeconds:45};
    s.arms.B = {mode:'fresh-only',refreshSeconds:20};
    const config = {release,settings:s,positions:['P1'],prebidVersion:'11.34.0',arms:{
      A:{path:'A.js',integrity:'A',sha256:'a'},B:{path:'B.js',integrity:'B',sha256:'b'}}};
    const boundary = 4294967296 * (100-traffic)/100;
    for (const sample of new Set([0,4294967295,Math.max(0,Math.ceil(boundary)-1),Math.min(4294967295,Math.ceil(boundary))])) {
      const expected = sample < boundary ? 'A' : 'B', {snapshot,inserted} = loaderState(config,sample);
      assert.equal(snapshot.variant,expected); assert.equal(inserted.length,1);
      assert(inserted[0].src.endsWith('/'+expected+'.js')); assert.equal(inserted[0].integrity,expected);
      assert.equal(snapshot.mode,s.arms[expected].mode); assert.equal(snapshot.refreshSeconds,s.arms[expected].refreshSeconds);
      assert.equal(snapshot.blockedDuplicateLoaders,1);
    }
  }
});

test('full packages are deterministic, pinned, minified and settings changes produce new releases', async () => {
  const s = settings(); s.arms.A.refreshSeconds=10; s.arms.B.refreshSeconds=10;
  const build = settings => buildConfigurableABPackage({base,previousArchive,settings});
  const a = await build(s), b = await build(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(a.archive,b.archive); assert.equal(a.release,b.release);
  const files = unzipSync(a.archive), m = a.manifest;
  assert.equal(Object.keys(files).length,9); assert.equal(m.config.positions.length,19);
  for (const [n,e] of Object.entries(m.files)) {assert.equal(files[n].length,e.bytes);assert.equal(sha256(files[n]),e.sha256);}
  assert.deepEqual(files['prebid.js'],files[m.config.prebidPath]);
  for (const v of ['A','B']) assert.equal(integrity(files[m.config.arms[v].path]),m.config.arms[v].integrity);
  for (const n of ['ads.js',m.config.arms.A.path,m.config.arms.B.path]) {
    const code = Buffer.from(files[n]).toString(),comments=[];
    parse(code,{ecmaVersion:'latest',onComment:comments}); assert.equal(comments.length,0);
    assert(!code.includes('tanjug-ab-2.0.0-'+'0'.repeat(64)), 'No placeholder release survives compilation.');
  }
  for (const sample of [0,4294967295]) {
    const state=loaderState(m.config,sample,Buffer.from(files['ads.js']).toString());
    assert.equal(state.snapshot.release,a.release); assert.equal(state.snapshot.refreshSeconds,10);
    assert.equal(state.snapshot.scriptSha256,m.config.arms[state.snapshot.variant].sha256);
  }
  s.trafficBPercent=10; const changed=await build(s); assert.notEqual(changed.release,a.release);
  s.arms.B.refreshSeconds=11; assert.notEqual((await build(s)).release,changed.release);
  assert.equal(sha256(previousArchive),'bd0d9a6973903a3ec585f88e4b815eefb7a061ec8a32593f671b53ce211dfb1e');
  await assert.rejects(()=>buildConfigurableABPackage({base:Buffer.from('changed'),previousArchive,settings:s}));
});
