import test from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {runtimeLabel, publicRuntimeChoices} from '../../src/site-workspace/runtime-labels.ts';
import {runtimeNotice, runtimeNoticeSuffix, runtimeNoticeText} from '../../src/site-workspace/runtime-notices.ts';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
import {recommendedRuntimeRelease, runtimeNotices} from '../../shared/runtime-notices.mjs';
import {runtimeCatalog, previewInput} from '../../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {compileRuntime321} from '../../worker/runtime-321/compiler.mjs';
import {compileRuntime3212} from '../../worker/runtime-3212/compiler.mjs';
import {compileRuntime322} from '../../worker/runtime-322/compiler.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {conditionalFixture} from '../support/conditional-maps-fixture.mjs';
import {configure, TS} from './artifact-fixture.mjs';
import {runtimeSelectionPage, runtimeSelectionScript} from '../../worker/test-workspace/runtime-selection-page.mjs';

const SUFFIX = ' · No 3.21.1+ fixes';
const WARNING = '3.22.0 adds bidder rules but is built on 3.21.0. It does not have the 3.21.1 and 3.21.2 fixes for page and category size maps when no key-value mapping sets a size map, contextual signals with existing Prebid RTD providers, and the TakeOver frequency cap and debug storage before CMP consent.';
// The same payload shape and recommendation the Script setup endpoint returns.
const runtimes = runtimeCatalog.map(r => ({version: r.version, channel: r.channel, pin: pinRuntime(r, {allowPreview: true})}));
const recommended = recommendedRuntimeRelease(runtimeReleaseHistory);
const current = runtimes.find(r => r.pin.runtimeSha256 === recommended.codeSha256);
const record = runtimeReleaseHistory.find(r => r.version === '3.22.0');
const pinOf = version => runtimes.find(r => r.version === version).pin;

test('only exact registered earlier builds carry notices; the registry is read, never changed', () => {
  const before = JSON.stringify(runtimeReleaseHistory);
  const noticed = runtimeReleaseHistory.filter(r => runtimeNotice({runtimeVersion: r.version, runtimeSha256: r.codeSha256}));
  assert.deepEqual(noticed.map(r => r.version), ['3.25.0','3.24.0','3.23.0','3.22.0']);
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
  for (const item of choices) if (!['3.22.0','3.23.0','3.24.0','3.25.0'].includes(item.version)) assert.equal(runtimeNoticeSuffix(item.pin), '');
  assert.equal(runtimeNoticeSuffix(pinOf('3.23.0')),' · Earlier bid cache');
});

test('warning names the alternative and the current version from data, not from a literal', () => {
  const notice = runtimeNotice(pinOf('3.22.0')), choices = publicRuntimeChoices(runtimes);
  assert.equal(notice.warning, WARNING);
  assert(!/current/i.test(notice.warning), 'The fixed text never names the current version');
  // Derived as the endpoint does, excluding only the exact known earlier cache source.
  assert(current && current.channel === 'stable' && current.version !== '3.22.0');
  assert.equal(runtimeNoticeText(notice, choices, current), `${WARNING} 3.22.2 (Preview) has bidder rules with these fixes. ${current.version} is the current version.`);
  const today = {version: '3.21.2', channel: 'stable', pin: pinOf('3.21.2')};
  assert.equal(runtimeNoticeText(notice, choices, today), `${WARNING} 3.22.2 (Preview) has bidder rules with these fixes. 3.21.2 is the current version.`);
  // A later stable release (for example 3.23.0) becomes current without editing the notice.
  const future = {version: '3.23.0', channel: 'stable', pin: {runtimeVersion: '3.23.0', runtimeSha256: 'a'.repeat(64)}};
  assert.equal(runtimeNoticeText(notice, publicRuntimeChoices([...runtimes, future]), future), `${WARNING} 3.22.2 (Preview) has bidder rules with these fixes. 3.23.0 is the current version.`);
  // Missing recommendation: no current-version sentence.
  assert.equal(runtimeNoticeText(notice, choices, null), `${WARNING} 3.22.2 (Preview) has bidder rules with these fixes.`);
  // The alternative is named only when it is offered.
  assert.equal(runtimeNoticeText(notice, choices.filter(item => item.version !== '3.22.2'), today), `${WARNING} 3.21.2 is the current version.`);
  // If the alternative itself were the stable recommendation, it is named once.
  const promoted = {version: '3.22.2', channel: 'stable', pin: {runtimeVersion: '3.22.2', runtimeSha256: 'b'.repeat(64)}};
  assert.equal(runtimeNoticeText(notice, publicRuntimeChoices([...runtimes, promoted]), promoted), `${WARNING} 3.22.2, the current version, has bidder rules with these fixes.`);
});

