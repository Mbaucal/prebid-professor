/** Site-owned choices for future packages. Saved releases always keep their own snapshot. */
import {CACHE_POSITIONS,hasBidCache} from '../experiments/position-cache-settings.mjs';
import {runtimeSupportsBidCache} from '../../shared/bid-cache/eligibility.mjs';
import {validateAdUnitCode} from '../../shared/gam/ad-unit-code.mjs';
export {hasBidCache};
export const DEFAULT_BID_CACHE = Object.freeze({enabled:false,maxBidAgeSeconds:60});
/** The most position overrides one site can save; each names one of its own ad units. */
export const MAX_POSITION_OVERRIDES = 500;
const OVERRIDE_MESSAGE = 'Choose bid caching on or off for a supported ad position.';
/** Code-unit order, so the saved order never depends on the host locale. */
const byCodeUnit = ([a],[b]) => (a < b ? -1 : a > b ? 1 : 0);
const named = codes => codes.length > 3 ? `${codes.slice(0,3).join(', ')} and ${codes.length-3} more` : codes.join(', ');
/** Shape only: any valid GAM ad unit code, each with a boolean. Whether a code is one of the
 * site's eligible positions is checked when it is saved (requireEligibleOverrides). */
export function bidCacheOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length > MAX_POSITION_OVERRIDES
    || Object.entries(value).some(([code,enabled])=>validateAdUnitCode(code).length>0||typeof enabled!=='boolean')) {
    throw Object.assign(Error(OVERRIDE_MESSAGE),{status:422});
  }
  return Object.fromEntries(Object.entries(value).sort(byCodeUnit));
}
/** A save may add or change an override only for one of the site's eligible positions
 * (bidCacheEligibleCodes in shared/bid-cache/eligibility.mjs). An override saved earlier and sent
 * back unchanged stays, even when its ad unit is no longer eligible (renamed, deleted, disabled,
 * moved to Draft, made Outstream or TakeOver): it is not applied, Generate reports it, and it never
 * blocks an unrelated save. Removing an override is always allowed. */
export function requireEligibleOverrides(next, saved, eligibleCodes) {
  const before = saved && typeof saved === 'object' && saved.positionOverrides && typeof saved.positionOverrides === 'object' ? saved.positionOverrides : {};
  const eligible = new Set(eligibleCodes);
  const refused = Object.entries(next.positionOverrides ?? {})
    .filter(([code,enabled])=>!eligible.has(code) && !(Object.hasOwn(before,code) && before[code] === enabled)).map(([code])=>code);
  if (refused.length) {
    throw Object.assign(Error(`${OVERRIDE_MESSAGE} ${named(refused)} ${refused.length === 1 ? 'is not an enabled ATF or BTF banner position' : 'are not enabled ATF or BTF banner positions'} on this site. Reload to see the current positions.`),{status:422});
  }
}
export function bidCacheSettings(value = DEFAULT_BID_CACHE) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).filter(key=>key!=='positionOverrides').sort().join(',') !== 'enabled,maxBidAgeSeconds'
    || typeof value.enabled !== 'boolean' || !Number.isInteger(value.maxBidAgeSeconds)
    || value.maxBidAgeSeconds < 1 || value.maxBidAgeSeconds > 300) {
    throw Object.assign(Error('Choose bid caching on or off and a maximum bid age of 1–300 seconds.'),{status:422});
  }
  const overrides=Object.hasOwn(value,'positionOverrides')?bidCacheOverrides(value.positionOverrides):{};
  return {enabled:value.enabled,maxBidAgeSeconds:value.maxBidAgeSeconds,
    ...(Object.keys(overrides).length?{positionOverrides:overrides}:{})};
}
export const supportsNamedScripts = row => Boolean(row && /^(?:https?:\/\/)?(?:www\.)?tanjug\.rs\/?$/i.test(row.domain?.trim() || '')
  && row.gam_path === '/22852026051/Tanjug.rs-Display/');
export function savedPrebidSettings(config) {
  return {enabled:config.enablePrebid !== false,bidCache:bidCacheSettings(config.prebidBidCache)};
}
/** Named scripts (Releases → Scripts and A/B tests) keep the reviewed Tanjug inventory of
 * CACHE_POSITIONS. A site override for any other position is refused, never silently dropped. */
export function settingsForScript(config,refreshSeconds) {
  const {enabled,bidCache}=savedPrebidSettings(config);
  if(!enabled)throw Object.assign(Error('Enable Prebid in Config → Demand → Prebid before creating a new script.'),{status:409});
  const outside=Object.keys(bidCache.positionOverrides??{}).filter(code=>!CACHE_POSITIONS.includes(code));
  if(outside.length)throw Object.assign(Error(`Named scripts use the reviewed Tanjug inventory of ${CACHE_POSITIONS.length} positions, which has no ${named(outside)}. Set ${outside.length===1?'that position':'those positions'} to Use site setting under Config → Ad units → Bid cache, or remove unused overrides under Config → Demand → Prebid, before creating a named script.`),{status:409});
  return {mode:bidCache.enabled?'auction-with-cache':'fresh-only',refreshSeconds,
    ...(bidCache.enabled||bidCache.positionOverrides?{maxBidAgeSeconds:bidCache.maxBidAgeSeconds}:{}),
    ...(bidCache.positionOverrides?{positionOverrides:bidCache.positionOverrides}:{})};
}
export const BID_CACHE_GENERATOR_MESSAGE = 'Bid caching needs a compatible script version. Select 3.24.0 (Preview) in Script setup and save; your bid cache settings are kept. '
  + 'This version combines bid caching with bidder accounts, bidder rules and the current native activity and floor checks. '
  + 'To keep this script version instead, turn bid caching off in Config → Demand → Prebid, remove unused overrides there, and set positions that are On to Use site setting under Config → Ad units → Bid cache.';
/** Saved cache settings that would reuse bids (site default on, or a position override on) are
 * applied only by a runtime with the 'bid-cache' capability, never silently ignored. Without a
 * descriptor (older generators) such settings are always refused. An Off override alone needs no
 * capability: without bid caching every position already uses its current auction only. */
export function requireSupportedCacheGenerator(config, descriptor) {
  const prebid=savedPrebidSettings(config);
  if(prebid.enabled && hasBidCache(prebid.bidCache) && !runtimeSupportsBidCache(descriptor))throw Object.assign(Error(BID_CACHE_GENERATOR_MESSAGE),{status:409});
}
