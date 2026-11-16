import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {runtimeCatalog, buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {prebidRequirements, inspectPrebidArtifact, sha256} from '../../worker/runtime/prebid-artifact-check.mjs';
import {previewInput} from '../../worker/runtime-323/snapshot.mjs';
import {browserSources} from '../../.generated/runtime-323-browser-source.mjs';
import {bidCachePage, decided} from './bid-cache323-page.mjs';
import {bidCacheSite as site} from './bid-cache323-site.mjs';

// The whole generated ads.min.js of a synthetic, non-Tanjug site runs in node:vm
// with a GPT that records every GAM request, a TCF CMP and a Prebid fake with
// Prebid 11.34 bid cache semantics (see bid-cache323-page.mjs). The site is
// bid-cache323-site.mjs. Synthetic demand only.
const stamp = '20261115_120000', decoder = new TextDecoder();
const V323 = runtimeCatalog.find(r => r.id === 'tessera-3.23.0'), V3212 = runtimeCatalog.find(r => r.id === 'tessera-3.21.2');
const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => assert.fail('No network'); });
test.after(() => { globalThis.fetch = originalFetch; delete globalThis.__bidCachePage; });

const packages = new Map();
async function adsFor(options = {}, descriptor = V323) {
  const key = JSON.stringify([options, descriptor.id]);
  if (!packages.has(key)) {
    const snapshot = site(options), config = JSON.parse(snapshot.config.config_json);
    const requirements = prebidRequirements(previewInput(snapshot, V323, stamp), config);
    const bytes = new TextEncoder().encode(`/* prebid.js v11.34.0\nModules: ${requirements.modules.join(', ')} */\nvoid 0;`).buffer;
    const build = {id: 'b', publisher_id: 'bc-site', status: 'current', version: '11.34.0', file_key: 'publishers/bc-site/prebid-builds/b/prebid.js', modules_json: JSON.stringify(requirements.modules)};
    const object = {size: bytes.byteLength, customMetadata: {sha256: await sha256(bytes), version: '11.34.0'}, async arrayBuffer() { return bytes; }};
    const prebid = {bytes, report: await inspectPrebidArtifact({siteId: 'bc-site', builds: [build], requirements}, {async get() { return object; }})};
    const candidate = await buildArtifactCandidate({snapshot, pin: pinRuntime(descriptor), buildTimestamp: stamp, prebid});
    packages.set(key, {min: decoder.decode(candidate.files['ads.min.js']), config: JSON.parse(decoder.decode(candidate.files['config.json']))});
  }
  return packages.get(key);
}

/** Scripted bids per position: rounds[code][n] are the bids of that position's n-th auction. */
function script(rounds) {
  const seen = {};
  return auction => auction.codes.flatMap(code => {
    const n = seen[code] = (seen[code] ?? -1) + 1;
    return ((rounds[code] || [])[n] || []).map(bid => ({code, ...bid}));
  });
}
const pub = (cpm, extra = {}) => ({bidder: 'pubmatic', cpm, ...extra});
const ox = (cpm, extra = {}) => ({bidder: 'openx', cpm, ...extra});
const STANDARD = {Billboard: [[pub(4), pub(10)], [pub(1)], [pub(12)]]};

/** Consent, the initial requests and `refreshes` automatic refreshes (30 s rule). */
async function run(source, {rounds = STANDARD, refreshes = 2, between, ...options} = {}) {
  const page = bidCachePage(source, {respond: script(rounds), ...options}).run();
  await page.clock.tick(10);
  page.consent(decided());
  await page.clock.tick(1000);
  for (let i = 0; i < refreshes; i++) {
    if (between) await between(page, i);
    await page.clock.tick(36000);
  }
  assert.deepEqual(page.errors, []);
  assert(page.fetches.length <= 1, 'at most the country lookup, which never resolves here');
  return page;
}
const adOf = (page, code, cpm, bidder = 'pubmatic') => page.prebid.bids.find(bid => bid.adUnitCode === code && bid.cpm === cpm && bid.bidderCode === bidder)?.adId;
const sent = (page, code) => page.requestsFor(code).map(request => request.keys.hb_pb ? Number(request.keys.hb_pb[0]) : null);

