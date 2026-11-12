/** Auction-local eligibility; native cache filtering keeps its existing enablement. */
export function createBidderRules(win, config, options) {
  var settings = JSON.parse(JSON.stringify(config));
  var events = [], dropped = 0, requests = 0, skipped = 0;
  var own = Object.prototype.hasOwnProperty;
  var nativePb = null, nativeListener = null, cacheFilter = null, cachePrevious = null, cacheStatus = 'off';
  var auctions = Object.create(null), order = [], latest = Object.create(null);
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function state() {
    var country = null, width = null;
    try {
      var geo = win.__AD_GEO;
      var current = geo && geo.version === 1 && typeof geo.getSnapshot === 'function' ? geo.getSnapshot() : null;
      if (current && current.version === 1 && current.status === 'known' && current.source === 'cloudflare') country = options.normalizeCountry(current.country);
    } catch (ignored) {}
    try {
      var candidate = win.innerWidth;
      if (!(typeof candidate === 'number' && isFinite(candidate) && candidate > 0)) candidate = win.document && win.document.documentElement && win.document.documentElement.clientWidth;
      if (typeof candidate === 'number' && isFinite(candidate) && candidate > 0) width = candidate;
    } catch (ignored) {}
    return {country:country, width:width};
  }
  function note(value) {
    events.push(value);
    if (events.length > 200) { events.shift(); dropped++; }
  }
  function simulate(context) {
    context = context || {};
    var current = state();
    return options.evaluate(settings, {bidder:context.bidder, code:context.code,
      country:own.call(context, 'country') ? options.normalizeCountry(context.country) : current.country,
      width:own.call(context, 'width') ? context.width : current.width});
  }
  function observeAuction(event) {
    if (!event) return;
    var record = auctions[event.auctionId];
    var codes = event.adUnitCodes || (event.adUnits || []).map(function(unit) {return unit.code;});
    if (!Array.isArray(codes)) return;
    codes.forEach(function(code) {
      if (record && own.call(record.codes, code)) latest[code] = record;
      else delete latest[code]; // A foreign auction owns native targeting now.
    });
  }
  function installCacheFilter() {
    if (!nativePb) return;
    try {
      var previous = nativePb.getConfig('bidCacheFilterFunction');
      if (typeof cacheFilter === 'function' && previous === cacheFilter) return;
      var scope = latest;
      // Prebid calls this public hook only for bids from older auctions. The
      // normal native winner/deal/Send All Bids logic still selects targeting.
      var composed = function(bid) {
        var prior = typeof previous === 'function' ? previous.apply(this, arguments) : true;
        if (!prior) return prior;
        var record = bid && scope[bid.adUnitCode];
        if (record && !options.evaluate(settings, {bidder:bid.bidderCode || bid.bidder, code:bid.adUnitCode,
          country:record.context.country, width:record.context.width}).allowed) return false;
        return prior;
      };
      nativePb.setConfig({bidCacheFilterFunction:composed});
      if (nativePb.getConfig('bidCacheFilterFunction') !== composed) throw Error('Cache filter not installed');
      cacheFilter = composed; cachePrevious = previous;
      cacheStatus = 'installed';
    } catch (ignored) {
      cacheStatus = 'unavailable';
      note({reason:'cache-filter-unavailable', allowed:false});
    }
  }
  function configurePrebid(pb) {
    if (!settings.enabled || nativePb === pb) return;
    if (nativePb) {
      try { if (nativePb.offEvent) nativePb.offEvent('auctionInit', nativeListener); } catch (ignored) {}
      // Detach even if a third-party hook now wraps our previous function.
      // Old callbacks must never see policy ownership from a new Prebid object.
      Object.keys(latest).forEach(function(code) {delete latest[code];});
      try {
        if (typeof cacheFilter === 'function' && nativePb.getConfig('bidCacheFilterFunction') === cacheFilter)
          nativePb.setConfig({bidCacheFilterFunction:cachePrevious});
      } catch (ignored) {}
      auctions = Object.create(null); order = []; latest = Object.create(null);
    }
    nativePb = null; nativeListener = null; cacheFilter = null; cachePrevious = null;
    if (!pb || typeof pb.getConfig !== 'function' || typeof pb.setConfig !== 'function' || typeof pb.onEvent !== 'function') {
      cacheStatus = 'unavailable'; note({reason:'cache-filter-unavailable', allowed:false}); return;
    }
    try {
      var listener = function(event) {if (nativePb === pb) observeAuction(event);};
      pb.onEvent('auctionInit', listener); nativePb = pb; nativeListener = listener; installCacheFilter();
    }
    catch (ignored) { cacheStatus = 'unavailable'; note({reason:'cache-filter-unavailable', allowed:false}); }
  }
  function remember(id, units, context) {
    if (typeof id !== 'string' || !id) return;
    var codes = Object.create(null);
    units.forEach(function(unit) {codes[unit.code] = true;});
    auctions[id] = {id:id, codes:codes, context:context}; order.push(id);
    while (order.length > 128) {
      var removed = order.shift(), record = auctions[removed]; delete auctions[removed];
      if (record) Object.keys(record.codes).forEach(function(code) {if (latest[code] === record) delete latest[code];});
    }
  }
  function request(pb, input) {
    if (!settings.enabled) return options.request(pb, input);
    // The final native boundary is essential: responsive Outstream reconstructs
    // adUnits inside the inherited callbacks. Filter after that reconstruction.
    var guarded = Object.create(pb);
    guarded.requestBids = function(next) {
      var current = state(), allowed = Object.create(null), changed = Object.create(null);
      var nextUnits = [], units = next.adUnits;
      requests++;
      // All generated requests supply explicit units. An unexpected registry-only
      // request cannot be safely filtered; complete cleanly instead of bypassing.
      if (!Array.isArray(units)) {
        note({auctionId:next.auctionId || null, reason:'explicit-units-required', allowed:false});
        if (typeof next.bidsBackHandler === 'function') next.bidsBackHandler({}, false, next.auctionId);
        return;
      }
      units.forEach(function(unit) {
        var bidders = Object.create(null), removed = false;
        var bids = (unit.bids || []).filter(function(bid) {
          var decision = options.evaluate(settings, {bidder:bid.bidder, code:unit.code, country:current.country, width:current.width});
          note(Object.assign({auctionId:next.auctionId || null, code:unit.code, bidder:bid.bidder, width:current.width}, decision));
          if (decision.allowed) bidders[bid.bidder] = true;
          else { removed = true; skipped++; }
          return decision.allowed;
        });
        allowed[unit.code] = bidders;
        if (removed) changed[unit.code] = true;
        if (bids.length) nextUnits.push(Object.assign({}, unit, {bids:bids}));
      });
      if (!nextUnits.length) {
        if (typeof next.bidsBackHandler === 'function') next.bidsBackHandler({}, false, next.auctionId);
        return;
      }
      installCacheFilter();
      remember(next.auctionId, nextUnits, current);
      var outgoing = Object.assign({}, next, {adUnits:nextUnits});
      if (Array.isArray(next.adUnitCodes)) outgoing.adUnitCodes = next.adUnitCodes.filter(function(code) { return nextUnits.some(function(unit) {return unit.code === code;}); });
      if (typeof next.bidsBackHandler === 'function') outgoing.bidsBackHandler = function(bids) {
        var args = Array.prototype.slice.call(arguments);
        // Also exclude unexpected responses on a filtered position. Together
        // with inherited current-auction adId/TTL checks this prevents cached or
        // unsolicited excluded bidders from acquiring GAM targeting.
        if (bids && typeof bids === 'object' && !Array.isArray(bids)) {
          var result = Object.assign(Object.create(null), bids);
          Object.keys(changed).forEach(function(code) {
            if (!own.call(bids, code) || !bids[code] || !Array.isArray(bids[code].bids)) return;
            Object.defineProperty(result, code, {enumerable:true, configurable:true, writable:true, value:Object.assign({}, bids[code], {
              bids:bids[code].bids.filter(function(bid) {return !!allowed[code][bid.bidderCode || bid.bidder];})
            })});
          });
          args[0] = result;
        }
        return next.bidsBackHandler.apply(this, args);
      };
      return pb.requestBids(outgoing);
    };
    return options.request(guarded, input);
  }
  function snapshot() {
    return {schemaVersion:1, enabled:settings.enabled, context:state(), requests:requests,
      skipped:skipped, dropped:dropped, cacheFilter:cacheStatus, trackedAuctions:order.length, events:copy(events),
      evidence:'Eligibility at the native Prebid request boundary; not SSP receipt, fill or revenue.'};
  }
  var api = {snapshot:snapshot, simulate:simulate};
  try { if (!own.call(win, '__AD_BIDDER_RULES')) Object.defineProperty(win, '__AD_BIDDER_RULES', {value:Object.freeze(api), configurable:false, writable:false}); } catch (ignored) {}
  return {request:request, configurePrebid:configurePrebid, snapshot:snapshot, simulate:simulate};
}