test('each notice names an alternative that is offered, has no notice and no newer patch of its line', () => {
  const numbers = version => version.split('.').map(Number);
  for (const notice of runtimeNotices) {
    const alternative = runtimeReleaseHistory.find(r => r.version === notice.alternative.version);
    assert(alternative && runtimeCatalog.some(r => r.version === alternative.version && r.codeSha256 === alternative.codeSha256), notice.alternative.version);
    assert.equal(runtimeNotice({runtimeVersion: alternative.version, runtimeSha256: alternative.codeSha256}), undefined, alternative.version);
    // It has every capability of the noticed version, and no newer patch of the same line with those capabilities replaces it.
    const record = runtimeReleaseHistory.find(r => r.version === notice.version && r.codeSha256 === notice.runtimeSha256);
    assert(record.capabilities.every(c => alternative.capabilities.includes(c)), alternative.version);
    const [major, minor, patch] = numbers(alternative.version);
    const newer = runtimeReleaseHistory.filter(r => { const [m, n, p] = numbers(r.version); return m === major && n === minor && p > patch && alternative.capabilities.every(c => r.capabilities.includes(c)); });
    assert.deepEqual(newer.map(r => r.version), [], `${notice.version}: name the newest patch instead of ${alternative.version}`);
  }
  assert.equal(runtimeNotice(pinOf('3.22.0')).alternative.version, '3.22.2');
});

test('the exact earlier cache source is labelled without changing its channel, pin or availability',()=>{
  const cache=runtimeCatalog.find(r=>r.version==='3.23.0'),notice=runtimeNotice(pinOf('3.23.0'));
  assert.equal(cache.channel,'stable');assert.doesNotThrow(()=>pinRuntime(cache));
  assert.equal(notice.optionSuffix,' · Earlier bid cache');
  assert.match(notice.warning,/bidder activity restriction or a raised price floor/);
  assert.equal(runtimeNotice({runtimeVersion:'3.23.0',runtimeSha256:'f'.repeat(64)}),undefined);
  const choices=publicRuntimeChoices(runtimes),text=runtimeNoticeText(notice,choices,current);
  assert(text.includes('3.25.1 (Preview) has bid caching, bidder accounts and rules with these safeguards and the cache history and expiry fixes.'));
  assert(text.endsWith('3.21.2 is the current version.'));
  assert(!runtimeNoticeText(notice,choices.filter(r=>r.version!=='3.25.1'),current).includes('3.25.1'));
});

test('long-page cache notices match exact sources and retain selectable original pins',()=>{
  for(const version of ['3.24.0','3.25.0']){
    const item=runtimeCatalog.find(r=>r.version===version),pin=pinOf(version),notice=runtimeNotice(pin);
    assert(item);assert.equal(item.channel,'preview');assert.doesNotThrow(()=>pinRuntime(item,{allowPreview:true}));
    assert.equal(notice.runtimeSha256,item.codeSha256);assert.equal(notice.optionSuffix,' · Limited');
    assert.match(notice.warning,/With bid caching enabled/);assert.match(notice.warning,/Fresh auctions continue/);
    assert.equal(notice.alternative.version,'3.25.1');
    assert.equal(runtimeNotice({...pin,runtimeSha256:'0'.repeat(64)}),undefined);
    assert(runtimes.some(r=>r.version===version&&r.pin.runtimeSha256===pin.runtimeSha256));
  }
});

