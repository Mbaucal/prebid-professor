/* Browser bid cache policy for Tessera 3.25.1. scripts/prepare-runtime3251.mjs
 * copies the exact source text of the exported function into
 * .generated/runtime-3251-browser-source.mjs after the source hash check. The
 * function uses only its arguments and browser built-ins, and it is written in
 * ES5 syntax like the rest of ads.js. */

/**
 * Reuse of earlier Prebid banner bids on one page, per position.
 *
 * settings: {version, defaultEnabled, maxAgeSeconds, positions: [[code, true|false]]},
 *   each position already resolved at Generate (its override, else the site default).
 * options.sizes(code): the banner sizes that position may request now, as [[w, h]].
 *
 * Native Prebid keeps its bid pool. This policy only decides, through Prebid's
 * bidCacheFilterFunction, which earlier bids may compete again: banner bids of
 * the same position, from an auction Tessera completed in the current consent
 * epoch with the same Prebid consent data, never sent to GAM before, of a size
 * the position may request now, and younger than the saved age and the bidder
 * TTL (minus one second). A bidder with a fresh deal bid in the current auction
 * keeps that deal: none of its earlier bids competes there. Every refresh still
 * runs a new auction; a cached bid only competes with its fresh bids. Nothing
 * is stored outside page memory.
 * Missing Prebid features or a filter Prebid does not honor switch the page to
 * fresh bids only (status 'fresh-only'); no position is ever dropped.
 */
