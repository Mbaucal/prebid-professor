import {reportingContract} from '../runtime-reporting-v1/contract.mjs';

export function demandReportingContract(input) {
  if (!input.options.enablePrebid) return reportingContract;
  const prefixes = ['hb_pb','hb_bidder','hb_size','hb_format','hb_source','hb_deal','hb_adid'];
  const owners = new Map();
  const bidders = input.core.bidders.map(({bidder}) => ({bidder, keys:prefixes.map(prefix => {
    const key = (prefix + '_' + bidder).slice(0,20);
    if (owners.has(key) && owners.get(key) !== bidder) throw Error('Bidder-specific GAM key collision; use distinct shorter bidder aliases.');
    owners.set(key, bidder);
    return {key, purpose:prefix === 'hb_adid' ? 'Creative rendering; do not make this high-cardinality ID a reporting dimension.' : 'Reporting/targeting when present on a valid bid.'};
  })}));
  return {...reportingContract, prebid:{enableSendAllBids:true, alwaysIncludeDeals:true, bidders,
    note:'Standard winner keys remain. Configure supported GAM reporting dimensions for bidder-specific price buckets, bidder, size, format, source and deal. Not all keys occur on every bid. Prices are buckets, not payouts. No-bids/timeouts are not bidder bid records.'},
    gpid:input.demandSignals.placements};
}
