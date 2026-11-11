import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from 'acorn';
import {createContextualSignals} from '../../worker/runtime-321/browser-contextual.mjs';
import {PREBID_CONTEXTUAL_MODULE_SOURCE} from '../../worker/runtime-321/prebid-module.mjs';
import {compileRuntime321, contextualCompletionHook} from '../../worker/runtime-321/compiler.mjs';
import {previewInput} from '../../worker/runtime-321/snapshot.mjs';
import {buildArtifactCandidate} from '../../worker/runtime-321/artifact-candidate.mjs';
import {descriptor} from '../../.generated/runtime-321-manifest.mjs';
import {fixture, configure, checkedFixture} from './artifact-fixture.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {createTesseraReadiness} from '../../worker/runtime-3161/browser-readiness.mjs';

const settings = (overrides = {}) => ({schemaVersion: 1, enabled: true, sourceKey: 'category', providerName: 'publisher.invalid', prebidVersion: '11.34.0',
  gam: {enabled: true}, bidders: [{bidder: 'openx', taxonomy: 'iab-content-2.2'}, {bidder: 'ix', taxonomy: 'iab-content-3.0'}],
  mappings: [{value: 'Sports', taxonomies: {'iab-content-2.2': ['483'], 'iab-content-3.0': ['VK7KD0']}},
    {value: 'Books', taxonomies: {'iab-content-2.2': ['42'], 'iab-content-3.0': ['42']}},
    {value: 'Sport', taxonomies: {'iab-content-2.2': ['483']}}], ...overrides});
const plain = value => JSON.parse(JSON.stringify(value));
function harness(config = settings(), {category = 'Sports', pps = {}, api = true} = {}) {
  const sent = [], requests = [], writes = [], configWrites = [];
  let currentPps = pps;
  const win = {adsKeywords: {category}, googletag: api ? {setConfig(value) { writes.push(plain(value)); currentPps = value.pps; }} : {}};
  const pb = {version: 'v11.34.0', getConfig() {return {};}, setConfig(value) {configWrites.push(value);}};
  const context = createContextualSignals(win, config, {
    request(pb, input) { requests.push(input); return input.auctionId; },
    dispatch(service, slots, options) { sent.push({slots: slots.map(slot => slot.id), options, pps: plain(currentPps)}); return 'sent'; },
    code: slot => slot.id,
  });
  function request(id, codes = ['P1'], callback = () => {}) { return context.request(pb, {auctionId: id, adUnits: codes.map(code => ({code})), bidsBackHandler: callback}); }
  function fragments(id, global = {}, bidder = {}) { const value = {auctionId: id, ortb2Fragments: {global, bidder}}; context.enrichAuction(value); return value.ortb2Fragments; }
  return {context, win, pb, sent, requests, writes, configWrites, request, fragments};
}
const dataFor = (fragments, bidder) => fragments.bidder[bidder]?.site?.content?.data || [];

test('routes explicit separate taxonomies without global mutation, SChain loss or data replacement', () => {
  const state = harness();
  const schain = {ver: '1.0', complete: 1, nodes: [{asi: 'ringier.rs', sid: '20221205191920', hp: 1}]};
  const global = {source: {ext: {schain}}, site: {name: 'Foreign name', content: {data: [{name: 'other.invalid', ext: {segtax: 6}, segment: [{id: '44'}]}]}}};
  const foreignBidder = {source: {ext: {schain}}, user: {ext: {existing: true}}, site: {name: 'Bidder site', content: {title: 'Article', data: [{name: 'another.invalid', ext: {segtax: 4}, segment: [{id: '7'}]}]}}};
  const untouched = plain({global, foreignBidder});
  state.request('auction-one');
  const result = state.fragments('auction-one', global, {openx: foreignBidder, other: {site: {name: 'Unselected'}}});
  assert.deepEqual(global, untouched.global);
  assert.deepEqual(foreignBidder.user, untouched.foreignBidder.user);
  assert.deepEqual(foreignBidder.source, untouched.foreignBidder.source);
  assert.deepEqual(foreignBidder.site.content.data[0], untouched.foreignBidder.site.content.data[0]);
  assert.deepEqual(result.bidder.openx.source.ext.schain, schain);
  assert.deepEqual(result.bidder.openx.user, foreignBidder.user);
  assert.equal(result.bidder.openx.site.name, 'Bidder site');
  assert.equal(result.bidder.openx.site.content.title, 'Article');
  assert.deepEqual(dataFor(result, 'openx').map(data => data.ext.segtax), [4, 6]);
  assert.deepEqual(dataFor(result, 'openx')[1].segment, [{id: '483'}]);
  assert.deepEqual(dataFor(result, 'ix'), [{name: 'publisher.invalid', ext: {segtax: 7}, segment: [{id: 'VK7KD0'}]}]);
  assert.deepEqual(result.bidder.other, {site: {name: 'Unselected'}});
});

