import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Independent public-boundary policy regressions. Demand, native Prebid events
// and the clock are synthetic; this suite performs no network or ad rendering.
// The override is only for proving that these cases fail on the frozen policy:
// TESSERA_BID_CACHE_POLICY=worker/runtime-324/browser-bid-cache.mjs node --test ...
const root = fileURLToPath(new URL('../../', import.meta.url));
const source = await readFile(resolve(root, process.env.TESSERA_BID_CACHE_POLICY || 'worker/runtime-3251/browser-bid-cache.mjs'), 'utf8');
const program = source.replace('export function createTesseraBidCache(', 'function createTesseraBidCache(');
const plain = value => JSON.parse(JSON.stringify(value));
const CODE = 'Billboard', START = 1_700_000_000_000;

function harness({maxAgeSeconds = 60, floors, floor = 0, sizes = [[300, 250]]} = {}) {
  const clock = {value: START}, win = {}, handlers = {}, config = floors ? {floors} : {};
  const state = {allows: true, floor, sizes, reads: 0, epoch: 1, native: () => ({})};
  const context = vm.createContext({Date: {now: () => clock.value}});
  vm.runInContext(program, context);
  const cache = context.createTesseraBidCache(win, {
    version: '3.25.1', defaultEnabled: true, maxAgeSeconds, positions: [[CODE, true]],
  }, {
    sizes: () => state.sizes, currentAllows: () => state.allows,
    floorsRequired: !!floors, floorOwnedBidders: [],
  });
  const pb = {
    version: 'v11.34.0', bidderSettings: {},
    setConfig: value => Object.assign(config, value), getConfig: key => config[key],
    onEvent: (name, fn) => { handlers[name] = fn; },
    getAdserverTargetingForAdUnitCode(code) { state.reads++; return state.native(code); },
  };
  cache.install(pb); cache.consent(true, state.epoch);
  function bid(id, extra = {}) {
    return {adId: id, adUnitCode: CODE, auctionId: 'a1', bidderCode: 'pubmatic',
      cpm: 4, originalCpm: 4, currency: 'EUR', originalCurrency: 'EUR',
      width: 300, height: 250, mediaType: 'banner', ttl: 300,
      responseTimestamp: clock.value, ...extra};
  }
  function complete(id, bids = [], {bidders = ['pubmatic', 'openx'], nativeBidders = bidders, consent = 'synthetic-tc'} = {}) {
    cache.request([{code: CODE, bids: bidders.map(bidder => ({bidder}))}], id);
    handlers.auctionInit({auctionId: id, adUnitCodes: [CODE]});
    for (const bidder of nativeBidders) {
      handlers.bidRequested({auctionId: id, bidderCode: bidder,
        bids: [{adUnitCode: CODE, auctionId: id, getFloor: () => ({floor: state.floor, currency: 'EUR'})}],
        gdprConsent: {gdprApplies: true, consentString: consent}});
    }
    cache.auction([CODE], {[CODE]: {bids}}, id, state.epoch);
  }
  const filter = value => config.bidCacheFilterFunction(value);
  const targeting = value => value ? {hb_adid: value.adId, hb_bidder: value.bidderCode,
    hb_pb: value.cpm.toFixed(2), ['hb_adid_' + value.bidderCode]: value.adId} : {};
  function native(pool, fallback = {}) {
    state.native = () => {
      if (!config.useBidCache) return fallback;
      const valid = pool.filter(filter).sort((a, b) => b.cpm - a.cpm);
      return valid.length ? targeting(valid[0]) : fallback;
    };
  }
  function seed(old, current = [], options) { complete('a1', old, options); complete('a2', current, options); }
  return {clock, win, cache, pb, config, state, handlers, bid, complete, seed, filter, targeting, native,
    extend: (candidate, allowed = {}) => ({map: cache.extend(pb, CODE, candidate, allowed), allowed}),
    active: () => { assert.equal(cache.snapshot().status, 'active'); assert.equal(config.useBidCache, true); },
  };
}

test('more than 4096 evaluated tracked bids retain the highest eligible cached bid', () => {
  const h = harness();
  const pool = Array.from({length: 4100}, (_, i) => h.bid('older-' + i, {cpm: 5000 - i}));
  h.seed(pool); h.native(pool);
  const candidate = h.pb.getAdserverTargetingForAdUnitCode(CODE);
  assert.equal(candidate.hb_adid, pool[0].adId);
  const {map, allowed} = h.extend(candidate);
  h.active();
  assert.equal(map.hb_adid, pool[0].adId);
  assert.equal(allowed[pool[0].adId], START + 60000);
  assert(h.state.reads <= 4, 'bounded target reads despite a large native pool');
});

test('diagnostic history rollover does not forget positive native evidence for a live tracked bid', () => {
  const h = harness(), old = h.bid('kept'); h.seed([old]);
  assert.equal(h.filter(old), true);
  for (let i = 0; i < 8200; i++) assert.equal(h.filter(h.bid('untracked-' + i)), false);
  const {map, allowed} = h.extend(h.targeting(old));
  h.active(); assert.equal(map.hb_adid, old.adId); assert.equal(allowed[old.adId], START + 60000);
});

