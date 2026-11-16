import {parse} from 'acorn';
import {compileRuntime321} from '../runtime-321/compiler.mjs';
import {once} from '../runtime-3161/compiler.mjs';
import {browserSources} from '../../.generated/runtime-322-browser-source.mjs';
export {idempotentStickyStyles} from '../runtime-321/compiler.mjs';
const literal = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** New immutable version; all earlier source and request ordering is retained. */
export function compileRuntime322(input) {
  const previous = compileRuntime321(input);
  const settings = input.bidderRules || {schemaVersion:1, enabled:false, rules:[]};
  let source = once(previous.adsJs, '  var _tesseraReady=createTesseraReadiness(window,{', `${browserSources.createBidderRules}
  var _adBidderRules=createBidderRules(window,${literal(settings)},{
    evaluate:(${browserSources.evaluateBidderRule}),normalizeCountry:(${browserSources.normalizeCountry}),request:_adContext.request
  });
  var _tesseraReady=createTesseraReadiness(window,{`);
  source = once(source, 'rawRequest:_adContext.request,rawDispatch:_adContext.dispatch', 'rawRequest:_adBidderRules.request,rawDispatch:_adContext.dispatch');
  source = once(source, '    _adContext.configurePrebid(pbjs);', '    _adContext.configurePrebid(pbjs);\n    _adBidderRules.configurePrebid(pbjs);');
  parse(source, {ecmaVersion:2015});
  return {...previous, adsJs:source, adsMinJs:source, patches:[...previous.patches,
    '3.22.0: optional exact bidder and position eligibility by country and current viewport layout at each natural auction',
    '3.22.0: native request filtering follows responsive Outstream resolution; empty demand keeps consent-gated GAM fallback and current-auction targeting checks']};
}
