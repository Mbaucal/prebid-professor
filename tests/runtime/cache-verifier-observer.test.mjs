import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

// Only the CI fixture executes, against native-method stubs. No generated
// publisher runtime, browser, ad server, request, timer or network is invoked.
const root = fileURLToPath(new URL('../../', import.meta.url));
const source = await readFile(resolve(root, process.env.CACHE_VERIFIER_FIXTURE || 'tests/runtime/full-cache-browser-fixture.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function harness(nativeImplementation = () => undefined, decorateRequest = () => {}) {
  const calls = [], adapters = new Map();
  const win = {Date: {now: () => 123456}, __positionCacheTest: true};
  win.window = win;
  vm.createContext(win);
  vm.runInContext(source, win, {filename: 'full-cache-browser-fixture.js'});
  const queued = [...win.pbjs.que];
  const native = {
    requestBids(...args) {
      calls.push({receiver: this, args, input: args[0]});
      return nativeImplementation.apply(this, args);
    },
    registerBidAdapter(_factory, name, adapter) { adapters.set(name, adapter); },
  };
  decorateRequest(native.requestBids);
  const originalRequestBids = native.requestBids;
  win.pbjs = native;
  for (const fn of queued) fn();
  return {win, native, calls, adapters, originalRequestBids};
}

function invoke(h, input, {receiver = h.native, rest = []} = {}) {
  const value = h.native.requestBids.apply(receiver, [input, ...rest]);
  return {value, forwarded: h.calls.at(-1).input};
}

function responseArguments(auctionId = 'auction-a') {
  return [{Billboard: {bids: [{adId: 'bid-a'}]}}, false, auctionId, {extra: 'native'}];
}

const fixtureBid = (code = 'Billboard', requestId = 'request-1', auctionId = 'auction-a') => ({
  adUnitCode: code, bidId: requestId, auctionId,
  mediaTypes: {banner: {sizes: [[1, 1], [300, 250], 'fluid']}},
});

test('installing the observer registers only the existing synthetic adapters and starts no auction', () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  assert.deepEqual([...h.adapters.keys()], ['pubmatic', 'openx']);
  assert.deepEqual(plain(h.win.__fixtureCallbackTrace), []);
});

test('requestBids preserves receiver, rest arguments, return and all shallow option references', () => {
  const nativeReturn = {native: 'return'}, receiver = {name: 'caller'};
  const h = harness(() => nativeReturn);
  const callback = () => {}, codes = ['Billboard'], units = [{code: 'Billboard'}], labels = ['desktop'];
  const input = {bidsBackHandler: callback, adUnitCodes: codes, adUnits: units, labels, timeout: 800, custom: {kept: true}};
  const rest = [{rest: 1}, 2];
  const {value, forwarded} = invoke(h, input, {receiver, rest});
  assert.equal(value, nativeReturn);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].receiver, receiver);
  assert.equal(h.calls[0].args[1], rest[0]);
  assert.equal(h.calls[0].args[2], rest[1]);
  assert.equal(h.calls[0].args.length, 3);
  assert.notEqual(forwarded, input, 'Only the options container is copied for the wrapped callback');
  assert.notEqual(forwarded.bidsBackHandler, callback);
  for (const key of Object.keys(input).filter(key => key !== 'bidsBackHandler')) assert.equal(forwarded[key], input[key], key);
  assert.equal(input.bidsBackHandler, callback);
  assert.deepEqual(codes, ['Billboard']);
  assert.deepEqual(plain(h.win.__fixtureCallbackTrace), []);
});

test('options without a function callback are passed to native unchanged', () => {
  const h = harness(() => 'same-native-return');
  for (const callback of [undefined, null, 'not-a-function']) {
    const input = {adUnitCodes: ['Billboard'], bidsBackHandler: callback};
    const {value, forwarded} = invoke(h, input);
    assert.equal(value, 'same-native-return'); assert.equal(forwarded, input);
  }
  assert.equal(h.calls.length, 3);
  assert.deepEqual(plain(h.win.__fixtureCallbackTrace), []);
});