test('delayed and concurrent auctions retain their own category and matching GAM PPS', () => {
  const state = harness();
  state.request('sports', ['P1']);
  state.win.adsKeywords.category = 'Books';
  state.request('books', ['P2']);
  state.win.adsKeywords.category = 'Unknown';
  const second = state.fragments('books'), first = state.fragments('sports');
  assert.deepEqual(dataFor(first, 'openx')[0].segment, [{id: '483'}]);
  assert.deepEqual(dataFor(second, 'openx')[0].segment, [{id: '42'}]);
  state.context.dispatch({}, [{id: 'P2'}, {id: 'P1'}], {changeCorrelator: false});
  assert.deepEqual(state.sent.map(row => [row.slots, row.pps.taxonomies.IAB_CONTENT_2_2.values]), [[['P2'], ['42']], [['P1'], ['483']]]);
  assert.deepEqual(state.sent[0].options, {changeCorrelator: false});
});

test('refresh reads fresh context; absent or unknown values clear prior managed PPS and add no bidder data', () => {
  const state = harness();
  state.request('initial'); state.fragments('initial'); state.context.dispatch({}, [{id: 'P1'}]);
  state.win.adsKeywords.category = 'Books';
  state.request('refresh'); state.fragments('refresh'); state.context.dispatch({}, [{id: 'P1'}]);
  delete state.win.adsKeywords.category;
  state.request('unknown'); assert.deepEqual(state.fragments('unknown'), {global: {}, bidder: {}});
  state.context.dispatch({}, [{id: 'P1'}]);
  assert.deepEqual(state.sent.map(row => row.pps.taxonomies.IAB_CONTENT_2_2.values), [['483'], ['42'], []]);
});

test('same-position concurrent auctions bind context to completion rather than request-start order', () => {
  for (const order of [[0, 1], [1, 0]]) {
    const state = harness();
    state.request('sports', ['P1'], () => state.context.dispatch({}, [{id: 'P1'}]));
    state.win.adsKeywords.category = 'Books';
    state.request('books', ['P1'], () => state.context.dispatch({}, [{id: 'P1'}]));
    state.win.adsKeywords.category = 'Unknown';
    order.forEach(index => state.requests[index].bidsBackHandler({}, false, state.requests[index].auctionId));
    assert.deepEqual(state.sent.map(row => row.pps.taxonomies.IAB_CONTENT_2_2.values), order.map(index => index ? ['42'] : ['483']));
  }
});

