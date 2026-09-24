/** Site-owned choices for future packages. Saved releases always keep their own snapshot. */
import {positionCacheOverrides,hasBidCache} from '../experiments/position-cache-settings.mjs';
export {hasBidCache};
export const DEFAULT_BID_CACHE = Object.freeze({enabled:false,maxBidAgeSeconds:60});
export function bidCacheSettings(value = DEFAULT_BID_CACHE) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).filter(key=>key!=='positionOverrides').sort().join(',') !== 'enabled,maxBidAgeSeconds'
    || typeof value.enabled !== 'boolean' || !Number.isInteger(value.maxBidAgeSeconds)
    || value.maxBidAgeSeconds < 1 || value.maxBidAgeSeconds > 300) {
    throw Object.assign(Error('Choose bid caching on or off and a maximum bid age of 1–300 seconds.'),{status:422});
  }
  const overrides=Object.hasOwn(value,'positionOverrides')?positionCacheOverrides(value.positionOverrides):{};
  return {enabled:value.enabled,maxBidAgeSeconds:value.maxBidAgeSeconds,
    ...(Object.keys(overrides).length?{positionOverrides:overrides}:{})};
}
export const supportsNamedScripts = row => Boolean(row && /^(?:https?:\/\/)?(?:www\.)?tanjug\.rs\/?$/i.test(row.domain?.trim() || '')
  && row.gam_path === '/22852026051/Tanjug.rs-Display/');
export function savedPrebidSettings(config) {
  return {enabled:config.enablePrebid !== false,bidCache:bidCacheSettings(config.prebidBidCache)};
}
export function settingsForScript(config,refreshSeconds) {
  const {enabled,bidCache}=savedPrebidSettings(config);
  if(!enabled)throw Object.assign(Error('Enable Prebid in Config → Demand → Prebid before creating a new script.'),{status:409});
  return {mode:bidCache.enabled?'auction-with-cache':'fresh-only',refreshSeconds,
    ...(bidCache.enabled||bidCache.positionOverrides?{maxBidAgeSeconds:bidCache.maxBidAgeSeconds}:{}),
    ...(bidCache.positionOverrides?{positionOverrides:bidCache.positionOverrides}:{})};
}
export const BID_CACHE_GENERATOR_MESSAGE = 'Bid caching settings are saved in Demand → Prebid or Ad units. Create a named version in Scripts and A/B tests below; this older generator does not support bid caching.';
export function requireSupportedCacheGenerator(config) {
  const prebid=savedPrebidSettings(config);
  if(prebid.enabled && (hasBidCache(prebid.bidCache)||prebid.bidCache.positionOverrides))throw Object.assign(Error(BID_CACHE_GENERATOR_MESSAGE),{status:409});
}
