import {parse} from 'acorn';
import {compileReadiness} from '../runtime-readiness-v1/compiler.mjs';
import {browserSources} from '../../.generated/runtime-316-browser-source.mjs';

function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Tessera 3.16.0 runtime insertion point changed: ' + before);
  return source.replace(before, () => after);
}
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');

/** Tessera 3.16.0 compiler. Historical engines remain independently pinned. */
export function compileRuntime316(input) {
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
    browserSources.outstreamPlayerSize,
    browserSources.applyOutstreamUnit,
    browserSources.installOutstreamRenderGuard,
  ].join('\n');
  source = once(source, 'function adUnitFromCode(code){', helpers + '\nfunction adUnitFromCode(code){');
  source = once(source, '    return unit;\n  }\n\nfunction applyHbVerTargetingForSlots',
    '    unit=applyDealParams(unit,TESSERA_DEALS,Date.now());\n' +
    '    return applyOutstreamUnit(unit,TESSERA_OUTSTREAM.units[code],cfg.sizeMapName);\n  }\n\nfunction applyHbVerTargetingForSlots');
  // No guessed player events: pilot video positions never enter auto refresh.
  source = once(source, 'function getAdUnitRefreshRule(code){',
    'function getAdUnitRefreshRule(code){\n  if(TESSERA_OUTSTREAM.disabledRefreshCodes.indexOf(code)!==-1)return {enabled:false,minSeconds:30,minViewPct:0,requirePreviousViewable:false,checkEveryMs:5000};');
  source = once(source, 'function tryRefresh(id, slot, minGapSec){',
    'function tryRefresh(id, slot, minGapSec){\n  if(TESSERA_OUTSTREAM.disabledRefreshCodes.indexOf(id)!==-1)return;');
  // Re-resolve only responsive positions immediately after consent/Prebid readiness,
  // not when a lazy fetch was scheduled or before a delayed CMP decision.
  source=once(source,'rawRequest:_gamReporting.request,rawDispatch:_gamReporting.dispatch',
    `rawRequest:function(pb,request){
      var next=Object.assign({},request);
      next.adUnits=(request.adUnits||[]).map(function(unit){
        var settings=TESSERA_OUTSTREAM.units[unit.code];
        return settings&&settings.playerSizing==='size-map'?adUnitFromCode(unit.code):unit;
      }).filter(Boolean);
      if(!next.adUnits.length){if(next.bidsBackHandler)next.bidsBackHandler({},false,next.auctionId);return;}
      return _gamReporting.request(pb,next);
    },rawDispatch:function(service,slots,options){
      var active=(slots||[]).filter(function(slot){
        var code=slot.getSlotElementId(),settings=TESSERA_OUTSTREAM.units[code];
        if(!settings||settings.playerSizing!=='size-map')return true;
        var cfg=getUnitConfigById(code);
        return !!outstreamPlayerSize(settings,cfg&&cfg.sizeMapName);
      });
      if(active.length)return _gamReporting.dispatch(service,active,options);
    }`);
  source=once(source,'    _tesseraConfiguredPb=pbjs;',
    `    if(TESSERA_OUTSTREAM.disabledRefreshCodes.length)installOutstreamRenderGuard(pbjs,{
      codes:TESSERA_OUTSTREAM.disabledRefreshCodes,
      consent:function(){return _tesseraReady.snapshot().consent;},
      sizeMatches:function(code,size){
        var settings=TESSERA_OUTSTREAM.units[code];
        if(!settings||settings.playerSizing!=='size-map')return true;
        var cfg=getUnitConfigById(code),current=outstreamPlayerSize(settings,cfg&&cfg.sizeMapName);
        return !!current&&current[0]===size[0]&&current[1]===size[1];
      },
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
    'Responsive PubMatic outstream size-map choices resolved at auction dispatch; changed-size pending render blocked; banner maps preserved; auto refresh disabled']};
}