test('a bid expiring after native selection triggers a bounded reread and leaves future cache usable', () => {
  const h = harness(), expiring = h.bid('expires', {ttl: 2}), reserve = h.bid('reserve', {cpm: 3});
  const fresh = h.bid('fresh', {auctionId: 'a2', cpm: 1});
  h.seed([expiring, reserve], [fresh]); assert.equal(h.filter(expiring), true);
  const candidate = h.targeting(expiring), allowed = {[fresh.adId]: START + 299000};
  h.clock.value += 1000;
  h.native([expiring], h.targeting(fresh));
  const result = h.extend(candidate, allowed);
  assert.equal(result.map.hb_adid, fresh.adId); assert.equal(Object.hasOwn(allowed, expiring.adId), false);
  assert.equal(allowed[fresh.adId], START + 299000); h.active();
  assert(h.state.reads >= 1 && h.state.reads <= 4);
  h.complete('a3', []); assert.equal(h.filter(reserve), true);
  const next = h.extend(h.targeting(reserve));
  assert.equal(next.map.hb_adid, reserve.adId); assert.equal(next.allowed[reserve.adId], START + 60000); h.active();
});

test('retry removes a previously extended cached ID after its TTL expires', () => {
  const h = harness(), old = h.bid('previously-allowed', {ttl: 2}); h.seed([old]);
  assert.equal(h.filter(old), true);
  const allowed = {}, candidate = h.targeting(old); h.extend(candidate, allowed);
  assert.equal(allowed[old.adId], START + 1000);
  h.clock.value += 1000; h.native([old]);
  assert.deepEqual(plain(h.extend(candidate, allowed).map), {});
  assert.equal(Object.hasOwn(allowed, old.adId), false); h.active();
});

test('a mixed valid and expired candidate cannot leave abandoned cache allowances after retry', () => {
  const h = harness(), valid = h.bid('valid'), expires = h.bid('expires', {bidderCode: 'openx', ttl: 2});
  h.seed([valid, expires]); assert.equal(h.filter(valid), true); assert.equal(h.filter(expires), true);
  const candidate = {...h.targeting(valid), hb_adid_openx: expires.adId};
  h.clock.value += 1000; h.state.native = () => ({});
  const allowed = {}, {map} = h.extend(candidate, allowed);
  assert.deepEqual(plain(map), {}); assert.deepEqual(allowed, {}); h.active();
});

for (const kind of ['used', 'rendered', 'targetingSet', 'account', 'size', 'floor']) {
  test('a previously accepted bid is revalidated for a late ' + kind + ' change', () => {
    const h = harness(kind === 'floor' ? {floors: {enabled: true, enforcement: {floorDeals: true}}, floor: 1} : {});
    const old = h.bid('late-' + kind); h.seed([old]); assert.equal(h.filter(old), true);
    if (kind === 'used') h.cache.applied(CODE, h.targeting(old));
    if (kind === 'rendered' || kind === 'targetingSet') old.status = kind;
    if (kind === 'account') h.state.allows = false;
    if (kind === 'size') h.state.sizes = [[728, 90]];
    if (kind === 'floor') h.state.floor = 10;
    h.native([old]);
    const {map, allowed} = h.extend(h.targeting(old));
    assert.deepEqual(plain(map), {}); assert.equal(Object.hasOwn(allowed, old.adId), false); h.active();
  });
}

test('an explicitly rejected bid after earlier acceptance still fails closed if native returns it', () => {
  const h = harness(), old = h.bid('rejected'); h.seed([old]); assert.equal(h.filter(old), true);
  h.state.allows = false; assert.equal(h.filter(old), false);
  h.state.native = () => h.config.useBidCache ? h.targeting(old) : {};
  const {allowed} = h.extend(h.targeting(old));
  assert.equal(Object.hasOwn(allowed, old.adId), false);
  assert.equal(h.cache.snapshot().status, 'fresh-only'); assert.equal(h.config.useBidCache, false);
});

test('diagnostic history rollover cannot erase an explicit rejection and revive the bid', () => {
  const h = harness(), old = h.bid('denied-before-rollover'); h.seed([old]);
  assert.equal(h.filter(old), true); h.state.allows = false; assert.equal(h.filter(old), false);
  for (let i = 0; i < 4100; i++) h.filter(h.bid('noise-' + i));
  h.state.allows = true;
  h.state.native = () => h.config.useBidCache ? h.targeting(old) : {};
  const {allowed} = h.extend(h.targeting(old));
  assert.equal(Object.hasOwn(allowed, old.adId), false);
  assert.equal(h.cache.snapshot().status, 'fresh-only'); assert.equal(h.config.useBidCache, false);
});

