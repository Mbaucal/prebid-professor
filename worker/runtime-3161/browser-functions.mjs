// Captured as source by the prepare script, never Function#toString after bundling.
export function scheduleDefineSlotsRetry(reason) {
  var state = _tesseraDiscovery;
  if (state.ended) return;
  function missing() {
    return Array.prototype.some.call(document.querySelectorAll(AD_CONTAINER_SELECTOR), function(el){
      var id=rawWrapperId(el);
      return id && !window.adSlots[id] && !state.failed[id] && getUnitConfigById(id);
    });
  }
  function stop() {
    state.ended = true;
    clearTimeout(state.timer); clearTimeout(state.debounce);
    if (state.observer) state.observer.disconnect();
    window.__ADS_WAITING_FOR_SLOTS = false;
  }
  if (!state.started) {
    state.started = true;
    window.__ADS_WAITING_FOR_SLOTS = true;
    if (typeof MutationObserver === 'function') {
      state.observer = new MutationObserver(function(){
        if (state.ended || state.debounce || !missing()) return;
        state.debounce = setTimeout(function(){state.debounce = null; if (!state.ended && missing()) defineAllSlots();}, 50);
      });
      state.observer.observe(document.documentElement || document.body, {childList:true, subtree:true});
    }
    setTimeout(stop, 20000);
  }
  if (!state.timer && state.attempts < 10) {
    state.timer = setTimeout(function(){
      state.timer = null; state.attempts++;
      if (!state.ended) defineAllSlots();
    }, 750);
  }
}

export function tesseraHandleLateSlots(slots) {
  if (!_tesseraInitialScanDone) return;
  if (TESSERA_LAZY_STARTED) tesseraWireConfiguredLazy();
  (slots || []).forEach(function(slot){
    var id = slot.getSlotElementId(), cfg = getUnitConfigById(id) || {};
    if (tesseraLazyRule(id)) return; // The configured lazy path already owns it.
    if (id === STICKY_TARGET_ID && STICKY_LAZY_ENABLED || id === STICKY_TOP_TARGET_ID && STICKY_TOP_LAZY_ENABLED) return;
    if (String(cfg.type || 'BTF').toUpperCase() === 'ATF') startATF([slot]);
    else if (_tesseraObserveLegacyLazy) _tesseraObserveLegacyLazy(id);
  });
}

export function lateMergeTargeting(totalMs, pollMs) {
  var total = totalMs || 2500, step = pollMs || 250, tries = Math.ceil(total / step), count = 0;
  (function tick(){
    count++;
    var src = window.adsKeywords && typeof window.adsKeywords === 'object' ? window.adsKeywords : null;
    if (src && Object.keys(src).length) {
      googletag.cmd.push(function(){
        mergeKV(src);
        if (!PAGE_TYPE) {
          var prefixes = computePageTypePrefixes();
          if (prefixes.length) { PAGE_TYPE = prefixes[prefixes.length - 1]; setKV('page_type', PAGE_TYPE); }
        }
      });
      return;
    }
    if (count < tries) setTimeout(tick, step);
  })();
}

/** Same responsive pilot contract, with no post-ES2015 object-spread syntax. */
export function applyOutstreamUnit(unit, settings, mapName) {
  if (!unit || !settings || settings.format === 'banner') return unit;
  var size = outstreamPlayerSize(settings, mapName);
  if (!size) return null;
  function copy(first, second) {
    var result = {};
    [first, second].forEach(function(source){
      Object.keys(source || {}).forEach(function(key){
        // Match object-spread's own data-property semantics, including __proto__.
        Object.defineProperty(result,key,{value:source[key],writable:true,enumerable:true,configurable:true});
      });
    });
    return result;
  }
  var video = {context:'outstream',playerSize:[size.slice()],mimes:['video/mp4'],
    minduration:settings.minDuration,maxduration:settings.maxDuration,playbackmethod:[settings.playbackMethod],
    protocols:[2,3,5,6],linearity:1,placement:settings.placement,plcmt:settings.plcmt};
  var mediaTypes = settings.format === 'outstream' ? {video:video} : copy(unit.mediaTypes,{video:video});
  var bids = (unit.bids || []).filter(function(bid){return settings.format !== 'outstream' || bid.bidder === settings.partner.bidder;}).map(function(bid){
    return bid.bidder === settings.partner.bidder ? copy(bid,{mediaTypes:copy(mediaTypes),params:copy(bid.params,{outstreamAU:settings.partner.outstreamAU})}) :
      copy(bid,{mediaTypes:{banner:copy(unit.mediaTypes.banner)}});
  });
  return copy(unit,{mediaTypes:mediaTypes,bids:bids});
}
