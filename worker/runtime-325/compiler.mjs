import {parse} from 'acorn';
import {compileRuntime324} from '../runtime-324/compiler.mjs';
import {browserSources} from '../../.generated/runtime-325-browser-source.mjs';
import {once} from '../runtime-3161/compiler.mjs';
export {idempotentStickyStyles} from '../runtime-324/compiler.mjs';

function replaceHelper(source, name) {
  const found=[];
  (function walk(node){
    if(!node||typeof node!=='object')return;
    if(node.type==='FunctionDeclaration'&&node.id?.name===name)found.push(node);
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);
  })(parse(source,{ecmaVersion:2015}));
  if(found.length!==1||typeof browserSources[name]!=='string')throw Error('3.25.0 expected one canonical helper: '+name);
  return source.slice(0,found[0].start)+browserSources[name]+source.slice(found[0].end);
}

/** Add reporting only to the audited combined program; serving remains owned by 3.24. */
export function compileRuntime325(input) {
  const previous=compileRuntime324(input);
  let source=replaceHelper(previous.adsJs,'createGamReporting');
  source=once(source,'function createGamReporting(config) {',browserSources.createTesseraRequestMetrics+'\nfunction createGamReporting(config) {');
  source=once(source,'  var _gamReporting=createGamReporting({\n',
    '  var _gamReporting=createGamReporting({\n    readiness:function(code){return _tesseraReady&&_tesseraReady.reporting(code);},\n'+
    '    reportingPrebid:function(code){var unit=HAS_PREBID&&BIDDERS&&BIDDERS.length?adUnitFromCode(code):null;return !!(unit&&Array.isArray(unit.bids)&&unit.bids.length);},\n'+
    '    consentDeadline:function(codes){return getConsentTimeoutForSlots(codes.map(function(code){return {getSlotElementId:function(){return code;}};}));},\n');
  source=once(source,'  var _tesseraReady=createTesseraReadiness(window,{\n',
    '  var _tesseraReady=createTesseraReadiness(window,{\n    requestMetrics:_gamReporting.metrics,\n');
  source=once(source,'  function whenConsent(fn) {\n',
    '  function whenConsent(fn) {\n    try{if(options.requestMetrics)options.requestMetrics.enter(consent.ready,consent.epoch);}catch(_){}\n');
  source=once(source,'    win.setTimeout(function(){if(consent.ready)fn(consent);else waiters.push(fn);},0);',
    '    win.setTimeout(function(){try{if(options.requestMetrics)options.requestMetrics.enter(consent.ready,consent.epoch);}catch(_){}if(consent.ready)fn(consent);else waiters.push(fn);},0);');
  const accepted='    consent = {ready:!!ready, phase:phase, epoch:consent.epoch + (changed ? 1 : 0)};\n';
  source=once(source,accepted,accepted+'    try{if(options.requestMetrics)options.requestMetrics.consent(consent.ready,consent.epoch);}catch(_){}\n');
  const completed="        var completed = started && consent.ready && consent.epoch === epoch && id === auctionId && bids && typeof bids === 'object' && typeof timedOut === 'boolean';\n";
  source=once(source,completed,completed+'        try{if(options.requestMetrics)options.requestMetrics.auction(codes,bids,auctionId,epoch,completed);}catch(_){}\n');
  source=once(source,'          targets[code] = {epoch:consent.epoch, values:values, allowed:allowed, hadBids:Object.keys(allowed).length > 0};',
    '          targets[code] = {epoch:consent.epoch, auctionId:completed?auctionId:null, completed:!!completed, values:values, allowed:allowed, hadBids:Object.keys(allowed).length > 0};');
  source=once(source,'    whenConsent:whenConsent, prebid:prebid, request:request, targeting:targeting,',
    '    whenConsent:whenConsent, prebid:prebid, request:request, targeting:targeting,\n'+
    '    reporting:function(code){var record=targets[code];return consent.ready&&record&&record.epoch===consent.epoch?record:null;},');
  source=once(source,"    if(k==='geo_country')return;",
    "    if(k==='geo_country'||k==='aq_bid_origin'||k==='aq_first_request'||k==='aq_consent_wait')return;");
  parse(source,{ecmaVersion:2015});
  return {...previous,adsJs:source,adsMinJs:source,patches:[...previous.patches,
    '3.25.0: per-request primary-bid origin uses exact applied identity and current owned readiness/cache admission; unknown or inactive demand omits the key',
    '3.25.0: document first-request and CMP-gate timings are fixed at the first successful owned GAM dispatch; reporting never releases consent or changes auction/request scheduling',
    '3.25.0: reporting keys are reserved from publisher keywords; per-slot stale origin and page-key overrides are cleared immediately before every owned GAM request']};
}
