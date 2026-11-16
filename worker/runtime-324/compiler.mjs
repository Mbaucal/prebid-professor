import {parse} from 'acorn';
import {compileRuntime3222} from '../runtime-3222/compiler.mjs';
import {bidCacheWarnings} from '../runtime-323/compiler.mjs';
import {activeBidCache, applyBidCache} from './bid-cache-compiler.mjs';
import {browserSources} from '../../.generated/runtime-324-browser-source.mjs';
import {once} from '../runtime-3161/compiler.mjs';
export {idempotentStickyStyles} from '../runtime-3222/compiler.mjs';

/** Replace a canonical generated helper, never serialize bundled functions. */
function replaceHelper(source, name) {
  const matches=[];
  (function walk(node){
    if(!node||typeof node!=='object')return;
    if(node.type==='FunctionDeclaration'&&node.id?.name===name)matches.push(node);
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);
  })(parse(source,{ecmaVersion:2015}));
  if(matches.length!==1||typeof browserSources[name]!=='string')throw Error('3.24.0 expected one canonical helper: '+name);
  const node=matches[0];
  return source.slice(0,node.start)+browserSources[name]+source.slice(node.end);
}

/** Audited 3.22.2 + exact-account/current-eligibility-aware bid reuse. */
export function compileRuntime324(input) {
  const previous=compileRuntime3222(input),active=activeBidCache(input);
  if(!active)return {...previous,warnings:[...previous.warnings,...bidCacheWarnings(input)]};
  let source=replaceHelper(previous.adsJs,'createBidderRules');
  if(source.includes('function createBidderAccounts('))source=replaceHelper(source,'createBidderAccounts');
  source=once(source,'    evaluate:(',"    cachePolicy:'tessera-3.24.0',evaluate:(");
  source=applyBidCache(source,input);
  parse(source,{ecmaVersion:2015});
  return {...previous,adsJs:source,adsMinJs:source,
    warnings:[...previous.warnings,...bidCacheWarnings(input)],
    patches:[...previous.patches,
      '3.24.0: bidder accounts, per-account SChain, bidder rules and bid caching share one policy on the audited lazy/consent/TakeOver base',
      '3.24.0: reuse requires exact current native-request admission and live bidder/account eligibility on every targeting read, plus unexpired current-size unsent Banner bids in the same consent epoch and current native floors; fresh deals remain preferred',
      '3.24.0: missing or replaced cache hooks fall back to fresh-only; TakeOver and Outstream never reuse cached bids']};
}
