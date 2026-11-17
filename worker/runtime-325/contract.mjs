export const requestReportingContract = {
  keys: {
    aq_bid_origin: {scope:'slot', values:['fresh','cached','none'],
      meaning:'Origin of the actual primary unsuffixed hb_adid sent in this GAM request, matched to exact alias, slot and owned current-auction/cache admission. Omitted for inactive Prebid, unknown or ambiguous identity. none means confirmed active Prebid completed without a primary bid, not GAM no-fill.'},
    aq_first_request: {scope:'page', values:['lt_500','500_999','1000_1499','1500_1999','2000_2999','3000_plus'],
      meaning:'Milliseconds from document navigation to the first actual owned GAM dispatch. Set before the call and retained for later requests in this document. A new document starts a new measurement.'},
    aq_consent_wait: {scope:'page', values:['lt_500','500_999','1000_1499','1500_1999','2000_2999','3000_plus','na','timeout'],
      meaning:'Milliseconds from first entry into the existing CMP serving gate to the current completed decision enabling the first owned GAM request. Already-ready decisions measure immediately. na is reserved for a genuinely ungated path; timeout requires an applicable existing deadline and never grants serving permission.'},
  },
  limitations:[
    'These labels describe requests and targeting, not rendered impressions, the demand GAM selected, paid revenue, page RPM or consent permission.',
    'Current 3.25 inherits a strict gate with no CMP timeout-release path: pending/unknown decisions never release GAM, late valid decisions report elapsed buckets, and timeout is reserved but not emitted. na is likewise reserved because all current owned request paths enter this gate.',
    'The inherited strict TCF gate also applies to GAM-only. Missing, loading or unknown-scope CMP states never release an ad request. Prebid library/auction deadlines are not CMP deadlines.',
    'Create the three custom targeting keys and their predefined values in GAM and enable reporting before the next pilot. This package never edits a GAM account.',
  ],
};
