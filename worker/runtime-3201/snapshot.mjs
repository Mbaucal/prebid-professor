import {previewInput as viewportInput} from '../runtime-320/snapshot.mjs';
import {encodeSnapshot, decodeValue, rememberInput} from '../runtime-3191/identity.mjs';
import {placeholderStyles} from './styles.mjs';

/** Compile a private identifier-safe copy; public settings retain their exact codes. */
export function previewInput(snapshot, descriptor, timestamp, takeOver = {enabled: false}, countryTarget = 'main') {
  const identity = encodeSnapshot(snapshot, takeOver);
  let safeInput;
  try {
    safeInput = viewportInput(identity.snapshot, descriptor, timestamp, identity.takeOver, countryTarget);
  } catch (error) {
    for (const [alias, code] of identity.reverse) error.message = error.message.split(alias).join(code);
    throw error;
  }
  const input = decodeValue(safeInput, identity.reverse);
  // CSS is rebuilt from public identities using CSS escaping, never raw replacement.
  input.conditionalCss = placeholderStyles(input);
  return rememberInput(input, safeInput, identity);
}
