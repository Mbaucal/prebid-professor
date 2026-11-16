import {previewInput as previousInput} from '../runtime-319/snapshot.mjs';
import {encodeSnapshot,decodeValue,rememberInput} from './identity.mjs';
import {conditionalPlaceholders} from './styles.mjs';
export function previewInput(snapshot,descriptor,timestamp,takeOver={enabled:false},countryTarget='main') {
  const identity=encodeSnapshot(snapshot,takeOver);
  let safeInput;
  try {safeInput=previousInput(identity.snapshot,descriptor,timestamp,identity.takeOver,countryTarget);}
  catch(error){for(const [alias,code]of identity.reverse)error.message=error.message.split(alias).join(code);throw error;}
  const input=decodeValue(safeInput,identity.reverse);
  input.conditionalCss=conditionalPlaceholders(input);
  return rememberInput(input,safeInput,identity);
}