test('callback receives the original this and arguments and returns its exact result', () => {
  const h = harness(), callbackThis = {callback: 'receiver'}, callbackReturn = {callback: 'result'};
  const args = responseArguments(); let seen;
  const input = {adUnitCodes: ['Billboard'], bidsBackHandler: function (...actual) {
    seen = {receiver: this, actual, context: plain(h.win.__fixtureCallbackContext)};
    return callbackReturn;
  }};
  const {forwarded} = invoke(h, input);
  const result = forwarded.bidsBackHandler.apply(callbackThis, args);
  assert.equal(result, callbackReturn); assert.equal(seen.receiver, callbackThis);
  assert.equal(seen.actual.length, args.length);
  for (let i = 0; i < args.length; i++) assert.equal(seen.actual[i], args[i]);
  assert.equal(seen.context.auctionId, 'auction-a');
  assert.deepEqual(seen.context.codes, ['Billboard']); assert.equal(seen.context.at, 123456);
  assert.equal(h.win.__fixtureCallbackContext, undefined);
  assert.equal(h.calls.length, 1);
});

test('callback trace uses the native callback auction ID, independent of selected historic bids', () => {
  const h = harness(); let inside;
  const args = [{Billboard: {bids: [{adId: 'cached', auctionId: 'older-auction'}]}}, false, 'current-auction'];
  const {forwarded} = invoke(h, {adUnitCodes: ['Billboard'], bidsBackHandler() { inside = h.win.__fixtureCallbackContext.auctionId; }});
  forwarded.bidsBackHandler(...args);
  assert.equal(inside, 'current-auction');
  assert.equal(h.win.__fixtureCallbackTrace[0].auctionId, 'current-auction');
  assert.equal(args[0].Billboard.bids[0].auctionId, 'older-auction');
});

test('non-string callback auction IDs remain unknown instead of being guessed or coerced', () => {
  for (const value of [undefined, null, 17, {auctionId: 'not-native'}]) {
    const h = harness(); let inside;
    const {forwarded} = invoke(h, {auctionId: 'input-is-not-proof', adUnitCodes: ['Billboard'], bidsBackHandler() { inside = h.win.__fixtureCallbackContext.auctionId; }});
    forwarded.bidsBackHandler({}, false, value);
    assert.equal(inside, null); assert.equal(h.win.__fixtureCallbackTrace[0].auctionId, null);
  }
});

test('adUnitCodes takes precedence over the adUnits fallback without changing either input', () => {
  const h = harness(); let codes;
  const input = {adUnitCodes: ['Explicit'], adUnits: [{code: 'Fallback'}], bidsBackHandler() { codes = plain(h.win.__fixtureCallbackContext.codes); }};
  const {forwarded} = invoke(h, input); forwarded.bidsBackHandler(...responseArguments());
  assert.deepEqual(codes, ['Explicit']); assert.deepEqual(input.adUnitCodes, ['Explicit']);
  assert.deepEqual(input.adUnits, [{code: 'Fallback'}]);
});

test('code fallback covers adUnits and absent code options', () => {
  for (const [options, expected] of [[{adUnits: [{code: 'Billboard'}, {code: 'Sticky'}]}, ['Billboard', 'Sticky']], [{}, []]]) {
    const h = harness(); let codes;
    const {forwarded} = invoke(h, {...options, bidsBackHandler() { codes = plain(h.win.__fixtureCallbackContext.codes); }});
    forwarded.bidsBackHandler(...responseArguments());
    assert.deepEqual(codes, expected);
  }
});

test('callback trace is an immutable snapshot of codes at observation time', () => {
  const h = harness(), codes = ['Billboard'];
  const {forwarded} = invoke(h, {adUnitCodes: codes, bidsBackHandler() {}});
  forwarded.bidsBackHandler(...responseArguments());
  const trace = h.win.__fixtureCallbackTrace[0];
  codes.push('Later');
  assert.deepEqual(plain(trace.codes), ['Billboard']);
  assert(Object.isFrozen(trace)); assert(Object.isFrozen(trace.codes));
  assert.equal(Reflect.set(trace, 'auctionId', 'mutated'), false);
  assert.equal(Reflect.set(trace.codes, '0', 'mutated'), false);
  assert.equal(trace.auctionId, 'auction-a'); assert.equal(trace.codes[0], 'Billboard');
});

