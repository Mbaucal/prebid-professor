/** Frequency state is page-local unless the current CMP decision permits storage. */
export function createConsentStorage(win) {
  var permitted = false, pageViews = Object.create(null);
  function update(data, success, ready) {
    // Reset on every CMP event, including UI-open, error and unknown scope. A
    // previously granted permission must never survive a pending/revoked choice.
    permitted = false;
    try {
      permitted = success === true && ready === true && !!data &&
        (data.gdprApplies === false || data.gdprApplies === true &&
          data.cmpStatus === 'loaded' &&
          (data.eventStatus === 'tcloaded' || data.eventStatus === 'useractioncomplete') &&
          typeof data.tcString === 'string' && data.tcString.length > 0 &&
          !!data.purpose && !!data.purpose.consents && data.purpose.consents[1] === true);
    } catch (_) { permitted = false; }
  }
  function timestamp(value, now) {
    var number = Number(value);
    // Corrupt values and clock rollback cannot permanently suppress serving.
    return isFinite(number) && number > 0 && number <= now ? number : 0;
  }
  function allowed(path, minutes) {
    if (!minutes) return true;
    var key = 'tessera:takeover:' + path, now = Date.now();
    var last = timestamp(pageViews[key], now);
    if (permitted) {
      try { last = Math.max(last, timestamp(win.sessionStorage.getItem(key), now)); }
      catch (_) { /* Storage denial falls back to this page's memory. */ }
    }
    return !last || now - last >= minutes * 60000;
  }
  function record(path, minutes) {
    if (!minutes) return;
    var key = 'tessera:takeover:' + path, now = Date.now();
    // Keep the page cap even when storage is unavailable or permission changes.
    pageViews[key] = now;
    if (permitted) {
      try { win.sessionStorage.setItem(key, String(now)); } catch (_) {}
    }
  }
  return {update: update, allowed: allowed, record: record};
}

/** Called only inside the existing current-decision readiness gate. */
export function resolveTakeOverCap() {
  if (_tesseraTakeOverCapResolved) return TAKEOVER_ACTIVE_FOR_PAGE;
  _tesseraTakeOverCapResolved = true;
  var device = tesseraOverlayDevice();
  var skippedViewport = !!TESSERA_OVERLAY.frequencyMinutes && !device;
  var capped = !!device && !tesseraOverlayAllowed();
  TAKEOVER_ACTIVE_FOR_PAGE = !skippedViewport && !capped;
  window.TAKEOVER_ACTIVE_FOR_PAGE = TAKEOVER_ACTIVE_FOR_PAGE;
  _takeOver.activeForPage = TAKEOVER_ACTIVE_FOR_PAGE;
  if (!TAKEOVER_ACTIVE_FOR_PAGE) {
    _takeOver.initialized = true;
    _takeOver.status = skippedViewport ? 'skipped-viewport' : 'frequency-capped';
    takeOverEvent(_takeOver.status, skippedViewport ? {width: window.innerWidth} : {});
  } else applyTakeOverCodelessLinkBlock();
  return TAKEOVER_ACTIVE_FOR_PAGE;
}

/** Resolve a stored cap before the original boot defines its GPT guard/services. */
export function init() {
  if (_tesseraTakeOverEligible && TESSERA_OVERLAY.frequencyMinutes && !_tesseraTakeOverCapResolved) {
    if (_tesseraTakeOverBootWaiting) return;
    _tesseraTakeOverBootWaiting = true;
    _tesseraReady.whenConsent(function() {
      _tesseraTakeOverBootWaiting = false;
      resolveTakeOverCap();
      initAfterTakeOverCap();
    });
    return;
  }
  initAfterTakeOverCap();
}

export function initTakeOver() {
  if (_takeOver.initialized || _tesseraTakeOverWaiting) return;
  if (!_tesseraTakeOverEligible) return;
  _tesseraTakeOverWaiting = true;
  _tesseraReady.whenConsent(function() {
    _tesseraTakeOverWaiting = false;
    if (_takeOver.initialized) return;
    if (!resolveTakeOverCap()) return;
    applyTakeOverCodelessLinkBlock();
    initTakeOverReady();
  });
}

export function tesseraOverlayAllowed() {
  return !!tesseraOverlayDevice() && _adStorage.allowed(takeOverMainAdUnitPath(), TESSERA_OVERLAY.frequencyMinutes);
}

export function tesseraRecordOverlayView() {
  _adStorage.record(takeOverMainAdUnitPath(), TESSERA_OVERLAY.frequencyMinutes);
}