test('without saved bid caching, 3.23.0 sends exactly the 3.21.2 GAM requests and Prebid settings', async () => {
  const rounds = {Billboard: [[pub(4), pub(10), ox(3)], [pub(1)], [pub(12)]], P1: [[ox(2)], [], [ox(5, {dealId: 'D-1'})]]};
  const old = await run((await adsFor({}, V3212)).min, {rounds}), next = await run((await adsFor({})).min, {rounds});
  const shape = page => page.requests.map(request => ({code: request.code, at: request.at, keys: request.keys}));
  assert.deepEqual(shape(next), shape(old));
  assert.deepEqual(sent(next, 'Billboard'), [10, 1, 12], 'fresh bids only');
  assert.deepEqual(JSON.stringify(next.prebid.log), JSON.stringify(old.prebid.log));
  assert.equal(next.prebid.config().useBidCache, false); assert.equal(next.prebid.config().bidCacheFilterFunction, undefined);
  assert.equal(next.snapshot(), undefined, 'no bid cache diagnostics');
  assert(next.prebid.auctions.every(auction => auction.preset), 'presetGPTTargeting stays as in 3.21.2');
});

test('a higher unsent earlier bid wins the refresh and is the targeting GAM receives; a higher fresh bid wins later', async () => {
  const page = await run((await adsFor({cache: {enabled: true, maxBidAgeSeconds: 60}})).min);
  const [first, second, third] = page.requestsFor('Billboard');
  assert.deepEqual(first.keys.hb_adid, [adOf(page, 'Billboard', 10)]);
  // Refresh 1: fresh 1 against the unsent 4 of the first auction (same bidder, so only its best is targeted).
  assert.deepEqual(second.keys.hb_adid, [adOf(page, 'Billboard', 4)]);
  assert.deepEqual(second.keys.hb_pb, ['4.00']); assert.deepEqual(second.keys.hb_adid_pubmatic, [adOf(page, 'Billboard', 4)]);
  // Refresh 2: fresh 12 beats every earlier bid (4 was sent, 1 is still unsent).
  assert.deepEqual(third.keys.hb_adid, [adOf(page, 'Billboard', 12)]);
  const snapshot = page.snapshot();
  assert.equal(snapshot.status, 'active'); assert.equal(snapshot.counters.cachedWins, 1);
  assert.equal(snapshot.lastSelection.code, 'P1');
  assert.equal(page.prebid.config().useBidCache, true); assert.equal(page.prebid.config().targetingControls.presetGPTTargeting, undefined);
  assert.equal(page.prebid.config().targetingControls.alwaysIncludeDeals, true); assert.equal(page.prebid.config().enableSendAllBids, true);
  // Prebid's own presetGPTTargeting only clears hb_* keys at auctionInit (it never writes pool bids): kept as in 3.21.2.
  assert(page.prebid.auctions.every(auction => auction.preset), 'presetGPTTargeting stays as in 3.21.2 while caching is on');
  // Prebid asks the filter again on every targeting read; each bid counts once per refusal reason.
  for (const [why, count] of Object.entries(snapshot.counters.filterRejections)) assert(count <= page.prebid.bids.length, `${why}: ${count} refusals for ${page.prebid.bids.length} bids`);
  // Every GAM request had its own new auction, also when an earlier bid won.
  assert.equal(page.prebid.auctions.filter(auction => auction.codes.includes('Billboard')).length, page.requestsFor('Billboard').length);
  const text = JSON.stringify(snapshot);
  assert(!/ad-\d|synthetic-tc|consentString/.test(text), 'diagnostics carry no ad IDs or consent strings');
});

test('maximum bid age: 1 second never reuses at a 30-second refresh, 300 seconds does; bidder TTL still limits reuse', async () => {
  const one = await run((await adsFor({cache: {enabled: true, maxBidAgeSeconds: 1}})).min);
  assert.deepEqual(sent(one, 'Billboard'), [10, 1, 12]);
  assert(one.snapshot().counters.filterRejections.expired >= 1, 'an expired earlier bid is refused as expired');
  assert.deepEqual(sent(await run((await adsFor({cache: {enabled: true, maxBidAgeSeconds: 300}})).min), 'Billboard'), [10, 4, 12]);
  // The cached 4 has a 20 s TTL: expired by the first refresh even with a 300 s maximum age.
  const short = {Billboard: [[pub(4, {ttl: 20}), pub(10)], [pub(1)], [pub(12)]]};
  const page = await run((await adsFor({cache: {enabled: true, maxBidAgeSeconds: 300}})).min, {rounds: short});
  assert.deepEqual(sent(page, 'Billboard'), [10, 1, 12]);
  assert.equal(page.snapshot().counters.cachedWins, 0);
  assert(page.snapshot().counters.filterRejections.expired >= 1);
});

