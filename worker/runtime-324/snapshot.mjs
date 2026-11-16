import {previewInput as previousInput} from '../runtime-3222/snapshot.mjs';
import {bidCacheInput} from '../runtime-323/snapshot.mjs';
export function previewInput(snapshot, descriptor, timestamp, takeOver = {enabled:false}, countryTarget = 'main') {
  const input = previousInput(snapshot, descriptor, timestamp, takeOver, countryTarget);
  Object.assign(input, bidCacheInput(snapshot, input.options.enablePrebid));
  return input;
}
