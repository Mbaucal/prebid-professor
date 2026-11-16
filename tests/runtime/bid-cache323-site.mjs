import {defaultOverlay} from '../../worker/runtime-next/position-settings.mjs';

/* The synthetic, non-Tanjug site of the 3.23.0 bid cache checks (node:vm and
 * Chromium): Billboard and P1 are ATF banners with a 30-second refresh, two
 * bidders, and optionally a TakeOver position and an Outstream position. */
export const OUTSTREAM = {format: 'outstream', playerSize: [640, 360], minDuration: 1, maxDuration: 30, playbackMethod: 2, placement: 3, plcmt: 4,
  partner: {bidder: 'pubmatic', adapter: 'pubmatic', outstreamAU: 'synthetic-au', activationConfirmed: true}, cacheUrl: 'https://prebid.adnxs.com/pbc/v1/cache'};

/** cache: the saved config.prebidBidCache, or undefined when nothing was saved. */
export function bidCacheSite({cache, takeOver = false, outstream = false} = {}) {
  const config = {enablePrebid: true, runtimeControls: {sticky: {bottomAdUnitId: ''}, floors: {enabled: false}, currencyConversion: {enabled: false}}};
  if (cache !== undefined) config.prebidBidCache = cache;
  const units = [{code: 'Billboard', type: 'ATF', media_type: 'banner', size_map_key: 'display', enabled: 1, sort_order: 0},
    {code: 'P1', type: 'ATF', media_type: 'banner', size_map_key: 'display', enabled: 1, sort_order: 1}];
  const maps = [{name: 'display', map_json: JSON.stringify([{viewport: [0, 0], sizes: [[300, 250]]}, {viewport: [1024, 0], sizes: [[300, 250], [970, 250]]}])}];
  if (takeOver) {
    config.runtimeControls.adPositions = {Overlay: {...defaultOverlay(), demand: 'site', desktopSeconds: 0, mobileSeconds: 0}};
    units.push({code: 'Overlay', type: 'ATF', media_type: 'banner', size_map_key: 'modal', enabled: 1, sort_order: 2});
    maps.push({name: 'modal', map_json: JSON.stringify([{viewport: [0, 0], sizes: [[300, 250]]}, {viewport: [1024, 0], sizes: [[800, 600]]}])});
  }
  if (outstream) {
    config.runtimeControls.outstream = {schemaVersion: 1, units: {P2: OUTSTREAM}};
    units.push({code: 'P2', type: 'ATF', media_type: 'banner', size_map_key: 'video', enabled: 1, sort_order: 3});
    maps.push({name: 'video', map_json: JSON.stringify([{viewport: [0, 0], sizes: [[640, 360]]}])});
  }
  return {site: {id: 'bc-site', name: 'Synthetic bid cache site', domain: 'bidcache.example.invalid', gam_path: '/999/bidcache/'},
    config: {config_json: JSON.stringify(config)}, units,
    bidders: [{bidder: 'pubmatic', params_json: '{"publisherId":"1","adSlot":"a"}', enabled: 1}, {bidder: 'openx', params_json: '{"unit":"1","delDomain":"synthetic.example.invalid"}', enabled: 1}],
    overrides: [], maps, prebidBuilds: outstream ? [{id: 'synthetic', publisher_id: 'bc-site', version: '11.34.0', file_key: 'synthetic',
      modules_json: '["pubmaticBidAdapter"]', status: 'current', uploaded_at: '2026-11-15T00:00:00.000Z'}] : [],
    rules: [{rule_key: '__ATF__', rule_json: JSON.stringify({lazy: {enabled: false, fetchMarginPx: 0, renderMarginPx: 0}, timeout: 800,
      refresh: {enabled: true, minSeconds: 30, minViewPct: 0, requirePreviousViewable: false, checkEveryMs: 1000}})}]};
}