test('a position override off keeps fresh bids while the site default reuses on the other position', async () => {
  const rounds = {Billboard: STANDARD.Billboard, P1: [[ox(5), ox(9)], [ox(2)], []]};
  const page = await run((await adsFor({cache: {enabled: true, maxBidAgeSeconds: 60, positionOverrides: {Billboard: false}}})).min, {rounds});
  assert.deepEqual(sent(page, 'Billboard'), [10, 1, 12]);
  // P1 reuses: 5 beats the fresh 2, then the unsent 2 fills the empty third auction.
  assert.deepEqual(sent(page, 'P1'), [9, 5, 2]);
  assert.deepEqual(page.snapshot().positions, [{code: 'Billboard', enabled: false}, {code: 'P1', enabled: true}]);
});

test('the site default off with a position override on reuses only on that position', async () => {
  const rounds = {Billboard: STANDARD.Billboard, P1: [[ox(5), ox(9)], [ox(2)], []]};
  const page = await run((await adsFor({cache: {enabled: false, maxBidAgeSeconds: 60, positionOverrides: {Billboard: true}}})).min, {rounds});
  assert.deepEqual(sent(page, 'Billboard'), [10, 4, 12]);
  assert.deepEqual(sent(page, 'P1'), [9, 2, null]);
});

test('a TCF change drops every earlier bid; GPP and US privacy changes prevent reuse only when Prebid sends that data', async () => {
  const source = (await adsFor({cache: {enabled: true, maxBidAgeSeconds: 60}})).min;
  const tcf = await run(source, {between: async (page, i) => { if (i === 0) { page.consent(decided('synthetic-tc-b')); assert.equal(page.snapshot().trackedBids, 0); } }});
  assert.deepEqual(sent(tcf, 'Billboard'), [10, 1, 12]);
  // Tessera turns Prebid's GPP module off (as 3.21.2), so bidders get no GPP data and a GPP change does not stop reuse.
  const gppString = {gpp: {gppString: 'DBABMA~synthetic', applicableSections: [7]}};
  const gpp = await run(source, {modules: ['consentManagementGpp'], between: async (page, i) => { if (i === 0) page.privacy(gppString); }});
  assert.equal(gpp.prebid.config().consentManagement.gpp.enabled, false);
  assert(gpp.prebid.auctions.every(auction => auction.consent.gppConsent === undefined), 'no GPP data reaches bidders');
  assert.deepEqual(sent(gpp, 'Billboard'), [10, 4, 12]);
  // Without consentManagementUsp in the site's Prebid.js (the vendored build has none), US privacy never reaches bidders either.
  const plain = await run(source, {between: async (page, i) => { if (i === 0) page.privacy({usp: '1YNN'}); }});
  assert(plain.prebid.auctions.every(auction => auction.consent.uspConsent === undefined), 'no US privacy data reaches bidders');
  assert.deepEqual(sent(plain, 'Billboard'), [10, 4, 12]);
  // With consentManagementUsp, Prebid sends US privacy data, and a change prevents reuse across it.
  const usp = await run(source, {modules: ['consentManagementUsp'], between: async (page, i) => { if (i === 0) page.privacy({usp: '1YNN'}); }});
  assert.deepEqual(sent(usp, 'Billboard'), [10, 1, 12]);
  assert(usp.snapshot().counters.filterRejections.consent >= 1);
  // Unchanged consent data between the first two auctions keeps reuse there; a later change affects only later auctions.
  const same = await run(source, {modules: ['consentManagementUsp'], between: async (page, i) => { if (i === 1) page.privacy({usp: '1YNN'}); }});
  assert.deepEqual(sent(same, 'Billboard'), [10, 4, 12]);
});

