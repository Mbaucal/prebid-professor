import {previewInput as previousInput} from '../runtime-317/snapshot.mjs';

export const COUNTRY_ENDPOINTS = Object.freeze({
  main: 'https://prebid-professor.mbaucal.workers.dev/geo/v1/country',
  test: 'https://prebid-professor-test.mbaucal.workers.dev/geo/v1/country',
});

/** The server selects the deployment target; page data never overrides it. */
export function previewInput(snapshot, descriptor, timestamp, takeOver, countryTarget = 'main') {
  if (!Object.hasOwn(COUNTRY_ENDPOINTS, countryTarget)) throw Error('Unknown country service target.');
  const input = previousInput(snapshot, descriptor, timestamp, takeOver);
  input.countrySignal = {version:1, endpoint:COUNTRY_ENDPOINTS[countryTarget], timeoutMs:1500,
    scope:'document', blocking:false, storage:'memory'};
  return input;
}
