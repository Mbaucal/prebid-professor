import {previewInput as previousInput} from '../runtime-3161/snapshot.mjs';

/** Explicit patch release: 3.16.2 reads exactly the 3.16.1 compiler input. */
export function previewInput(snapshot, descriptor, timestamp, takeOver) {
  return previousInput(snapshot, descriptor, timestamp, takeOver);
}