test('without a completed CMP decision there is no auction and no GAM request', async () => {
  const page = bidCachePage((await adsFor({cache: {enabled: true, maxBidAgeSeconds: 60}})).min, {respond: script(STANDARD)}).run();
  await page.clock.tick(60000);
  page.consent({gdprApplies: true, cmpStatus: 'loaded', eventStatus: 'cmpuishown'});
  await page.clock.tick(60000);
  assert.equal(page.prebid.auctions.length, 0); assert.equal(page.requests.length, 0);
  assert.equal(page.snapshot().consentReady, false); assert.equal(page.snapshot().trackedBids, 0);
  page.consent(decided());
  await page.clock.tick(1000);
  assert.deepEqual(sent(page, 'Billboard'), [10]);
});

test('a bid sent to GAM once is never sent again: winner, other bidders and deal keys', async () => {
  // First auction: pubmatic 10 wins, openx 3 and the openx deal go out as bidder keys.
  const rounds = {Billboard: [[pub(10), ox(3), ox(2, {dealId: 'D-7'})], [pub(1)], [pub(0.5)]], P1: [[ox(6, {dealId: 'D-8'}), pub(1)], [pub(0.2)], []]};
  const page = await run((await adsFor({cache: {enabled: true, maxBidAgeSeconds: 60}})).min, {rounds});
  const [first, second, third] = page.requestsFor('Billboard');
  assert.deepEqual(first.keys.hb_adid_openx, [adOf(page, 'Billboard', 3, 'openx')]);
  // openx 3 was sent as hb_adid_openx; only openx 2 (deal, never sent) may compete again.
  assert.deepEqual(second.keys.hb_adid, [adOf(page, 'Billboard', 2, 'openx')]);
  assert.deepEqual(second.keys.hb_deal_openx, ['D-7']);
  // pubmatic 1 went out as hb_adid_pubmatic in the second request, so the fresh 0.5 is the only pubmatic bid left.
  assert.deepEqual(second.keys.hb_adid_pubmatic, [adOf(page, 'Billboard', 1)]);
  assert.deepEqual(third.keys.hb_adid, [adOf(page, 'Billboard', 0.5)]);
  const ids = page.requestsFor('Billboard').flatMap(request => Object.entries(request.keys).filter(([key]) => /^hb_adid/.test(key)).flatMap(([, value]) => value));
  for (const request of page.requests) {
    const earlier = page.requests.filter(other => other.at < request.at && other.code === request.code)
      .flatMap(other => Object.entries(other.keys).filter(([key]) => /^hb_adid/.test(key)).flatMap(([, value]) => value));
    for (const [key, value] of Object.entries(request.keys)) if (/^hb_adid/.test(key)) for (const id of value) assert(!earlier.includes(id), `${request.code} ${key} ${id} was sent before`);
  }
  assert(ids.length > 3);
  // P1: the openx deal won the first request, so its deal is not offered again.
  assert.deepEqual(page.requestsFor('P1')[0].keys.hb_deal, ['D-8']);
  assert(!page.requestsFor('P1').slice(1).some(request => (request.keys.hb_deal_openx || []).includes('D-8')));
});

test('a fresh deal bid keeps the same bidder\'s earlier bids out of that auction: hb_deal_<bidder> as in 3.21.2', async () => {
  // First auction: openx 6 goes out as hb_adid_openx and openx 5 stays unsent. The refresh brings a fresh
  // openx deal at 3. Prebid keeps one bid per bidder per position before it sets hb_*_<bidder> and
  // hb_deal_<bidder>, so the cached openx 5 must not take the deal's place.
  const rounds = {Billboard: [[pub(10), ox(6), ox(5)], [pub(1), ox(3, {dealId: 'D-9'})], [pub(2)]]};
  const old = await run((await adsFor({}, V3212)).min, {rounds});
  const page = await run((await adsFor({cache: {enabled: true, maxBidAgeSeconds: 300}})).min, {rounds});
  const second = target => target.requestsFor('Billboard')[1].keys;
  assert.deepEqual(second(page).hb_deal_openx, ['D-9'], 'the fresh deal reaches GAM');
  assert.deepEqual(second(page).hb_adid_openx, [adOf(page, 'Billboard', 3, 'openx')], 'the fresh deal is the openx bid');
  assert.deepEqual(second(page), second(old), 'the refresh sends what 3.21.2 sends');
  // Without a fresh openx deal in the next auction, the unsent openx 5 competes again and wins.
  assert.deepEqual(page.requestsFor('Billboard')[2].keys.hb_adid, [adOf(page, 'Billboard', 5, 'openx')]);
  assert.deepEqual(sent(page, 'Billboard'), [10, 3, 5]);
  assert.equal(page.snapshot().status, 'active');
  assert.equal(page.snapshot().counters.filterRejections.deal, 1, JSON.stringify(page.snapshot().counters));
});

