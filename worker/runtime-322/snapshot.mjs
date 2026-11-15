import {previewInput as previousInput} from '../runtime-321/snapshot.mjs';
import {bidderRulesInput} from '../../shared/bidder-rules/settings.mjs';

/** Saved rules do not require a visitor country or viewport during generation. */
export function previewInput(snapshot, descriptor, timestamp, takeOver = {enabled:false}, countryTarget = 'main') {
  const input = previousInput(snapshot, descriptor, timestamp, takeOver, countryTarget);
  input.bidderRules = bidderRulesInput(snapshot);
  return input;
}
