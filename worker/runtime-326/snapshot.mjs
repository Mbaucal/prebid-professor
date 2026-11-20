import {previewInput as previousInput} from '../runtime-3251/snapshot.mjs';
import {normalizeAdaptiveTimeout} from '../../shared/auction-timeout/settings.mjs';
export function previewInput(snapshot,descriptor,time,takeOver,countryTarget='main') {
  const input=previousInput(snapshot,descriptor,time,takeOver,countryTarget);
  input.adaptiveAuctionTimeout=normalizeAdaptiveTimeout(JSON.parse(snapshot.config.config_json).adaptiveAuctionTimeout);
  return input;
}