test('real consent readiness pairs same-position targeting and PPS across deferred delivery', () => {
  const queue = new Map(), listeners = new Set(), requests = [], sent = [];
  let timer = 0, pps, nativeTarget = {}, cmp;
  const win = {adsKeywords: {category: 'Sports'}, setTimeout(fn, delay) {queue.set(++timer, {fn, delay}); return timer;}, clearTimeout(id) {queue.delete(id);},
    __tcfapi(command, version, callback) {cmp = callback;}, googletag: {setConfig(value) {pps = value.pps;}}};
  const flush = () => {for (let count = 0; count < 100; count++) {const task = [...queue].find(([, task]) => task.delay === 0); if (!task) return; queue.delete(task[0]); task[1].fn();} throw Error('Unbounded immediate work');};
  const pb = win.pbjs = {setConfig() {}, getConfig() {return {};}, onEvent(name, fn) {listeners.add(fn);}, offEvent(name, fn) {listeners.delete(fn);},
    requestBids(input) {requests.push(input); [...listeners].forEach(fn => fn({auctionId: input.auctionId}));}, getAdserverTargetingForAdUnitCode() {return nativeTarget;}};
  const slot = {id: 'P1', targeting: {}};
  const context = createContextualSignals(win, settings(), {request: (pb, input) => pb.requestBids(input), dispatch: () => sent.push({target: {...slot.targeting}, pps: plain(pps)}), code: slot => slot.id});
  const readiness = vm.runInNewContext('(' + contextualCompletionHook(createTesseraReadiness.toString()) + ')');
  const ready = readiness(win, {rawRequest: context.request, rawDispatch: context.dispatch, contextFinished: context.finished, clear: slot => {slot.targeting = {};}, apply: (slot, target) => Object.assign(slot.targeting, target), code: slot => slot.id});
  cmp({gdprApplies: false}, true);
  function request() {ready.request(pb, {adUnits: [{code: 'P1'}], bidsBackHandler() {ready.dispatch({}, [slot]);}}); flush();}
  request(); win.adsKeywords.category = 'Books'; request(); win.adsKeywords.category = 'Unknown';
  function complete(index) {const req = requests[index], adId = 'ad-' + index; nativeTarget = {hb_adid: adId}; req.bidsBackHandler({P1: {bids: [{auctionId: req.auctionId, adUnitCode: 'P1', adId, cpm: 1, ttl: 60, responseTimestamp: Date.now()}]}}, false, req.auctionId);}
  complete(0); flush(); complete(1); flush();
  assert.deepEqual(sent.map(value => [value.target.hb_adid, value.pps.taxonomies.IAB_CONTENT_2_2.values]), [['ad-0', ['483']], ['ad-1', ['42']]]);
  // Both callbacks may arrive before the scheduled delivery. Readiness coalesces
  // that slot and uses its latest completion; PPS must follow the same record.
  win.adsKeywords.category = 'Sports'; request(); win.adsKeywords.category = 'Books'; request();
  complete(3); complete(2); flush();
  assert.deepEqual([sent[2].target.hb_adid, sent[2].pps.taxonomies.IAB_CONTENT_2_2.values], ['ad-2', ['483']]);
  // A new request can begin after completion but before queued GAM delivery.
  win.adsKeywords.category = 'Sports'; request(); complete(4);
  win.adsKeywords.category = 'Books'; request();
  assert.deepEqual(sent[3].pps.taxonomies.IAB_CONTENT_2_2.values, ['483']);
  // Readiness's own watchdog (no raw callback) still selects its auction's PPS.
  const watchdog = [...queue].find(([, task]) => task.delay === 1500);
  assert(watchdog); queue.delete(watchdog[0]); watchdog[1].fn(); flush();
  assert.deepEqual(sent[4].pps.taxonomies.IAB_CONTENT_2_2.values, ['42']);
});

test('native GPT dispatch failure retains the captured category for a retry', () => {
  const requests = [], sent = [];
  let attempt = 0, pps;
  const win = {adsKeywords: {category: 'Sports'}, googletag: {setConfig(value) {pps = value.pps;}}};
  const context = createContextualSignals(win, settings(), {request(pb, input) {requests.push(input);}, code: slot => slot.id,
    dispatch() {if (++attempt === 1) throw Error('native GPT failure'); sent.push(plain(pps));}});
  context.request({}, {auctionId: 'first', adUnits: [{code: 'P1'}]});
  requests[0].bidsBackHandler({}, false, 'first');
  assert.throws(() => context.dispatch({}, [{id: 'P1'}]), /native GPT failure/);
  win.adsKeywords.category = 'Books'; context.dispatch({}, [{id: 'P1'}]);
  assert.deepEqual(sent[0].taxonomies.IAB_CONTENT_2_2.values, ['483']);
});

test('values are exact, arrays union mappings and IDs are not re-labelled between taxonomies', () => {
  const state = harness(settings(), {category: ['Sports', 'Books', 'Sports', 'Sport', 42]});
  state.request('multi'); const result = state.fragments('multi');
  assert.deepEqual(dataFor(result, 'openx')[0].segment, [{id: '483'}, {id: '42'}]);
  assert.deepEqual(dataFor(result, 'ix')[0].segment, [{id: 'VK7KD0'}, {id: '42'}]);
  state.win.adsKeywords.category = 'sports'; state.request('lowercase');
  assert.deepEqual(state.fragments('lowercase'), {global: {}, bidder: {}});
  state.win.adsKeywords.category = 'Sport'; state.request('only22');
  assert.equal(dataFor(state.fragments('only22'), 'ix').length, 0);
});

