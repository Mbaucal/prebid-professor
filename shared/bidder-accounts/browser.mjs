/** Account routing is configured once per Prebid instance, never per overlapping auction. */
export function createBidderAccounts(win, settings, siteSchain, hooks) {
  var accounts = Object.create(null), states = Object.create(null), events = [], configured = null, prepared = null;
  var own = Object.prototype.hasOwnProperty, guard = null;
  var ownerKey = JSON.stringify({accounts: settings, schain: siteSchain});
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function note(kind, bidder, detail) {
    events.push({kind: kind, bidder: bidder || null, detail: detail || null});
    if (events.length > 100) events.shift();
  }
  function sourceChains(value) {
    var source = value && value.source;
    return [source && source.schain, source && source.ext && source.ext.schain].filter(function(chain) { return chain != null; });
  }
  function globalChain(pb) {
    var ortb2 = pb.getConfig('ortb2'), legacy = pb.getConfig('schain');
    return sourceChains(ortb2).concat(legacy && legacy.config != null ? [legacy.config] : []);
  }
  function state(code) { return states[code] || (states[code] = {status: 'pending', reason: null, alias: 'not-needed'}); }
  function fail(code, reason) { var value = state(code); value.status = 'blocked'; value.reason = reason; note(reason, code); }
  (settings || []).forEach(function(account) { accounts[account.bidder] = clone(account); state(account.bidder); });
  function preparePrebid(pb) {
    if (prepared === pb) return;
    prepared = pb;
    Object.keys(accounts).forEach(function(code) {
      var account = accounts[code], current = state(code);
      if (account.baseAdapter === code) return;
      try {
        if (typeof pb.aliasBidder !== 'function') { fail(code, 'alias-api-unavailable'); return; }
        var registry = pb.aliasRegistry;
        if (!registry || typeof registry !== 'object') { fail(code, 'alias-registry-private'); return; }
        if (registry && own.call(registry, code)) {
          if (registry[code] !== account.baseAdapter) { fail(code, 'alias-base-conflict'); return; }
          current.alias = 'existing';
          return;
        }
        pb.aliasBidder(account.baseAdapter, code, {useBaseGvlid: true});
        if (registry && registry[code] !== account.baseAdapter) { fail(code, 'alias-registration-failed'); return; }
        current.alias = registry ? 'registered' : 'registration-requested';
      } catch (_) { fail(code, 'alias-registration-failed'); }
    });
  }
  function desired(account) {
    return account.schain.mode === 'custom' ? account.schain.config : account.schain.mode === 'inherit' ? siteSchain : null;
  }
  function applyChain(pb, code) {
    var account = accounts[code], current = state(code);
    try {
      guard.originalSet.call(pb, {bidders: [code], config: {schain: null,
        ortb2: {source: {schain: undefined, ext: {schain: undefined}}}}}, true);
      var chain = desired(account);
      if (chain) guard.originalSet.call(pb, {bidders: [code], config: {ortb2: {source: {schain: clone(chain)}}}}, true);
      current.status = 'configured'; current.reason = null;
    } catch (_) { fail(code, 'bidder-config-failed'); }
  }
  function installGuard(pb) {
    var existing = pb.__AD_ACCOUNT_CONFIG_GUARD;
    if (existing) {
      if (existing.ownerKey !== ownerKey) return false;
      guard = existing;
      return true;
    }
    var originalSet = pb.setBidderConfig, originalMerge = pb.mergeBidderConfig;
    if (typeof originalSet !== 'function') return false;
    guard = {ownerKey: ownerKey, originalSet: originalSet, originalMerge: originalMerge};
    function protect(original) {
      return function() {
        var result = original.apply(this, arguments), update = arguments[0];
        if (update && Array.isArray(update.bidders) && update.config && typeof update.config === 'object') {
          update.bidders.forEach(function(code) {
            if (own.call(accounts, code) && state(code).status === 'configured') {
              applyChain(pb, code);
              note('managed-schain-preserved', code, 'An external configuration write retained its other fields; the saved account SChain remains authoritative.');
            }
          });
        }
        return result;
      };
    }
    guard.set = protect(originalSet);
    guard.merge = typeof originalMerge === 'function' ? protect(originalMerge) : null;
    pb.setBidderConfig = guard.set;
    if (guard.merge) pb.mergeBidderConfig = guard.merge;
    Object.defineProperty(pb, '__AD_ACCOUNT_CONFIG_GUARD', {value: guard});
    return true;
  }
  function configurePrebid(pb) {
    if (configured === pb) return;
    preparePrebid(pb);
    var version = String(pb.version || '').replace(/^v/, '').split('.');
    var guarded = false;
    try { guarded = installGuard(pb); } catch (_) {}
    Object.keys(accounts).forEach(function(code) {
      var current = state(code), account = accounts[code];
      if (current.status === 'blocked') return;
      if (!(Number(version[0]) >= 10)) { fail(code, 'unsupported-prebid-version'); return; }
      if (typeof pb.setBidderConfig !== 'function' || typeof pb.getConfig !== 'function') { fail(code, 'bidder-config-api-unavailable'); return; }
      if (!guarded) { fail(code, 'account-config-ownership-conflict'); return; }
      applyChain(pb, code);
    });
    configured = pb;
  }
  function request(pb, input) {
    configurePrebid(pb);
    // Responsive Outstream rebuilds ad units inside hooks.request. Filter the
    // rebuilt bids through a per-request proxy before native Prebid sees them.
    var guarded = Object.create(pb);
    guarded.requestBids = function(next) {
      var conflict = false;
      var protectedConfig = guard && pb.setBidderConfig === guard.set && (!guard.merge || pb.mergeBidderConfig === guard.merge);
      try { conflict = globalChain(pb).length > 0 || sourceChains(next.ortb2).length > 0; } catch (_) { conflict = true; }
      var units = Array.isArray(next.adUnits) ? next.adUnits : [];
      var adUnits = [];
      units.forEach(function(unit) {
        var bids = (unit.bids || []).filter(function(bid) {
          var code = bid.bidder, account = accounts[code], current = state(code);
          var reason = !account ? 'unconfigured-account' : current.status !== 'configured' ? current.reason || 'account-not-ready' : !protectedConfig ? 'configuration-guard-replaced' : conflict ? 'external-global-schain-conflict' : sourceChains(bid.ortb2).length > 0 ? 'external-bid-schain-conflict' : null;
          if (reason) note(reason, code, unit.code);
          return !reason;
        });
        if (bids.length) adUnits.push(Object.assign({}, unit, {bids: bids}));
      });
      if (!adUnits.length) {
        if (typeof next.bidsBackHandler === 'function') next.bidsBackHandler({}, false, next.auctionId);
        return;
      }
      var outgoing = Object.assign({}, next, {adUnits: adUnits});
      if (Array.isArray(next.adUnitCodes)) outgoing.adUnitCodes = next.adUnitCodes.filter(function(code) {
        return adUnits.some(function(unit) { return unit.code === code; });
      });
      return pb.requestBids(outgoing);
    };
    return hooks.request(guarded, input);
  }
  function snapshot() {
    return {schemaVersion: 1, evidence: 'Configured upstream chains; SSP receipt and downstream nodes are not verified.',
      accounts: Object.keys(accounts).map(function(code) { var account = accounts[code]; return Object.assign({bidder: code,
        baseAdapter: account.baseAdapter, displayName: account.displayName, mode: account.schain.mode, schain: clone(desired(account))}, clone(state(code))); }),
      events: clone(events)};
  }
  var api = {preparePrebid: preparePrebid, configurePrebid: configurePrebid, request: request, snapshot: snapshot};
  win.__AD_BIDDER_ACCOUNTS = {snapshot: snapshot};
  return api;
}