test('an eligible cached bid never seen by the native filter still fails closed', () => {
  const h = harness(), old = h.bid('not-filtered'); h.seed([old]);
  h.state.native = () => h.config.useBidCache ? h.targeting(old) : {};
  const {allowed} = h.extend(h.targeting(old));
  assert.equal(Object.hasOwn(allowed, old.adId), false);
  assert.equal(h.cache.snapshot().status, 'fresh-only'); assert.equal(h.config.useBidCache, false);
});

test('repeated inconsistent native targeting terminates without admitting the expired bid', () => {
  const h = harness(), old = h.bid('stale-forever', {ttl: 2}); h.seed([old]); assert.equal(h.filter(old), true);
  h.clock.value += 1000;
  h.state.native = () => h.config.useBidCache ? h.targeting(old) : {};
  const {map, allowed} = h.extend(h.targeting(old));
  assert.deepEqual(plain(map), {}); assert.equal(Object.hasOwn(allowed, old.adId), false);
  assert(h.state.reads <= 4, 'a broken native getter must not create a request loop');
  assert.equal(h.cache.snapshot().status, 'fresh-only'); assert.equal(h.config.useBidCache, false);
});

test('a native filter replaced between selection and dispatch removes existing cache allowances', () => {
  const h = harness(), old = h.bid('filter-replaced'); h.seed([old]); assert.equal(h.filter(old), true);
  const allowed = {}; h.extend(h.targeting(old), allowed); assert.equal(typeof allowed[old.adId], 'number');
  h.config.bidCacheFilterFunction = () => true; h.state.native = () => ({});
  h.extend(h.targeting(old), allowed);
  assert.equal(Object.hasOwn(allowed, old.adId), false); assert.equal(h.cache.snapshot().status, 'fresh-only');
});

test('consent epoch change clears accepted bid evidence and any prior readiness allowance', () => {
  const h = harness(), old = h.bid('old-consent'); h.seed([old]); assert.equal(h.filter(old), true);
  const allowed = {}; h.extend(h.targeting(old), allowed); assert.equal(typeof allowed[old.adId], 'number');
  h.state.epoch++; h.cache.consent(false, h.state.epoch);
  assert.equal(h.filter(old), false);
  const {map} = h.extend({}, allowed);
  assert.deepEqual(plain(map), {}); assert.equal(Object.hasOwn(allowed, old.adId), false);
  assert.equal(h.cache.snapshot().trackedBids, 0);
});

test('exact alias and native bidder admission remain necessary after history rollover', () => {
  for (const denied of ['base-only', 'native-denied']) {
    const h = harness(), old = h.bid('alias-' + denied, {bidderCode: 'pubmatic_ag'});
    h.complete('a1', [old], {bidders: ['pubmatic_ag']});
    h.complete('a2', [], denied === 'base-only' ? {bidders: ['pubmatic']} : {bidders: ['pubmatic_ag'], nativeBidders: []});
    assert.equal(h.filter(old), false);
    for (let i = 0; i < 4100; i++) h.filter(h.bid('noise-' + i));
    h.state.native = () => h.config.useBidCache ? h.targeting(old) : {};
    const {allowed} = h.extend(h.targeting(old));
    assert.equal(Object.hasOwn(allowed, old.adId), false);
    assert.equal(h.cache.snapshot().status, 'fresh-only');
  }
});

test('native consent data and fresh deal protections still reject earlier bids', () => {
  for (const denied of ['privacy', 'deal']) {
    const h = harness(), old = h.bid('guard-' + denied); h.complete('a1', [old]);
    h.complete('a2', denied === 'deal' ? [h.bid('new-deal', {auctionId: 'a2', dealId: 'D-1'})] : [],
      denied === 'privacy' ? {consent: 'changed-synthetic-tc'} : {});
    assert.equal(h.filter(old), false);
    assert.equal(h.cache.snapshot().counters.filterRejections[denied === 'privacy' ? 'consent' : 'deal'], 1);
  }
});

test('positive filter evidence from an earlier completed auction cannot authorize a later one', () => {
  const h = harness(), old = h.bid('prior-auction-evidence'); h.seed([old]); assert.equal(h.filter(old), true);
  h.complete('a3', []);
  h.state.native = () => h.config.useBidCache ? h.targeting(old) : {};
  const {allowed} = h.extend(h.targeting(old));
  assert.equal(Object.hasOwn(allowed, old.adId), false);
  assert.equal(h.cache.snapshot().status, 'fresh-only');
});

test('tracked bid evidence remains bounded by the existing auction retention limit', () => {
  const h = harness(), old = h.bid('retired-auction'); h.seed([old]); assert.equal(h.filter(old), true);
  for (let i = 3; i <= 66; i++) h.complete('a' + i, []);
  assert.equal(h.cache.snapshot().trackedAuctions, 64);
  assert.equal(h.cache.snapshot().trackedBids, 0);
  assert.equal(h.filter(old), false);
  const {allowed} = h.extend(h.targeting(old));
  assert.equal(Object.hasOwn(allowed, old.adId), false);
});