test('OFF leaves request and dispatch identity and existing PPS untouched', () => {
  const state = harness(settings({enabled: false}), {pps: {taxonomies: {IAB_AUDIENCE_1_1: {values: ['6']}}}});
  const request = {auctionId: 'off', adUnitCodes: ['P1']};
  state.context.request(state.pb, request);
  assert.equal(state.requests[0], request);
  state.context.configurePrebid(state.pb);
  assert.equal(state.configWrites.length, 0);
  assert.deepEqual(state.fragments('off'), {global: {}, bidder: {}});
  state.context.dispatch({}, [{id: 'P1'}]);
  assert.equal(state.writes.length, 0);
  assert.deepEqual(state.sent[0].pps, {taxonomies: {IAB_AUDIENCE_1_1: {values: ['6']}}});
});

test('GAM-only opportunities use current category, without Prebid or RTD', () => {
  const state = harness(settings({bidders: []}));
  state.context.dispatch({}, [{id: 'P1'}]);
  state.win.adsKeywords.category = 'Books'; state.context.dispatch({}, [{id: 'P1'}]);
  assert.deepEqual(state.sent.map(row => row.pps.taxonomies.IAB_CONTENT_2_2.values), [['483'], ['42']]);
});

test('GAM opt-out preserves foreign PPS and the original mixed-context batch', () => {
  const state = harness(settings({gam: {enabled: false}}), {pps: {foreign: true}});
  state.request('a', ['P1']); state.win.adsKeywords.category = 'Books'; state.request('b', ['P2']);
  state.context.dispatch({}, [{id: 'P1'}, {id: 'P2'}]);
  assert.equal(state.writes.length, 0); assert.equal(state.sent.length, 1);
  assert.deepEqual(state.sent[0], {slots: ['P1', 'P2'], options: undefined, pps: {foreign: true}});
});

test('same contextual PPS from different auctions keeps a single GPT batch', () => {
  const state = harness();
  state.request('a', ['P1']); state.request('b', ['P2']);
  state.context.dispatch({}, [{id: 'P1'}, {id: 'P2'}]);
  assert.equal(state.sent.length, 1); assert.deepEqual(state.sent[0].slots, ['P1', 'P2']);
});

test('missing optional provider never blocks callback or delivery and is diagnosed', () => {
  const state = harness(); let called = 0;
  state.request('missing', ['P1'], () => called++);
  state.requests[0].bidsBackHandler({}, false, 'missing');
  assert.equal(called, 1);
  state.context.dispatch({}, [{id: 'P1'}]); assert.equal(state.sent.length, 1);
  assert(state.context.snapshot().events.some(event => event.kind === 'provider-not-observed'));
  assert.equal(state.context.snapshot().providerRegistered, false);
});

test('unavailable GPT API and throwing category getters do not delay ads or split batches', () => {
  const state = harness(settings(), {api: false});
  state.request('a', ['P1']); state.win.adsKeywords.category = 'Books'; state.request('b', ['P2']);
  state.context.dispatch({}, [{id: 'P1'}, {id: 'P2'}]);
  assert.equal(state.sent.length, 1);
  Object.defineProperty(state.win.adsKeywords, 'category', {get() {throw Error('Unavailable');}});
  assert.doesNotThrow(() => state.request('error'));
  assert.deepEqual(state.fragments('error'), {global: {}, bidder: {}});
  assert(state.context.snapshot().events.some(event => event.kind === 'category-unavailable'));
});

test('transient GPT configuration exception never blocks ads and recovers on the next request', () => {
  const state = harness(); let attempts = 0;
  const original = state.win.googletag.setConfig;
  state.win.googletag.setConfig = value => {if (++attempts === 1) throw Error('Transient'); original(value);};
  state.request('first');
  assert.doesNotThrow(() => state.context.dispatch({}, [{id: 'P1'}]));
  assert.equal(state.sent.length, 1); assert(state.context.snapshot().events.some(event => event.kind === 'gam-pps-config-error'));
  state.request('second'); state.context.dispatch({}, [{id: 'P1'}]);
  assert.deepEqual(state.writes[0].pps.taxonomies.IAB_CONTENT_2_2.values, ['483']);
});

