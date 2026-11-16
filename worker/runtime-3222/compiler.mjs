import {parse} from 'acorn';
import {compileRuntime3221} from '../runtime-3221/compiler.mjs';
import {once} from '../runtime-3161/compiler.mjs';
export {idempotentStickyStyles} from '../runtime-3221/compiler.mjs';

/** Claim one initial lazy path even when observer delivery order reverses. */
export function compileRuntime3222(input) {
  const previous = compileRuntime3221(input);
  let source = once(previous.adsJs,
    'if (!id || prefetched[id]) return;',
    'if (!id || prefetched[id] || displayed[id]) return;');
  source = once(source, 'if (!prefetched[id]){',
    'if (!prefetched[id]){\n          prefetched[id] = true;\n          prefetchIO.unobserve(el);');
  source = once(source, 'if (_auctionLock[c]) continue;',
    'if (displayed[c] || _auctionLock[c]) continue;');
  parse(source, {ecmaVersion:2015});
  return {...previous, adsJs:source, adsMinJs:source, patches:[...previous.patches,
    '3.22.2: initial lazy display claims the prefetch path; late observer callbacks cannot start an unused second auction']};
}
