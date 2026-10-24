/** 3.16.1: current-auction, unexpired targeting and one page-level library wait. */
export function createTesseraReadiness(win, options) {
  var consent = {ready:false, phase:'cmp-missing', epoch:0}, consentKey = null;
  var waiters = [], listeners = [], api = null, poll = null;
  var targets = Object.create(null), sequence = 0, events = [], pendingSlots = new Set();
  var libraryWaiters = [], libraryTimer = null, libraryDeadline = null, libraryExpired = false;
  function note(phase, extra) {
    var event = Object.assign({at:Date.now(), phase:phase}, extra || {});
    events.push(event); if (events.length > 100) events.shift();
  }
  function accept(data, success) {
    var ready = success === true && data && (data.gdprApplies === false ||
      data.gdprApplies === true && data.cmpStatus === 'loaded' &&
      (data.eventStatus === 'tcloaded' || data.eventStatus === 'useractioncomplete') &&
      typeof data.tcString === 'string' && data.tcString.length > 0);
    var phase = ready ? 'decision-ready' : data && data.eventStatus === 'cmpuishown' ? 'user-decision' :
      data && typeof data.gdprApplies !== 'boolean' ? 'scope-unknown' : 'cmp-loading';
    var key = ready ? JSON.stringify([data.gdprApplies,data.tcString || '',data.addtlConsent || '']) : null;
    var changed = key !== consentKey || consent.ready !== !!ready;
    consentKey = key;
    consent = {ready:!!ready, phase:phase, epoch:consent.epoch + (changed ? 1 : 0)};
    if (changed) { if(options.discard)options.discard(Object.keys(targets)); targets = Object.create(null); listeners.slice().forEach(function(fn){fn();}); }
    note(phase);
    if (ready) {
      var pending = waiters; waiters = [];
      pending.forEach(whenConsent);
    }
  }
  function discover() {
    if (typeof win.__tcfapi !== 'function') {
      consent.phase = 'cmp-missing'; poll = win.setTimeout(discover, 250); return;
    }
    api = win.__tcfapi; consent.phase = 'cmp-loading';
    try { api('addEventListener', 2, accept); }
    catch (_) { api = null; note('cmp-error'); poll = win.setTimeout(discover, 1000); }
  }
  function whenConsent(fn) {
    if (!consent.ready) {waiters.push(fn);return;}
    // Complete delivery of a CMP event to its other listeners before starting
    // native Prebid/GPT work; they must see the same decision as this gate.
    win.setTimeout(function(){if(consent.ready)fn(consent);else waiters.push(fn);},0);
  }
  function prebid(fn, fallback) {
    var pb = win.pbjs;
    if (pb && typeof pb.requestBids === 'function' && typeof pb.setConfig === 'function' && typeof pb.onEvent === 'function') {
      try { if (options.configure) options.configure(pb); fn(pb); }
      catch (_) { note('prebid-config-error'); fallback(); }
      return;
    }
    if (libraryExpired) { fallback(); return; }
    libraryWaiters.push({ready:fn, fallback:fallback});
    if (libraryDeadline !== null) return;
    function finish(value, expired) {
      win.clearTimeout(libraryTimer); win.clearTimeout(libraryDeadline);
      libraryTimer = null; libraryDeadline = null;
      libraryExpired = !!expired;
      var list = libraryWaiters; libraryWaiters = [];
      if (expired) note('prebid-unavailable');
      list.forEach(function(item){ if (value) item.ready(value); else item.fallback(); });
    }
    function check() {
      var current = win.pbjs;
      if (current && typeof current.requestBids === 'function' && typeof current.setConfig === 'function' && typeof current.onEvent === 'function') {
        try { if (options.configure) options.configure(current); }
        catch (_) { note('prebid-config-error'); finish(null, false); return; }
        finish(current, false);
      } else libraryTimer = win.setTimeout(check, 50);
    }
    libraryDeadline = win.setTimeout(function(){finish(null, true);}, options.prebidWaitMs || 3000);
    check();
  }
  function targeting(code) {
    var record = targets[code];
    if (!record || !consent.ready || record.epoch !== consent.epoch || !record.hadBids) return {};
    try {
      var pb = win.pbjs;
      if (!pb || typeof pb.getAdserverTargetingForAdUnitCode !== 'function') return {};
      var candidate = pb.getAdserverTargetingForAdUnitCode(code) || {};
      var ids = Object.keys(candidate).filter(function(key){return key === 'hb_adid' || key.indexOf('hb_adid_') === 0;});
      if (!ids.length || !ids.every(function(key){
        var values = Array.isArray(candidate[key]) ? candidate[key] : [candidate[key]];
        return values.length && values.every(function(value){
          var expires = record.allowed[String(value)];
          return typeof expires === 'number' && expires > Date.now();
        });
      })) return {};
      return Object.assign({}, candidate);
    } catch (_) { return {}; }
  }
  function request(pb, input) {
    var codes = (input.adUnits || []).map(function(unit){return unit.code;});
    if (!codes.length) codes = (input.adUnitCodes || []).slice();
    codes.forEach(function(code){delete targets[code];});
    whenConsent(function(){
      var epoch = consent.epoch, settled = false, timer = null, started = false;
      var auctionId = 'tessera-' + Date.now().toString(36) + '-' + (++sequence) + '-' + Math.random().toString(36).slice(2);
      function cleanup() {
        win.clearTimeout(timer);
        var i = listeners.indexOf(changed); if (i >= 0) listeners.splice(i, 1);
        try { if (pb.offEvent) pb.offEvent('auctionInit', auctionStart); } catch (_) {}
      }
      function finish(bids, timedOut, id, reason) {
        if (settled) return; settled = true; cleanup();
        var completed = started && consent.ready && consent.epoch === epoch && id === auctionId && bids && typeof bids === 'object' && typeof timedOut === 'boolean';
        codes.forEach(function(code){
          var values = {}, allowed = Object.create(null);
          if (completed) {
            var row = bids[code];
            (row && Array.isArray(row.bids) ? row.bids : []).forEach(function(bid){
              if (bid && bid.auctionId === auctionId && bid.adUnitCode === code && typeof bid.cpm === 'number' && bid.cpm > 0 && Number.isFinite(bid.cpm) && bid.adId) {
                var ttl = Number(bid.ttl), received = Number(bid.responseTimestamp);
                // Native Prebid's targeting already removes expired bids. Keep an
                // independent current-auction expiry boundary as well (1s buffer).
                if (Number.isFinite(ttl) && ttl > 0 && Number.isFinite(received) && received > 0)
                  allowed[String(bid.adId)] = received + Math.max(0, ttl - 1) * 1000;
              }
            });
            try {
              var candidate = pb.getAdserverTargetingForAdUnitCode(code) || {};
              var ids = Object.keys(candidate).filter(function(key){return key === 'hb_adid' || key.indexOf('hb_adid_') === 0;});
              if (ids.length && ids.every(function(key){
                var list = Array.isArray(candidate[key]) ? candidate[key] : [candidate[key]];
                return list.length && list.every(function(value){return typeof allowed[String(value)] === 'number' && allowed[String(value)] > Date.now();});
              })) values = Object.assign({}, candidate);
            } catch (_) {}
          }
          targets[code] = {epoch:consent.epoch, values:values, allowed:allowed, hadBids:Object.keys(allowed).length > 0};
        });
        if(!completed && options.discard)options.discard(codes);
        note(reason, {codes:codes.slice(), auctionId:auctionId, completed:!!completed});
        // A watchdog is not a completed Prebid auction. Unknown callback fields
        // keep reporting aq_* absent and every caller follows its clean fallback.
        if (input.bidsBackHandler) input.bidsBackHandler(completed ? bids : undefined, completed ? timedOut : undefined, completed ? id : undefined);
      }
      function changed() { if (consent.epoch !== epoch) finish(null, null, null, 'consent-changed'); }
      function auctionStart(event) {
        if (settled || !event || event.auctionId !== auctionId || started) return;
        started = true; win.clearTimeout(timer);
        note('auction-start', {codes:codes.slice(), auctionId:auctionId});
        timer = win.setTimeout(function(){finish(null,null,null,'auction-deadline');}, Math.max(100,Number(input.timeout)||1000) + 500);
      }
      listeners.push(changed);
      prebid(function(readyPb){
        if (settled) return; pb = readyPb;
        try {
          pb.onEvent('auctionInit', auctionStart);
          note('pre-auction', {codes:codes.slice(), auctionId:auctionId});
          timer = win.setTimeout(function(){finish(null,null,null,'pre-auction-deadline');}, options.preAuctionWaitMs || 10000);
          // Guard before the reporting helper receives the callback, otherwise a
          // canceled epoch could populate aq_* while GAM is waiting for a choice.
          var guardedPb=Object.create(pb);
          guardedPb.requestBids=function(next){
            var callback=next.bidsBackHandler;
            return pb.requestBids(Object.assign({},next,{bidsBackHandler:function(){
              if(!settled&&consent.ready&&consent.epoch===epoch)return callback.apply(this,arguments);
            }}));
          };
          options.rawRequest(guardedPb, Object.assign({}, input, {auctionId:auctionId, bidsBackHandler:function(bids,timedOut,id){finish(bids,timedOut,id,'auction-complete');}}));
        } catch (_) { finish(null,null,null,'prebid-error'); }
      }, function(){finish(null,null,null,'prebid-unavailable');});
    });
  }
  function deliver(service, pending, settings, retried) {
    whenConsent(function(){
      var active = pending.filter(function(slot){return !options.alive || options.alive(slot);});
      if (!active.length) { pending.forEach(function(slot){pendingSlots.delete(slot);}); return; }
      var expired = active.filter(function(slot){
        var record = targets[options.code(slot)];
        return record && record.epoch === consent.epoch && record.hadBids && !Object.keys(targeting(options.code(slot))).length;
      });
      if (!retried && expired.length && options.unit) {
        var units = expired.map(function(slot){return options.unit(options.code(slot));}).filter(Boolean);
        if (units.length) {
          var timeout = Math.max.apply(null, units.map(function(unit){return options.timeout ? options.timeout(unit.code) : 1000;}));
          request(win.pbjs, {adUnits:units, timeout:timeout, bidsBackHandler:function(){deliver(service, pending, settings, true);}});
          return;
        }
      }
      try {
        active.forEach(function(slot){
          options.clear(slot);
          options.apply(slot, targeting(options.code(slot)));
        });
        options.rawDispatch(service, active, settings);
        active.forEach(function(slot){delete targets[options.code(slot)];});
      } finally {
        // A transient native GPT exception must not permanently lock this slot.
        // Retain unconsumed targeting on error; its epoch and TTL are rechecked
        // if the existing caller retries the same opportunity.
        pending.forEach(function(slot){pendingSlots.delete(slot);});
      }
    });
  }
  discover();
  return {
    whenConsent:whenConsent, prebid:prebid, request:request, targeting:targeting,
    snapshot:function(){return {consent:Object.assign({},consent),events:events.map(function(e){return Object.assign({},e);})};},
    dispatch:function(service, slots, settings) {
      var pending=(slots||[]).filter(function(slot){
        if(pendingSlots.has(slot))return false;
        pendingSlots.add(slot);return true;
      });
      if(!pending.length)return;
      deliver(service, pending, settings, false);
    }
  };
}
