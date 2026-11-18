import {activeBidCache} from '../runtime-324/bid-cache-compiler.mjs';

function packageState(input) {
  if(input.options.enablePrebid!==true)return 'Off. This package is GAM-only.';
  const cache=activeBidCache(input);
  if(!cache)return 'Off. Every Prebid auction in this package uses fresh bids only.';
  const on=cache.positions.filter(([,enabled])=>enabled).map(([code])=>code);
  const off=cache.positions.filter(([,enabled])=>!enabled).map(([code])=>code);
  return `On for ${on.join(', ')}, with a maximum bid age of ${cache.maxAgeSeconds} seconds.`+
    (off.length?` Off for ${off.join(', ')}.`:'')+' Every other position uses fresh bids only.';
}

export function bidCacheReadme(input) {
  const cache=input.options.enablePrebid===true?activeBidCache(input):null;
  const skipped=input.bidCacheExclusions.map(({code,enabled})=>`${code} (${enabled?'on':'off'})`);
  return '\nBid caching in 3.25.1\nThis package: '+packageState(input)+'\n'+
    (skipped.length?'Saved settings not applied in this package: '+skipped.join(', ')+'.\n':'')+
    'Every refresh still runs a new Prebid auction. Eligible valid bids never previously sent to GAM may compete with fresh bids for the same Banner position. TakeOver, Outstream and unsupported formats use fresh bids only. Current consent, exact bidder-account admission, account rules, sizes, native floors, TTL and used-bid checks remain enforced.\n'+
    (cache?'Diagnostics: window.__tesseraBidCache.snapshot(). Filter decisions remain attached to the bounded tracked-bid history when the separate diagnostic map resets. A bid that becomes ineligible after filtering causes a bounded targeting retry; stale cached allow-list entries are removed before every retry. Replaced or ignored filters retain fresh-only fallback.\n'+
      'Cached deals: this page has no authoritative live SSP/GAM deal-end feed. A returned deal can remain a cache candidate until its original bid TTL or the configured maximum age, whichever is shorter, subject to all current eligibility checks. TTL does not prove that the commercial deal remains active; a newly returned deal from that bidder suppresses its older bids. Use Bid cache Off for positions whose deal terms require authoritative live expiry.\n':'')+
    'Reporting: fresh_auction describes the request path; it can include an admitted cached primary. aq_bid_origin identifies the primary bid offered to GAM, not the winner, rendered impression or paid revenue. Other cached bidder-specific bids can also be present. Package generation never changes GAM settings or a publisher deployment.\n';
}

export function bidCacheHtmlNote(input) {
  const cache=input.options.enablePrebid===true?activeBidCache(input):null;
  return cache?'<!-- Valid unused bids compete with a new auction; see README.txt for this package\'s enabled positions. -->':
    '<!-- Bid caching is off in this package. -->';
}
