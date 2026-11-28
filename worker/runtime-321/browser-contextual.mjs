/** Per-auction contextual data; no requests, storage, bidder-config writes or consent overrides. */
export function createContextualSignals(win, config, options) {
  var enabled = !!(config && config.enabled), auctions = Object.create(null), slots = Object.create(null);
  var sequence = 0, history = [], last = null, maxHistory = 24, providerRegistered = false;
  var prebidVersion = String(config.prebidVersion || '').replace(/^v/, '');
  var has = function(object, key) { return !!object && Object.prototype.hasOwnProperty.call(object, key); };
  var plain = function(value) { return value && typeof value === 'object' && !Array.isArray(value); };
  var clone = function(value) { return JSON.parse(JSON.stringify(value)); };
  function note(kind, details) {
    history.push(Object.assign({kind: kind}, details || {}));
    if (history.length > maxHistory) history.shift();
  }
  function current() {
    var values = [], ids = {'iab-content-2.2': [], 'iab-content-3.0': []};
    if (enabled) {
      try {
        var raw = win.adsKeywords && has(win.adsKeywords, config.sourceKey) ? win.adsKeywords[config.sourceKey] : null;
        (Array.isArray(raw) ? raw : [raw]).forEach(function(value) {
          if (typeof value === 'string' && value && values.indexOf(value) < 0) values.push(value);
        });
        (config.mappings || []).forEach(function(mapping) {
          if (values.indexOf(mapping.value) < 0) return;
          Object.keys(ids).forEach(function(taxonomy) {
            (mapping.taxonomies[taxonomy] || []).forEach(function(id) { if (ids[taxonomy].indexOf(id) < 0) ids[taxonomy].push(id); });
          });
        });
      } catch (_) { note('category-unavailable'); }
    }
    return {id: ++sequence, values: values, taxonomies: ids};
  }
  function outputs(snapshot) {
    var result = [];
    if (config.gam && config.gam.enabled) result.push({destination: 'gam', taxonomy: 'iab-content-2.2', ids: snapshot.taxonomies['iab-content-2.2'].slice(), evidence: 'configuration-only'});
    (config.bidders || []).forEach(function(route) {
      result.push({destination: route.bidder, taxonomy: route.taxonomy, ids: (snapshot.taxonomies[route.taxonomy] || []).slice(), evidence: 'configuration-only'});
    });
    return result;
  }
  function snapshot() {
    var value = last || current();
    return clone({schemaVersion: 1, enabled: enabled, source: 'window.adsKeywords', sourceKey: config.sourceKey,
      categoryValues: value.values, taxonomies: value.taxonomies, outputs: outputs(value),
      gamPpsOwnership: config.gam && config.gam.enabled ? 'exclusive' : 'unmanaged', providerRegistered: providerRegistered, prebidVersion: prebidVersion || null,
      evidence: 'Configuration and auction enrichment only; SSP receipt, taxonomy acceptance and revenue are not verified.', events: history});
  }
  function prune() {
    var keys = Object.keys(auctions);
    if (keys.length > 64) keys.slice(0, keys.length - 64).forEach(function(key) { delete auctions[key]; });
  }
  function codes(input) {
    var list = (input.adUnits || []).map(function(unit) { return unit.code; });
    return list.length ? list : (input.adUnitCodes || []).slice();
  }
  function request(pb, input) {
    if (!enabled) return options.request(pb, input);
    var value = current(), id = input.auctionId, list = codes(input);
    var record = {snapshot: value, enriched: false, completed: false};
    last = value;
    list.forEach(function(code) { if (!has(slots, code) || !slots[code].completed) slots[code] = record; });
    if (typeof id === 'string' && id) { auctions[id] = record; prune(); }
    else note('missing-auction-id');
    var callback = input.bidsBackHandler;
    var next = Object.assign({}, input, {bidsBackHandler: function() {
      if ((config.bidders || []).length && !record.enriched) note('provider-not-observed', {auctionId: id || null});
      // Match readiness's completed-auction targeting, including two concurrent
      // requests for the same code that complete in reverse order. Deferred
      // delivery uses the latest completed targeting/context together.
      record.completed = true;
      list.forEach(function(code) { slots[code] = record; });
      try { if (typeof callback === 'function') return callback.apply(this, arguments); }
      finally { if (has(auctions, id) && auctions[id] === record) delete auctions[id]; }
    }});
    try { return options.request(pb, next); }
    catch (error) {
      if (has(auctions, id) && auctions[id] === record) delete auctions[id];
      note('prebid-request-error', {auctionId: id || null});
      throw error;
    }
  }
  function finished(list, id) {
    if (!enabled) return;
    var record = has(auctions, id) && auctions[id];
    if (record) record.completed = true;
    (list || []).forEach(function(code) {
      if (record) slots[code] = record;
      else delete slots[code];
    });
    if (record) delete auctions[id];
  }
  function segmentData(fragment) {
    var content = fragment && fragment.site && fragment.site.content;
    return content && Array.isArray(content.data) ? content.data : [];
  }
  function configurePrebid(pb) {
    if (!enabled || !(config.bidders || []).length) return;
    try {
      if (!pb || typeof pb.getConfig !== 'function' || typeof pb.setConfig !== 'function') { note('prebid-config-api-unavailable'); return; }
      if (typeof pb.version === 'string') prebidVersion = pb.version.replace(/^v/, '');
      var existing = pb.getConfig('realTimeData') || {};
      if (!plain(existing) || existing.dataProviders != null && !Array.isArray(existing.dataProviders)) { note('rtd-config-unavailable'); return; }
      var providers = (existing.dataProviders || []).slice();
      if (!providers.some(function(provider) { return provider && provider.name === 'contextualSignals'; })) providers.push({name: 'contextualSignals', waitForIt: false, params: {}});
      pb.setConfig({realTimeData: Object.assign({}, existing, {dataProviders: providers})});
    } catch (_) { note('rtd-config-error'); }
  }
  function enrichAuction(input) {
    var id = input && input.auctionId, record = has(auctions, id) && auctions[id];
    if (!enabled || !record) return false;
    if (record.enriched) return true;
    var fragments = input.ortb2Fragments;
    if (!plain(fragments) || !plain(fragments.bidder)) { note('auction-fragments-unavailable', {auctionId: id}); return false; }
    record.enriched = true;
    (config.bidders || []).forEach(function(route) {
      var ids = record.snapshot.taxonomies[route.taxonomy] || [], taxonomy = route.taxonomy === 'iab-content-2.2' ? 6 : 7;
      if (!ids.length) { note('unmapped', {auctionId: id, bidder: route.bidder, taxonomy: route.taxonomy}); return; }
      if (['11.11.0', '11.34.0'].indexOf(prebidVersion) >= 0 && ['teads', 'richaudience'].indexOf(route.bidder) >= 0) {
        note('adapter-route-unavailable', {auctionId: id, bidder: route.bidder, prebidVersion: prebidVersion}); return;
      }
      try {
        if (!has(fragments.bidder, route.bidder) && route.bidder in fragments.bidder) {
          note('inherited-bidder-name-skipped', {auctionId: id, bidder: route.bidder}); return;
        }
        var bidder = has(fragments.bidder, route.bidder) ? fragments.bidder[route.bidder] : {};
        if (!plain(bidder)) { note('bidder-fragment-unavailable', {auctionId: id, bidder: route.bidder}); return; }
        var foreign = segmentData(fragments.global).concat(segmentData(bidder));
        // Rubicon banner flattens recognized contextual taxonomies into tg_i.iab.
        // Keep the existing contribution untouched rather than mixing taxonomies.
        if ((route.bidder === 'rubicon' || route.bidder === 'magnite') && foreign.some(function(data) {
          return data && data.ext && [1, 2, 5, 6, 7].indexOf(Number(data.ext.segtax)) >= 0 && Number(data.ext.segtax) !== taxonomy && Array.isArray(data.segment) && data.segment.length;
        })) { note('mixed-taxonomy-skipped', {auctionId: id, bidder: route.bidder, taxonomy: route.taxonomy}); return; }
        var site = bidder.site == null ? {} : bidder.site, content = site.content == null ? {} : site.content;
        if (!plain(site) || !plain(content) || content.data != null && !Array.isArray(content.data)) {
          note('content-data-unavailable', {auctionId: id, bidder: route.bidder}); return;
        }
        var data = {name: config.providerName, ext: {segtax: taxonomy}, segment: ids.map(function(id) { return {id: id}; })};
        // Write only the leaf in this auction's fragment. Copying a whole bidder
        // or site can lose unrelated fields hidden by RTD activity-control reads.
        // Native Proxy setters must run for every branch we create or update.
        if (!has(fragments.bidder, route.bidder)) fragments.bidder[route.bidder] = {site: {content: {data: [data]}}};
        else if (bidder.site == null) bidder.site = {content: {data: [data]}};
        else if (site.content == null) site.content = {data: [data]};
        else content.data = (content.data || []).concat([data]);
        note('auction-enriched', {auctionId: id, bidder: route.bidder, taxonomy: route.taxonomy, ids: ids.slice()});
      } catch (_) { note('auction-enrichment-error', {auctionId: id, bidder: route.bidder}); }
    });
    return true;
  }
  function configureGam(value) {
    if (!config.gam || !config.gam.enabled) return;
    try {
      if (!win.googletag || typeof win.googletag.setConfig !== 'function') { note('gam-pps-api-unavailable'); return; }
      // GPT has no public PPS getter. Opting in explicitly gives this script sole
      // ownership of PPS; empty values clear its previous page-context category.
      var ids = value.taxonomies['iab-content-2.2'].slice();
      win.googletag.setConfig({pps: {taxonomies: {IAB_CONTENT_2_2: {values: ids}}}});
      note('gam-configured', {taxonomy: 'iab-content-2.2', ids: ids});
    } catch (_) { note('gam-pps-config-error'); }
  }
  function dispatch(service, list, settings) {
    if (!enabled) return options.dispatch(service, list, settings);
    var fallback = null, groups = [];
    (list || []).forEach(function(slot) {
      var code = options.code(slot), record = has(slots, code) ? slots[code] : null;
      var value = record ? record.snapshot : fallback || (fallback = current());
      var key = JSON.stringify(value.taxonomies['iab-content-2.2']);
      var group = groups.filter(function(group) { return group.key === key; })[0];
      if (!group) { group = {key: key, value: value, slots: [], records: []}; groups.push(group); }
      group.slots.push(slot); group.records.push({code: code, record: record});
    });
    // Without managed PPS the original GPT batch remains exactly unchanged.
    if (!config.gam || !config.gam.enabled || !win.googletag || typeof win.googletag.setConfig !== 'function') {
      if (config.gam && config.gam.enabled) note('gam-pps-api-unavailable');
      var result = options.dispatch(service, list, settings);
      groups.forEach(function(group) { group.records.forEach(function(item) { if (slots[item.code] === item.record) delete slots[item.code]; }); });
      return result;
    }
    var result;
    groups.forEach(function(group) {
      last = group.value; configureGam(group.value);
      result = options.dispatch(service, group.slots, settings);
      group.records.forEach(function(item) { if (slots[item.code] === item.record) delete slots[item.code]; });
    });
    return result;
  }
  var api = {protocol: 1, snapshot: snapshot, enrichAuction: enrichAuction,
    providerReady: function() { providerRegistered = true; }};
  if (!has(win, '__AD_CONTEXT')) win.__AD_CONTEXT = api;
  else if (win.__AD_CONTEXT !== api) note('diagnostic-name-in-use');
  return {request: request, dispatch: dispatch, snapshot: snapshot, enrichAuction: enrichAuction, configurePrebid: configurePrebid, finished: finished};
}
