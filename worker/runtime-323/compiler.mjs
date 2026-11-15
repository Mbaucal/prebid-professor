import {parse} from 'acorn';
import {compileRuntime3212} from '../runtime-3212/compiler.mjs';
import {activeBidCache, applyBidCache} from './bid-cache-compiler.mjs';
export {idempotentStickyStyles} from '../runtime-3212/compiler.mjs';

/** Generate-time warnings for saved bid cache settings this package does not apply. */
export function bidCacheWarnings(input) {
  const warnings = input.bidCacheExclusions.map(({code}) => `${code}: saved bid cache setting not applied. Bid reuse applies only to enabled ATF/BTF Banner positions of this package; TakeOver, its Interstitial fallback, Outstream and disabled or removed positions use fresh bids only. The setting stays saved.`);
  if (input.bidCache !== null && !activeBidCache(input))
    warnings.push('Bid caching is on in Demand → Prebid, but no position in this package can reuse bids; every position uses fresh bids.');
  return warnings;
}

/** 3.21.2 plus Prebid bid caching. Without an active bid cache the 3.21.2 program is unchanged. */
export function compileRuntime323(input) {
  const previous = compileRuntime3212(input);
  const active = activeBidCache(input);
  const source = applyBidCache(previous.adsJs, input);
  parse(source, {ecmaVersion: 2015});
  const patches = active ? [
    `3.23.0: Prebid bid caching for ${active.positions.filter(([, enabled]) => enabled).length} position(s), maximum bid age ${active.maxAgeSeconds} s; useBidCache with a Tessera bidCacheFilterFunction, presetGPTTargeting off`,
    '3.23.0: a cached bid competes only for its own Banner position, from an auction completed in the current consent epoch with the same Prebid consent data, never sent to GAM before, of a size the position requests now, and younger than the saved age and the bidder TTL minus 1 s',
    '3.23.0: every refresh still runs a new auction; a consent change drops all cached bids; missing Prebid features fall back to fresh bids only',
  ] : [];
  return {...previous, adsJs: source, adsMinJs: source,
    warnings: [...previous.warnings, ...bidCacheWarnings(input)], patches: [...previous.patches, ...patches]};
}
