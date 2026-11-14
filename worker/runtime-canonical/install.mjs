/** Canonical source text for functions that compilers embed in generated code.
 * Imported first by every Worker entry; see ./functions.mjs for why.
 * Only toString changes: the functions still run unchanged in the Worker.
 */
import {canonicalSources} from '../../.generated/browser-canonical-source.mjs';
import {runtimeFunctions} from './functions.mjs';
import * as nextBrowser from '../runtime-next/browser-functions.mjs';
import * as storage3211 from '../runtime-3211/browser-storage.mjs';
import * as geoCountry from '../../shared/geo-country.mjs';

const stale = 'Run scripts/prepare-builtin-runtime.mjs before building the Worker.';

/** Fails at module load when a listed function or its prepared text is missing. */
export function installCanonicalText(listed, modules) {
  const paths = Object.keys(listed);
  if (paths.join('\n') !== Object.keys(modules).join('\n')) throw Error('Canonical browser text: the imported modules differ from the listed modules.');
  for (const path of paths) {
    const names = listed[path], texts = canonicalSources[path], namespace = modules[path];
    if (!texts || Object.keys(texts).join('\n') !== names.join('\n')) throw Error(`Canonical browser text for ${path} is missing or stale. ${stale}`);
    for (const name of names) {
      const fn = namespace[name], text = texts[name];
      if (typeof fn !== 'function') throw Error(`${path} no longer exports function ${name}, which generated code embeds.`);
      if (typeof text !== 'string') throw Error(`Canonical browser text for ${path} ${name} is missing. ${stale}`);
      if (Object.hasOwn(fn, 'toString')) throw Error(`${path} ${name} is listed twice or already has its own toString.`);
      Object.defineProperty(fn, 'toString', {value: function toString() { return text; }, enumerable: false, writable: false, configurable: false});
    }
  }
}

installCanonicalText(runtimeFunctions, {
  'worker/runtime-next/browser-functions.mjs': nextBrowser,
  'worker/runtime-3211/browser-storage.mjs': storage3211,
  'shared/geo-country.mjs': geoCountry,
});
