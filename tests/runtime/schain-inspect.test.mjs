import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { schainInspectCommand, schainPositionCommand } from '../../src/debug/schain-inspect.mjs';

const chain = { ver: '1.0', complete: 1, nodes: [{ asi: 'seller.example', sid: '123', hp: 1 }] };
function request(bidder = 'openx', auctionId = 'auction-1', schain = chain) {
  return { bidderCode: bidder, auctionId, bidderRequestId: bidder + '-request', schain: null,
    bids: ['P1', 'P2'].map((adUnitCode, i) => ({ adUnitCode, bidId: auctionId + '-' + bidder + '-' + i, schain, params: { placementId: 'test' } })) };
}
function fixture({ events = [request()], version = '9.18.0', config = { schain: { config: chain } }, bidderConfig = {}, noPrebid = false, getEvents, fetch, decompression = true } = {}) {
  const logs = [], calls = [], handlers = new Set(), timers = new Map();
  let timerId = 0;
  const forbidden = () => { throw Error('Ad/config/CMP write forbidden'); };
  class XHR {
    open(...args) { calls.push({ type: 'open', receiver: this, args }); return 'opened'; }
    send(...args) { calls.push({ type: 'send', receiver: this, args }); return 'sent'; }
  }
  const nativeFetch = fetch || function (...args) { calls.push({ type: 'fetch', receiver: this, args }); return promise; };
  const promise = Promise.resolve('response');
  const pbjs = noPrebid ? undefined : { version, getEvents: getEvents || (() => events.map(args => ({ eventType: 'bidRequested', elapsedTime: 12, args }))),
    getConfig: () => config, getBidderConfig: () => bidderConfig,
    onEvent(name, cb) { assert.equal(name, 'bidRequested'); handlers.add(cb); },
    offEvent(name, cb) { assert.equal(name, 'bidRequested'); handlers.delete(cb); },
    requestBids: forbidden, setConfig: forbidden, setBidderConfig: forbidden };
  const window = { pbjs, fetch: nativeFetch, XMLHttpRequest: XHR, __tcfapi: forbidden, googletag: { pubads: forbidden } };
  const context = vm.createContext({ window, location: { href: 'https://publisher.invalid/article' },
    URL, URLSearchParams, Blob, Request, TextDecoder, Uint8Array, ArrayBuffer, btoa,
    DecompressionStream: decompression ? DecompressionStream : undefined,
    console: Object.fromEntries(['log','table','group','groupCollapsed','groupEnd','info'].map(name => [name, (...args) => logs.push([name, ...args])])),
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  const run = (scope = { adUnit: '', bidder: '' }, capture = false) => vm.runInContext(schainInspectCommand(scope, capture), context);
  return { window, context, run, calls, logs, handlers, timers, nativeFetch, promise, config, events, XHR };
}
const plain = value => JSON.parse(JSON.stringify(value));
const openx = 'https://rtb.openx.net/openrtbb/prebidjs';
const pubmatic = 'https://hbopenbid.pubmatic.com/translator?source=prebid-client&gzip=1';
const position = (f, target, bidder = '') => { vm.runInContext(schainPositionCommand(target, bidder), f.context); return f.window.__AD_REQUEST_DEBUG.snapshot(); };

test('position report requires a target and returns only the latest exact bid, without duplicating history or private fields', () => {
  const a = request(), b = request('openx', 'latest');
  b.bids[0].userId = { secret: 'not-for-sharing' };
  b.bids[0].ortb2 = { user: { consent: 'private' } };
  const f = fixture({ events: [a,b] });
  assert.equal(position(f, '').status, 'selection-required');
  assert.equal(f.handlers.size, 0);
  const report = position(f, ' P1 ', 'openx');
  assert.equal(report.evidence, 'prebid-only');
  assert.equal(report.request.auctionId, 'latest');
  assert.equal(report.request.adUnitCode, 'P1');
  assert.equal(report.request.originalBatchBids, 2);
  assert.equal(report.schainCheck.status, 'basic-fields-pass');
  assert.ok(JSON.stringify(report).length < 3000);
  assert.doesNotMatch(JSON.stringify(report), /not-for-sharing|"consent"|originalRequest|filteredBids|"P2"/);
  assert.equal(f.window.__AD_REQUEST_DEBUG.fullSnapshot().requests.length, 2);
  assert.equal(b.bids.length, 2);
  assert.equal(position(f, 'P', 'openx').status, 'not-found');
  assert.equal(position(f, 'P1', 'openxAlias').status, 'not-found');
});

test('position matches a full recorded GAM path/GPID exactly, never its suffix', () => {
  const r = request();
  r.bids[0].ortb2Imp = { ext: { data: { adserver: { adslot: '/123/site/P1' } } } };
  r.bids[1].ortb2Imp = { ext: { gpid: '/123/other/P1' } };
  const f = fixture({ events: [r] });
  assert.equal(position(f, '/123/site/P1').request.adUnitCode, 'P1');
  assert.equal(position(f, '/123/other/P1').request.adUnitCode, 'P2');
  assert.equal(position(f, '/P1').status, 'not-found');
  assert.equal(position(f, '/123/missing/P1').status, 'not-found');
});

test('GPT fallback uses the exact slot element ID, rejects duplicate paths, and never overrides a recorded path', () => {
  const r = request();
  const f = fixture({ events: [r] });
  const slots = [{ getSlotElementId: () => 'P1', getAdUnitPath: () => '/123/site/P1' }];
  f.window.googletag = { pubadsReady: true, pubads: () => ({ getSlots: () => slots }) };
  assert.equal(position(f, '/123/site/P1').request.matchedBy, 'current GPT path + exact slot element ID');
  r.bids[0].ortb2Imp = { ext: { gpid: '/123/different/P1' } };
  assert.equal(position(f, '/123/site/P1').status, 'not-found');
  delete r.bids[0].ortb2Imp;
  slots.push({ getSlotElementId: () => 'P2', getAdUnitPath: () => '/123/site/P1' });
  assert.equal(position(f, '/123/site/P1').status, 'ambiguous-position');
  assert.equal(position(f, 'P1').status, 'matched');
});

test('compact report does not turn config presence, missing chain or conflicting chains into a pass', () => {
  const missing = request('openx', 'a', null);
  const f = fixture({ events: [missing] });
  assert.equal(position(f, 'P1').schainCheck.status, 'not-found-in-selected-evidence');
  missing.bids[0].schain = chain;
  missing.ortb2 = { source: { schain: { ...chain, complete: 0 } } };
  const conflict = position(f, 'P1');
  assert.equal(conflict.schainCheck.status, 'check-failed');
  assert.equal(conflict.request.schain, null);
  assert.equal(conflict.request.conflictingSchain.length, 2);
  missing.ortb2.source.schain = { nodes: chain.nodes, complete: 1, ver: '1.0' };
  assert.equal(position(f, 'P1').schainCheck.status, 'basic-fields-pass');
});

test('basic SChain checks reject malformed required fields; incomplete chains are disclosed without claiming commercial validation', () => {
  for (const bad of [
    { ...chain, complete: true }, { ...chain, ver: '2.0' }, { ...chain, nodes: [] },
    ...[{ asi: 'https://seller.example' }, { sid: 123 }, { hp: 0 }, { sid: '' }, { ext: 'bad' }].map(change => ({ ...chain, nodes: [{ ...chain.nodes[0], ...change }] })),
  ]) assert.equal(position(fixture({ events: [request('openx', 'a', bad)] }), 'P1').schainCheck.status, 'check-failed');
  const incomplete = position(fixture({ events: [request('openx', 'a', { ...chain, complete: 0 })] }), 'P1');
  assert.equal(incomplete.schainCheck.status, 'basic-fields-pass');
  assert.match(incomplete.warnings.join(' '), /incomplete chain/);
  assert.match(incomplete.limits, /do not verify ads.txt/);
});

test('compact capture returns only the matching HTTP impression and stops; original multi-position body remains unchanged', async () => {
  const f = fixture(); position(f, 'P1', 'openx');
  const payload = { id: 'wire-request', user: { id: 'private-user' }, source: { ext: { schain: chain } },
    imp: [{ id: 'auction-1-openx-0', banner: { format: [{ w: 300, h: 250 }] } }, { id: 'auction-1-openx-1', ext: { other: 'omit-this' } }] };
  const body = JSON.stringify(payload);
  f.window.fetch(openx + '?private=omit-query', { method: 'POST', body });
  const report = await f.window.__AD_REQUEST_DEBUG.ready();
  assert.equal(report.evidence, 'captured-http-call');
  assert.equal(report.request.requestId, 'wire-request');
  assert.equal(report.request.impression.id, 'auction-1-openx-0');
  assert.equal(report.request.originalBatchImpressions, 2);
  assert.equal(report.schainCheck.status, 'basic-fields-pass');
  assert.equal(report.capture.active, false);
  assert.equal(f.window.fetch, f.nativeFetch);
  assert.equal(f.calls[0].args[1].body, body);
  assert.doesNotMatch(JSON.stringify(report), /private-user|omit-this|omit-query|"P2"/);
  assert.equal(f.window.__AD_REQUEST_DEBUG.fullSnapshot().network[0].body.raw, body);
  assert.ok(f.logs.every(log => !String(log[1]).includes('full batch; inspect mapping')));
});

test('an old auction or another position HTTP capture is never attached to the latest selected bid', async () => {
  const f = fixture({ events: [request(), request('openx', 'latest')] }); position(f, 'P1');
  for (const id of ['auction-1-openx-0', 'latest-openx-1']) {
    f.window.fetch(openx, { method: 'POST', body: JSON.stringify({ imp: [{ id }], source: { schain: chain } }) });
    const report = await f.window.__AD_REQUEST_DEBUG.ready();
    assert.equal(report.evidence, 'prebid-only');
    assert.equal(report.request.auctionId, 'latest');
    assert.equal(report.capture.active, true);
  }
});

test('All bidders can select a mapped supported HTTP request from the latest auction without falsely naming the last adapter', async () => {
  const f = fixture({ events: [request('openx'), request('teads')] }); position(f, 'P1');
  assert.equal(f.window.__AD_REQUEST_DEBUG.snapshot().request.bidder, 'teads');
  f.window.fetch(openx, { body: JSON.stringify({ imp: [{ id: 'auction-1-openx-0' }], source: { schain: chain } }) });
  const report = await f.window.__AD_REQUEST_DEBUG.ready();
  assert.equal(report.evidence, 'captured-http-call');
  assert.equal(report.request.bidder, 'openx');
  assert.equal(report.request.bidId, 'auction-1-openx-0');
});

test('HTTP absence overrides Prebid presence; a chain on an unrelated impression is not evidence for the selected one', async () => {
  const f = fixture(); position(f, 'P1');
  f.window.fetch(openx, { body: JSON.stringify({ imp: [{ id: 'auction-1-openx-0' }, { id: 'auction-1-openx-1', ext: { schain: chain } }] }) });
  const report = await f.window.__AD_REQUEST_DEBUG.ready();
  assert.equal(report.evidence, 'captured-http-call');
  assert.equal(report.schainCheck.status, 'not-found-in-selected-evidence');
  assert.equal(report.request.schain, null);
});

test('compact PubMatic gzip report keeps one decoded impression and no base64 dump', async () => {
  const f = fixture({ events: [request('pubmatic')] }); position(f, 'P1', 'pubmatic');
  const xhr = new f.XHR(); xhr.open('POST', pubmatic);
  xhr.send(gzipSync(JSON.stringify({ source: { schain: chain }, imp: [{ id: 'auction-1-pubmatic-0' }] })));
  const report = await f.window.__AD_REQUEST_DEBUG.ready();
  assert.equal(report.evidence, 'captured-http-call');
  assert.equal(report.request.decoding, 'decoded gzip');
  assert.doesNotMatch(JSON.stringify(report), /base64/);
});

test('ambiguous latest bids and replaced/oversized chain evidence are never a positive short report', () => {
  const r = request(); r.bids.push({ ...r.bids[0], bidId: 'second' });
  assert.equal(position(fixture({ events: [r] }), 'P1').status, 'ambiguous-bids');
  const withFunction = { ...chain, nodes: [{ ...chain.nodes[0], sid() {} }] };
  assert.equal(position(fixture({ events: [request('openx', 'a', withFunction)] }), 'P1').schainCheck.status, 'check-failed');
  const large = { ...chain, ext: { long: 'x'.repeat(25000) } };
  const report = position(fixture({ events: [request('openx', 'a', large)] }), 'P1');
  assert.equal(report.status, 'evidence-too-large');
  assert.ok(JSON.stringify(report).length < 2200);
});

test('Prebid 9: null top-level SChain is not missing when bid-level chain exists; original batch stays intact', () => {
  const f = fixture();
  const before = JSON.stringify(f.events);
  const report = f.run({ adUnit: 'P1', bidder: 'openx' });
  assert.equal(report.requests.length, 1);
  assert.equal(report.requests[0].originalRequest.bids.length, 2);
  assert.equal(report.requests[0].filteredBids.length, 1);
  assert.equal(report.requests[0].filteredBids[0].schainStatus, 'present in Prebid request');
  assert.equal(report.requests[0].filteredBids[0].schain[0].path, 'request.bids[0].schain');
  assert.deepEqual(plain(report.configured.global[0].value), chain);
  assert.equal(f.handlers.size, 0); assert.equal(f.window.fetch, f.nativeFetch);
  report.requests[0].originalRequest.bids[0].params.placementId = 'only snapshot';
  assert.equal(JSON.stringify(f.events), before);
});

test('Prebid 11: request ORTB2 SChain and bidder config are reported without assuming a merge policy', () => {
  const r = request('pubmatic'); r.bids.forEach(b => delete b.schain);
  r.ortb2 = { source: { ext: { schain: chain } } };
  const report = fixture({ events: [r], version: '11.11.0', config: { ortb2: { source: { schain: chain } } },
    bidderConfig: { pubmatic: { ortb2: { source: { schain: chain } } }, other: { schain: { config: chain } } } }).run({ adUnit: '', bidder: 'pubmatic' });
  assert.equal(report.requests[0].filteredBids.length, 2);
  assert.equal(report.requests[0].filteredBids[0].schain[0].path, 'request.ortb2.source.ext.schain');
  assert.equal(report.configured.bidders.length, 1);
  assert.equal(report.configured.bidders[0].schain[0].value.nodes[0].sid, '123');
});

test('all requests includes absent chain; exact scope does not match text elsewhere', () => {
  const a = request('openx'), b = request('openxAlias', 'auction-2', null);
  b.someDescription = 'openx P1 schain';
  const f = fixture({ events: [a,b] });
  assert.equal(f.run().requests.length, 2);
  assert.equal(f.run().requests[1].filteredBids[0].schainStatus, 'not found in captured Prebid fields');
  assert.equal(f.run({ adUnit: 'P1', bidder: 'openx' }).requests.length, 1);
  assert.equal(f.run({ adUnit: 'P', bidder: '' }).requests.length, 0);
});

test('missing, malformed or inaccessible APIs return useful partial reports', () => {
  const missing = fixture({ noPrebid: true }).run();
  assert.equal(missing.requests.length, 0); assert.match(missing.warnings[0], /not loaded/);
  const malformed = fixture({ getEvents: () => ({}) }).run();
  assert.match(malformed.warnings[0], /unsupported format/);
  const unavailable = fixture({ getEvents() { throw Error('unavailable'); } }).run();
  assert.match(unavailable.warnings[0], /history unavailable/);
  const f = fixture(); delete f.window.pbjs.getBidderConfig;
  assert.equal(f.run().configured.bidderConfigAvailable, false);
});

test('snapshots replace circular data explicitly and preserve shared chain objects', () => {
  const r = request(); r.cycle = r;
  const report = fixture({ events: [r] }).run();
  assert.match(report.requests[0].serialization, /incomplete/);
  assert.equal(report.requests[0].originalRequest.cycle, '[Circular]');
  assert.deepEqual(plain(report.requests[0].originalRequest.bids[1].schain), chain);
});

test('history is bounded and oversized requests are disclosed', () => {
  const events = Array.from({ length: 210 }, (_, i) => request('openx', 'a' + i));
  events.push({ ...request(), large: 'x'.repeat(300000) });
  const report = fixture({ events }).run();
  assert.equal(report.requests.length, 200); assert.equal(report.capture.droppedRequests, 11);
  assert.match(report.warnings[0], /512 KiB/);
});

test('fetch capture forwards original args/context/return value and maps by exact bid ID', async () => {
  const f = fixture(); f.run({ adUnit: 'P1', bidder: '' }, true);
  const body = JSON.stringify({ source: { ext: { schain: chain } }, imp: [{ id: 'auction-1-openx-0' }, { id: 'auction-1-openx-1' }] });
  const init = { method: 'POST', body, credentials: 'include' };
  const receiver = {};
  const result = f.window.fetch.call(receiver, openx, init);
  assert.equal(result, f.promise); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[1], init); assert.equal(f.calls[0].receiver, receiver);
  const report = await f.window.__AD_REQUEST_DEBUG.ready();
  assert.equal(report.network.length, 1); assert.equal(report.network[0].body.raw, body);
  assert.equal(report.network[0].matches.length, 2);
  assert.deepEqual(plain(report.network[0].schain[0].value), chain);
  assert.equal(report.network[0].body.value.imp.length, 2);
  f.window.__AD_REQUEST_DEBUG.stop();
  assert.equal(f.window.fetch, f.nativeFetch); assert.equal(f.handlers.size, 0); assert.equal(f.timers.size, 0);
});

test('unmapped batches stay separate from selected position and unrelated hosts are ignored', async () => {
  const f = fixture(); f.run({ adUnit: 'P1', bidder: '' }, true);
  f.window.fetch(openx, { method: 'POST', body: JSON.stringify({ imp: [{ id: 'unknown' }], source: { schain: chain } }) });
  f.window.fetch('https://rtb.openx.net.evil.invalid/openrtbb/prebidjs', { body: 'unrelated' });
  f.window.fetch('https://rtb.openx.net/user-sync', { body: 'unrelated' });
  const report = await f.window.__AD_REQUEST_DEBUG.ready();
  assert.equal(report.network.length, 0); assert.equal(report.unmappedNetwork.length, 1);
  assert.match(report.unmappedNetwork[0].mapping, /unresolved/);
});

test('XHR gzip capture keeps original bytes and decodes PubMatic payload', async () => {
  const r = request('pubmatic');
  const f = fixture({ events: [r] }); f.run(undefined, true);
  const bytes = gzipSync(JSON.stringify({ source: { schain: chain }, imp: [{ id: r.bids[0].bidId }] }));
  const xhr = new f.XHR();
  assert.equal(xhr.open('POST', pubmatic, true), 'opened');
  assert.equal(xhr.send(bytes), 'sent');
  assert.equal(f.calls[1].args[0], bytes); assert.equal(f.calls[1].receiver, xhr);
  const report = await f.window.__AD_REQUEST_DEBUG.ready();
  assert.equal(report.network[0].body.status, 'decoded gzip');
  assert.equal(report.network[0].body.raw.value, bytes.toString('base64'));
  assert.equal(report.network[0].matches[0].adUnitCode, 'P1');
  assert.deepEqual(plain(report.network[0].schain[0].value), chain);
});

test('unavailable gzip decoder and unsupported body types do not imply missing SChain', async () => {
  const f = fixture({ decompression: false }); f.run(undefined, true);
  f.window.fetch(pubmatic, { body: gzipSync('{}') });
  f.window.fetch(pubmatic, { body: new FormData() });
  const report = await f.window.__AD_REQUEST_DEBUG.ready();
  assert.match(report.network[0].body.status, /decoder unavailable/);
  assert.match(report.network[1].body.status, /unavailable/);
  assert.equal(f.calls.length, 2);
});

test('URL-encoded bodies and GET query schain retain source evidence', async () => {
  const f = fixture(); f.run(undefined, true);
  const encoded = new URLSearchParams({ schain: JSON.stringify(chain), repeated: 'test' });
  f.window.fetch(openx, { method: 'POST', body: encoded });
  f.window.fetch(openx + '?' + encoded);
  const report = await f.window.__AD_REQUEST_DEBUG.ready();
  assert.equal(report.network[0].body.format, 'url-encoded');
  assert.deepEqual(plain(report.network[0].schain[0].value), chain);
  assert.deepEqual(plain(report.network[1].schain[0].value), chain);
});

test('Request stream is never read or cloned; observation exposes limitation', async () => {
  const f = fixture(); f.run(undefined, true);
  const req = new Request(openx, { method: 'POST', body: 'original' });
  f.window.fetch(req);
  const report = await f.window.__AD_REQUEST_DEBUG.ready();
  assert.equal(f.calls[0].args[0], req); assert.equal(req.bodyUsed, false);
  assert.match(report.network[0].body.status, /unavailable/);
});

test('rejection and synchronous native exception are unchanged', async () => {
  const rejection = Promise.reject(Error('native rejection')); rejection.catch(() => {});
  const f = fixture({ fetch() { return rejection; } }); f.run(undefined, true);
  assert.equal(f.window.fetch(openx), rejection);
  await assert.rejects(rejection, /native rejection/);
  const g = fixture({ fetch() { throw Error('native throw'); } }); g.run(undefined, true);
  assert.throws(() => g.window.fetch(openx), /native throw/);
});

test('repeated installation removes old listeners; stop respects another tool wrapper', () => {
  const f = fixture(); f.run(undefined, true); const first = f.window.__AD_REQUEST_DEBUG;
  f.run(undefined, true); assert.equal(f.handlers.size, 1); assert.equal(first.snapshot().capture.active, false);
  const wrapper = () => {}; f.window.fetch = wrapper;
  f.window.__AD_REQUEST_DEBUG.stop();
  assert.equal(f.window.fetch, wrapper); assert.equal(f.handlers.size, 0);
});

test('five-minute stop cleans XHR and future callbacks, malformed live event does not throw', () => {
  const f = fixture(); const open = f.XHR.prototype.open, send = f.XHR.prototype.send;
  f.run({ adUnit: 'P1', bidder: '' }, true);
  const handler = [...f.handlers][0];
  assert.doesNotThrow(() => handler({ bidderCode: 'openx', bids: {} }));
  handler(request('openx', 'new-auction'));
  assert.equal(f.window.__AD_REQUEST_DEBUG.snapshot().requests.length, 2);
  const timer = [...f.timers.values()][0]; assert.equal(timer.ms, 300000); timer.fn();
  assert.equal(f.XHR.prototype.open, open); assert.equal(f.XHR.prototype.send, send);
  handler(request('openx', 'after-stop'));
  assert.equal(f.window.__AD_REQUEST_DEBUG.snapshot().requests.length, 2);
});

test('console scope encoding cannot execute injected text and copy falls back to local JSON', async () => {
  const f = fixture(); const code = 'P1\");globalThis.pwned=true;//';
  const report = f.run({ adUnit: code, bidder: '' });
  assert.equal(report.scope.adUnit, code); assert.equal(f.context.pwned, undefined);
  assert.equal(JSON.parse(await f.window.__AD_REQUEST_DEBUG.copy()).schemaVersion, 1);
});


test('fetch init accessors are evaluated only by the original transport', async () => {
  let reads = 0, methods = 0;
  const f = fixture({ fetch(input, init) { void init.body; void init.method; return 'native-result'; } });
  f.run(undefined, true);
  const init = { get body() { reads++; return 'original'; }, get method() { methods++; return 'POST'; } };
  assert.equal(f.window.fetch(openx, init), 'native-result');
  assert.equal(reads, 1); assert.equal(methods, 1);
  const report = await f.window.__AD_REQUEST_DEBUG.ready();
  assert.equal(report.network[0].method, 'unavailable');
  assert.match(report.network[0].body.status, /unavailable/);
});

test('ambiguous reused impression IDs do not assert an auction or position match', async () => {
  const a = request(), b = request(); b.auctionId = 'other-auction';
  const f = fixture({ events: [a,b] }); f.run({ adUnit: 'P1', bidder: '' }, true);
  f.window.fetch(openx, { body: JSON.stringify({ imp: [{ id: a.bids[0].bidId }] }) });
  const report = await f.window.__AD_REQUEST_DEBUG.ready();
  assert.equal(report.network.length, 0); assert.match(report.unmappedNetwork[0].mapping, /ambiguous/);
});

test('gzip inflation and concurrent capture limits stay explicit and non-blocking', async () => {
  const f = fixture(); f.run(undefined, true);
  f.window.fetch(pubmatic, { body: gzipSync('x'.repeat(600000)) });
  for (let i=0;i<10;i++) f.window.fetch(pubmatic, { body: new Blob(['{}']) });
  const report = await f.window.__AD_REQUEST_DEBUG.ready();
  assert.equal(f.calls.length, 11);
  assert.match(report.network[0].body.status, /size limit/);
  assert(report.capture.droppedNetwork > 0);
  assert.equal(report.capture.pending, 0);
});


test('null/undefined fetch init body never hides an inherited Request stream', async () => {
  const f = fixture(); f.run(undefined, true);
  for (const body of [null, undefined]) {
    const req = new Request(openx, { method: 'POST', body: 'inherited payload' });
    f.window.fetch(req, { body });
    assert.equal(req.bodyUsed, false);
  }
  const report = await f.window.__AD_REQUEST_DEBUG.ready();
  assert(report.network.every(record => record.body.status.startsWith('unavailable')));
});


test('iframe context is explicit, checks nothing and never reads parent or installs capture hooks', () => {
  const f = fixture();
  f.window.top = Object.defineProperty({}, 'pbjs', { get() { throw Error('Do not inspect parent'); } });
  Object.defineProperty(f.window, 'pbjs', { get() { throw Error('Do not inspect iframe Prebid'); } });
  const result = position(f, 'P1');
  assert.equal(result.status, 'wrong-console-context');
  assert.equal(result.evidence, 'none');
  assert.equal(result.schainCheck.status, 'not-checked');
  assert.equal(result.request, null);
  assert.equal(result.capture.active, false);
  assert.equal(f.window.fetch, f.nativeFetch);
  assert.equal(f.handlers.size, 0); assert.equal(f.timers.size, 0);
  assert.match(result.warnings.join(' '), /Choose top/);
  assert.deepEqual(plain(result.otherChecks), { adsTxt: 'not-checked', sellersJson: 'not-checked', paymentRelationships: 'not-checked', sspAcceptance: 'not-checked' });
  assert.ok(!f.logs.some(log => log[0] === 'groupCollapsed'));
});

test('top context without Prebid is not a missing SChain and recovers after rerunning', () => {
  const f = fixture({ noPrebid: true }); f.window.top = f.window;
  assert.equal(position(f, 'P1').status, 'prebid-unavailable');
  assert.equal(f.window.__AD_REQUEST_DEBUG.snapshot().capture.active, false);
  assert.equal(f.window.fetch, f.nativeFetch);
  f.window.pbjs = fixture().window.pbjs;
  assert.equal(position(f, 'P1').schainCheck.status, 'basic-fields-pass');
  assert.equal(f.window.__AD_REQUEST_DEBUG.snapshot().environment.frame, 'top');
});

test('console output is tables plus collapsed original details, with no duplicate returned report or branding', () => {
  const f = fixture();
  const code = schainPositionCommand('P1');
  assert.doesNotMatch(code, /tessera/i);
  assert.doesNotMatch(schainInspectCommand({ adUnit: '', bidder: '' }, true), /tessera/i);
  assert.equal(vm.runInContext(code, f.context), undefined);
  const tables = f.logs.filter(log => log[0] === 'table');
  assert.equal(tables.length, 2);
  assert.equal(tables[0][1].find(row => row.Field === 'SChain').Value, 'Present');
  assert.match(tables[0][1].find(row => row.Field === 'SChain field path').Value, /bids\[0\].schain/);
  assert.equal(tables[1][1][0].sid, '123');
  assert.ok(f.logs.some(log => log[0] === 'groupCollapsed' && log[1].includes('Complete Prebid input')));
  assert.doesNotMatch(JSON.stringify(f.logs), /tessera/i);
});

test('full selected request export preserves all HTTP fields and raw body but excludes unrelated history', async () => {
  const f = fixture({ events: [request('openx','old'),request()] }); position(f, 'P1');
  const payload = { id:'full-http', user:{ id:'user-detail' }, device:{ ua:'test-agent' }, site:{ domain:'publisher.invalid' }, regs:{ext:{gdpr:1}}, source:{ext:{schain:chain}}, imp:[{id:'auction-1-openx-0',banner:{format:[{w:300,h:250}]}},{id:'auction-1-openx-1'}] };
  const raw = JSON.stringify(payload);
  f.window.fetch(openx+'?a=1',{method:'POST',body:raw}); await f.window.__AD_REQUEST_DEBUG.ready();
  const detail = f.window.__AD_REQUEST_DEBUG.details();
  assert.equal(detail.originalRequest.kind,'captured-http-call');
  assert.equal(detail.originalRequest.body.raw,raw);
  assert.deepEqual(plain(detail.originalRequest.body.value),payload);
  assert.equal(detail.originalRequest.batchSize,2);
  assert.equal(detail.originalRequest.selectedImpressionId,'auction-1-openx-0');
  assert.equal(detail.originalRequest.url,openx+'?a=1');
  assert.match(detail.originalRequest.note,/Headers .* not recorded/);
  assert.ok(!('requests' in detail) && !('network' in detail));
  assert.doesNotMatch(JSON.stringify(detail), /old-openx/);
  const exported = JSON.parse(await f.window.__AD_REQUEST_DEBUG.copy());
  assert.deepEqual(plain(exported.originalRequest),plain(detail.originalRequest));
  const text = await f.window.__AD_REQUEST_DEBUG.copySummary();
  assert.match(text,/\| SChain \| Present \|/);
  assert.match(text,/\| 1 \| seller.example \| 123 \| 1 \|/);
  assert.doesNotMatch(text,/user-detail|test-agent|tessera|old-openx/);
});

test('full selected Prebid input preserves unknown fields and reports replaced values without calling it HTTP', () => {
  const r=request(); r.extra={keep:'all fields'}; r.bids[0].getFloor=()=>({floor:0});
  const f=fixture({events:[r]}); position(f,'P1');
  const d=f.window.__AD_REQUEST_DEBUG.details();
  assert.equal(d.originalRequest.kind,'prebid-input');
  assert.equal(d.originalRequest.body.extra.keep,'all fields');
  assert.equal(d.originalRequest.body.bids.length,2);
  assert.match(d.originalRequest.serialization,/incomplete/);
  assert.equal(d.schainCheck.status,'basic-fields-pass');
});

test('copy fallback returns the selected export and readable table when clipboard permission is denied', async () => {
  const f=fixture(); f.context.navigator={clipboard:{async writeText(){throw Error('denied');}}}; position(f,'P1');
  assert.equal(JSON.parse(await f.window.__AD_REQUEST_DEBUG.copy()).originalRequest.kind,'prebid-input');
  assert.match(await f.window.__AD_REQUEST_DEBUG.copySummary(),/Ad request report/);
});