test('Rubicon rejects only this contribution when foreign data has another flattened taxonomy', () => {
  for (const otherTaxonomy of [1, 2, 5, 7]) {
    const state = harness(settings({bidders: [{bidder: 'rubicon', taxonomy: 'iab-content-2.2'}]}));
    state.request('mixed');
    const foreign = {site: {content: {data: [{name: 'foreign.invalid', ext: {segtax: otherTaxonomy}, segment: [{id: '42'}]}]}}};
    const result = state.fragments('mixed', foreign);
    assert.deepEqual(result, {global: foreign, bidder: {}});
    assert(state.context.snapshot().events.some(event => event.kind === 'mixed-taxonomy-skipped'));
  }
  const state = harness(settings({bidders: [{bidder: 'rubicon', taxonomy: 'iab-content-2.2'}]}));
  state.request('same');
  assert.equal(dataFor(state.fragments('same', {site: {content: {data: [{ext: {segtax: 6}, segment: [{id: '42'}]}]}}}), 'rubicon').length, 1);
});

test('checked Teads/RichAudience adapter versions are skipped with a precise diagnostic', () => {
  for (const version of ['11.11.0', 'v11.34.0']) {
    const state = harness(settings({prebidVersion: version, bidders: [{bidder: 'teads', taxonomy: 'iab-content-2.2'}, {bidder: 'richaudience', taxonomy: 'iab-content-3.0'}]}));
    state.request('unsupported'); assert.deepEqual(state.fragments('unsupported'), {global: {}, bidder: {}});
    assert.equal(state.context.snapshot().events.filter(event => event.kind === 'adapter-route-unavailable').length, 2);
  }
});

test('RTD setup preserves unrelated providers, timing and options without changing ortb2', () => {
  const state = harness();
  const existing = {auctionDelay: 30, dataProviders: [{name: 'other', waitForIt: true, params: {key: 'value'}}], custom: true};
  state.pb.getConfig = key => {assert.equal(key, 'realTimeData'); return existing;};
  state.context.configurePrebid(state.pb);
  assert.deepEqual(state.configWrites, [{realTimeData: {...existing, dataProviders: [...existing.dataProviders, {name: 'contextualSignals', waitForIt: false, params: {}}]}}]);
  assert.equal(existing.dataProviders.length, 1);
  state.pb.getConfig = () => state.configWrites[0].realTimeData;
  state.context.configurePrebid(state.pb);
  assert.equal(state.configWrites[1].realTimeData.dataProviders.length, 2);
});

test('provider source always completes once, including missing helper and helper failures', () => {
  const code = PREBID_CONTEXTUAL_MODULE_SOURCE.replace("import {submodule} from '../src/hook.js';", '').replaceAll('export ', '');
  let registered;
  const context = vm.createContext({window: {}, submodule(type, provider) {assert.equal(type, 'realTimeData'); registered = provider;}});
  vm.runInContext(code, context);
  let completed = 0; registered.getBidRequestData({}, () => completed++); assert.equal(completed, 1);
  context.window.__AD_CONTEXT = {protocol: 1, enrichAuction() {throw Error('Data failure');}};
  registered.getBidRequestData({}, () => completed++); assert.equal(completed, 2);
  let ready = 0, enriched = 0;
  context.window.__AD_CONTEXT = {protocol: 1, enrichAuction() {enriched++;}, providerReady() {ready++;}};
  assert.equal(registered.init(), true);
  registered.getBidRequestData({}, () => completed++);
  assert.equal(completed, 3); assert.equal(enriched, 1); assert.equal(ready, 2);
});

test('duplicate provider call is idempotent and unrelated auctions are ignored', () => {
  const state = harness(); state.request('ours');
  const request = {auctionId: 'ours', ortb2Fragments: {global: {}, bidder: {}}};
  state.context.enrichAuction(request); state.context.enrichAuction(request);
  assert.equal(dataFor(request.ortb2Fragments, 'openx').length, 1);
  const foreign = {auctionId: 'not-ours', ortb2Fragments: {global: {}, bidder: {}}};
  assert.equal(state.context.enrichAuction(foreign), false); assert.deepEqual(foreign.ortb2Fragments.bidder, {});
});

