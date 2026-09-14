/** Explicit developer verification against the user's checksum-locked reference.
 * Usage: node --experimental-strip-types scripts/verify-reference-bridge.mjs ORIGINAL.txt OUTPUT_DIRECTORY
 * Missing original is an error, not a skipped/passed test. No network or storage APIs are used.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Script, runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { extractReference391 } from './extract-reference391.mjs';
import { compileRuntime } from '../worker/runtime-compiler.ts';
import { compileReferenceBuild, prepareReferenceBuild } from '../worker/runtime/reference-bridge.mjs';
import { fixture } from '../tests/runtime/bridge-fixture.mjs';

const [referencePath, outputPath] = process.argv.slice(2);
if (!referencePath || !outputPath) throw new Error('Provide the actual reference file and a new report directory.');
const output = resolve(outputPath);
await mkdir(output, { recursive: true });
const extracted = extractReference391(await readFile(resolve(referencePath)));
const { buildReference391 } = await import(`data:text/javascript;base64,${Buffer.from(extracted.code).toString('base64')}`);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const deps = { buildReference391, compileRuntime };
const scenarios = [
  ['standard', () => {}],
  ['first-then-fixed', ({core}) => { core.adUnitRules.P1 = { refresh: { schedule: { mode: 'firstThenFixed', firstSeconds: 60, nextSeconds: 45 } } }; }],
  ['percentage', ({core}) => { core.adUnitRules.P1 = { refresh: { schedule: { mode: 'percentage', firstSeconds: 30, growthPercent: 50, maxSeconds: 90 } } }; }],
  ['sequence', ({core}) => { core.adUnitRules.P1 = { refresh: { schedule: { mode: 'sequence', sequenceSeconds: [30, 60, 120] } } }; }],
  ['gpt-only', ({options}) => { options.enablePrebid = false; }],
  ['no-bidders', ({core}) => { core.bidders = []; }],
  ['sticky-off', ({options}) => { options.sticky.bottomAdUnitId = null; }],
  ['takeover-off', ({options}) => { options.takeOver.enabled = false; }],
  ['floor-off', ({options}) => { options.floors.enabled = false; }],
  ['id5-explicit', ({core}) => { core.userSync.userIds = [{name: 'id5Id', params: {partner: 42}, storage: {name: 'id5id', type: 'html5', expires: 30}}]; }],
  ['custom-takeover', ({options}) => { options.takeOver.desktopSize = [640, 480]; options.takeOver.mobileSize = [320, 100]; options.takeOver.autoCloseDesktopSec = 1; options.takeOver.autoCloseMobileSec = 1; }],
  ['short-timeout', ({options}) => { options.takeOver.requestTimeoutMs = 1000; options.takeOver.renderFallbackMs = 20; }],
  ['timer-disabled', ({options}) => { options.takeOver.autoCloseDesktopSec = 0; options.takeOver.autoCloseMobileSec = 0; }],
  ['cmp-8000', ({core}) => { core.maxCmpTimeout = 8000; }],
  ['currency-usd', ({options}) => { options.floors.currency = 'USD'; }],
];
const results = [];
const takeoverBlock = (source) => {
  const start = source.indexOf('  function takeOverEvent(type, data){');
  const end = source.indexOf('  /* ====== GPT definicije ====== */', start);
  assert.ok(start >= 0 && end > start); return source.slice(start, end);
};
for (const [name, mutate] of scenarios) {
  const f = fixture(); mutate(f); const before = JSON.stringify(f);
  const prepared = prepareReferenceBuild(f.core, f.options);
  const original = buildReference391(prepared.settings, {buildTimestamp: prepared.buildTimestamp});
  const compiled = compileReferenceBuild(f.core, f.options, deps);
  new Script(compiled.adsJs); new Script(compiled.adsMinJs);
  assert.equal(compiled.adsJs, compileReferenceBuild(f.core, f.options, deps).adsJs);
  assert.equal(JSON.stringify(f), before);
  assert.equal(takeoverBlock(compiled.adsJs), takeoverBlock(original), 'TakeOver function bodies must stay unchanged');
  assert.equal(compiled.warnings.length, 0);
  if (name === 'sticky-off') assert.match(compiled.adsJs, /var STICKY_TARGET_ID = "";/);
  if (name === 'floor-off') {
    assert.match(compiled.adsJs, /floors: \{\n  enabled: false,/);
    assert.match(compiled.adsJs, /var HARD_FLOOR_EUR = 0;/);
  }
  assert.match(compiled.adsJs, name === 'id5-explicit' ? /var ID5_PARTNER_ID = 42;/ : /var ID5_PARTNER_ID = 0;/);
  if (['first-then-fixed', 'percentage', 'sequence'].includes(name)) {
    const start = compiled.adsJs.indexOf('function getAdUnitRefreshRule(code){');
    const end = compiled.adsJs.indexOf('function getSlotViewPct(id){', start);
    const expected = name === 'first-then-fixed' ? [60, 45, 45, 45] : name === 'percentage' ? [30, 45, 68, 90] : [30, 60, 120, 120];
    for (let count = 0; count < expected.length; count++) {
      const context = {
        getAdUnitRuntimeRule: () => f.core.adUnitRules.P1,
        isMobile: () => false, MIN_SECONDS_BETWEEN_REFRESHES: 30, DWELL_MIN_VIEW_SEC: 30,
        _refreshCounts: {P1: count}, REFRESH_MAX_INTERVAL_SEC: 120, REFRESH_EXIT_PCT: 10, MAX_REFRESHES_PER_SLOT: 20,
      };
      assert.equal(runInNewContext(`${compiled.adsJs.slice(start, end)};getAdUnitRefreshRule('P1').minSeconds;`, context), expected[count]);
    }
  }
  const filename = `${name}.js`;
  await writeFile(join(output, filename), compiled.adsJs);
  results.push({ name, passed: true, file: filename, sha256: sha(compiled.adsJs), bytes: Buffer.byteLength(compiled.adsJs), takeoverBodySha256: sha(takeoverBlock(compiled.adsJs)) });
}
for (const [name, mutate, message] of [
  ['reject-duplicate-takeover-unit', (f) => f.core.explicitUnits.push({id:'TakeOver'}), /NE dodaje/],
  ['reject-invalid-date', (f) => { f.options.buildTimestamp = '20260230_120000'; }, /valid UTC date/],
  ['reject-invalid-creative-size', (f) => { f.options.takeOver.desktopSize = [0, 600]; }, /neispravnu veli/],
  ['reject-out-of-range-timer', (f) => { f.options.takeOver.autoCloseMobileSec = -1; }, /između/],
]) {
  const f = fixture(); mutate(f);
  assert.throws(() => compileReferenceBuild(f.core, f.options, deps), message);
  results.push({name, passed: true});
}
const report = { source: extracted.manifest, passed: results.length, failed: 0, cases: results,
  scope: 'Real reference through existing compiler. Syntax, deterministic output, selected rule behavior and unchanged TakeOver bodies. Browser tests are separate; not a production release.' };
await writeFile(join(output, 'generation-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({passed: report.passed, failed: report.failed, report: join(output, 'generation-report.json')}));
