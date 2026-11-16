import test from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {runtimeLabel, publicRuntimeChoices} from '../../src/site-workspace/runtime-labels.ts';
import {runtimeNotice, runtimeNoticeSuffix, runtimeNoticeText} from '../../src/site-workspace/runtime-notices.ts';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
import {runtimeCatalog, previewInput} from '../../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {compileRuntime321} from '../../worker/runtime-321/compiler.mjs';
import {compileRuntime3212} from '../../worker/runtime-3212/compiler.mjs';
import {compileRuntime322} from '../../worker/runtime-322/compiler.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {conditionalFixture} from '../support/conditional-maps-fixture.mjs';
import {configure, TS} from './artifact-fixture.mjs';

const SUFFIX = ' · No 3.21.1+ fixes';
const WARNING = '3.22.0 adds bidder rules but is built on 3.21.0. It does not have the 3.21.1 and 3.21.2 fixes for page and category size maps when no key-value mapping sets a size map, contextual signals with existing Prebid RTD providers, and the TakeOver frequency cap and debug storage before CMP consent.';
// The same payload shape and recommendation the Script setup endpoint returns.
const runtimes = runtimeCatalog.map(r => ({version: r.version, channel: r.channel, pin: pinRuntime(r, {allowPreview: true})}));
const recommended = runtimeReleaseHistory.find(r => r.channel === 'stable');
const current = runtimes.find(r => r.pin.runtimeSha256 === recommended.codeSha256);
const record = runtimeReleaseHistory.find(r => r.version === '3.22.0');
const pinOf = version => runtimes.find(r => r.version === version).pin;

test('only the exact registered 3.22.0 build carries a notice; the registry is read, never changed', () => {
  const before = JSON.stringify(runtimeReleaseHistory);
  const noticed = runtimeReleaseHistory.filter(r => runtimeNotice({runtimeVersion: r.version, runtimeSha256: r.codeSha256}));
  assert.deepEqual(noticed.map(r => r.version), ['3.22.0']);
  const notice = runtimeNotice(pinOf('3.22.0'));
  assert.equal(notice.runtimeSha256, record.codeSha256);
  assert.equal(record.channel, 'stable', '3.22.0 stays a stable, savable choice without preview opt-in');
  assert.doesNotThrow(() => pinRuntime(runtimeCatalog.find(r => r.version === '3.22.0')));
  for (const pin of [null, undefined, {}, {runtimeVersion: '3.22.0'}, {runtimeVersion: '3.22.0', runtimeSha256: 'f'.repeat(64)}, {runtimeVersion: '3.22.0-tessera.preview.1', runtimeSha256: record.codeSha256}])
    assert.equal(runtimeNotice(pin), undefined, JSON.stringify(pin));
  assert.equal(JSON.stringify(runtimeReleaseHistory), before);
});

test('Script setup labels: 3.22.0 gets the short suffix, order and every other label are unchanged', () => {
  const choices = publicRuntimeChoices(runtimes);
  const labels = choices.map(item => runtimeLabel(item.version) + (item.channel === 'preview' ? ' · Preview' : '') + runtimeNoticeSuffix(item.pin));
  // Order stays by version number; the notice only appends text. Relative
  // positions keep this true when a later release is added above them.
  const index = version => choices.findIndex(item => item.version === version);
  assert.deepEqual([index('3.22.0') - index('3.22.1'), index('3.21.2') - index('3.22.0')], [1, 1]);
  assert.deepEqual(['3.22.1', '3.22.0', '3.21.2'].map(version => labels[index(version)]), ['3.22.1 · Preview', '3.22.0' + SUFFIX, '3.21.2']);
  assert.deepEqual(labels.filter(label => label.includes(SUFFIX)), ['3.22.0' + SUFFIX]);
  assert.equal(SUFFIX.split(' · ')[1], 'No 3.21.1+ fixes', 'Verifiers split labels on the existing separator');
  for (const item of choices) if (item.version !== '3.22.0') assert.equal(runtimeNoticeSuffix(item.pin), '');
});

