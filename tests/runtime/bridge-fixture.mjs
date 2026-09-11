export function fixture() {
  return {
    core: {
      engine: 'legacy-advanced-refresh-v1', buildVersion: '20260911_120000', siteId: 'tessera-test',
      generatorProfileId: 'builtin-reference-3.9.1-preview', gamPath: '/123/test/',
      bidders: [{ bidder: 'ix', params: { siteId: 'test' } }],
      bidderSlotParams: { ix: { ATF: { siteId: 'atf' } } },
      bidderDeviceParams: { ix: { mobile: { siteId: 'mobile' } } },
      bidderAdUnitParams: { ix: { Billboard: { siteId: 'exact' } } },
      adUnitRules: { __DEFAULT__: { timeout: 1500, cmpTimeout: 1500, refresh: {
        enabled: true, minSeconds: 30, minViewPct: 50, schedule: { mode: 'fixed', fixedSeconds: 30 },
      } } },
      explicitUnits: [
        { id: 'Billboard', type: 'ATF', formats: ['banner'], sizes: [[970, 250], [300, 250]], sizeMapName: 'billboard', prebidSizeConfigName: 'billboard' },
        { id: 'P1', type: 'BTF', formats: ['banner'], sizes: [[300, 250]] },
        { id: 'Sticky', type: 'ATF', formats: ['banner'], sizes: [[320, 100]] },
      ],
      sizeMapsRaw: { billboard: [{ viewport: [0, 0], sizes: [[300, 250]] }, { viewport: [1024, 0], sizes: [[970, 250]] }] },
      prebidSizeConfigsRaw: { billboard: [{ minViewPort: [0, 0], sizes: [[300, 250]] }, { minViewPort: [1024, 0], sizes: [[970, 250]] }] },
      userSync: { syncEnabled: true, aliasSyncEnabled: true, syncsPerBidder: 3, syncDelay: 2000, auctionDelay: 0, userIds: [] },
      defaultTimeout: 1500, atfTimeout: 1800, btfTimeout: 1400, stickyTimeout: 1300,
      globalRefresh: { enabled: true, minSeconds: 30, minViewPct: 50, maxRefreshes: 20, minGapSeconds: 30,
        exitViewPct: 10, accumulateViewTime: true, schedule: { mode: 'fixed', fixedSeconds: 30 } },
      maxCmpTimeout: 1500,
    },
    options: {
      buildTimestamp: '20260911_120000', adContainerSelector: '.wrapperAd', enablePrebid: true, debug: false,
      sticky: { bottomAdUnitId: 'Sticky', topAdUnitId: null, refreshSeconds: 30, emptyRetryDelays: [30000] },
      floors: { enabled: true, hardFloor: 0.08, currency: 'EUR', bidderFloors: { ix: 0.09 }, rules: {} },
      currencyConversion: { enabled: false, url: 'https://example.com/currency.json' },
      takeOver: { enabled: true, adUnitCode: 'TakeOver', desktopSize: [800, 600], mobileSize: [300, 250],
        desktopMinWidth: 1024, codelessAdUnitPath: '/123/test/Interstitial', autoCloseDesktopSec: 10, autoCloseMobileSec: 5 },
    },
  };
}
