import {parse} from 'acorn';
import {compileRuntime3201} from '../runtime-3201/compiler.mjs';
import {once} from '../runtime-3161/compiler.mjs';
import {browserSources} from '../../.generated/runtime-321-browser-source.mjs';
export {idempotentStickyStyles} from '../runtime-3201/compiler.mjs';
const literal = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function rawHooks(source) {
  const ast = parse(source, {ecmaVersion: 2015}), matches = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.id?.name === '_tesseraReady' && node.init?.callee?.name === 'createTesseraReadiness') matches.push(node.init.arguments[1]);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  if (matches.length !== 1 || matches[0]?.type !== 'ObjectExpression') throw Error('3.21.0 readiness hook boundary changed');
  const result = {};
  for (const key of ['rawRequest', 'rawDispatch']) {
    const properties = matches[0].properties.filter(property => property.key?.name === key);
    if (properties.length !== 1) throw Error('3.21.0 readiness hook changed: ' + key);
    result[key] = properties[0].value;
  }
  return result;
}

export function contextualCompletionHook(source) {
  return once(source, '        if (input.bidsBackHandler) input.bidsBackHandler(completed ? bids : undefined, completed ? timedOut : undefined, completed ? id : undefined);',
    '        if(options.contextFinished)options.contextFinished(codes,auctionId);\n        if (input.bidsBackHandler) input.bidsBackHandler(completed ? bids : undefined, completed ? timedOut : undefined, completed ? id : undefined);');
}

/** New opt-in source version. The previously sealed source chain is unchanged. */
export function compileRuntime321(input) {
  const previous = compileRuntime3201(input);
  const settings = input.contextualSignals || {schemaVersion: 1, enabled: false, sourceKey: 'category', gam: {enabled: false}, bidders: [], mappings: [], providerName: ''};
  let source = previous.adsJs;
  // Later compilers wrap these callbacks for responsive outstream. Preserve
  // their complete final expressions rather than bypassing those callbacks.
  const hooks = rawHooks(source);
  const request = source.slice(hooks.rawRequest.start, hooks.rawRequest.end);
  const dispatch = source.slice(hooks.rawDispatch.start, hooks.rawDispatch.end);
  Object.entries(hooks).sort((a, b) => b[1].start - a[1].start).forEach(([key, node]) => {
    source = source.slice(0, node.start) + (key === 'rawRequest' ? '_adContext.request' : '_adContext.dispatch') + source.slice(node.end);
  });
  source = once(source, '  var _tesseraReady=createTesseraReadiness(window,{', `${browserSources.createContextualSignals}
  var _adContext=createContextualSignals(window,${literal(settings)},{
    request:${request},dispatch:${dispatch},
    code:function(slot){return slot===_takeOverSlot&&TESSERA_OVERLAY?TESSERA_OVERLAY.code:slot.getSlotElementId();}
  });
  var _tesseraReady=createTesseraReadiness(window,{
    contextFinished:_adContext.finished,`);
  source = contextualCompletionHook(source);
  // Interstitial fallback deliberately dispatches synchronously inside its
  // existing one-shot permission and consent gate, outside rawDispatch.
  source = once(source, 'try { _gamReporting.dispatch(pa,[guard]); }', 'try { _adContext.dispatch(pa,[guard]); }');
  source = once(source, '    _tesseraConfiguredPb=pbjs;', '    _adContext.configurePrebid(pbjs);\n    _tesseraConfiguredPb=pbjs;');
  parse(source, {ecmaVersion: 2015});
  return {...previous, adsJs: source, adsMinJs: source, patches: [...previous.patches,
    '3.21.0: optional explicit per-taxonomy contextual mapping; GAM Content 2.2 PPS and auction-scoped bidder routing through contextualSignals RTD',
    '3.21.0: snapshots align delayed/concurrent Prebid auctions and GAM requests; unknown categories and unavailable optional provider do not block ads']};
}
