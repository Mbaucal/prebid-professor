import {savedScriptNeeds, scriptGuidance} from './script-version-guidance.mjs';
export {savedBidderAccounts, bidderAccountsForBuild} from '../../shared/bidder-accounts/snapshot.mjs';
/** Active accounts with an alias or their own SChain need a script with bidder accounts. The reason names the
 * versions that also apply the other saved options (bidder rules, bid caching). */
export function requireBidderAccounts(snapshot, descriptor) {
  const needs = savedScriptNeeds(snapshot);
  if (needs.accounts.length && !descriptor?.capabilities?.includes('bidder-accounts')) {
    throw Object.assign(new Error(scriptGuidance(needs, descriptor)), {status: 422});
  }
}