test('a notice with no local alternative renders its warning without inventing a selectable version',()=>{
  const notice={...runtimeNotice(pinOf('3.24.0')),alternative:undefined};
  const text=runtimeNoticeText(notice,publicRuntimeChoices(runtimes));
  assert.equal(text,notice.warning);assert(!text.includes('3.25.1'));
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

// The TEST workspace Script version page (/runtime-selection) is a plain
// script, so run it against a small DOM stub and the payload its endpoint
// returns (worker/test-workspace/runtime-selection.mjs).
function selectionPage() {
  const elements = new Map();
  const node = id => ({id, children: [], attributes: {}, dataset: {}, listeners: {}, textContent: '', value: '', hidden: false, disabled: false, checked: false,
    classList: {toggle() {}}, replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
    addEventListener(type, listener) { this.listeners[type] = listener; }, setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; }, getAttribute(name) { return this.attributes[name] ?? null; }});
  const html = runtimeSelectionPage();
  for (const [, id] of html.matchAll(/ id="([^"]+)"/g)) elements.set(id, node(id));
  const state = {site: {name: 'Test site', domain: 'example.invalid', gamPath: '/123/test/'}, revision: 'r1', selected: null, validationIssue: null,
    enablePrebid: false, prebidBuildId: null, releaseHistory: [], runtimes: runtimeCatalog.map(r => ({id: r.id, version: r.version, channel: r.channel, pin: pinRuntime(r, {allowPreview: true})}))};
  const context = {document: {getElementById: id => elements.get(id) ?? null, createElement: tag => node(tag)}, location: {assign() {}},
    fetch: async () => ({status: 200, ok: true, json: async () => state}), setTimeout, console};
  vm.createContext(context);
  vm.runInContext(runtimeSelectionScript, context);
  const runtime = elements.get('runtime');
  return {html, state, runtime, note: elements.get('runtime-notice'), choose(version) { runtime.value = String(state.runtimes.findIndex(r => r.version === version)); runtime.listeners.change(); }};
}
test('TEST workspace Script version page labels and explains 3.22.0 without an API change', async () => {
  const page = selectionPage();
  await new Promise(resolve => setImmediate(resolve));
  const labels = page.runtime.children.slice(1).map(option => option.textContent);
  assert.deepEqual(labels, page.state.runtimes.map(r => `${r.version} · ${r.channel}${runtimeNoticeSuffix(r.pin)}`));
  assert(page.note, 'The page has a note for the selected version');
  assert.match(page.html, /<p id="runtime-notice"[^>]* role="note"[^>]* hidden>/);
  assert.equal(page.note.hidden, true);
  page.choose('3.22.0');
  assert.equal(page.note.hidden, false);
  assert.equal(page.note.textContent, `${WARNING} 3.22.2 (Preview) has bidder rules with these fixes.`);
  assert.equal(page.runtime.getAttribute('aria-describedby'), 'runtime-notice');
  for (const version of ['3.21.2', '3.22.1']) {
    page.choose(version);
    assert.equal(page.note.hidden, true, version);
    assert.equal(page.note.textContent, '', version);
    assert.equal(page.runtime.getAttribute('aria-describedby'), null, version);
  }
  page.choose('3.23.0');
  assert.equal(page.note.hidden,false);
  assert(page.note.textContent.includes('3.25.1 (Preview) has bid caching, bidder accounts and rules with these safeguards and the cache history and expiry fixes.'));
  assert.equal(page.runtime.getAttribute('aria-describedby'),'runtime-notice');
});
