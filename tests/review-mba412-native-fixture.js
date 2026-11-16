/* Independent QA: native Prebid/Adform, synthetic account IDs, no paid traffic. */
window.runAccountNativeCase = async function (scenario) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const chain = sid => ({ver: '1.0', complete: 1, nodes: [{asi: 'seller.invalid', sid, hp: 1}]});
  const siteChain = chain('site-seller'), customChain = chain('custom-seller'), foreignChain = chain('foreign-seller');
  const accounts = [
    {bidder: 'adf', baseAdapter: 'adf', displayName: '', schain: {mode: 'inherit'}},
    {bidder: 'adf_smn', baseAdapter: 'adf', displayName: 'Site account', schain: {mode: 'inherit'}},
    {bidder: 'adf_ag', baseAdapter: 'adf', displayName: 'Agency buyer', schain: {mode: 'none'}},
    {bidder: 'adf_custom', baseAdapter: 'adf', displayName: 'Separate seller', schain: {mode: 'custom', config: customChain}},
  ];
  if (scenario.mode === 'base-adapter-collision') accounts[2].bidder = 'pubmatic';
  const configuredAccounts = clone(accounts);
  const initial = {site: {name: 'QA Publisher', content: {data: [{name: 'qa.invalid', ext: {segtax: 6}, segment: [{id: 'synthetic-context'}]}]}},
    source: {ext: {publisherMarker: 'keep-source'}}, user: {ext: {data: {globalMarker: 'keep-global'}}}};
  pbjs.setConfig({debug: false, bidderSequence: 'fixed', bidderTimeout: 350, userSync: {syncEnabled: false},
    firstPartyData: {uaHints: ['architecture']}, ortb2: clone(initial)});
  if (scenario.mode === '11.45-replacement') pbjs.setConfig({firstPartyData: {replaceGlobalSchain: true, uaHints: ['architecture']}});
  if (scenario.mode === 'existing-alias') pbjs.aliasBidder('adf', 'adf_ag', {useBaseGvlid: true});
  if (['alias-conflict', 'private-alias-conflict'].includes(scenario.mode)) pbjs.aliasBidder('openx', 'adf_ag', {useBaseGvlid: true});
  if (['private-registry', 'private-alias-conflict'].includes(scenario.mode)) pbjs.setConfig({aliasRegistry: 'private'});
  const bidderFpd = {site: {content: {title: 'keep-bidder-title'}}, user: {ext: {data: {bidderMarker: 'keep-bidder'}}}};
  if (scenario.mode === 'bidder-current') bidderFpd.source = {schain: foreignChain};
  if (scenario.mode === 'bidder-legacy-path') bidderFpd.source = {ext: {schain: foreignChain}};
  const bidderConfig = {ortb2: bidderFpd};
  if (scenario.mode === 'bidder-legacy-config') bidderConfig.schain = {config: foreignChain};
  pbjs.setBidderConfig({bidders: ['adf_ag'], config: bidderConfig});
  if (scenario.mode === 'global-current') pbjs.setConfig({ortb2: {...clone(initial), source: {schain: foreignChain}}});
  if (scenario.mode === 'global-legacy-path') pbjs.setConfig({ortb2: {...clone(initial), source: {ext: {schain: foreignChain}}}});
  if (scenario.mode === 'global-legacy-config') pbjs.setConfig({schain: {config: foreignChain}});
  if (scenario.mode === 'activity-denied') pbjs.setConfig({allowActivities: {fetchBids: {default: true, rules: [{condition: p => p.componentName === 'adf_ag', allow: false}]}}});
  const globalBefore = clone(pbjs.getConfig('ortb2'));
  const firstPartyBefore = clone(pbjs.getConfig('firstPartyData'));
  const calls = [], callbacks = [];
  pbjs.onEvent('bidRequested', r => calls.push({auctionId: r.auctionId, bidder: r.bidderCode, ortb2: clone(r.ortb2 || {}), bids: r.bids.map(b => ({bidder: b.bidder, code: b.adUnitCode, ortb2: clone(b.ortb2 || {})}))}));
  const helper = createBidderAccounts(window, configuredAccounts, siteChain, {request: (pb, req) => pb.requestBids(req)});
  helper.preparePrebid(pbjs); helper.configurePrebid(pbjs);
  if (scenario.mode === 'repeat-configure') { helper.preparePrebid(pbjs); helper.configurePrebid(pbjs); helper.configurePrebid(pbjs); }
  if (scenario.mode === 'late-global-current') pbjs.setConfig({ortb2: {...clone(initial), source: {schain: foreignChain}}});
  if (scenario.mode === 'late-global-legacy-config') pbjs.setConfig({schain: {config: foreignChain}});
  if (scenario.mode === 'late-bidder-current') pbjs.setBidderConfig({bidders: ['adf_ag'], config: {ortb2: {...clone(bidderFpd), source: {schain: foreignChain}}}});
  if (scenario.mode === 'late-merge-bidder-current') pbjs.mergeBidderConfig({bidders: ['adf_ag'], config: {ortb2: {source: {schain: foreignChain}}}});
  if (scenario.mode === 'late-bidder-legacy-config') pbjs.setBidderConfig({bidders: ['adf_ag'], config: {schain: {config: foreignChain}}});
  if (scenario.mode === 'guard-replaced') {const previous = pbjs.setBidderConfig; pbjs.setBidderConfig = function () {return previous.apply(this, arguments);};}
  if (scenario.mode === 'late-empty-config') pbjs.setBidderConfig({bidders: ['adf_smn', 'adf_custom'], config: {}});
  if (scenario.mode === 'late-option-only') pbjs.setBidderConfig({bidders: ['adf_smn', 'adf_custom'], config: {bidderTimeout: 500}});
  const bids = accounts.map((a, i) => ({bidder: a.bidder, params: {mid: 999990 + i}}));
  const submit = (id, position) => new Promise(resolve => {
    const request = {auctionId: id, adUnits: [{code: position, mediaTypes: {banner: {sizes: [[300, 250]]}}, bids: clone(bids)}],
      bidsBackHandler: () => {callbacks.push(id); resolve();}};
    if (scenario.mode === 'request-current') request.ortb2 = {source: {schain: foreignChain}};
    if (scenario.mode === 'request-legacy-path') request.ortb2 = {source: {ext: {schain: foreignChain}}};
    if (scenario.mode === 'bid-current') request.adUnits[0].bids[2].ortb2 = {source: {schain: foreignChain}};
    helper.request(pbjs, request);
  });
  await Promise.race([
    scenario.mode === 'concurrent' ? Promise.all([submit('qa-account-1', 'P1'), submit('qa-account-2', 'P2')]) : submit('qa-account-1', 'P1'),
    new Promise((_, reject) => setTimeout(() => reject(Error('Native auction callback timeout')), 5000)),
  ]);
  if (scenario.mode === 'repeat-auction') await submit('qa-account-2', 'P2');
  return {version: pbjs.version, siteChain, customChain, accounts, accountsAfter: configuredAccounts, calls, callbacks,
    snapshot: helper.snapshot(), globalBefore, globalAfter: clone(pbjs.getConfig('ortb2')), firstPartyBefore,
    firstPartyAfter: clone(pbjs.getConfig('firstPartyData')), aliases: clone(pbjs.aliasRegistry || {})};
};
