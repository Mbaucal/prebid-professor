/** Mutable TEST planner: retain the demand preview while adding account-aware modules. */
import {prebidRequirements as demandRequirements, moduleReason} from '../runtime-demand-v1/requirements.mjs';
import {prebidRequirements as accountRequirements} from '../runtime/prebid-artifact-check-v2.mjs';
export {moduleReason};
export function prebidRequirements(input, config = {}) {
  if (!input?.bidderAccounts) return demandRequirements(input, config);
  const result = accountRequirements(input, config);
  if (!result.required || !input.demandSignals) return result;
  return {...result, modules: [...new Set([...result.modules, 'gptPreAuction'])].sort()};
}