test('inherited bidder names cannot mutate object prototypes through native fragment setters', () => {
  const state = harness(settings({bidders: ['__proto__', 'constructor'].map(bidder => ({bidder, taxonomy: 'iab-content-2.2'}))}));
  state.request('inherited');
  const result = state.fragments('inherited');
  assert.deepEqual(result.bidder, {});
  assert.equal(Object.prototype.site, undefined);
  assert.equal(Object.site, undefined);
  assert.equal(state.context.snapshot().events.filter(event => event.kind === 'inherited-bidder-name-skipped').length, 2);
});

test('debug snapshots are detached, bounded and do not claim server acceptance', () => {
  const state = harness();
  for (let i = 0; i < 40; i++) {state.request('request' + i); state.fragments('request' + i);}
  const report = state.context.snapshot();
  assert(report.events.length <= 24); assert.match(report.evidence, /not verified/);
  report.categoryValues[0] = 'changed'; report.taxonomies['iab-content-2.2'].push('fake');
  assert.deepEqual(state.context.snapshot().categoryValues, ['Sports']);
  assert.deepEqual(state.context.snapshot().taxonomies['iab-content-2.2'], ['483']);
});

test('new compiler emits ES2015 and hooks the consent-gated request/dispatch boundary without changing old source', () => {
  const source = configure(fixture(), config => {config.enablePrebid = false;});
  const input = previewInput(source, descriptor, '20261111_100000');
  const compiled = compileRuntime321(input).adsJs;
  parse(compiled, {ecmaVersion: 2015});
  assert.match(compiled, /rawRequest:_adContext.request,rawDispatch:_adContext.dispatch/);
  assert.match(compiled, /_adContext.configurePrebid\(pbjs\)/);
  assert.match(compiled, /try \{ _adContext.dispatch\(pa,\[guard\]\); \}/);
  assert(!compiled.includes('_gamReporting.dispatch(pa,[guard])'));
  assert(!compiled.includes('getConfig(\'pps\')'));
  assert(!compiled.includes('setBidderConfig'));
});

test('GAM-only package carries exact contextual settings and ownership instructions without requiring a live category', async () => {
  const source = configure(fixture(), config => {config.enablePrebid = false; config.runtimeControls.contextualSignals = {...settings({bidders: []}), providerName: undefined, prebidVersion: undefined};});
  const original = plain(source);
  const bundle = await buildArtifactCandidate({snapshot: source, pin: pinRuntime(descriptor, {allowPreview: true}), buildTimestamp: '20261111_100000'});
  const config = JSON.parse(new TextDecoder().decode(bundle.files['config.json']));
  assert.deepEqual(config.contextualSignals.mappings, settings().mappings);
  assert.equal(config.contextualSignals.providerName, 'example.invalid');
  assert.equal(config.contextualSignals.prebidVersion, null);
  assert.match(new TextDecoder().decode(bundle.files['README.txt']), /exclusive control/);
  assert.deepEqual(source, original);
});

test('Prebid package remains generatable with missing optional provider and preserves SChain', async () => {
  const source = configure(fixture(), config => {config.runtimeControls.schain = {ver: '1.0', complete: 1, nodes: [{asi: 'ringier.rs', sid: '20221205191920', hp: 1}]};
    config.runtimeControls.contextualSignals = {...settings({bidders: [{bidder: 'ix', taxonomy: 'iab-content-2.2'}]}), providerName: undefined, prebidVersion: undefined};});
  const prebid = await checkedFixture(source);
  const bundle = await buildArtifactCandidate({snapshot: source, pin: pinRuntime(descriptor, {allowPreview: true}), buildTimestamp: '20261111_100000', prebid});
  const config = JSON.parse(new TextDecoder().decode(bundle.files['config.json']));
  assert.equal(config.contextualSignals.prebidVersion, '11.11.0');
  assert.deepEqual(config.contextualSignals.bidders, [{bidder: 'ix', taxonomy: 'iab-content-2.2'}]);
  assert.equal(config.options.schain.nodes[0].sid, '20221205191920');
});
