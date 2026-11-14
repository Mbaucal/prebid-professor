import {parse} from 'acorn';
import {compileReadiness} from '../runtime-readiness-v1/compiler.mjs';
import {browserSources} from '../../.generated/runtime-revenue-browser-source.mjs';

function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Revenue runtime insertion point changed: ' + before);
  return source.replace(before, () => after);
}
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');

/** New opt-in source layer; the recorded readiness and demand engines are untouched. */
export function compileRevenue(input) {
  const result = compileReadiness(input);
  if (!input.options.enablePrebid) return result;
  const deals = input.deals;
  const outstream = input.outstream;
  let source = once(result.adsJs, 'enableSendAllBids: false,',
    'enableSendAllBids: true,' + (outstream?.cacheUrl ? '\n        cache: {url: ' + json(outstream.cacheUrl) + '},' : ''));
  const helpers = [
    'var TESSERA_DEALS=' + json(deals) + ';',
    'var TESSERA_OUTSTREAM=' + json(outstream) + ';',
    browserSources.applyDealParams,
    browserSources.applyOutstreamUnit,
    browserSources.installOutstreamRenderGuard,
  ].join('\n');
  source = once(source, 'function adUnitFromCode(code){', helpers + '\nfunction adUnitFromCode(code){');
  source = once(source, '    return unit;\n  }\n\nfunction applyHbVerTargetingForSlots',
    '    unit=applyDealParams(unit,TESSERA_DEALS,Date.now());\n' +
    '    return applyOutstreamUnit(unit,TESSERA_OUTSTREAM.units[code]);\n  }\n\nfunction applyHbVerTargetingForSlots');
  // No guessed player events: pilot video positions never enter auto refresh.
  source = once(source, 'function getAdUnitRefreshRule(code){',
    'function getAdUnitRefreshRule(code){\n  if(TESSERA_OUTSTREAM.disabledRefreshCodes.indexOf(code)!==-1)return {enabled:false,minSeconds:30,minViewPct:0,requirePreviousViewable:false,checkEveryMs:5000};');
  source = once(source, 'function tryRefresh(id, slot, minGapSec){',
    'function tryRefresh(id, slot, minGapSec){\n  if(TESSERA_OUTSTREAM.disabledRefreshCodes.indexOf(id)!==-1)return;');
  source=once(source,'    _tesseraConfiguredPb=pbjs;',
    `    if(TESSERA_OUTSTREAM.disabledRefreshCodes.length)installOutstreamRenderGuard(pbjs,{
      codes:TESSERA_OUTSTREAM.disabledRefreshCodes,
      consent:function(){return _tesseraReady.snapshot().consent;},
      authorized:function(code,id){
        var slot=(window.adSlots||{})[code];
        if(!slot)return false;
        return slot.getTargetingKeys().some(function(key){
          return /^hb_adid(?:_|$)/.test(key)&&slot.getTargeting(key).map(String).indexOf(String(id))!==-1;
        });
      }
    });
    _tesseraConfiguredPb=pbjs;`);
  parse(source, {ecmaVersion:'latest'});
  return {...result, adsJs:source, adsMinJs:source, patches:[...result.patches,
    'Native Send All Bids with returned deal/adId targeting; configured deal IDs never become targeting values',
    'Explicit PubMatic outstream settings; only native selected-creative rendering; video pilot auto refresh disabled']};
}
