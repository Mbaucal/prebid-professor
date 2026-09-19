import { parse } from 'acorn';
import { compileObserved } from '../runtime-observed/compiler.mjs';
import { createMeasurement } from './targeting.mjs';

export function compileMeasured(input, descriptor) {
  const generated = compileObserved(input, descriptor);
  let source = generated.adsJs;
  function insert(marker, after) {
    if (source.split(marker).length !== 2) throw Error('Measurement insertion point changed; source review required.');
    source = source.replace(marker, () => marker + '\n' + after);
  }
  const literal = value => JSON.stringify(value).replace(/</g, '\\u003c');
  // After both entry guards, before any GPT command or slot is created.
  insert('if (window.__TESSERA_RUNTIME_STARTED) return;',
    'var tesseraMeasureSlot=(' + createMeasurement.toString() + ')(' + literal(input.core.siteId) + ',' + literal(descriptor.version) + ');');
  insert('window.adSlots[id] = slot;', 'tesseraMeasureSlot(slot);');
  insert('_takeOverSlot = slot;', 'tesseraMeasureSlot(slot);');
  parse(source, {ecmaVersion:'latest'});
  return {...generated, adsJs:source, adsMinJs:source,
    patches:[...generated.patches, 'owned-slot experiment targeting before first display and refresh']};
}