test('warning names the alternative and the current version from data, not from a literal', () => {
  const notice = runtimeNotice(pinOf('3.22.0')), choices = publicRuntimeChoices(runtimes);
  assert.equal(notice.warning, WARNING);
  assert(!/current/i.test(notice.warning), 'The fixed text never names the current version');
  // Derived as the endpoint does: the first stable registry record (3.21.2 on this branch).
  assert(current && current.channel === 'stable' && current.version !== '3.22.0');
  assert.equal(runtimeNoticeText(notice, choices, current), `${WARNING} 3.22.1 (Preview) has bidder rules with these fixes. ${current.version} is the current version.`);
  const today = {version: '3.21.2', channel: 'stable', pin: pinOf('3.21.2')};
  assert.equal(runtimeNoticeText(notice, choices, today), `${WARNING} 3.22.1 (Preview) has bidder rules with these fixes. 3.21.2 is the current version.`);
  // A later stable release (for example 3.23.0) becomes current without editing the notice.
  const future = {version: '3.23.0', channel: 'stable', pin: {runtimeVersion: '3.23.0', runtimeSha256: 'a'.repeat(64)}};
  assert.equal(runtimeNoticeText(notice, publicRuntimeChoices([...runtimes, future]), future), `${WARNING} 3.22.1 (Preview) has bidder rules with these fixes. 3.23.0 is the current version.`);
  // Missing recommendation: no current-version sentence.
  assert.equal(runtimeNoticeText(notice, choices, null), `${WARNING} 3.22.1 (Preview) has bidder rules with these fixes.`);
  // The alternative is named only when it is offered.
  assert.equal(runtimeNoticeText(notice, choices.filter(item => item.version !== '3.22.1'), today), `${WARNING} 3.21.2 is the current version.`);
  // If the alternative itself were the stable recommendation, it is named once.
  const promoted = {version: '3.22.1', channel: 'stable', pin: {runtimeVersion: '3.22.1', runtimeSha256: 'b'.repeat(64)}};
  assert.equal(runtimeNoticeText(notice, publicRuntimeChoices([...runtimes, promoted]), promoted), `${WARNING} 3.22.1, the current version, has bidder rules with these fixes.`);
});

// The warning's claims, checked against generated output from one synthetic
// config. 3.22.0 keeps the 3.21.0 functions that 3.21.1/3.21.2 replaced.
function functions(source) {
  const out = new Map();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id) out.set(node.id.name, source.slice(node.start, node.end));
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
  })(parse(source, {ecmaVersion: 2015}));
  return out;
}
test('the fixes named in the warning are absent from generated 3.22.0 and present in 3.21.2', () => {
  const snapshot = configure(positionFixture(true), c => { c.runtimeControls.adPositions.Overlay.frequencyMinutes = 5; });
  const build = (version, compile) => compile(previewInput(snapshot, runtimeCatalog.find(r => r.version === version), TS)).adsJs;
  const old = build('3.21.0', compileRuntime321), audited = build('3.21.2', compileRuntime3212), legacy = build('3.22.0', compileRuntime322);
  const [f0, f2, f22] = [old, audited, legacy].map(functions);
  for (const name of ['adConditionalConfig', 'createContextualSignals']) {
    assert.equal(f22.get(name), f0.get(name), `${name}: 3.22.0 keeps the 3.21.0 implementation`);
    assert.notEqual(f22.get(name), f2.get(name), `${name}: 3.21.2 has the audited implementation`);
  }
  for (const name of ['createConsentStorage', 'resolveTakeOverCap', 'tesseraBootRelease']) {
    assert(f2.has(name), `3.21.2 has ${name}`);
    assert(!f22.has(name), `3.22.0 lacks ${name}`);
  }
  const debugStorage = source => (source.match(/localStorage\.(?:getItem|setItem|removeItem)\(\s*['"]ADOPS_DEBUG['"]/g) || []).length;
  assert.equal(debugStorage(legacy), 3);
  assert.equal(debugStorage(audited), 0);
});

// adConditionalConfig in a VM. The unit's base map is 'base'; the page and
// category maps chosen before the rules run are 'category' (GPT) and
// 'prebid-category' (Prebid).
function sizeMaps(source, selected) {
  const context = {AD_CONDITIONAL_UNITS: {P2: {usesGeo: false, baseMap: 'base', maps: ['base', 'category', 'rule']}}, AD_CONDITIONAL_DECISIONS: {},
    AD_GEO_STATE: {settled: true}, adGeoSelect: () => selected, document: {getElementById: () => null}};
  vm.createContext(context);
  vm.runInContext(`${source}; this.adConditionalConfig = adConditionalConfig;`, context);
  const config = context.adConditionalConfig('P2', {sizeMapName: 'category', prebidSizeConfigName: 'prebid-category'});
  return [config.sizeMapName, config.prebidSizeConfigName];
}
test('3.22.0 drops page and category size maps whenever no key-value mapping sets a size map', () => {
  const snapshot = conditionalFixture({prebid: true});
  const source = (version, compile) => functions(compile(previewInput(snapshot, runtimeCatalog.find(r => r.version === version), TS)).adsJs).get('adConditionalConfig');
  // No mapping matches; a mapping matches but only enables the slot; a mapping sets a size map.
  const cases = {noMatch: undefined, matchWithoutMap: {sizeMapKey: null, slotAction: 'enable'}, matchWithMap: {sizeMapKey: 'rule', slotAction: 'inherit'}};
  const run = text => Object.fromEntries(Object.entries(cases).map(([name, selected]) => [name, sizeMaps(text, selected)]));
  const legacy = run(source('3.22.0', compileRuntime322));
  assert.deepEqual(legacy, run(source('3.21.0', compileRuntime321)));
  assert.deepEqual(legacy, {noMatch: ['base', 'base'], matchWithoutMap: ['base', 'base'], matchWithMap: ['rule', 'rule']});
  assert.deepEqual(run(source('3.21.2', compileRuntime3212)), {noMatch: ['category', 'prebid-category'], matchWithoutMap: ['category', 'prebid-category'], matchWithMap: ['rule', 'rule']});
});