export function createTesseraBidCache(win, settings, options) {
  var MAX_AUCTIONS = 64, MAX_REQUESTS = 128, MAX_DECISIONS = 4096;
  var positions = Object.create(null), rows = [];
  (settings.positions || []).forEach(function(row) {
    positions[row[0]] = row[1] === true;
    rows.push([row[0], row[1] === true]);
  });
  var maxAgeMs = settings.maxAgeSeconds * 1000;
  var pb = null, active = false, configured = false;
  var status = 'waiting-prebid', reason = null, prebidVersion = null;
  var floorAdjustments = Object.create(null), zeroFloorOwner = null, zeroFloorPrint = null, zeroFloorFields = null;
  var consentReady = false, consentEpoch = 0;
  var known = Object.create(null), auctions = [], latest = Object.create(null);
  var started = Object.create(null), requested = Object.create(null), requestOrder = [];
  var admissions = Object.create(null), nativeRequests = Object.create(null), admissionOrder = [], extended = Object.create(null);
  var decisions = Object.create(null), reasons = Object.create(null), decisionCount = 0;
  var counters = {auctions:0, cachedWins:0, freshWins:0, noBid:0, filterRejections:Object.create(null)};
  var lastSelection = null;

  function adIds(map) {
    var ids = [];
    Object.keys(map || {}).forEach(function(key) {
      if (key !== 'hb_adid' && key.indexOf('hb_adid_') !== 0) return;
      (Array.isArray(map[key]) ? map[key] : [map[key]]).forEach(function(value) {
        if (value === undefined || value === null || value === '') return;
        value = String(value);
        if (ids.indexOf(value) < 0) ids.push(value);
      });
    });
    return ids;
  }
  function text(value) { return typeof value === 'string' ? value : null; }
  // Consent data exactly as native Prebid sent it to bidders. Kept only in
  // this closure for comparison; never exposed in diagnostics.
  function consentPrint(request) {
    var gdpr = request.gdprConsent, gpp = request.gppConsent;
    return JSON.stringify([
      gdpr && typeof gdpr === 'object' ? [typeof gdpr.gdprApplies === 'boolean' ? gdpr.gdprApplies : null, text(gdpr.consentString), text(gdpr.addtlConsent)] : null,
      text(request.uspConsent),
      gpp && typeof gpp === 'object' ? [text(gpp.gppString), Array.isArray(gpp.applicableSections) ? gpp.applicableSections.map(Number) : null] : null
    ]);
  }
  function drop() {
    known = Object.create(null); auctions = []; latest = Object.create(null);
    requested = Object.create(null); requestOrder = [];
    admissions = Object.create(null); nativeRequests = Object.create(null); admissionOrder = [];
    decisions = Object.create(null); reasons = Object.create(null); decisionCount = 0;
  }
  function fresh(why) {
    active = false; status = 'fresh-only'; reason = why;
    drop();
    if (configured && pb) {
      configured = false;
      try { pb.setConfig({useBidCache:false}); } catch (_) {}
    }
  }
  /** Final native request, after account/rule/responsive-format filtering. */
  function request(units, auctionId) {
    var id = typeof auctionId === 'string' && auctionId ? auctionId : null;
    if (!id) return;
    var codes = Object.create(null);
    (Array.isArray(units) ? units : []).forEach(function(unit) {
      if (!unit || typeof unit.code !== 'string') return;
      var bidders = Object.create(null);
      (Array.isArray(unit.bids) ? unit.bids : []).forEach(function(bid) {
        if (bid && typeof bid.bidder === 'string') bidders[bid.bidder] = true;
      });
      codes[unit.code] = bidders;
    });
    if (!Object.prototype.hasOwnProperty.call(admissions, id)) admissionOrder.push(id);
    admissions[id] = codes; nativeRequests[id] = Object.create(null);
    while (admissionOrder.length > MAX_REQUESTS) {
      var removed = admissionOrder.shift(); delete admissions[removed]; delete nativeRequests[removed];
    }
  }
  function clearExtended(code, allowed) {
    var previous = extended[code];
    if (previous) Object.keys(previous).forEach(function(id) { delete allowed[id]; });
    extended[code] = Object.create(null);
  }
  function onInit(event) {
    if (!event || event.auctionId === undefined || event.auctionId === null || !Array.isArray(event.adUnitCodes)) return;
    event.adUnitCodes.forEach(function(code) { started[code] = String(event.auctionId); });
  }
  function onRequested(request) {
    if (!active || !request || typeof request !== 'object' || request.auctionId === undefined || request.auctionId === null) return;
    var id = String(request.auctionId), print;
    try { print = consentPrint(request); } catch (_) { print = false; }
    if (!(id in requested)) {
      requestOrder.push(id);
      while (requestOrder.length > MAX_REQUESTS) delete requested[requestOrder.shift()];
    } else if (requested[id] !== print) print = false;
    requested[id] = print;
    // Native Prebid may remove a bidder through activity controls or validation
    // after our final request boundary. Only a real exact bidder/position
    // request may admit that bidder's earlier bids to the current auction.
    var incoming = nativeRequests[id], admitted = admissions[id], bidder = request.bidderCode;
    if (incoming && admitted && typeof bidder === 'string' && Array.isArray(request.bids)) {
      request.bids.forEach(function(bid) {
        var code = bid && bid.adUnitCode;
        if (typeof code !== 'string' || !admitted[code] || admitted[code][bidder] !== true) return;
        if (!incoming[code]) incoming[code] = Object.create(null);
        incoming[code][bidder] = bid;
      });
    }
  }
  function onWon(bid) {
    var row = bid && bid.adId !== undefined && bid.adId !== null ? known[String(bid.adId)] : null;
    if (row) row.won = true;
  }
  function refused(why) { counters.filterRejections[why] = (counters.filterRejections[why] || 0) + 1; }
  /** Prebid asks again on every targeting read: a refused bid counts once per reason. */
  function remember(id, why) {
    // Native filter evidence belongs to the tracked bid and the current completed
    // auction, not the bounded diagnostic map. Resetting that map must not forget
    // a valid earlier decision midway through a large native targeting read.
    var row = known[id];
    if (row) { row.filterDecision = why === null; row.filterContext = latest[row.code]; }
    if (!(id in decisions) && ++decisionCount > MAX_DECISIONS) { decisions = Object.create(null); reasons = Object.create(null); decisionCount = 1; }
    decisions[id] = why === null;
    if (why !== null && reasons[id] !== why) refused(why);
    reasons[id] = why;
  }
  function sizeAllowed(code, width, height) {
    var sizes = options.sizes(code) || [];
    if (sizes.length === 2 && typeof sizes[0] === 'number') sizes = [sizes];
    for (var i = 0; i < sizes.length; i++) {
      if (Array.isArray(sizes[i]) && Number(sizes[i][0]) === width && Number(sizes[i][1]) === height) return true;
    }
    return false;
  }
  function zeroFloorModel(floors) {
    if (!options.zeroFloorModel || !floors || typeof floors !== 'object' || floors.floorMin !== 0) return false;
    if (floors.endpoint && (typeof floors.endpoint !== 'object' || Object.keys(floors.endpoint).length)) return false;
    var data = floors.data, schema = data && data.schema, values = data && data.values;
    if (!data || typeof data !== 'object' || !['currency,schema,values','currency,floorsSchemaVersion,schema,values'].includes(Object.keys(data).sort().join(',')) ||
      (Object.prototype.hasOwnProperty.call(data,'floorsSchemaVersion') && data.floorsSchemaVersion !== 1) ||
      typeof data.currency !== 'string' || data.currency.toUpperCase() !== options.floorCurrency ||
      !schema || schema.delimiter !== '|' || !Array.isArray(schema.fields) ||
      schema.fields.join(',') !== 'mediaType,size,deviceType,dayType,timeOfDay' ||
      !values || typeof values !== 'object' || Array.isArray(values)) return false;
    var keys = Object.keys(values);
    return keys.length >= 4 && ['banner|*|desktop|*|*','banner|*|mobile|*|*','banner|*|tablet|*|*','*|*|*|*|*'].every(function(key) {
      return Object.prototype.hasOwnProperty.call(values,key) && values[key] === 0;
    }) && keys.every(function(key) { return values[key] === 0; });
  }
  function zeroFloorProof(floors, nativeRequest) {
    if (floors !== zeroFloorOwner || !zeroFloorModel(floors) || JSON.stringify(floors.data) !== zeroFloorPrint) return false;
    var fields = floors.additionalSchemaFields || {};
    if (!zeroFloorFields || ['deviceType','dayType','timeOfDay'].some(function(key) { return fields[key] !== zeroFloorFields[key]; })) return false;
    var data = nativeRequest && nativeRequest.floorData;
    if (!data || data.location !== 'setConfig' || data.floorMin !== 0 || nativeRequest.floors != null) return false;
    var imp = nativeRequest.ortb2Imp, ext = imp && imp.ext, prebid = ext && ext.prebid;
    return !prebid || prebid.floors == null;
  }
  /** The current native floor contract, in the original adapter bid currency.
   * getFloor inversely adjusts bidder floors; comparing an already adjusted
   * cached CPM would undercut floors when a bidder multiplier is above one. */
  function floorRejection(row, nativeRequest) {
    var floors;
    try { floors = pb && pb.getConfig('floors'); } catch (_) { return 'floor-unavailable'; }
    if (!floors || typeof floors !== 'object') return options.floorsRequired ? 'floor-unavailable' : null;
    if (floors.enabled === false) return null;
    var enforcement = floors.enforcement || {};
    if (enforcement.enforceJS === false) return null;
    var bidders = enforcement.enforceBidders;
    if (Array.isArray(bidders) && bidders.length && bidders.indexOf('*') < 0 && bidders.indexOf(row.adapter) < 0) return null;
    if (row.deal && enforcement.floorDeals !== true) return null;
    if (nativeRequest && nativeRequest.floorData && nativeRequest.floorData.skipped === true) return null;
    // The wrapper owns standard hard-floor and saved per-bidder zeroing
    // adjustments. Arbitrary publisher functions can be nonlinear, while
    // native getFloor's inverse adjustment is approximate; keep them fresh.
    var bidderSettings = pb.bidderSettings || {}, standard = bidderSettings.standard || {};
    var exact = bidderSettings[row.bidder] || {}, base = pb.aliasRegistry && pb.aliasRegistry[row.bidder];
    var inherited = base && bidderSettings[base] && bidderSettings[base].adjustAlternateBids === true ? bidderSettings[base] : {};
    if (standard.bidCpmAdjustment !== floorAdjustments.standard || typeof standard.inverseBidAdjustment === 'function' ||
      typeof exact.inverseBidAdjustment === 'function' || typeof inherited.inverseBidAdjustment === 'function' ||
      (typeof exact.bidCpmAdjustment === 'function' && exact.bidCpmAdjustment !== floorAdjustments[row.bidder]) ||
      (typeof exact.bidCpmAdjustment !== 'function' && typeof inherited.bidCpmAdjustment === 'function' && inherited.bidCpmAdjustment !== floorAdjustments[base])) return 'floor-adjustment-unsupported';
    if (!nativeRequest || typeof nativeRequest.getFloor !== 'function' || !Number.isFinite(row.originalCpm) || row.originalCpm < 0 ||
      typeof row.originalCurrency !== 'string' || !/^[A-Z]{3}$/.test(row.originalCurrency)) return 'floor-unavailable';
    try {
      var value = nativeRequest.getFloor({currency:row.originalCurrency, mediaType:'banner', size:[row.width,row.height]});
      // A literal null is the module's explicit no-floor rule.
      if (value === null) return null;
      // Native priceFloors also returns {} after deleting an auction's floor
      // context (3 seconds after completion). That is never permission unless
      // the saved and still-owned static model proves every floor is zero.
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
        return zeroFloorProof(floors,nativeRequest) ? null : 'floor-unavailable';
      if (!value || typeof value !== 'object' || typeof value.floor !== 'number' || !Number.isFinite(value.floor) || value.floor < 0 ||
        typeof value.currency !== 'string' || value.currency.toUpperCase() !== row.originalCurrency) return 'floor-unavailable';
      return row.originalCpm < value.floor ? 'floor' : null;
    } catch (_) { return 'floor-unavailable'; }
  }
  /** null when this earlier bid may compete now, else the reason it may not. */
  function rejection(bid) {
    if (!active) return 'disabled';
    if (!bid || typeof bid !== 'object' || bid.adId === undefined || bid.adId === null) return 'untracked';
    var code = bid.adUnitCode;
    if (typeof code !== 'string' || positions[code] !== true) return 'position-off';
    var row = known[String(bid.adId)];
    if (!row || row.code !== code || row.auctionId !== String(bid.auctionId)) return 'untracked';
    if (typeof bid.bidderCode !== 'string' || bid.bidderCode !== row.bidder) return 'identity';
    var current = latest[code];
    if (!current || current.id !== started[code] || row.entry === current) return 'context';
    var admitted = current.admitted && current.admitted[code];
    if (!admitted || admitted[row.bidder] !== true) return 'bidder-not-requested';
    var native = current.native && current.native[code];
    if (!native || !native[row.bidder]) return 'native-bidder-not-requested';
    try { if (!options.currentAllows(row.bidder, code)) return 'bidder-ineligible'; }
    catch (_) { return 'bidder-ineligible'; }
    if (!consentReady || row.entry.epoch !== consentEpoch || current.epoch !== consentEpoch) return 'consent';
    if (typeof row.entry.consent !== 'string' || row.entry.consent !== current.consent) return 'consent';
    if (row.mediaType !== 'banner' || !(row.cpm > 0) || !Number.isFinite(row.cpm) ||
      !(row.width >= 1) || !(row.height >= 1) || Math.floor(row.width) !== row.width || Math.floor(row.height) !== row.height) return 'format';
    if (row.submitted || row.won || bid.status === 'rendered' || bid.status === 'targetingSet') return 'used';
    // Prebid keeps one bid per bidder and position before it sets hb_*_<bidder> and
    // hb_deal_<bidder>: a fresh deal of this bidder keeps that place, as in 3.21.2.
    var deals = current.deals[code];
    if (deals && (deals[row.bidder] === true || deals[String(bid.bidderCode)] === true)) return 'deal';
    if (!sizeAllowed(code, row.width, row.height)) return 'size';
    var now = Date.now();
    if (now < row.received || now >= row.expires) return 'expired';
    return floorRejection(row, native[row.bidder]);
  }
  /** Prebid bidCacheFilterFunction: consulted for bids of earlier auctions. */
  function filter(bid) {
    try {
      if (!bid || typeof bid !== 'object') return false;
      if (active && (!pb || pb.getConfig('bidCacheFilterFunction') !== filter)) { fresh('filter-replaced'); return false; }
      var why = rejection(bid);
      if (bid.adId !== undefined && bid.adId !== null) remember(String(bid.adId), why);
      else if (why !== null) refused(why);
      return why === null;
    } catch (_) { return false; }
  }
  function install(instance) {
    if (pb) { if (pb !== instance) fresh('prebid-replaced'); return; }
    pb = instance;
    try {
      if (!instance || typeof instance.setConfig !== 'function' || typeof instance.getConfig !== 'function' ||
        typeof instance.onEvent !== 'function' || typeof instance.getAdserverTargetingForAdUnitCode !== 'function') { fresh('prebid-api-missing'); return; }
      prebidVersion = typeof instance.version === 'string' ? instance.version.slice(0, 40) : null;
      var bidderSettings = instance.bidderSettings || {};
      floorAdjustments.standard = bidderSettings.standard && bidderSettings.standard.bidCpmAdjustment;
      (options.floorOwnedBidders || []).forEach(function(code) {
        floorAdjustments[code] = bidderSettings[code] && bidderSettings[code].bidCpmAdjustment;
      });
      var ownedFloors = instance.getConfig('floors');
      if (zeroFloorModel(ownedFloors)) {
        zeroFloorOwner = ownedFloors; zeroFloorPrint = JSON.stringify(ownedFloors.data);
        var fields = ownedFloors.additionalSchemaFields || {};
        zeroFloorFields = {deviceType:fields.deviceType, dayType:fields.dayType, timeOfDay:fields.timeOfDay};
      }
      var existing = instance.getConfig('bidCacheFilterFunction');
      if (existing !== undefined && existing !== null) { fresh('publisher-filter-present'); return; }
      instance.onEvent('auctionInit', onInit);
      instance.onEvent('bidRequested', onRequested);
      instance.onEvent('bidWon', onWon);
      configured = true;
      // Targeting controls stay as 3.21.2 set them. The read-back is a sanity check
      // only (Prebid stores any setting it is given); whether Prebid honors the
      // filter is checked for every cached bid in extend() ('filter-not-honored').
      instance.setConfig({useBidCache:true, bidCacheFilterFunction:filter});
      if (instance.getConfig('useBidCache') !== true || instance.getConfig('bidCacheFilterFunction') !== filter) { fresh('bid-cache-unsupported'); return; }
      active = true; status = 'active'; reason = null;
    } catch (_) { fresh('install-error'); }
  }
  /** A Prebid auction that Tessera completed in the current consent epoch. */
  function auction(codes, bids, auctionId, epoch) {
    if (!active) return;
    var id = String(auctionId);
    var entry = {id:id, epoch:epoch, consent:typeof requested[id] === 'string' ? requested[id] : null, deals:Object.create(null), admitted:admissions[id] || Object.create(null), native:nativeRequests[id] || Object.create(null)};
    counters.auctions++;
    (codes || []).forEach(function(code) {
      latest[code] = entry;
      if (positions[code] !== true) return;
      var row = bids && bids[code], deals = entry.deals[code] = Object.create(null);
      (row && Array.isArray(row.bids) ? row.bids : []).forEach(function(bid) {
        if (!bid || typeof bid !== 'object' || bid.auctionId !== auctionId || bid.adUnitCode !== code) return;
        // Bidders with a fresh deal bid here, at any CPM (alwaysIncludeDeals keeps 0 CPM deals).
        if (bid.dealId !== undefined && bid.dealId !== null && bid.dealId !== '') deals[String(bid.bidderCode)] = true;
        if (bid.adId === undefined || bid.adId === null || bid.adId === '') return;
        var ttl = Number(bid.ttl), received = Number(bid.responseTimestamp);
        if (!Number.isFinite(ttl) || ttl <= 0 || !Number.isFinite(received) || received <= 0) return;
        known[String(bid.adId)] = {code:code, entry:entry, auctionId:id, bid:bid, bidder:String(bid.bidderCode), adapter:String(bid.adapterCode || bid.bidderCode),
          originalCpm:Number(bid.originalCpm), originalCurrency:typeof bid.originalCurrency === 'string' ? bid.originalCurrency.toUpperCase() : null,
          deal:bid.dealId !== undefined && bid.dealId !== null && bid.dealId !== '',
          mediaType:bid.mediaType, cpm:Number(bid.cpm), width:Number(bid.width), height:Number(bid.height),
          received:received, expires:received + Math.min(maxAgeMs, Math.max(0, ttl - 1) * 1000),
          submitted:false, won:false};
      });
    });
    auctions.push(entry);
    // Rows stay until their auction is one of more than MAX_AUCTIONS, so an
    // expired or used bid is still refused with its own reason ('expired', 'used').
    while (auctions.length > MAX_AUCTIONS) {
      var old = auctions.shift();
      Object.keys(known).forEach(function(key) { if (known[key].entry === old) delete known[key]; });
    }
  }
  /**
   * Targeting from native Prebid for one position, checked again here. A cached
   * bid that passes is added to the readiness allow-list with its own expiry.
   * A cached bid the filter refused, or never saw, means Prebid did not honor
   * the filter: the page switches to fresh bids only and the targeting is read
   * again without cached bids.
   */
  function extend(instance, code, candidate, allowed) {
    // Cached IDs are never grandfathered into readiness's allow-list. The live
    // rules/account/size/consent decision is re-evaluated before every dispatch.
    clearExtended(code, allowed);
    if (!active) return candidate;
    try {
      if (instance !== pb || instance.getConfig('bidCacheFilterFunction') !== filter) {
        fresh(instance !== pb ? 'prebid-replaced' : 'filter-replaced');
        return instance.getAdserverTargetingForAdUnitCode(code) || {};
      }
      for (var round = 0; round < 3; round++) {
        // Every retry has a new native candidate. None of a previous candidate's
        // cache permissions may survive if that bid expired or became ineligible.
        if (round) clearExtended(code, allowed);
        var ids = adIds(candidate), retry = false;
        for (var i = 0; i < ids.length; i++) {
          var id = ids[i], row = known[id];
          var cached = !!row && row.auctionId !== started[code];
          var decision = cached ? (row.filterContext === latest[code] ? row.filterDecision : undefined) : decisions[id];
          if (!cached && typeof allowed[id] === 'number') continue;
          if (cached && rejection(row.bid) === null && decision === true) {
            allowed[id] = row.expires; extended[code][id] = true; continue;
          }
          if (decision === false || (cached && decision !== true)) {
            clearExtended(code, allowed);
            fresh('filter-not-honored');
            return instance.getAdserverTargetingForAdUnitCode(code) || {};
          }
          // Native filtering accepted this bid for this completed auction, but
          // a live rule (for example TTL) changed before this check. Read native
          // targeting again so it can remove that bid without disabling reuse.
          if (cached) retry = true;
        }
        if (!retry) return candidate;
        if (round < 2) candidate = instance.getAdserverTargetingForAdUnitCode(code) || {};
      }
      clearExtended(code, allowed);
      fresh('filter-unstable');
      return instance.getAdserverTargetingForAdUnitCode(code) || {};
    } catch (_) {
      clearExtended(code, allowed);
      fresh('cache-error');
      try { return instance.getAdserverTargetingForAdUnitCode(code) || {}; } catch (error) { return {}; }
    }
  }
  /** Targeting set on the slot just before its GAM request: every bid in it is used. */
  function applied(code, map) {
    if (!active || positions[code] !== true) return;
    var ids = adIds(map), now = Date.now(), cachedBids = 0;
    ids.forEach(function(id) {
      var row = known[id];
      if (!row) return;
      row.submitted = true;
      if (row.auctionId !== started[code]) cachedBids++;
    });
    var winner = map && map.hb_adid !== undefined && map.hb_adid !== null ? known[String(Array.isArray(map.hb_adid) ? map.hb_adid[0] : map.hb_adid)] : null;
    var origin = !ids.length ? 'none' : winner && winner.auctionId !== started[code] ? 'cached' : 'fresh';
    if (origin === 'cached') counters.cachedWins++; else if (origin === 'fresh') counters.freshWins++; else counters.noBid++;
    lastSelection = {code:code, winner:origin, cachedBids:cachedBids, winnerAgeMs:origin === 'cached' ? now - winner.received : null, at:now};
  }
  /** Readiness consent change (new epoch): every earlier bid is dropped. */
  function consent(ready, epoch) {
    consentReady = ready === true; consentEpoch = epoch;
    drop();
  }
  function snapshot() {
    var rejections = {};
    Object.keys(counters.filterRejections).forEach(function(key) { rejections[key] = counters.filterRejections[key]; });
    return {version:settings.version, status:status, reason:reason, prebidVersion:prebidVersion,
      defaultEnabled:settings.defaultEnabled === true, maxAgeSeconds:settings.maxAgeSeconds,
      positions:rows.map(function(row) { return {code:row[0], enabled:row[1]}; }),
      consentReady:consentReady, trackedAuctions:auctions.length, trackedBids:Object.keys(known).length,
      counters:{auctions:counters.auctions, cachedWins:counters.cachedWins, freshWins:counters.freshWins, noBid:counters.noBid, filterRejections:rejections},
      lastSelection:lastSelection ? Object.assign({}, lastSelection) : null};
  }
  if (win.__tesseraBidCache === undefined) {
    try { win.__tesseraBidCache = {snapshot:snapshot}; } catch (_) {}
  }
  return {install:install, request:request, filter:filter, auction:auction, extend:extend, applied:applied, consent:consent, snapshot:snapshot};
}
