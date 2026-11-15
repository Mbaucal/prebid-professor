import {savedBidderAccounts} from '../../shared/bidder-accounts/snapshot.mjs';
export {savedBidderAccounts, bidderAccountsForBuild} from '../../shared/bidder-accounts/snapshot.mjs';
export function requireBidderAccounts(snapshot, descriptor) {
  const config = JSON.parse(snapshot.config.config_json);
  if (config.enablePrebid !== true) return;
  const changed = savedBidderAccounts(snapshot, {activeOnly: true}).filter(account => account.bidder !== account.baseAdapter || account.schain.mode !== 'inherit');
  if (changed.length && !descriptor?.capabilities?.includes('bidder-accounts')) {
    throw new Error(`Bidder accounts ${changed.map(account => account.bidder).join(', ')} require script 3.22.1. Select that script explicitly in Script setup before generating; saved settings and previous packages are unchanged.`);
  }
}
