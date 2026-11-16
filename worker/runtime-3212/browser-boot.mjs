/* Browser functions for Tessera 3.21.2. scripts/prepare-runtime3212.mjs copies
 * their exact source text into .generated/runtime-3212-browser-source.mjs after
 * the source hash check; free identifiers resolve inside the ads.js IIFE. */

/** Eligible TakeOver with an interval whose CMP decision is still pending. */
export function tesseraTakeOverPending() {
  return TAKEOVER_ACTIVE_FOR_PAGE === null && !_tesseraTakeOverCapResolved;
}

/** Called only from consent-ready code: the first readiness waiter, or the
 * existing initTakeOver waiter. Storage access stays inside _adStorage. */
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
    // The link block was never applied while undecided, so a capped or
    // skipped page keeps the publisher's interstitial attributes untouched.
    _takeOver.initialized = true;
    _takeOver.status = skippedViewport ? 'skipped-viewport' : 'frequency-capped';
    takeOverEvent(_takeOver.status, skippedViewport ? {width: window.innerWidth} : {});
  } else {
    if (_takeOver.status === 'waiting-consent') _takeOver.status = 'waiting';
    // Active: block Google's codeless interstitial before GPT services start.
    applyTakeOverCodelessLinkBlock();
  }
  return TAKEOVER_ACTIVE_FOR_PAGE;
}

/** Decide once; a failure never leaves the page holding GPT services. */
export function tesseraTakeOverDecision() {
  if (!tesseraTakeOverPending()) return;
  try { resolveTakeOverCap(); }
  catch (error) {
    _tesseraTakeOverCapResolved = true;
    TAKEOVER_ACTIVE_FOR_PAGE = false;
    window.TAKEOVER_ACTIVE_FOR_PAGE = false;
    _takeOver.activeForPage = false;
    _takeOver.initialized = true;
    _takeOver.status = 'cap-error';
    try { restoreTakeOverCodelessLinkBlock(); } catch (_) {}
    try { takeOverEvent('cap-error', {message: error && error.message}); } catch (_) {}
  }
}

/** defineAllSlots: true while services, the guard and display must wait for the cap. */
export function tesseraBootHoldServices() {
  if (window.__ADS_GPT_SERVICES_ENABLED) return false;
  if (!_tesseraBootHeld && !tesseraTakeOverPending()) return false;
  _tesseraBootHeld = true;
  return true;
}

export function tesseraBootQueueDisplay(slots) {
  (slots || []).forEach(function(slot) { _tesseraBootPendingDisplay.push(slot); });
}

/** Boot at load as 3.21.0; only the cap-dependent GPT start waits. */
export function init() {
  if (tesseraTakeOverPending()) _tesseraBootStartDeferred = true;
  initAfterTakeOverCap();
}

/** First readiness waiter (registered before init): decide, then run the held
 * GPT start and the initial ATF start in the 3.21.1 order. Slots, unit rules
 * and page key-values are not touched here: they were set at load and by the
 * existing discovery, exactly as in 3.21.0. The held job defines the guard of
 * an active page before enableServices and displays every queued slot once. */
export function tesseraBootRelease() {
  tesseraTakeOverDecision();
  if (_tesseraBootHeld) googletag.cmd.push(tesseraBootEnableHeldServices);
  if (_tesseraBootStartDeferred) {
    _tesseraBootStartDeferred = false;
    startAfterGptAndConsent();
  }
}
