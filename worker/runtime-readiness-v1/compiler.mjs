import {parse} from 'acorn';
import {compileReporting} from '../runtime-reporting-v1/compiler.mjs';
import {browserSources} from '../../.generated/runtime-readiness-browser-source.mjs';

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(item=>walk(item,fn)); else if (value && typeof value==='object') walk(value,fn);
}
function replaceFunction(source, name, replacement) {
  const matches=[]; walk(parse(source,{ecmaVersion:'latest'}),node=>{if(node.type==='FunctionDeclaration'&&node.id?.name===name)matches.push(node);});
  if(matches.length!==1)throw Error('Readiness runtime expected one '+name);
  const n=matches[0];return source.slice(0,n.start)+replacement+source.slice(n.end);
}
function once(source,before,after){if(source.split(before).length!==2)throw Error('Readiness insertion point changed: '+before);return source.replace(before,()=>after);}
export function compileReadiness(input) {
  const result=compileReporting(input);
  let source=result.adsJs;
  source=replaceFunction(source,'resolveConsent',`function resolveConsent(cb){_tesseraReady.whenConsent(function(){cb({src:'TCF:decision-ready'});});}`);
  source=replaceFunction(source,'getTCF','function getTCF(cb){_tesseraReady.whenConsent(function(){cb(null);});}');
  // GPT consumes the actual completed CMP decision itself, including rejection.
  // The wrapper must not map timeout/unknown/rejection to an NPA override.
  const edits=[];
  walk(parse(source,{ecmaVersion:'latest'}),node=>{
    if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&node.callee.property.name==='setPrivacySettings')edits.push({start:node.start,end:node.end,text:'void 0'});
    if(node.type==='VariableDeclarator'&&node.id.name==='failsafe'&&node.init?.type==='CallExpression'&&node.init.callee.name==='setTimeout')edits.push({start:node.init.start,end:node.init.end,text:'null'});
  });
  if(edits.length!==4)throw Error('Expected two privacy overrides and two legacy pre-auction failsafes.');
  for(const e of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,e.start)+e.text+source.slice(e.end);
  source=once(source,'timer=setTimeout(function(){done(false);},timeout+100);','timer=null;');
  if(input.overlay)source=once(source,'state.timer=setTimeout(function(){requestGam(false);},timeout+100);','state.timer=null;');
  // Request readiness now owns the deadline even when the Prebid queue never runs.
  source=once(source,'      pbjs.que.push(function(){\n        if(ready)return;','      (function(){\n        if(ready)return;');
  source=once(source,'try{_gamReporting.request(pbjs,{adUnits:[unit],timeout:timeout,bidsBackHandler:function(){done(true);}});}catch(_){done(false);}\n      });','try{_gamReporting.request(pbjs,{adUnits:[unit],timeout:timeout,bidsBackHandler:function(){done(true);}});}catch(_){done(false);}\n      })();');
  if(input.overlay){
    source=once(source,'  pbjs.que.push(function(){\n    if(state.settled||!alive())return;','  _tesseraReady.prebid(function(){\n    if(state.settled||!alive())return;');
    source=once(source,'    }catch(_){requestGam(false);}\n  });','    }catch(_){requestGam(false);}\n  },function(){requestGam(false);});');
  }
  source=once(source,"  if (!HAS_PREBID || !window.pbjs || typeof pbjs.requestBids !== 'function' ||\n      !BIDDERS || !BIDDERS.length || !adUnits.length){","  if (!HAS_PREBID || !BIDDERS || !BIDDERS.length || !adUnits.length){");
  source=once(source,"      if (!HAS_PREBID || !window.pbjs || typeof pbjs.requestBids !== 'function' ||\n          !BIDDERS || !BIDDERS.length) return;","      if (!HAS_PREBID || !BIDDERS || !BIDDERS.length) return;");
  source=source.replaceAll('_gamReporting.request(pbjs,','_tesseraReady.request(pbjs,').replaceAll('_gamReporting.dispatch(','_tesseraReady.dispatch(');
  source=source.replaceAll('pbjs.getAdserverTargetingForAdUnitCode(code)','_tesseraReady.targeting(code)');
  source=once(source,'function startATF(atfSlots){','function startATFConfigured(atfSlots){');
  const configStart=source.indexOf('      // V1: Registruj video bidder aliase',source.indexOf('function startATFConfigured'));
  const configEnd=source.indexOf('      // GPT SRA + services',configStart);
  if(configStart<0||configEnd<0)throw Error('Prebid configuration boundary changed.');
  const configSource=source.slice(configStart,configEnd);
  const lastCatch=configSource.lastIndexOf('}catch(_){}');
  if(lastCatch<0)throw Error('Prebid configuration error boundary changed.');
  const strictConfig=configSource.slice(0,lastCatch)+'}catch(error){throw error;}'+configSource.slice(lastCatch+'}catch(_){}'.length);
  source=source.slice(0,configStart)+'      configurePrebidReady();\n'+source.slice(configEnd);
  const helpers=`${browserSources.createTesseraReadiness}
  var _tesseraConfiguredPb=null;
  function configurePrebidReady(){
    if(_tesseraConfiguredPb===pbjs)return;
    ${strictConfig}
    _tesseraConfiguredPb=pbjs;
  }
  var _tesseraReady=createTesseraReadiness(window,{
    rawRequest:_gamReporting.request,rawDispatch:_gamReporting.dispatch,configure:configurePrebidReady,
    discard:function(codes){_gamReporting.discard(codes.map(function(code){return TESSERA_OVERLAY&&code===TESSERA_OVERLAY.code?_takeOverSlot:(window.adSlots||{})[code];}).filter(Boolean));},
    clear:clearPrebidTargetingFromSlot,apply:applyTargetingMapToSlot,
    alive:function(slot){return slot===_takeOverSlot||slot===_takeOverCodelessGuardSlot||(window.adSlots||{})[slot.getSlotElementId()]===slot;},
    code:function(slot){return slot===_takeOverSlot&&TESSERA_OVERLAY?TESSERA_OVERLAY.code:slot.getSlotElementId();}
  });
  window.__tesseraReadiness={snapshot:_tesseraReady.snapshot};
  var _tesseraInitialStarted=new WeakSet();
  function startATF(slots){
    var list=(slots||[]).filter(function(slot){if(_tesseraInitialStarted.has(slot))return false;_tesseraInitialStarted.add(slot);return true;});
    if(!list.length)return;
    _tesseraReady.whenConsent(function(){
      if(!HAS_PREBID||!BIDDERS||!BIDDERS.length){startATFConfigured(list);return;}
      _tesseraReady.prebid(function(){startATFConfigured(list);},function(){
        googletag.cmd.push(function(){
          if(!window.__ADS_GPT_SERVICES_ENABLED){try{googletag.pubads().enableSingleRequest();}catch(_){} googletag.enableServices();window.__ADS_GPT_SERVICES_ENABLED=true;}
          _tesseraReady.dispatch(googletag.pubads(),list);
        });
      });
    });
  }
`;
  source=once(source,'  function fetchBidsAndRefresh(slotList){',helpers+'\n  function fetchBidsAndRefresh(slotList){');
  // Avoid identity storage reads before/in place of TCF enforcement; the existing
  // ID5->PPID bridge remains a separate audited feature, disabled in this version.
  source=replaceFunction(source,'setPPIDFromID5','function setPPIDFromID5(){}');
  parse(source,{ecmaVersion:'latest'});
  return {...result,adsJs:source,adsMinJs:source,patches:[...result.patches,'TCF decision readiness; separate Prebid/pre-auction/auction deadlines; current-auction targeting only; no forced NPA or ID5 PPID copy']};
}
