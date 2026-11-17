export const requestReportingContract = {
  keys: {
    aq_bid_origin: {scope:'slot', values:['fresh','cached','none'],
      meaning:'Origin of the actual primary unsuffixed hb_adid sent in this GAM request, matched to exact alias, slot and owned current-auction/cache admission. Omitted for inactive Prebid, unknown or ambiguous identity. none means a configured active Prebid slot has a valid empty primary targeting result, including a clean fallback before an auction completes; it does not mean GAM no-fill.'},
    aq_first_request: {scope:'page', values:['lt_500','500_999','1000_1499','1500_1999','2000_2999','3000_plus'],
      meaning:'Milliseconds from document navigation to the first actual owned GAM dispatch. Set before the call and retained for later requests in this document. A new document starts a new measurement.'},
    aq_consent_wait: {scope:'page', values:['lt_500','500_999','1000_1499','1500_1999','2000_2999','3000_plus','na','timeout'],
      meaning:'Milliseconds from first entry into the existing CMP serving gate to the current completed decision enabling the first owned GAM request. Already-ready decisions measure immediately. timeout means this actual waiting interval reached the effective configured CMP budget, even though ads still waited for the real decision. The first actual request uses the maximum positive cmpTimeout of its owned logical positions, or the retained site/default CMP budget when no position supplies one. na is reserved for a genuinely ungated path.'},
  },
  limitations:[
    'These labels describe requests and targeting, not rendered impressions, the demand GAM selected, paid revenue, page RPM or consent permission.',
    'The origin label requires configured Prebid demand for that logical position and current media sizes. A globally enabled Prebid setting alone does not label fluid-only GAM inventory or positions without bidder parameters as Prebid demand.',
    'timeout is an observational reporting value, never an instruction to release GAM. Pending/unknown decisions keep waiting after the configured budget; a late valid decision can send a request labeled timeout. Slow Prebid, GEO or GPT after an already-ready CMP decision does not extend CMP waiting.',
    'Current 3.25 enters the existing CMP gate on all owned request paths, including GAM-only. na is reserved for a genuinely ungated path and is not emitted by those current paths.',
    'The inherited strict TCF gate also applies to GAM-only. Missing, loading or unknown-scope CMP states never release an ad request. Prebid library/auction deadlines are not CMP deadlines.',
    'Create the three custom targeting keys and their predefined values in GAM and enable reporting before the next pilot. This package never edits a GAM account.',
  ],
};