test('an existing callback context is restored after success and after the same error is rethrown', () => {
  for (const throws of [false, true]) {
    const h = harness(), previous = {auctionId: 'outer', codes: ['Outer']}, error = new Error('callback error');
    h.win.__fixtureCallbackContext = previous;
    const {forwarded} = invoke(h, {adUnitCodes: ['Billboard'], bidsBackHandler() {
      assert.equal(h.win.__fixtureCallbackContext.auctionId, 'auction-a');
      if (throws) throw error;
      return 'returned';
    }});
    if (throws) assert.throws(() => forwarded.bidsBackHandler(...responseArguments()), thrown => thrown === error);
    else assert.equal(forwarded.bidsBackHandler(...responseArguments()), 'returned');
    assert.equal(h.win.__fixtureCallbackContext, previous);
    assert.equal(h.win.__fixtureCallbackTrace.length, 1); assert.equal(h.calls.length, 1);
  }
});

test('nested callbacks keep separate auction contexts and restore the outer one in order', () => {
  const h = harness(), before = {auctionId: 'before'}, visits = [];
  h.win.__fixtureCallbackContext = before;
  let second;
  const first = invoke(h, {adUnitCodes: ['Billboard'], bidsBackHandler() {
    visits.push(plain(h.win.__fixtureCallbackContext));
    assert.equal(second.bidsBackHandler({}, false, 'auction-b'), 'second-result');
    visits.push(plain(h.win.__fixtureCallbackContext));
    return 'first-result';
  }}).forwarded;
  second = invoke(h, {adUnitCodes: ['Sticky'], bidsBackHandler() { visits.push(plain(h.win.__fixtureCallbackContext)); return 'second-result'; }}).forwarded;
  assert.equal(first.bidsBackHandler({}, false, 'auction-a'), 'first-result');
  assert.deepEqual(visits.map(row => [row.auctionId, row.codes]), [['auction-a', ['Billboard']], ['auction-b', ['Sticky']], ['auction-a', ['Billboard']]]);
  assert.equal(h.win.__fixtureCallbackContext, before);
  assert.deepEqual(plain(h.win.__fixtureCallbackTrace).map(row => row.auctionId), ['auction-a', 'auction-b']);
  assert.equal(h.calls.length, 2);
});

test('a caught nested callback error restores the outer context before its callback continues', () => {
  const h = harness(), error = new Error('nested callback error'); let second;
  const first = invoke(h, {adUnitCodes: ['Billboard'], bidsBackHandler() {
    assert.throws(() => second.bidsBackHandler({}, false, 'auction-b'), thrown => thrown === error);
    assert.equal(h.win.__fixtureCallbackContext.auctionId, 'auction-a');
  }}).forwarded;
  second = invoke(h, {adUnitCodes: ['Sticky'], bidsBackHandler() { throw error; }}).forwarded;
  first.bidsBackHandler({}, false, 'auction-a');
  assert.equal(h.win.__fixtureCallbackContext, undefined);
  assert.equal(h.win.__fixtureCallbackTrace.length, 2); assert.equal(h.calls.length, 2);
});

test('the observer records repeated native callback invocations instead of suppressing them', () => {
  const h = harness(); let callbacks = 0;
  const {forwarded} = invoke(h, {adUnitCodes: ['Billboard'], bidsBackHandler() { callbacks++; }});
  forwarded.bidsBackHandler({}, false, 'auction-a'); forwarded.bidsBackHandler({}, false, 'auction-a');
  assert.equal(callbacks, 2); assert.equal(h.win.__fixtureCallbackTrace.length, 2); assert.equal(h.calls.length, 1);
});

test('a native requestBids error is rethrown unchanged without fabricated callback records', () => {
  const error = new Error('native request error'), h = harness(() => { throw error; });
  assert.throws(() => h.native.requestBids({adUnitCodes: ['Billboard'], bidsBackHandler() { assert.fail('Not called'); }}), thrown => thrown === error);
  assert.equal(h.calls.length, 1); assert.deepEqual(plain(h.win.__fixtureCallbackTrace), []);
  assert.equal(h.win.__fixtureCallbackContext, undefined);
});

