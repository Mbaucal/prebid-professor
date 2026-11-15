/** Site-owned choices for future packages. Saved releases always keep their own snapshot. */
import {positionCacheOverrides,hasBidCache} from '../experiments/position-cache-settings.mjs';
import {BID_CACHE_RUNTIME_VERSION,runtimeSupportsBidCache} from '../../shared/bid-cache/eligibility.mjs';
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
export const BID_CACHE_GENERATOR_MESSAGE = `Bid caching needs script version ${BID_CACHE_RUNTIME_VERSION}. Select ${BID_CACHE_RUNTIME_VERSION} in Script setup and save; your bid cache settings are kept.`;
/** Saved cache settings are applied only by a runtime with the 'bid-cache' capability,
 * never silently ignored. Without a descriptor (older generators) it always refuses. */
export function requireSupportedCacheGenerator(config, descriptor) {
  const prebid=savedPrebidSettings(config);
  if(prebid.enabled && (hasBidCache(prebid.bidCache)||prebid.bidCache.positionOverrides) && !runtimeSupportsBidCache(descriptor))throw Object.assign(Error(BID_CACHE_GENERATOR_MESSAGE),{status:409});
}
