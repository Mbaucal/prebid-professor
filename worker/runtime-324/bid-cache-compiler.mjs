import {parse} from 'acorn';
import {browserSources} from '../../.generated/runtime-324-browser-source.mjs';
import {bidCacheEligibleInputCodes} from '../../shared/bid-cache/eligibility.mjs';

const BID_CACHE_RUNTIME_VERSION = '3.24.0';
export const BID_CACHE_HELPERS = ['createTesseraBidCache'];

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const byCodeUnit = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
/** A JSON literal that is also safe inside an inline <script>. */
const literal = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** Exact text anchor: a missing or repeated anchor fails generation. */
function once(source, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw Error(`3.24.0 bid cache expected one anchor, found ${count}: ${before.trim()}`);
  return source.replace(before, () => after);
}
function browser(name) {
  if (typeof browserSources[name] !== 'string') throw Error('3.24.0 bid cache missing browser helper ' + name);
  return browserSources[name];
}

/**
 * The bid cache decision of a 3.24.0 input, checked against the package it
 * compiles. Returns null when no position reuses bids (the 3.21.2 program is
 * kept), else {defaultEnabled, maxAgeSeconds, positions:[[code, boolean]]}
 * in code-unit order. A position that is not eligible in this package fails
 * generation: the snapshot step already moved such settings to warnings.
 */
export function activeBidCache(input) {
  if (!record(input) || !Object.hasOwn(input, 'bidCache') || !Array.isArray(input.bidCacheExclusions))
    throw Error('3.24.0 input has no bid cache decision.');
  const cache = input.bidCache;
  if (cache === null) return null;
  if (!record(cache) || Object.keys(cache).sort().join(',') !== 'defaultEnabled,maxAgeSeconds,positions'
    || typeof cache.defaultEnabled !== 'boolean' || !Number.isInteger(cache.maxAgeSeconds)
    || cache.maxAgeSeconds < 1 || cache.maxAgeSeconds > 300 || !record(cache.positions))
    throw Error('3.24.0 bid cache input is invalid.');
  const eligible = new Set(bidCacheEligibleInputCodes(input));
  const positions = Object.entries(cache.positions).sort(byCodeUnit);
  for (const [code, enabled] of positions) {
    if (!eligible.has(code) || typeof enabled !== 'boolean') throw Error(`3.24.0 bid cache cannot apply to position ${JSON.stringify(code)} in this package.`);
  }
  if (!positions.some(([, enabled]) => enabled)) return null;
  return {defaultEnabled: cache.defaultEnabled, maxAgeSeconds: cache.maxAgeSeconds, positions};
}

/**
 * 3.24.0 patch over the 3.21.2 program. Without an active bid cache the source
 * is returned unchanged. With one, the readiness layer gets four hooks: record
 * each completed auction, check cached bids in native targeting, mark applied
 * bids as used, and drop everything on a consent change.
 */
export function applyBidCache(source, input) {
  const cache = activeBidCache(input);
  if (!cache) return source;
  const settings = {version: BID_CACHE_RUNTIME_VERSION, defaultEnabled: cache.defaultEnabled,
    maxAgeSeconds: cache.maxAgeSeconds, positions: cache.positions};
  // 1. Policy object, created before readiness, and the readiness hooks.
  source = once(source, '  var _tesseraReady=createTesseraReadiness(window,{\n',
    `  var TESSERA_BID_CACHE=${literal(settings)};\n${browser('createTesseraBidCache')}\n` +
    '  var _tesseraBidCache=createTesseraBidCache(window,TESSERA_BID_CACHE,{sizes:function(code){\n' +
    '    var unit=adUnitFromCode(code);\n' +
    '    return unit&&unit.mediaTypes&&unit.mediaTypes.banner&&unit.mediaTypes.banner.sizes||[];\n' +
    '  },floorOwnedBidders:' + literal(Object.entries(input.options.floors && input.options.floors.bidderFloors || {}).filter(([,value]) => Number.isFinite(value) && value > 0).map(([bidder]) => bidder)) + ',floorsRequired:' + (input.options.floors && input.options.floors.enabled === true ? 'true' : 'false') + ',currentAllows:function(bidder,code){return _adBidderRules.simulate({bidder:bidder,code:code}).allowed&&' + (source.includes('function createBidderAccounts(') ? '_adBidderAccounts.allows(bidder)' : 'true') + ';}});\n' +
    '  var _tesseraReady=createTesseraReadiness(window,{\n' +
    '    cacheRequest:_tesseraBidCache.request,cacheAuction:_tesseraBidCache.auction,cacheExtend:_tesseraBidCache.extend,cacheApplied:_tesseraBidCache.applied,cacheConsent:_tesseraBidCache.consent,\n');
  // Final native request boundary: rules, accounts and responsive formats have
  // already filtered/reconstructed every adUnit by the time this guard runs.
  source = once(source, '            var callback=next.bidsBackHandler;\n',
    '            if(options.cacheRequest)options.cacheRequest(next.adUnits,next.auctionId);\n' +
    '            var callback=next.bidsBackHandler;\n');
  // 2. Configure after the new rules helper handed this version cache ownership.
  source = once(source, '    _adBidderRules.configurePrebid(pbjs);\n    _tesseraConfiguredPb=pbjs;\n',
    '    _adBidderRules.configurePrebid(pbjs);\n    _tesseraBidCache.install(pbjs);\n    _tesseraConfiguredPb=pbjs;\n');
  // 3. A consent change drops every earlier bid before in-flight auctions settle.
  source = once(source, '    if (changed) { if(options.discard)options.discard(Object.keys(targets)); targets = Object.create(null); ',
    '    if (changed) { if(options.discard)options.discard(Object.keys(targets)); targets = Object.create(null); if(options.cacheConsent)options.cacheConsent(consent.ready,consent.epoch); ');
  // 4. Record a completed auction before its targeting is read.
  const completed = "        var completed = started && consent.ready && consent.epoch === epoch && id === auctionId && bids && typeof bids === 'object' && typeof timedOut === 'boolean';\n";
  source = once(source, completed,
    completed + '        if (completed && options.cacheAuction) { try { options.cacheAuction(codes, bids, auctionId, epoch); } catch (_) {} }\n');
  // 5. Targeting read when the auction completes.
  const finishRead = '            try {\n              var candidate = pb.getAdserverTargetingForAdUnitCode(code) || {};\n';
  source = once(source, finishRead,
    finishRead + '              if (options.cacheExtend) candidate = options.cacheExtend(pb, code, candidate, allowed);\n');
  // 6. Targeting read again just before the GAM request.
  const deliverRead = "      if (!pb || typeof pb.getAdserverTargetingForAdUnitCode !== 'function') return {};\n      var candidate = pb.getAdserverTargetingForAdUnitCode(code) || {};\n";
  source = once(source, deliverRead,
    deliverRead + '      if (options.cacheExtend) candidate = options.cacheExtend(pb, code, candidate, record.allowed);\n');
  // 7. The targeting set on the slot for its GAM request: these bids are used.
  source = once(source, '          options.apply(slot, targeting(options.code(slot)));\n',
    '          var appliedTargeting = targeting(options.code(slot));\n' +
    '          options.apply(slot, appliedTargeting);\n' +
    '          if (options.cacheApplied) { try { options.cacheApplied(options.code(slot), appliedTargeting); } catch (_) {} }\n');
  parse(source, {ecmaVersion: 2015});
  return source;
}
