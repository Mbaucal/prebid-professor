import {parse} from 'acorn';
import {compileRuntime3251} from '../runtime-3251/compiler.mjs';
import {once} from '../runtime-3161/compiler.mjs';
import {browserSources} from '../../.generated/runtime-326-browser-source.mjs';
export {idempotentStickyStyles} from '../runtime-3251/compiler.mjs';
export function compileRuntime326(input) {
  const previous=compileRuntime3251(input);
  let source=once(previous.adsJs,'function createTesseraReadiness(win, options) {',browserSources.createAdaptiveAuctionTimeout+'\nfunction createTesseraReadiness(win, options) {');
  source=once(source,'  var _tesseraReady=createTesseraReadiness(window,{\n','  var _adaptiveAuctionTimeout=createAdaptiveAuctionTimeout(window,'+JSON.stringify(input.adaptiveAuctionTimeout)+');\n  window.__AD_AUCTION_TIMEOUT=_adaptiveAuctionTimeout;\n  var _tesseraReady=createTesseraReadiness(window,{\n    auctionTimeout:_adaptiveAuctionTimeout,\n');
  source=once(source,'    whenConsent(function(){\n      var epoch = consent.epoch, settled = false, timer = null, started = false;',
    '    whenConsent(function(){\n      var timeoutRecord=options.auctionTimeout.resolve(input);\n      input=Object.assign({},input,{timeout:timeoutRecord.timeoutMs});\n      var epoch = consent.epoch, settled = false, timer = null, started = false;');
  source=once(source,"timer = win.setTimeout(function(){finish(null,null,null,'auction-deadline');}, Math.max(100,Number(input.timeout)||1000) + 500);",
    "timer = win.setTimeout(function(){finish(null,null,null,'auction-deadline');}, options.auctionTimeout.started(timeoutRecord,event).failsafeMs);");
  parse(source,{ecmaVersion:2015});
  return {...previous,adsJs:source,adsMinJs:source,patches:[...previous.patches,'3.26.0: optional bounded local per-auction timeout; matching native auctionInit timeout owns the outer watchdog, including RTD overrides']};
}