test('an earlier bid whose size the position cannot request at the current viewport is not reused', async () => {
  const rounds = {Billboard: [[pub(4, {width: 970, height: 250}), pub(10)], [pub(1)], []]};
  const source = (await adsFor({cache: {enabled: true, maxBidAgeSeconds: 60}})).min;
  const wide = await run(source, {rounds, refreshes: 1});
  assert.deepEqual(sent(wide, 'Billboard'), [10, 4], '970x250 is valid on desktop');
  const narrow = await run(source, {rounds, refreshes: 1, between: async page => { page.context.innerWidth = 800; page.context.outerWidth = 800; }});
  assert.deepEqual(sent(narrow, 'Billboard'), [10, 1]);
  assert(narrow.snapshot().counters.filterRejections.size >= 1);
});

test('TakeOver and Outstream run fresh auctions only and are never dropped', async () => {
  const source = (await adsFor({cache: {enabled: true, maxBidAgeSeconds: 60}, takeOver: true, outstream: true})).config;
  assert.deepEqual(source.bidCache.positions, {Billboard: true, P1: true});
  const {min} = await adsFor({cache: {enabled: true, maxBidAgeSeconds: 60}, takeOver: true, outstream: true});
  const rounds = {Billboard: STANDARD.Billboard, Overlay: [[pub(7, {width: 800, height: 600}), pub(20, {width: 800, height: 600})], [pub(1, {width: 800, height: 600})]],
    P2: [[pub(6, {mediaType: 'video', width: 640, height: 360}), pub(3, {mediaType: 'video', width: 640, height: 360})], [pub(1, {mediaType: 'video', width: 640, height: 360})]]};
  const containers = ['Billboard', 'P1', 'P2'];
  const page = await run(min, {rounds, containers});
  const codes = [...new Set(page.prebid.auctions.flatMap(auction => auction.codes))].sort();
  assert.deepEqual(codes, ['Billboard', 'Overlay', 'P1', 'P2']);
  // TakeOver, its Interstitial fallback and Outstream send exactly what 3.21.2 sends for the same bids.
  const old = await run((await adsFor({takeOver: true, outstream: true}, V3212)).min, {rounds, containers});
  const others = target => target.requests.filter(request => !['Billboard', 'P1'].includes(request.code)).map(({code, at, keys}) => ({code, at, keys}));
  assert(others(page).some(request => request.code === 'adsx-takeover-slot') && others(page).some(request => request.code === 'P2' && request.keys.hb_pb));
  assert.deepEqual(others(page), others(old));
  for (const [code, element] of [['Overlay', 'adsx-takeover-slot'], ['P2', 'P2']]) {
    assert(page.requestsFor(element).length >= 1, `${code} is requested`);
    for (const request of page.requestsFor(element)) {
      const ids = Object.entries(request.keys).filter(([key]) => /^hb_adid/.test(key)).flatMap(([, value]) => value);
      const auctionOf = id => page.prebid.bids.find(bid => bid.adId === id)?.auctionId;
      const latest = page.prebid.auctions.filter(auction => auction.codes.includes(code) && auction.at <= request.at).at(-1);
      for (const id of ids) assert.equal(auctionOf(id), latest.id, `${code} only uses bids of its own latest auction`);
    }
  }
  assert.deepEqual(sent(page, 'Billboard'), [10, 4, 12]);
  // The policy itself refuses an earlier bid for these positions.
  const filter = page.prebid.config().bidCacheFilterFunction;
  for (const code of ['Overlay', 'P2', 'Interstitial']) {
    const old = page.prebid.bids.find(bid => bid.adUnitCode === code) || {adUnitCode: code, adId: 'x', auctionId: 'old', cpm: 1, mediaType: 'banner', width: 300, height: 250};
    assert.equal(filter({...old, auctionId: 'an-earlier-auction'}), false, code);
  }
  assert(page.snapshot().counters.filterRejections['position-off'] >= 3);
});

