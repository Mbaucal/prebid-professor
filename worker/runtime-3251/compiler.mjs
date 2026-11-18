import {parse} from 'acorn';
import {compileRuntime325} from '../runtime-325/compiler.mjs';
import {activeBidCache} from '../runtime-324/bid-cache-compiler.mjs';
import {browserSources} from '../../.generated/runtime-3251-browser-source.mjs';
import {once} from '../runtime-3161/compiler.mjs';
export {idempotentStickyStyles} from '../runtime-325/compiler.mjs';

/** Keep the reporting program and replace only its active cache policy. */
export function compileRuntime3251(input) {
  const previous=compileRuntime325(input);
  if(!activeBidCache(input))return previous;
  const matches=[];
  (function walk(node){
    if(!node||typeof node!=='object')return;
    if(node.type==='FunctionDeclaration'&&node.id?.name==='createTesseraBidCache')matches.push(node);
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);
  })(parse(previous.adsJs,{ecmaVersion:2015}));
  if(matches.length!==1||typeof browserSources.createTesseraBidCache!=='string')throw Error('3.25.1 expected one canonical cache helper.');
  const node=matches[0];
  let source=previous.adsJs.slice(0,node.start)+browserSources.createTesseraBidCache+previous.adsJs.slice(node.end);
  source=once(source,'var TESSERA_BID_CACHE={"version":"3.24.0"','var TESSERA_BID_CACHE={"version":"3.25.1"');
  parse(source,{ecmaVersion:2015});
  return {...previous,adsJs:source,adsMinJs:source,patches:[...previous.patches,
    '3.25.1: native filter evidence survives bounded diagnostic-history resets without admitting never-filtered bids',
    '3.25.1: expired or newly ineligible cache selections retry native targeting with bounded cleanup; genuine filter violations retain fresh-only fallback']};
}
