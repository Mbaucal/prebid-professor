import { parse } from 'acorn';
import { compileCached } from '../runtime-cache/compiler.mjs';
import { createMeasurement as previousMeasurement } from '../runtime-measured/targeting.mjs';
import { createMeasurement } from './targeting.mjs';

// Keep every existing compiler/source closure unchanged. Replace only the
// serialized measurement function in this separately versioned runtime.
export function compileVariant(input, descriptor) {
  const generated = compileCached(input, descriptor);
  const before = previousMeasurement.toString();
  if (generated.adsJs.split(before).length !== 2) throw Error('Measurement insertion point changed; source review required.');
  const source = generated.adsJs.replace(before, () => createMeasurement.toString());
  parse(source, {ecmaVersion:'latest'});
  return {...generated, adsJs:source, adsMinJs:source,
    patches:[...generated.patches, 'public GAM targeting: Variant=A or Variant=B']};
}