for (const [mode, reason] of [['no-getconfig', 'prebid-api-missing'], ['no-cache', 'bid-cache-unsupported'], ['no-filter', 'filter-not-honored']]) {
  test(`a Prebid.js without working bid cache support (${mode}) falls back to fresh bids without errors`, async () => {
    const page = await run((await adsFor({cache: {enabled: true, maxBidAgeSeconds: 60}})).min, {mode});
    assert.deepEqual(sent(page, 'Billboard'), [10, 1, 12]);
    assert.equal(page.snapshot().status, 'fresh-only'); assert.equal(page.snapshot().reason, reason);
    assert.equal(page.prebid.config().useBidCache === true, false, 'useBidCache is off again');
    assert.deepEqual(page.errors, []);
  });
}

test('a bid cache filter set by another script is respected: fresh bids only', async () => {
  const source = (await adsFor({cache: {enabled: true, maxBidAgeSeconds: 60}})).min;
  const page = bidCachePage(source, {respond: script(STANDARD)});
  const foreign = () => true;
  page.prebid.pb.setConfig({bidCacheFilterFunction: foreign});
  page.run();
  await page.clock.tick(10); page.consent(decided());
  await page.clock.tick(1000);
  for (let i = 0; i < 2; i++) await page.clock.tick(36000);
  assert.equal(page.snapshot().status, 'fresh-only'); assert.equal(page.snapshot().reason, 'publisher-filter-present');
  assert.equal(page.prebid.config().bidCacheFilterFunction, foreign);
  assert.deepEqual(sent(page, 'Billboard'), [10, 1, 12]);
});

// The policy alone, with exact clock boundaries.
function policy(settings, sizes = [[300, 250]]) {
  const clock = {value: 1_700_000_000_000, now() { return this.value; }}, win = {};
  const context = vm.createContext({Date: {now: () => clock.value}});
  vm.runInContext(browserSources.createTesseraBidCache, context);
  const cache = context.createTesseraBidCache(win, settings, {sizes: () => sizes});
  const config = {}, handlers = {};
  const pb = {version: 'v11.34.0', setConfig: value => Object.assign(config, value), getConfig: key => config[key], onEvent: (name, fn) => { handlers[name] = fn; },
    getAdserverTargetingForAdUnitCode: () => ({})};
  cache.install(pb); cache.consent(true, 1);
  const auction = (id, code, bids) => {
    handlers.auctionInit({auctionId: id, adUnitCodes: [code]});
    handlers.bidRequested({auctionId: id, gdprConsent: {gdprApplies: true, consentString: 'synthetic-tc'}});
    cache.auction([code], {[code]: {bids}}, id, 1);
  };
  return {clock, cache, config, win, auction};
}
const bid = (auctionId, cpm, extra = {}) => ({adUnitCode: 'Billboard', auctionId, adId: `${auctionId}-${cpm}`, cpm, width: 300, height: 250, mediaType: 'banner', ttl: 300, responseTimestamp: 0, ...extra});

test('policy boundaries: maximum age, TTL minus one second, and the latest auction context', () => {
  for (const [maxAgeSeconds, ttl, lastMs] of [[1, 300, 999], [300, 300, 298999], [60, 5, 3999], [300, 1, -1]]) {
    const p = policy({version: '3.23.0', defaultEnabled: true, maxAgeSeconds, positions: [['Billboard', true]]});
    const old = bid('a1', 4, {ttl, responseTimestamp: p.clock.now()});
    p.auction('a1', 'Billboard', [old]);
    const start = p.clock.now();
    p.auction('a2', 'Billboard', []);
    const filter = p.config.bidCacheFilterFunction;
    if (lastMs >= 0) {
      // Exactly at the last allowed millisecond, then one later.
      const at = ms => { p.clock.value = start + ms; };
      at(lastMs); assert.equal(filter(old), true, `${maxAgeSeconds}/${ttl} at ${lastMs}`);
      at(lastMs + 1); assert.equal(filter(old), false, `${maxAgeSeconds}/${ttl} after ${lastMs}`);
    } else assert.equal(filter(old), false, 'a 1-second TTL is never reused');
  }
  const p = policy({version: '3.23.0', defaultEnabled: true, maxAgeSeconds: 60, positions: [['Billboard', true]]});
  const old = bid('a1', 4, {responseTimestamp: p.clock.now()});
  p.auction('a1', 'Billboard', [old]);
  // Prebid never asks about bids of its own latest auction; a1 is Tessera's latest, so a1 bids are not cached bids.
  assert.equal(p.config.bidCacheFilterFunction(old), false, 'a bid of the latest completed auction is not a cached bid');
  p.auction('a2', 'Billboard', []);
  assert.equal(p.config.bidCacheFilterFunction(old), true);
  assert.equal(p.config.bidCacheFilterFunction({...old, width: 728, height: 90}), true, 'the recorded size counts, not a changed bid object');
  assert.equal(p.config.bidCacheFilterFunction({...old, status: 'rendered'}), false);
  assert.equal(p.config.bidCacheFilterFunction({...old, adId: 'unknown'}), false);
  assert.equal(p.config.bidCacheFilterFunction({...old, adUnitCode: 'P1'}), false);
  p.cache.consent(true, 2);
  assert.equal(p.config.bidCacheFilterFunction(old), false, 'a new consent epoch drops it');
  assert.equal(p.cache.snapshot().trackedBids, 0);
  assert.equal(p.win.__tesseraBidCache.snapshot().version, '3.23.0');
});

