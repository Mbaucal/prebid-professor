/* Synthetic publisher/CMP/GPT observation only: the wrapper and Prebid are real. */
(() => {
  const clone = value => JSON.parse(JSON.stringify(value));
  window.adsKeywords = {pageType: 'Naslovna', category: 'Sports'};
  window.__wrapperAudit = {requested: [], auctions: [], completed: [], sent: [], ppsWrites: [], readiness: []};
  const audit = window.__wrapperAudit;
  const callbacks = new Map();
  let listenerId = 0, current = null, pps = null;
  window.__emitWrapperConsent = data => {
    current = data;
    for (const [id, callback] of callbacks) callback({...data, listenerId: id}, true);
    audit.readiness.push(clone(window.__tesseraReadiness?.snapshot() || {}));
  };
  window.__tcfapi = (command, version, callback, id) => {
    if (command === 'addEventListener') {
      const next = ++listenerId; callbacks.set(next, callback);
      if (current) callback({...current, listenerId: next}, true);
    } else if (command === 'removeEventListener') { callbacks.delete(id); callback(true); }
    else if (command === 'getTCData') callback(current, !!current);
    else if (command === 'ping') callback({cmpLoaded: true, cmpStatus: 'loaded', gdprApplies: current?.gdprApplies}, true);
  };
  const nativeSetConfig = googletag.setConfig;
  googletag.setConfig = function(config) {
    if (Object.prototype.hasOwnProperty.call(config, 'pps')) {
      pps = clone(config.pps); audit.ppsWrites.push(pps);
    }
    return nativeSetConfig.apply(this, arguments);
  };
  const nativeRefresh = __testAds.service.refresh;
  __testAds.service.refresh = function(slots) {
    for (const slot of slots || []) audit.sent.push({id: slot.id, pps: clone(pps), mapping: clone(slot.mapping), sizes: clone(slot.sizes),
      consent: clone(window.__tesseraReadiness?.snapshot().consent || {}), targeting: clone(slot.targeting)});
    return nativeRefresh.apply(this, arguments);
  };
  window.prepareWrapperPrebidAudit = mode => {
    pbjs.setConfig({debug: false, userSync: {syncEnabled: false}, ortb2: {
      source: {ext: {schain: {ver: '1.0', complete: 1, nodes: [{asi: 'audit.invalid', sid: 'synthetic', hp: 1}]}}},
      site: {content: {data: [{name: 'existing-context.invalid', ext: {segtax: 500}, segment: [{id: 'preserved'}]}]}},
    }});
    pbjs.onEvent('auctionInit', request => audit.auctions.push({id: request.auctionId, codes: request.adUnitCodes}));
    pbjs.onEvent('auctionEnd', request => audit.completed.push(request.auctionId));
    pbjs.onEvent('bidRequested', request => audit.requested.push({id: request.auctionId, bidder: request.bidderCode,
      ortb2: clone(request.ortb2 || {}), gdprConsent: clone(request.gdprConsent || {}), codes: request.bids.map(bid => bid.adUnitCode),
      bannerSizes: request.bids.map(bid => clone(bid.mediaTypes.banner.sizes))}));
    if (mode !== 'baseline') {
      const dataProviders = [{name: 'contextualAudit', waitForIt: false, params: {keep: true}}];
      if (mode === 'combined-first') dataProviders.push({name: 'contextualSignals', waitForIt: false, params: {}});
      pbjs.setConfig({realTimeData: {auctionDelay: 0, dataProviders}});
    }
    audit.initialRtd = clone(pbjs.getConfig('realTimeData') || {});
  };
  window.wrapperAuditResult = () => ({...clone(audit), snapshot: window.__AD_CONTEXT.snapshot(),
    nativePrebidVersion: pbjs.version, installedModules: pbjs.installedModules,
    publisherProviderCalls: window.__contextualAuditCalls || 0,
    finalRtd: clone(pbjs.getConfig('realTimeData') || {}), privacy: clone(__testAds.observations.privacy)});
})();
