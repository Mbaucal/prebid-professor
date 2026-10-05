export const reportingContract = {
  schemaVersion: 1,
  scope: 'slot',
  keys: {
    refresh_count: {values: '0, 1, 2, ...', meaning: 'GPT requests dispatched after the first request for this slot instance; not impressions.'},
    refresh_bucket: {values: ['initial', 'r1_3', 'r4_plus'], meaning: 'First request; refresh 1–3; refresh 4 and later.'},
    refresh_interval: {values: 'initial, unscheduled, or configured minimum interval in seconds', meaning: 'Selected minimum interval for this refresh; not wall-clock time or proof of viewability.'},
    refresh_policy: {values: ['initial', 'fresh_auction', 'gam_only', 'prebid_fallback'], meaning: 'Executed request path, not winning demand. This built-in version starts a fresh auction; it does not implement the separate Tanjug cache policy.'},
    aq_bidder_count: {values: '0, 1, 2, ...', meaning: 'Distinct bidder codes returning positive numeric CPM bids in this completed auction for this slot; not bidders contacted.'},
    aq_bid_count: {values: '0, 1, 2, ...', meaning: 'Unique positive-CPM responses matching this auction ID and ad-unit code; excludes zero/negative/nonfinite, duplicate and old bids.'},
    aq_timed_out: {values: ['yes', 'no'], meaning: 'Prebid callback timedOut: any bidder timed out in the auction. In a batched auction this is auction-wide, not evidence that this individual slot timed out.'}
  },
  limitations: [
    'GAM-only and GAM-only TakeOver/Interstitial do not send aq_* keys. Keys are slot-level only; do not configure aq_* as page-level defaults.',
    'Fallback or malformed/missing auction results omit aq_* rather than invent zero/no. Each result is consumed once; late callbacks cannot label a later request.',
    'Labels do not change auction scheduling, refresh eligibility, consent, floors, request counts or hb_* / Variant targeting.',
    'Positive bids can still lose to GAM/AdX/direct demand. These labels do not measure billable revenue, the winning creative or page RPM.',
    'Create the keys/values in GAM and enable reporting before collecting a report. Use supported custom/enhanced dimensions for comparisons; do not sum overlapping raw key-value rows.',
    'No GAM account configuration or live publisher activation is performed by downloading this package.'
  ],
  references: ['https://docs.prebid.org/dev-docs/publisher-api-reference/requestBids.html', 'https://support.google.com/admanager/answer/14528835?hl=en']
};
