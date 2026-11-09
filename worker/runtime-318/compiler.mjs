import {parse} from 'acorn';
import {compileRuntime317} from '../runtime-317/compiler.mjs';
import {countrySource} from '../../.generated/runtime-318-browser-source.mjs';
export {idempotentStickyStyles} from '../runtime-317/compiler.mjs';

export function compileRuntime318(input) {
  const result = compileRuntime317(input);
  const marker = JSON.stringify('__COUNTRY_ENDPOINT__');
  if (countrySource.split(marker).length !== 2) throw Error('Country endpoint insertion point changed.');
  const country = countrySource.replace(marker, JSON.stringify(input.countrySignal.endpoint).replace(/</g, '\\u003c'));
  // An optional metadata lookup cannot prevent the inherited ad startup.
  const source = ';(function(){try{\n' + country + '\n}catch(ignored){}})();\n' + result.adsJs;
  parse(source, {ecmaVersion:2015});
  return {...result, adsJs:source, adsMinJs:source, patches:[...result.patches,
    '3.18.0: one background country lookup per document, shared through window.__AD_GEO; no ad or consent decisions']};
}
