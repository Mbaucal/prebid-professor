/** 3.25: private request-boundary reporting. It never controls ad delivery. */
export function createTesseraRequestMetrics(win, config) {
  var first = null, gateStart = null, decisionAt = null, gateEpoch = null;
  var currentEpoch = null, history = [], identities = Object.create(null), identityCount = 0;
  var MAX_AUCTIONS = 64, MAX_IDS = 4096;
  function stamp() {
    try { var now = win.performance.now(); if (typeof now === 'number' && Number.isFinite(now)) return now; } catch (_) {}
    return Date.now();
  }
  function navigation() {
    try { var now = win.performance.now(); if (typeof now === 'number' && Number.isFinite(now) && now >= 0) return now; } catch (_) {}
    try {
      var start = win.performance.timing.navigationStart, elapsed = Date.now() - start;
      if (typeof start === 'number' && start > 0 && Number.isFinite(elapsed) && elapsed >= 0) return elapsed;
    } catch (_) {}
    return null;
  }
  function bucket(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
    return ms < 500 ? 'lt_500' : ms < 1000 ? '500_999' : ms < 1500 ? '1000_1499' :
      ms < 2000 ? '1500_1999' : ms < 3000 ? '2000_2999' : '3000_plus';
  }
  function drop() { identities = Object.create(null); history = []; identityCount = 0; }
  function remove(entry) {
    (entry.rows || []).forEach(function(row) {
      var list = identities[row.id]; if (!list) return;
      var index = list.indexOf(row); if (index >= 0) { list.splice(index, 1); identityCount--; }
      if (!list.length) delete identities[row.id];
    });
  }
  function prune() {
    var now = Date.now();
    Object.keys(identities).forEach(function(id) {
      identities[id] = identities[id].filter(function(row) { if (row.expires > now) return true; identityCount--; return false; });
      if (!identities[id].length) delete identities[id];
    });
    history.forEach(function(entry){entry.rows=entry.rows.filter(function(row){return row.expires > now;});});
    while (history.length > MAX_AUCTIONS || identityCount > MAX_IDS) remove(history.shift());
  }
  function consent(ready, epoch) {
    if (currentEpoch !== epoch) { drop(); currentEpoch = epoch; }
    if (gateEpoch !== epoch || !ready) decisionAt = null;
    gateEpoch = epoch;
    if (gateStart !== null && ready && decisionAt === null) decisionAt = stamp();
  }
  function enter(ready, epoch) {
    if (gateStart !== null) return;
    gateStart = stamp(); gateEpoch = epoch; decisionAt = ready ? gateStart : null;
  }
  function auction(codes, bids, auctionId, epoch, completed) {
    if (!completed || currentEpoch !== epoch || typeof auctionId !== 'string' || !auctionId) return;
    var entry = {rows:[]}, local = Object.create(null);
    (codes || []).forEach(function(code) {
      var row = bids && bids[code];
      (row && Array.isArray(row.bids) ? row.bids : []).forEach(function(bid) {
        if (!bid || bid.auctionId !== auctionId || bid.adUnitCode !== code || typeof bid.adId !== 'string' || !bid.adId ||
          typeof bid.bidderCode !== 'string' || !bid.bidderCode || typeof bid.cpm !== 'number' || !Number.isFinite(bid.cpm) || bid.cpm <= 0) return;
        var received = Number(bid.responseTimestamp), ttl = Number(bid.ttl);
        if (!Number.isFinite(received) || received <= 0 || !Number.isFinite(ttl) || ttl <= 0) return;
        var identity = JSON.stringify([bid.adId, code, bid.bidderCode, auctionId]);
        if (local[identity]) return; local[identity] = true;
        var item = {id:bid.adId, code:code, bidder:bid.bidderCode, auction:auctionId, epoch:epoch,
          expires:received + Math.max(0, ttl - 1) * 1000};
        entry.rows.push(item);
      });
    });
    // Read every untrusted response field before retaining any of this auction.
    // If a getter throws, the caller's reporting-only guard can discard it
    // without leaving rows outside the bounded auction eviction queue.
    entry.rows.forEach(function(item){
      if (!identities[item.id]) identities[item.id] = [];
      identities[item.id].push(item); identityCount++;
    });
    history.push(entry); prune();
  }
  function single(values) {
    var list = Array.isArray(values) ? values : values === undefined || values === null ? [] : [values];
    if (!list.length || !list.every(function(value){return typeof value === 'string' && value.length > 0 && value === list[0];})) return null;
    return list[0];
  }
  function origin(slot) {
    try {
      if (!config.prebid(slot)) return null;
      var code = config.code(slot), record = config.readiness(code);
      if (!record || !record.completed || record.epoch !== currentEpoch || typeof record.auctionId !== 'string') return null;
      var primary = slot.getTargeting('hb_adid');
      if (Array.isArray(primary) && !primary.length) return 'none';
      var id = single(primary), bidder = single(slot.getTargeting('hb_bidder'));
      if (!id || !bidder || typeof record.allowed[id] !== 'number' || record.allowed[id] <= Date.now()) return null;
      prune();
      var list = identities[id];
      if (!list || list.length !== 1) return null;
      var bid = list[0];
      if (bid.code !== code || bid.bidder !== bidder || bid.epoch !== record.epoch || bid.expires <= Date.now()) return null;
      // Only the owned 3.24 cache.extend hook can add a previous-auction ID to
      // this current readiness allow-list. A historic bid alone proves nothing.
      return bid.auction === record.auctionId ? 'fresh' : 'cached';
    } catch (_) { return null; }
  }
  function setSlot(slot, values) {
    try {
      if (slot.setConfig) { slot.setConfig({targeting:values}); return; }
      Object.keys(values).forEach(function(key){ if (values[key] === null) slot.clearTargeting(key); else slot.setTargeting(key, values[key]); });
    } catch (_) {}
  }
  function setPage(service, values) {
    try {
      if (win.googletag && typeof win.googletag.setConfig === 'function') { win.googletag.setConfig({targeting:values}); return; }
      Object.keys(values).forEach(function(key){ if (values[key] === null) service.clearTargeting(key); else service.setTargeting(key, values[key]); });
    } catch (_) {}
  }
  function before(service, slots) {
    if (!slots.length) return null;
    var created = first === null;
    if (created) {
      var wait=decisionAt === null || gateStart === null ? null : Math.max(0, decisionAt - gateStart);
      var consentValue=gateStart === null ? 'na' : bucket(wait), deadline=null;
      try { if(config.consentDeadline)deadline=config.consentDeadline(slots.map(config.code)); } catch (_) {}
      if (wait !== null && typeof deadline === 'number' && Number.isFinite(deadline) && deadline > 0 && wait >= deadline) consentValue='timeout';
      first = {navigation:bucket(navigation()), consent:consentValue, committed:false};
    }
    slots.forEach(function(slot){setSlot(slot, {aq_bid_origin:origin(slot), aq_first_request:null, aq_consent_wait:null});});
    setPage(service, {aq_bid_origin:null, aq_first_request:first.navigation, aq_consent_wait:first.consent});
    return {entry:first, created:created};
  }
  return {
    enter:enter, consent:consent, auction:auction, before:before,
    commit:function(token){if(token)token.entry.committed=true;},
    rollback:function(service, token){
      if (token && token.created && first === token.entry && !first.committed) {
        first = null; setPage(service, {aq_bid_origin:null, aq_first_request:null, aq_consent_wait:null});
      }
    }
  };
}
