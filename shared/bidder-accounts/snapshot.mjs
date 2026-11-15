import {normalizeBidderAccount, normalizeBidderAccounts} from './settings.mjs';
export function savedBidderAccounts(snapshot, {activeOnly = false} = {}) {
  return normalizeBidderAccounts((snapshot.bidders ?? []).filter(row => !activeOnly || row.enabled === 1).map(row => {
    let metadata;
    try { metadata = JSON.parse(row.account_json ?? '{}'); }
    catch { throw new Error(`Bidder ${row.bidder}: account settings contain invalid JSON. Reload and save this account before generating.`); }
    return normalizeBidderAccount(metadata, {bidder: row.bidder});
  }));
}
export function bidderAccountsForBuild(snapshot) {
  if (JSON.parse(snapshot.config.config_json).enablePrebid !== true) return [];
  return savedBidderAccounts(snapshot, {activeOnly: true});
}
