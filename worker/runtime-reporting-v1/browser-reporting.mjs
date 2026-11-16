/** Compiled inside the new runtime only. No global API replacement or telemetry. */
export function createGamReporting(config) {
  var slots = new WeakMap(), auctions = Object.create(null);
  var aqKeys = ['aq_bidder_count', 'aq_bid_count', 'aq_timed_out'];
  function state(slot) {
    if (!slots.has(slot)) slots.set(slot, {sent: 0, interval: null});
    return slots.get(slot);
  }
  function code(slot) { return config.code ? config.code(slot) : slot.getSlotElementId(); }
  function set(slot, values) {
    try {
      if (slot.setConfig) { slot.setConfig({targeting: values}); return; }
      Object.keys(values).forEach(function(key) {
        if (values[key] === null) slot.clearTargeting(key);
        else slot.setTargeting(key, values[key]);
      });
    } catch (_) { /* Reporting must never block delivery. */ }
  }
  function clearValues() {
    var values = {};
    aqKeys.forEach(function(key) { values[key] = null; });
    return values;
  }
  function request(pb, input) {
    var codes = (input.adUnits || []).map(function(unit) { return unit.code; });
    if (!codes.length) codes = (input.adUnitCodes || []).slice();
    var records = Object.create(null);
    codes.forEach(function(id) {
      if (typeof id === 'string') records[id] = auctions[id] = {ready: false, values: null};
    });
    var callback = input.bidsBackHandler;
    var next = Object.assign({}, input, {bidsBackHandler: function(bids, timedOut, auctionId) {
      try {
        codes.forEach(function(id) {
          var record = records[id];
          // A late callback cannot replace a newer auction or a consumed fallback.
          if (!record || auctions[id] !== record || record.ready) return;
          record.ready = true;
          if (!bids || typeof bids !== 'object' || typeof timedOut !== 'boolean' ||
              typeof auctionId !== 'string' || !auctionId) return;
          var row = bids[id];
          if (row && !Array.isArray(row.bids)) return;
          var bidders = Object.create(null), seen = Object.create(null), count = 0;
          (row ? row.bids : []).forEach(function(bid) {
            if (!bid || bid.auctionId !== auctionId || bid.adUnitCode !== id ||
                typeof bid.cpm !== 'number' || !Number.isFinite(bid.cpm) || bid.cpm <= 0) return;
            var bidder = bid.bidderCode || bid.bidder;
            // A real response identity prevents duplicate callbacks/entries being counted twice.
            var identity = bid.adId || bid.requestId;
            if (typeof bidder !== 'string' || !bidder || typeof identity !== 'string' || !identity) return;
            if (seen[identity]) return;
            seen[identity] = true; bidders[bidder] = true; count++;
          });
          record.values = {aq_bid_count: String(count), aq_bidder_count: String(Object.keys(bidders).length),
            aq_timed_out: timedOut ? 'yes' : 'no'};
        });
      } catch (_) { /* Unknown data remains absent, never a fabricated result. */ }
      if (typeof callback === 'function') return callback.apply(this, arguments);
    }});
    try { return pb.requestBids(next); }
    catch (error) {
      codes.forEach(function(id) { if (auctions[id] === records[id]) delete auctions[id]; });
      throw error;
    }
  }
  function discard(list) {
    (list || []).forEach(function(slot) {
      try { if (config.owns(slot)) { delete auctions[code(slot)]; state(slot).interval = null; } } catch (_) {}
    });
  }
  function send(original, service, list, options) {
    var pending = [];
    (list || []).forEach(function(slot) {
      try {
        if (!config.owns(slot)) return;
        var id = code(slot), s = state(slot), record = auctions[id];
        var prebid = config.prebid(slot);
        var values = clearValues();
        values.refresh_count = String(s.sent);
        values.refresh_bucket = s.sent === 0 ? 'initial' : s.sent <= 3 ? 'r1_3' : 'r4_plus';
        values.refresh_interval = s.sent === 0 ? 'initial' : s.interval === null ? 'unscheduled' : String(s.interval);
        values.refresh_policy = s.sent === 0 ? 'initial' : !prebid ? 'gam_only' :
          record && record.ready && record.values ? 'fresh_auction' : 'prebid_fallback';
        if (prebid && record && record.ready && record.values) Object.assign(values, record.values);
        set(slot, values);
        // Consume before calling GPT, which can synchronously emit events.
        delete auctions[id];
        pending.push({slot: slot, state: s}); s.sent++; s.interval = null;
      } catch (_) {}
    });
    try { return original.call(service, list, options); }
    catch (error) {
      pending.forEach(function(item) {
        item.state.sent--;
        var values = clearValues();
        values.refresh_count = String(Math.max(0, item.state.sent - 1));
        values.refresh_bucket = null; values.refresh_interval = null; values.refresh_policy = null;
        set(item.slot, values);
      });
      throw error;
    }
  }
  return {
    request: request, send: send, discard: discard,
    plan: function(slot, seconds) {
      if (config.owns(slot) && Number.isFinite(seconds) && seconds > 0) state(slot).interval = seconds;
    },
    dispatch: function(service, list, options) {
      // Normally the existing visibility gate calls send with its final allow-list.
      // Early TakeOver requests can precede gate installation and still get labels.
      if (service.__ads_gate_wrapped) return service.refresh(list, options);
      return send(service.refresh, service, list, options);
    }
  };
}