test('immutable adapter trace retains both public auction IDs and the original request ID', () => {
  const h = harness(), adapter = h.adapters.get('pubmatic'), bid = fixtureBid();
  const request = adapter.buildRequests([bid], {auctionId: 'bidder-auction-a', bidderRequestId: 'bidder-request-a'});
  assert.equal(request.method, 'GET'); assert.equal(request.url, 'https://readiness-fixture.invalid/bid');
  assert.deepEqual(JSON.parse(request.data.payload), [{requestId: 'request-1', cpm: 10, ttl: 120, width: 300, height: 250, fixtureRound: 1, fixtureCode: 'Billboard'}]);
  assert.deepEqual(plain(request.options), {withCredentials: false});
  const trace = h.win.__fixtureBidTrace[0];
  assert.deepEqual(plain(trace), {bidder: 'pubmatic', code: 'Billboard', round: 1, requestId: 'request-1', bidAuctionId: 'auction-a', bidderAuctionId: 'bidder-auction-a', bidderRequestId: 'bidder-request-a', at: 123456});
  assert(Object.isFrozen(trace)); assert.equal(Reflect.set(trace, 'round', 100), false);
  bid.auctionId = 'later'; bid.bidId = 'later'; bid.adUnitCode = 'Later';
  assert.equal(trace.bidAuctionId, 'auction-a'); assert.equal(trace.requestId, 'request-1'); assert.equal(trace.code, 'Billboard');
});

test('observational adapter tracing keeps existing per-bidder CPM sequences and round counters', () => {
  const h = harness();
  for (const [name, expected] of [['pubmatic', [10, 1, 1, 12]], ['openx', [4, 0.5, 0.5, 0.5]]]) {
    const adapter = h.adapters.get(name), actual = [];
    for (let round = 1; round <= 4; round++) {
      const response = adapter.buildRequests([fixtureBid('Billboard', name + '-' + round, 'auction-' + round)], {auctionId: 'auction-' + round});
      const payload = JSON.parse(response.data.payload); actual.push(payload[0].cpm);
      assert.equal(payload[0].fixtureRound, round); assert.equal(h.win.__fixtureBidRounds.get(name + ':Billboard'), round);
    }
    assert.deepEqual(actual, expected);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.win.__fixtureBidTrace.length, 8);
  assert.equal(h.win.__fixtureBidTrace[0].round, 1); assert.equal(h.win.__fixtureBidTrace[0].requestId, 'pubmatic-1');
});


test('native hook functions, symbols and property descriptors pass through the observer', () => {
  const before = () => 'before', after = () => 'after', symbol = Symbol('native-hook');
  const token = {hook: true};
  const h = harness(() => undefined, requestBids => {
    Object.defineProperty(requestBids, 'before', {value: before, enumerable: false, writable: false, configurable: false});
    Object.defineProperty(requestBids, 'after', {value: after, enumerable: true, writable: true, configurable: true});
    Object.defineProperty(requestBids, symbol, {value: token, enumerable: false, writable: false});
  });
  assert.equal(h.native.requestBids.before, before); assert.equal(h.native.requestBids.after, after);
  assert.equal(h.native.requestBids[symbol], token);
  for (const key of ['before', 'after', symbol]) assert.deepEqual(Object.getOwnPropertyDescriptor(h.native.requestBids, key), Object.getOwnPropertyDescriptor(h.originalRequestBids, key));
  assert.equal(h.calls.length, 0);
});

test('a fallback GAM observation outside a native callback has unknown callback lineage', () => {
  const h = harness();
  const observe = () => ({callbackAuctionId: h.win.__fixtureCallbackContext?.auctionId || null,
    callbackCodes: h.win.__fixtureCallbackContext?.codes || []});
  const {forwarded} = invoke(h, {adUnitCodes: ['Billboard'], bidsBackHandler() {
    assert.deepEqual(plain(observe()), {callbackAuctionId: 'auction-a', callbackCodes: ['Billboard']});
  }});
  assert.deepEqual(plain(observe()), {callbackAuctionId: null, callbackCodes: []});
  forwarded.bidsBackHandler(...responseArguments());
  assert.equal(h.win.__fixtureCallbackTrace[0].auctionId, 'auction-a');
  assert.deepEqual(plain(observe()), {callbackAuctionId: null, callbackCodes: []}, 'Previous callbacks cannot authorize a later fallback observation');
});
