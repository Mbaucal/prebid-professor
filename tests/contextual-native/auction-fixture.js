/* Synthetic publisher context and auctions. The Prebid core, RTD hook and adapters are real. */
window.runContextualNativeCase = async function (scenario) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const bids = [
    {bidder: 'connectad', params: {networkId: 999999, siteId: 999999}},
    {bidder: 'openx', params: {unit: '999999', delDomain: 'synthetic.invalid'}},
    {bidder: 'pubmatic', params: {publisherId: '999999', adSlot: 'synthetic@300x250'}},
    {bidder: 'ix', params: {siteId: '999999', size: [300, 250]}},
    {bidder: 'rubicon', params: {accountId: 999999, siteId: 999999, zoneId: 999999}},
    {bidder: 'teads', params: {pageId: 999999, placementId: 999999}},
    {bidder: 'richaudience', params: {pid: 'synthetic-native-context', supplyType: 'site'}},
  ];
  const supported = ['connectad', 'openx', 'pubmatic', 'ix', 'rubicon'];
  const providerName = 'native-context-fixture.invalid';
  const taxonomy = scenario.taxonomy || 'iab-content-2.2';
  // Deliberately synthetic IDs: this lab proves serialization, not taxonomy membership/server acceptance.
  const mappings = [
    {value: 'Alpha', taxonomies: {'iab-content-2.2': ['native-22-alpha'], 'iab-content-3.0': ['native-30-alpha']}},
    {value: 'Beta', taxonomies: {'iab-content-2.2': ['native-22-beta'], 'iab-content-3.0': ['native-30-beta']}},
  ];
  let routes = bids.map(bid => ({bidder: bid.bidder, taxonomy}));
  if (scenario.mode === 'route-off') routes = routes.filter(route => route.bidder !== 'openx');
  if (scenario.mode === 'no-routes') routes = [];
  const config = {enabled: scenario.mode !== 'disabled', sourceKey: 'category', providerName,
    prebidVersion: pbjs.version, mappings, bidders: routes, gam: {enabled: false}};
  const schain = {ver: '1.0', complete: 1, nodes: [{asi: 'publisher.invalid', sid: 'synthetic-seller', hp: 1}]};
  const foreign = {name: 'existing-context.invalid', ext: {segtax: 500}, segment: [{id: 'existing-context'}]};
  const initialOrtb2 = {site: {name: 'Synthetic contextual fixture', content: {data: [foreign]}},
    source: {ext: {schain}}, user: {ext: {data: {preserve: 'existing-user-marker'}}}};
  const activityChecks = [], guardedReads = [];
  if (scenario.mode === 'mixed-rubicon') initialOrtb2.site.content.data.push({
    name: 'foreign-iab.invalid', ext: {segtax: taxonomy === 'iab-content-2.2' ? 7 : 6},
    segment: [{id: 'foreign-other-taxonomy'}],
  });
  pbjs.setConfig({debug: false, bidderSequence: 'fixed', bidderTimeout: 1200, userSync: {syncEnabled: false},
    ortb2: initialOrtb2});
  if (scenario.mode === 'activity-denied') pbjs.setConfig({allowActivities: {
    transmitUfpd: {default: false}, enrichUfpd: {default: false}, transmitEids: {default: false},
  }});
  if (scenario.mode === 'rtd-activity-denied') {
    const rtdOnly = {default: true, rules: [{condition: params => {
      const denied = params.componentType === 'rtd' && params.componentName === 'contextualSignals';
      activityChecks.push({componentType: params.componentType, componentName: params.componentName, denied});
      return denied;
    }, allow: false}]};
    pbjs.setConfig({allowActivities: {transmitUfpd: rtdOnly, transmitEids: rtdOnly, enrichUfpd: rtdOnly, enrichEids: rtdOnly}});
  }
  pbjs.setBidderConfig({bidders: ['openx'], config: {ortb2: {
    site: {content: {title: 'existing-bidder-context'}},
    user: {ext: {data: {private: 'bidder-private-marker'},
      eids: [{source: 'id-provider.invalid', uids: [{id: 'synthetic-existing-id', atype: 1}]}]}},
  }}});
  const beforeGlobal = clone(pbjs.getConfig('ortb2'));
  const bidderConfigWrites = [], originalSetBidderConfig = pbjs.setBidderConfig;
  pbjs.setBidderConfig = function () { bidderConfigWrites.push(clone([...arguments])); return originalSetBidderConfig.apply(this, arguments); };
  const requested = [], callbacks = [], auctionEnds = [], providerCalls = [];
  pbjs.onEvent('bidRequested', request => requested.push({auctionId: request.auctionId, bidder: request.bidderCode,
    ortb2: clone(request.ortb2 || {}), bids: request.bids.map(bid => ({code: bid.adUnitCode, ortb2: clone(bid.ortb2 || {})}))}));
  pbjs.onEvent('auctionEnd', event => auctionEnds.push(event.auctionId));
  const contextual = createContextualSignals(window, config, {
    request: (pb, request) => pb.requestBids(scenario.mode === 'mismatched-auction'
      ? {...request, auctionId: `${request.auctionId}-different`} : request),
    dispatch: () => {}, code: slot => slot.code,
  });
  contextual.configurePrebid(pbjs);
  const originalEnrich = window.__AD_CONTEXT.enrichAuction;
  window.__AD_CONTEXT.enrichAuction = function (request) {
    providerCalls.push({auctionId: request.auctionId, category: clone(window.adsKeywords || {})});
    if (scenario.mode === 'rtd-activity-denied') {
      // This request is the actual native RTD Proxy. Prove the configured guard
      // is active before checking that the production runtime preserves data it cannot read.
      const user = JSON.stringify(request.ortb2Fragments.bidder.openx.user || {});
      guardedReads.push({auctionId: request.auctionId, privateVisible: user.includes('bidder-private-marker'),
        eidVisible: user.includes('synthetic-existing-id')});
    }
    if (scenario.mode === 'provider-throws') throw new Error('synthetic optional-provider failure');
    return originalEnrich(request);
  };
  const expected = [];
  function auction(label, category, foreignAuction = false) {
    window.adsKeywords = category == null ? {} : {category};
    const auctionId = `contextual-${scenario.name}-${label}`;
    const adUnits = [{code: `slot-${label}`, mediaTypes: {banner: {sizes: [[300, 250]]}}, bids: clone(bids)}];
    const mapped = mappings.find(mapping => mapping.value === category);
    const routeIds = {};
    bids.forEach(bid => {
      const enabled = config.enabled && mapped && supported.includes(bid.bidder)
        && routes.some(route => route.bidder === bid.bidder)
        && !foreignAuction
        && !['foreign-auction', 'mismatched-auction', 'provider-throws'].includes(scenario.mode)
        && !(scenario.mode === 'mixed-rubicon' && bid.bidder === 'rubicon');
      routeIds[bid.bidder] = enabled ? mapped.taxonomies[taxonomy] : [];
    });
    expected.push({auctionId: scenario.mode === 'mismatched-auction' ? `${auctionId}-different` : auctionId,
      taxonomy, routeIds});
    return new Promise(resolve => {
      const input = {auctionId, adUnits, timeout: 1200, bidsBackHandler: () => {callbacks.push(auctionId); resolve();}};
      if (scenario.mode === 'foreign-auction' || foreignAuction) pbjs.requestBids(input);
      else contextual.request(pbjs, input);
    });
  }
  const started = performance.now();
  if (scenario.mode === 'concurrent') {
    const alpha = auction('alpha', 'Alpha');
    const beta = auction('beta', 'Beta');
    await Promise.all([alpha, beta]);
  } else {
    await auction('single', scenario.mode === 'no-category' ? null : scenario.mode === 'unknown-category' ? 'Unmapped' : 'Alpha');
    if (scenario.mode === 'category-cleared') await auction('cleared', null);
    if (scenario.mode === 'no-leak') await auction('foreign', 'Alpha', true);
  }
  return {scenario, expected, requested, callbacks, auctionEnds, providerCalls, elapsedMs: performance.now() - started,
    activityChecks, guardedReads,
    providerName, schain, snapshot: contextual.snapshot(), beforeGlobal, afterGlobal: clone(pbjs.getConfig('ortb2')),
    bidderConfigWrites, realTimeData: clone(pbjs.getConfig('realTimeData') || {}),
    installedModules: pbjs.installedModules, prebidVersion: pbjs.version};
};
