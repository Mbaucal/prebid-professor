import {previewInput as previousInput} from '../runtime-3201/snapshot.mjs';
import {contextualSignalsInput} from '../../shared/contextual-signals/settings.mjs';

/** Resolve only saved mappings; generation never requires a publisher page value. */
export function previewInput(snapshot, descriptor, timestamp, takeOver = {enabled: false}, countryTarget = 'main') {
  const input = previousInput(snapshot, descriptor, timestamp, takeOver, countryTarget);
  input.contextualSignals = contextualSignalsInput(snapshot);
  return input;
}
