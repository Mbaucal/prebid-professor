import {previewInput as previousInput} from '../runtime-3212/snapshot.mjs';
import {compilationInput} from '../runtime-3191/identity.mjs';
import {bidderRulesInput} from '../../shared/bidder-rules/settings.mjs';
import {bidderAccountsForBuild} from '../../shared/bidder-accounts/snapshot.mjs';
import {buildAccountDealInput} from '../../shared/bidder-accounts/deals.mjs';

/** Preserve the audited mapper while the new account contract validates deals. */
export function previewInput(snapshot, descriptor, timestamp, takeOver = {enabled:false}, countryTarget = 'main') {
  const copy = structuredClone(snapshot), config = JSON.parse(copy.config.config_json);
  // Frozen deal validation knows only original adapter codes. This version owns
  // alias-aware validation and passes the rest of the snapshot through unchanged.
  if (config.runtimeControls) delete config.runtimeControls.deals;
  copy.config.config_json = JSON.stringify(config);
  const input = previousInput(copy, descriptor, timestamp, takeOver, countryTarget);
  input.bidderRules = bidderRulesInput(snapshot);
  input.bidderAccounts = bidderAccountsForBuild(snapshot);
  input.deals = buildAccountDealInput(snapshot);
  // The audited GAM-code compiler retains an encoded private input. Keep deal
  // positions in that same identity space until it restores exact page codes.
  const {safeInput, identity} = compilationInput(input);
  safeInput.deals = input.deals && {...input.deals, entries: input.deals.entries.map(entry =>
    ({...entry, positions: entry.positions.map(code => identity.forward.get(code) ?? code)}))};
  return input;
}
