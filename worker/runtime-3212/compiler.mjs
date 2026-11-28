import {parse} from 'acorn';
import {compileRuntime3211} from '../runtime-3211/compiler.mjs';
import {applyBootAtLoad} from './boot-compiler.mjs';
export {idempotentStickyStyles} from '../runtime-3211/compiler.mjs';

/** Patch only newly generated 3.21.2 output; 3.21.1 and older sources stay sealed. */
export function compileRuntime3212(input) {
  const previous = compileRuntime3211(input);
  const source = applyBootAtLoad(previous.adsJs, input);
  parse(source, {ecmaVersion: 2015});
  return {...previous, adsJs: source, adsMinJs: source, patches: [...previous.patches,
    '3.21.2: a TakeOver interval no longer delays the page boot; slots, keyword-conditioned unit rules and page key-values are set at load, and container discovery (pages without content containers at load) and the country pass run, as in 3.21.0; on pages where the TakeOver can show, only the TakeOver cap, the codeless guard, GPT services, slot display and the initial start wait for the current CMP decision',
    '3.21.2: on pages where the TakeOver can show, TakeOver reports waiting-consent (TAKEOVER_ACTIVE_FOR_PAGE null) until the decision']};
}