test('an auction Prebid starts without auctionInit (no bid requests) never offers the earlier auction\'s bids again', () => {
  // Prebid moves its latest auction for a position before it knows whether any bidder is asked; with
  // no bid requests it emits no auctionInit, so Tessera's own record still names a1.
  const p = policy({version: '3.23.0', defaultEnabled: true, maxAgeSeconds: 60, positions: [['Billboard', true]]});
  const sentBid = bid('a1', 4, {responseTimestamp: p.clock.now()}), unsent = bid('a1', 3, {responseTimestamp: p.clock.now()});
  p.auction('a1', 'Billboard', [sentBid, unsent]);
  p.cache.applied('Billboard', {hb_adid: sentBid.adId});
  const filter = p.config.bidCacheFilterFunction;
  assert.equal(filter(sentBid), false, 'a bid sent to GAM is never offered again');
  assert.equal(filter(unsent), false, 'no completed later auction: nothing competes');
  assert.equal(p.cache.snapshot().counters.filterRejections.context, 2);
});

test('diagnostics count each refused bid once per reason, however often Prebid asks', () => {
  const p = policy({version: '3.23.0', defaultEnabled: true, maxAgeSeconds: 1, positions: [['Billboard', true]]});
  const old = bid('a1', 4, {responseTimestamp: p.clock.now()}), other = bid('a1', 5, {responseTimestamp: p.clock.now()});
  p.auction('a1', 'Billboard', [old, other]);
  p.auction('a2', 'Billboard', []);
  const filter = p.config.bidCacheFilterFunction;
  for (let i = 0; i < 10; i++) { assert.equal(filter(old), true); assert.equal(filter(other), true); }
  p.cache.applied('Billboard', {hb_adid: other.adId});
  p.clock.value += 5000;
  for (let i = 0; i < 25; i++) { assert.equal(filter(old), false); assert.equal(filter(other), false); }
  assert.deepEqual(JSON.parse(JSON.stringify(p.cache.snapshot().counters.filterRejections)), {expired: 1, used: 1});
});

test('policy: a fresh deal at any CPM, even 0 (alwaysIncludeDeals), keeps only that bidder\'s earlier bids out', () => {
  const p = policy({version: '3.23.0', defaultEnabled: true, maxAgeSeconds: 60, positions: [['Billboard', true]]});
  const openx = bid('a1', 5, {bidderCode: 'openx', responseTimestamp: p.clock.now()}), pubmatic = bid('a1', 4, {bidderCode: 'pubmatic', responseTimestamp: p.clock.now()});
  p.auction('a1', 'Billboard', [openx, pubmatic]);
  const filter = p.config.bidCacheFilterFunction;
  p.auction('a2', 'Billboard', [bid('a2', 0, {bidderCode: 'openx', dealId: 'D-0', responseTimestamp: p.clock.now()})]);
  assert.equal(filter(openx), false, 'openx has a fresh deal at 0');
  assert.equal(filter(pubmatic), true, 'another bidder\'s deal does not keep pubmatic out');
  p.auction('a3', 'Billboard', [bid('a3', 1, {bidderCode: 'openx', dealId: '', responseTimestamp: p.clock.now()})]);
  assert.equal(filter(openx), true, 'an empty dealId is no deal');
  assert.deepEqual(JSON.parse(JSON.stringify(p.cache.snapshot().counters.filterRejections)), {deal: 1});
});
