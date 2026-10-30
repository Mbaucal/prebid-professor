import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { schainInspectCommand } from '../../src/debug/schain-inspect.mjs';

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
    console: Object.fromEntries(['log','table','group','groupEnd','info'].map(name => [name, (...args) => logs.push([name, ...args])])),
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  const run = (scope = { adUnit: '', bidder: '' }, capture = false) => vm.runInContext(schainInspectCommand(scope, capture), context);
  return { window, context, run, calls, logs, handlers, timers, nativeFetch, promise, config, events, XHR };
}
const plain = value => JSON.parse(JSON.stringify(value));
const openx = 'https://rtb.openx.net/openrtbb/prebidjs';
const pubmatic = 'https://hbopenbid.pubmatic.com/translator?source=prebid-client&gzip=1';

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
  const report = await f.window.__TESSERA_SCHAIN_DEBUG.ready();
  assert.equal(report.network.length, 1); assert.equal(report.network[0].body.raw, body);
  assert.equal(report.network[0].matches.length, 2);
  assert.deepEqual(plain(report.network[0].schain[0].value), chain);
  assert.equal(report.network[0].body.value.imp.length, 2);
  f.window.__TESSERA_SCHAIN_DEBUG.stop();
  assert.equal(f.window.fetch, f.nativeFetch); assert.equal(f.handlers.size, 0); assert.equal(f.timers.size, 0);
});

test('unmapped batches stay separate from selected position and unrelated hosts are ignored', async () => {
  const f = fixture(); f.run({ adUnit: 'P1', bidder: '' }, true);
  f.window.fetch(openx, { method: 'POST', body: JSON.stringify({ imp: [{ id: 'unknown' }], source: { schain: chain } }) });
  f.window.fetch('https://rtb.openx.net.evil.invalid/openrtbb/prebidjs', { body: 'unrelated' });
  f.window.fetch('https://rtb.openx.net/user-sync', { body: 'unrelated' });
  const report = await f.window.__TESSERA_SCHAIN_DEBUG.ready();
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
  const report = await f.window.__TESSERA_SCHAIN_DEBUG.ready();
  assert.equal(report.network[0].body.status, 'decoded gzip');
  assert.equal(report.network[0].body.raw.value, bytes.toString('base64'));
  assert.equal(report.network[0].matches[0].adUnitCode, 'P1');
  assert.deepEqual(plain(report.network[0].schain[0].value), chain);
});

test('unavailable gzip decoder and unsupported body types do not imply missing SChain', async () => {
  const f = fixture({ decompression: false }); f.run(undefined, true);
  f.window.fetch(pubmatic, { body: gzipSync('{}') });
  f.window.fetch(pubmatic, { body: new FormData() });
  const report = await f.window.__TESSERA_SCHAIN_DEBUG.ready();
  assert.match(report.network[0].body.status, /decoder unavailable/);
  assert.match(report.network[1].body.status, /unavailable/);
  assert.equal(f.calls.length, 2);
});

test('URL-encoded bodies and GET query schain retain source evidence', async () => {
  const f = fixture(); f.run(undefined, true);
  const encoded = new URLSearchParams({ schain: JSON.stringify(chain), repeated: 'test' });
  f.window.fetch(openx, { method: 'POST', body: encoded });
  f.window.fetch(openx + '?' + encoded);
  const report = await f.window.__TESSERA_SCHAIN_DEBUG.ready();
  assert.equal(report.network[0].body.format, 'url-encoded');
  assert.deepEqual(plain(report.network[0].schain[0].value), chain);
  assert.deepEqual(plain(report.network[1].schain[0].value), chain);
});

test('Request stream is never read or cloned; observation exposes limitation', async () => {
  const f = fixture(); f.run(undefined, true);
  const req = new Request(openx, { method: 'POST', body: 'original' });
  f.window.fetch(req);
  const report = await f.window.__TESSERA_SCHAIN_DEBUG.ready();
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
  const f = fixture(); f.run(undefined, true); const first = f.window.__TESSERA_SCHAIN_DEBUG;
  f.run(undefined, true); assert.equal(f.handlers.size, 1); assert.equal(first.snapshot().capture.active, false);
  const wrapper = () => {}; f.window.fetch = wrapper;
  f.window.__TESSERA_SCHAIN_DEBUG.stop();
  assert.equal(f.window.fetch, wrapper); assert.equal(f.handlers.size, 0);
});

test('five-minute stop cleans XHR and future callbacks, malformed live event does not throw', () => {
  const f = fixture(); const open = f.XHR.prototype.open, send = f.XHR.prototype.send;
  f.run({ adUnit: 'P1', bidder: '' }, true);
  const handler = [...f.handlers][0];
  assert.doesNotThrow(() => handler({ bidderCode: 'openx', bids: {} }));
  handler(request('openx', 'new-auction'));
  assert.equal(f.window.__TESSERA_SCHAIN_DEBUG.snapshot().requests.length, 2);
  const timer = [...f.timers.values()][0]; assert.equal(timer.ms, 300000); timer.fn();
  assert.equal(f.XHR.prototype.open, open); assert.equal(f.XHR.prototype.send, send);
  handler(request('openx', 'after-stop'));
  assert.equal(f.window.__TESSERA_SCHAIN_DEBUG.snapshot().requests.length, 2);
});

test('console scope encoding cannot execute injected text and copy falls back to local JSON', async () => {
  const f = fixture(); const code = 'P1\");globalThis.pwned=true;//';
  const report = f.run({ adUnit: code, bidder: '' });
  assert.equal(report.scope.adUnit, code); assert.equal(f.context.pwned, undefined);
  assert.equal(JSON.parse(await f.window.__TESSERA_SCHAIN_DEBUG.copy()).schemaVersion, 1);
});


test('fetch init accessors are evaluated only by the original transport', async () => {
  let reads = 0, methods = 0;
  const f = fixture({ fetch(input, init) { void init.body; void init.method; return 'native-result'; } });
  f.run(undefined, true);
  const init = { get body() { reads++; return 'original'; }, get method() { methods++; return 'POST'; } };
  assert.equal(f.window.fetch(openx, init), 'native-result');
  assert.equal(reads, 1); assert.equal(methods, 1);
  const report = await f.window.__TESSERA_SCHAIN_DEBUG.ready();
  assert.equal(report.network[0].method, 'unavailable');
  assert.match(report.network[0].body.status, /unavailable/);
});

test('ambiguous reused impression IDs do not assert an auction or position match', async () => {
  const a = request(), b = request(); b.auctionId = 'other-auction';
  const f = fixture({ events: [a,b] }); f.run({ adUnit: 'P1', bidder: '' }, true);
  f.window.fetch(openx, { body: JSON.stringify({ imp: [{ id: a.bids[0].bidId }] }) });
  const report = await f.window.__TESSERA_SCHAIN_DEBUG.ready();
  assert.equal(report.network.length, 0); assert.match(report.unmappedNetwork[0].mapping, /ambiguous/);
});

test('gzip inflation and concurrent capture limits stay explicit and non-blocking', async () => {
  const f = fixture(); f.run(undefined, true);
  f.window.fetch(pubmatic, { body: gzipSync('x'.repeat(600000)) });
  for (let i=0;i<10;i++) f.window.fetch(pubmatic, { body: new Blob(['{}']) });
  const report = await f.window.__TESSERA_SCHAIN_DEBUG.ready();
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
  const report = await f.window.__TESSERA_SCHAIN_DEBUG.ready();
  assert(report.network.every(record => record.body.status.startsWith('unavailable')));
});
