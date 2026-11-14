/** Pilot capabilities, verified against the pinned Prebid 11.34.0 adapter source.
 * This is not a general bidder capability registry or demand activation. */
export const OUTSTREAM_PILOT = Object.freeze({
  adapter: 'pubmatic', prebidVersion: '11.34.0', module: 'pubmaticBidAdapter',
  renderer: 'PubMatic BlueBillywig bid renderer',
  cacheUrl: 'https://prebid.adnxs.com/pbc/v1/cache',
  source: 'https://docs.prebid.org/dev-docs/bidders/pubmatic.html',
});
export const OUTSTREAM_FORMATS = Object.freeze(['banner', 'outstream', 'banner-outstream']);
