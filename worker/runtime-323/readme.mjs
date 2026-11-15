import {activeBidCache} from './bid-cache-compiler.mjs';

/** What this package does with saved bid cache settings, in one sentence. */
function packageState(input) {
  if (input.options.enablePrebid !== true) return 'Off. This package is GAM-only, so there are no Prebid bids to reuse.';
  if (input.bidCache === null) return 'Off. Bid caching is off for this site, so every auction uses fresh bids only, as in 3.21.2.';
  const active = activeBidCache(input);
  if (!active) return `${input.bidCache.defaultEnabled ? 'Bid caching is on for this site' : 'A saved position override asks for bid caching'}, but no position in this package can reuse bids, so every auction uses fresh bids only.`;
  const on = active.positions.filter(([, enabled]) => enabled).map(([code]) => code);
  const off = active.positions.filter(([, enabled]) => !enabled).map(([code]) => code);
  return `On for ${on.join(', ')}, with a maximum bid age of ${active.maxAgeSeconds} seconds.` +
    (off.length ? ` Off for ${off.join(', ')}.` : '') + ' Every other position uses fresh bids only.';
}

export function bidCacheReadme(input) {
  const skipped = input.bidCacheExclusions.map(({code, enabled}) => `${code} (${enabled ? 'on' : 'off'})`);
  return '\nBid caching in 3.23.0\n' +
    'Set in Config → Demand → Prebid (site setting and maximum bid age from 1 to 300 seconds) and Config → Ad units → Bid cache (optional on or off per position).\n' +
    `This package: ${packageState(input)}\n` +
    (skipped.length ? `Saved settings not applied in this package: ${skipped.join(', ')}. Bid reuse applies only to enabled ATF/BTF Banner positions; TakeOver, its Interstitial fallback, Outstream, Draft, disabled and removed positions use fresh bids only. The settings stay saved.\n` : '') +
    'Every refresh still runs a new Prebid auction. A bid that was received earlier on this page but never sent to Google Ad Manager can compete again in that auction, only for the same position. The highest bid wins; send-all-bids and deal keys work as before. A bidder with a fresh deal bid keeps that deal: none of its earlier bids competes in that auction.\n' +
    'An earlier bid is reused only if it is a Banner bid, its size is one the position can show at the current screen size, it is younger than both the maximum bid age and the bidder\'s own time-to-live minus one second, and it came from an auction under the same consent: the same TCF decision and the same consent data that Prebid sent to bidders. A TCF change drops every earlier bid. Tessera turns Prebid\'s GPP module off, and US privacy reaches Prebid only when the site\'s Prebid.js includes the US privacy module, so a GPP change, or a US privacy change without that module, does not stop reuse. A bid sent to Google Ad Manager once, as the winner or as a bidder or deal key, is never sent again.\n' +
    'TakeOver, its Interstitial fallback, Outstream, video and native always use fresh bids only; they are never dropped. Nothing is stored: earlier bids live only in the page\'s memory until the page is closed or reloaded.\n' +
    'If the loaded Prebid.js lacks the bid cache settings, does not apply the filter, or another script already set a bid cache filter, the page uses fresh bids only and keeps serving ads. window.__tesseraBidCache.snapshot() shows whether bid caching is active, why not, and how many cached and fresh bids won. It shows no bid contents, ad IDs or consent strings.\n' +
    'Generating this package does not change Prebid.js, GAM or any live script. Check win rates and discrepancies after rollout; a reused bid can still be refused by the bidder or ad server.\n';
}

/** One HTML comment for implementation.html, with no position codes in it. */
export function bidCacheHtmlNote(input) {
  const active = input.options.enablePrebid === true && input.bidCache !== null ? activeBidCache(input) : null;
  if (!active) return '<!-- Bid caching is off in this package: every Prebid auction uses fresh bids only. -->';
  const count = active.positions.filter(([, enabled]) => enabled).length;
  return `<!-- Bid caching is on for ${count} position${count === 1 ? '' : 's'} (see README.txt). Nothing else is needed on the page. -->`;
}
