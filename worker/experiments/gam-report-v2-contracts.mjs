/** Detailed normalized GAM reports. These declarations never enable collection or paid GAM features. */
export const GAM_REPORT_V2_KIND='tessera-gam-report-plan-v2';
export const GAM_REPORT_V2_CSV_LIMIT=1024*1024;
export const GAM_REPORT_V2_MAX_ROWS=10000;
export const GAM_REPORT_V2_BREAKDOWN_LIMIT=50;
export const GAM_REPORT_V2_BASE_COLUMNS=Object.freeze(['date','VersionId','Variant']);
export const GAM_REPORT_V2_PURPOSES=Object.freeze([
  {key:'overall',label:'Overall A/B result'},
  {key:'prebid',label:'Prebid delivery'},
  {key:'refresh',label:'Ad refresh'},
  {key:'startup',label:'First request and CMP'},
  {key:'inventory',label:'Inventory and requests'},
]);
export const GAM_REPORT_V2_DIMENSIONS=Object.freeze([
  {key:'adUnit',label:'Ad unit'},
  {key:'deviceCategory',label:'Device category'},
  {key:'country',label:'Country'},
  {key:'requestedAdSizes',label:'Requested ad sizes'},
  {key:'creativeSize',label:'Creative size'},
  {key:'orderId',label:'Order ID'},
  {key:'lineItemId',label:'Line item ID'},
  {key:'creativeId',label:'Creative ID'},
  {key:'hb_bidder',label:'Prebid bidder',help:'Targeted bidder; not proof of the serving bidder.'},
  {key:'hb_pb',label:'Prebid price bucket'},
  {key:'hb_size',label:'Prebid size'},
  {key:'aq_bid_origin',label:'Primary bid origin',values:['fresh','cached','none'],help:'Primary bid targeted in the request; not the GAM winner.'},
  {key:'refresh_count',label:'Refresh request count'},
  {key:'refresh_bucket',label:'Refresh group',values:['initial','r1_3','r4_plus']},
  {key:'refresh_interval',label:'Selected refresh interval'},
  {key:'refresh_policy',label:'Refresh path',values:['initial','fresh_auction','gam_only','prebid_fallback']},
  {key:'aq_first_request',label:'First GAM request bucket',values:['lt_500','500_999','1000_1499','1500_1999','2000_2999','3000_plus']},
  {key:'aq_consent_wait',label:'CMP wait bucket',values:['lt_500','500_999','1000_1499','1500_1999','2000_2999','3000_plus','na','timeout']},
  {key:'aq_bidder_count',label:'Positive bidders in completed auction'},
  {key:'aq_bid_count',label:'Positive bids in completed auction'},
  {key:'aq_timed_out',label:'Auction callback timeout',values:['yes','no']},
]);
export const GAM_REPORT_V2_METRICS=Object.freeze([
  {key:'impressions',label:'Impressions'},
  {key:'revenue',label:'Revenue'},
  {key:'clicks',label:'Clicks'},
  {key:'adRequests',label:'Ad requests'},
  {key:'responsesServed',label:'Responses served',help:'Matching code-served count, not rendered impressions.'},
  {key:'unfilledImpressions',label:'Unfilled impressions'},
  {key:'eligibleImpressions',label:'Active View eligible impressions'},
  {key:'measurableImpressions',label:'Active View measurable impressions'},
  {key:'viewableImpressions',label:'Active View viewable impressions'},
]);
/** A plan fixes both the selected grain and every exact source column name. */
export function gamReportV2Columns(report){return [...GAM_REPORT_V2_BASE_COLUMNS,...report.dimensions,...report.metrics];}
