/** Versioned, self-contained browser helper. CMP data stays page-local. */
export function createTesseraReadiness(win, options) {
  var consent = {ready:false, phase:'cmp-missing', epoch:0}, consentKey = null;
  var waiters = [], listeners = [], api = null, poll = null;
  var targets = Object.create(null), sequence = 0, events = [], pendingSlots = new Set();
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
    var done = false, timer = null, deadline = null;
    function finish(value) {
      if (done) return; done = true; win.clearTimeout(timer); win.clearTimeout(deadline);
      if (value) fn(value); else { note('prebid-unavailable'); fallback(); }
    }
    function check() {
      var pb = win.pbjs;
      if (pb && typeof pb.requestBids === 'function' && typeof pb.setConfig === 'function' && typeof pb.onEvent === 'function') {try{if(options.configure)options.configure(pb);finish(pb);}catch(_){note('prebid-config-error');finish(null);}}
      else timer = win.setTimeout(check, 50);
    }
    deadline = win.setTimeout(function(){finish(null);}, options.prebidWaitMs || 3000);
    check();
  }
  function targeting(code) {
    var record = targets[code];
    return record && consent.ready && record.epoch === consent.epoch ? record.values : {};
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
          var values = {};
          if (completed) {
            var row = bids[code], allowed = Object.create(null);
            (row && Array.isArray(row.bids) ? row.bids : []).forEach(function(bid){
              if (bid && bid.auctionId === auctionId && bid.adUnitCode === code && typeof bid.cpm === 'number' && bid.cpm > 0 && Number.isFinite(bid.cpm) && bid.adId) allowed[String(bid.adId)] = true;
            });
            try {
              var candidate = pb.getAdserverTargetingForAdUnitCode(code) || {};
              var ids = Object.keys(candidate).filter(function(key){return key === 'hb_adid' || key.indexOf('hb_adid_') === 0;});
              if (ids.length && ids.every(function(key){
                var list = Array.isArray(candidate[key]) ? candidate[key] : [candidate[key]];
                return list.length && list.every(function(value){return allowed[String(value)] === true;});
              })) values = Object.assign({}, candidate);
            } catch (_) {}
          }
          targets[code] = {epoch:consent.epoch, values:values};
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
      whenConsent(function(){
        var active=pending.filter(function(slot){pendingSlots.delete(slot);return !options.alive||options.alive(slot);});
        if(!active.length)return;
        active.forEach(function(slot){
          options.clear(slot);
          var code = options.code(slot), values = targeting(code);
          options.apply(slot, values);
        });
        options.rawDispatch(service, active, settings);
        active.forEach(function(slot){delete targets[options.code(slot)];});
      });
    }
  };
}
