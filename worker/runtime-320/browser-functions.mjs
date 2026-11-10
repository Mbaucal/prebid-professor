/** Extracted during the build, before bundling; no runtime eval/toString. */
export function adViewportSizes(rules) {
  if (!Array.isArray(rules)) return null;
  var width = window.innerWidth || document.documentElement.clientWidth || 0;
  var height = window.innerHeight || document.documentElement.clientHeight || 0;
  var sorted = rules.slice().sort(function(a, b) {
    var av = a.minViewPort || a.viewport || [0, 0], bv = b.minViewPort || b.viewport || [0, 0];
    return bv[0] - av[0] || bv[1] - av[1];
  });
  for (var i = 0; i < sorted.length; i++) {
    var row = sorted[i], viewport = row.minViewPort || row.viewport || [0, 0];
    if (width >= viewport[0] && height >= viewport[1]) return row.sizes || [];
  }
  return [];
}
export function sizesFromSizeMapName(name) {
  return adViewportSizes(SIZE_MAPS_RAW && SIZE_MAPS_RAW[name]);
}
export function sizesFromPrebidConfigName(name) {
  var rules = PREBID_SIZE_CONFIGS_RAW && PREBID_SIZE_CONFIGS_RAW[name];
  return rules ? adViewportSizes(rules) : sizesFromSizeMapName(name);
}
export function getUnitConfigById(id) {
  var config = adConditionalConfig(id, baseUnitConfigById(id));
  // Do not mutate the selected map or resolve rules a second time. This only
  // exposes the already resolved map to its matching responsive reservation.
  if (config) {
    var element = document.getElementById(id), index = AD_VIEWPORT_MAP_NAMES.indexOf(config.sizeMapName);
    if (element && index >= 0) element.setAttribute('data-ad-size-map', String(index));
  }
  return config;
}

export function adViewportInitialSlots(slots) {
  return (slots || []).filter(function(slot) {
    var id = slot.getSlotElementId();
    if (id === STICKY_TARGET_ID && _sticky.closed || !slotHasCurrentViewportSizes(id)) {
      // Waiting for consent/Prebid may cross a breakpoint. A skipped first
      // request must remain eligible for the normal startup path later.
      _tesseraInitialStarted.delete(slot);
      return false;
    }
    return true;
  });
}
export function startATF(slots) {
  var list = adViewportInitialSlots(slots).filter(function(slot) {
    if (_tesseraInitialStarted.has(slot)) return false;
    _tesseraInitialStarted.add(slot); return true;
  });
  if (!list.length) return;
  _tesseraReady.whenConsent(function() {
    list = adViewportInitialSlots(list);
    if (!list.length) return;
    if (!HAS_PREBID || !BIDDERS || !BIDDERS.length) { startATFConfigured(list); return; }
    _tesseraReady.prebid(function() {
      list = adViewportInitialSlots(list);
      if (list.length) startATFConfigured(list);
    }, function() {
      googletag.cmd.push(function() {
        list = adViewportInitialSlots(list);
        if (!list.length) return;
        if (!window.__ADS_GPT_SERVICES_ENABLED) {
          try { googletag.pubads().enableSingleRequest(); } catch (_) {}
          googletag.enableServices(); window.__ADS_GPT_SERVICES_ENABLED = true;
        }
        _tesseraReady.dispatch(googletag.pubads(), list);
      });
    });
  });
}
export function requestInitialSticky(id) {
  if (!id) return;
  googletag.cmd.push(function() {
    var slot = window.adSlots && window.adSlots[id];
    if (!slot) return;
    // Both immediate and scroll-triggered first requests use the same existing
    // one-start/consent/Prebid gate. Automatic refresh keeps its old ownership.
    if (id === STICKY_TARGET_ID) startATF([slot]);
    else fetchBidsAndRefresh([slot]);
  });
}
export function adViewportInstallInitialResume() {
  if (AD_VIEWPORT_INITIAL_LISTENER) return;
  var state = AD_VIEWPORT_INITIAL_LISTENER = {timer: null};
  function stop() {
    clearTimeout(state.timer); state.timer = null;
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    window.removeEventListener('focus', schedule);
    document.removeEventListener('visibilitychange', schedule);
  }
  function check() {
    state.timer = null;
    if (!_tesseraInitialScanDone || !pageActive()) return;
    var pending = false;
    (EXPLICIT_UNITS || []).forEach(function(unit) {
      var id = unit.id, bottom = id === STICKY_TARGET_ID;
      if (!bottom && String(unit.type || 'BTF').toUpperCase() !== 'ATF') return;
      if (TESSERA_OVERLAY && id === TESSERA_OVERLAY.code) return;
      if (bottom && _sticky.closed || _tesseraLastRefreshSentAt[id] != null) return;
      pending = true;
      var slot = window.adSlots && window.adSlots[id];
      if (!slot || _tesseraInitialStarted.has(slot) || !slotHasCurrentViewportSizes(id)) return;
      var config = getUnitConfigById(id), lazy = tesseraLazyRule(id);
      if (lazy) {
        if (!lazy.enabled && config && String(config.type || 'BTF').toUpperCase() === 'ATF') startATF([slot]);
        else if (TESSERA_LAZY_STARTED) tesseraWireConfiguredLazy();
        return;
      }
      if (bottom && STICKY_LAZY_ENABLED) {
        var y = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
        if (y >= STICKY_LAZY_SCROLL_PX) requestInitialSticky(id);
        return;
      }
      if (config && String(config.type || 'BTF').toUpperCase() === 'ATF') startATF([slot]);
    });
    if (!pending) stop();
  }
  function schedule() {
    if (state.timer != null) return;
    state.timer = setTimeout(check, 50);
  }
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  window.addEventListener('focus', schedule);
  document.addEventListener('visibilitychange', schedule);
}
