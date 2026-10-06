import {prebidRequirements as legacyRequirements, moduleReason as legacyReason, prebidFailureMessage as legacyFailure} from '../runtime/prebid-artifact-check.mjs';

export function prebidRequirements(input, config = {}) {
  const rubicon = input.demandSignals && input.core.bidders?.some(b => b.bidder === 'rubicon');
  const result = legacyRequirements(rubicon ? {...input,core:{...input.core,bidders:input.core.bidders.filter(b=>b.bidder!=='rubicon')}} : input, config);
  if (!result.required || !input.demandSignals) return result;
  return {...result, modules:[...new Set([...result.modules, 'gptPreAuction', ...(rubicon?['rubiconBidAdapter']:[])])].sort()};
}

export const moduleReason = name => name === 'gptPreAuction' ? 'Stable GPID and GAM slot identity' : legacyReason(name);

export const prebidFailureMessage = report => legacyFailure(report).replace(
  'gptPreAuction (Configured User ID)', 'gptPreAuction (' + moduleReason('gptPreAuction') + ')');
