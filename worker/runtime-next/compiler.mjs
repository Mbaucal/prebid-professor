import { parse } from 'acorn';
import { buildReference391 } from '../../.generated/reference391.mjs';
import { compileRuntime } from '../runtime-compiler.ts';
import { compileReferenceBuild } from '../runtime/reference-bridge.mjs';
import * as browser from './browser-functions.mjs';

function replaceOne(source, before, after) {
  if(source.split(before).length!==2)throw Error('Versioned runtime insertion point changed; source review required.');
  return source.replace(before,()=>after);
}
function replaceFunction(source,name,replacement) {
  const found=[];
  function walk(node){if(!node||typeof node!=='object')return;if(node.type==='FunctionDeclaration'&&node.id?.name===name)found.push(node);for(const child of Object.values(node))if(Array.isArray(child))child.forEach(walk);else if(child&&typeof child==='object')walk(child);}
  walk(parse(source,{ecmaVersion:'latest'}));
  if(found.length!==1)throw Error(`Expected one ${name} implementation.`);
  const n=found[0];return source.slice(0,n.start)+replacement+source.slice(n.end);
}
export function compilePositions(input) {
  const core=structuredClone(input.core);
  if(input.overlay)core.explicitUnits=core.explicitUnits.filter(u=>u.id!==input.overlay.code);
  const result=compileReferenceBuild(core,input.options,{buildReference391,compileRuntime});
  let source=result.adsJs;
  const literal=v=>JSON.stringify(v).replace(/</g,'\\u003c');
  const helperNames=['tesseraLazyRule','tesseraWireConfiguredLazy'];
  if(input.overlay)helperNames.push('tesseraOverlayDevice','tesseraOverlayAllowed','tesseraRecordOverlayView','tesseraStopOverlayAuction','tesseraRequestOverlay','tesseraConfirmOverlayRender');
  source=replaceOne(source,'  var TAKEOVER_ACTIVE_FOR_PAGE = takeOverIsActiveForPage();',
    `  var TESSERA_OVERLAY=${literal(input.overlay)};\n  var TESSERA_LAZY=${literal(input.lazyRules)};\n  var TESSERA_LAZY_STARTED=false;\n${helperNames.map(n=>browser[n].toString()).join('\n')}\n  var TAKEOVER_ACTIVE_FOR_PAGE = takeOverIsActiveForPage()${input.overlay?' && tesseraOverlayAllowed()':''};`);
  if(input.overlay){
    source=replaceFunction(source,'takeOverDeviceConfig','function takeOverDeviceConfig(){ return tesseraOverlayDevice(); }');
    source=replaceOne(source,'function getUnitConfigById(id){',`function getUnitConfigById(id){\n  if(id===TESSERA_OVERLAY.code)return TESSERA_OVERLAY.unit;`);
    source=replaceOne(source,'if (!id || window.adSlots[id]) return;','if (!id || id===TESSERA_OVERLAY.code || window.adSlots[id]) return;');
    const start=source.indexOf("        _takeOver.status = 'requested';",source.indexOf('function initTakeOver()'));
    const end=source.indexOf('\n      }catch(e){',start);
    if(start<0||end<0)throw Error('TakeOver request insertion point changed.');
    source=source.slice(0,start)+'        tesseraRequestOverlay(slot);'+source.slice(end);
    source=replaceOne(source,'function closeTakeOver(reason){','function closeTakeOver(reason){\n    tesseraStopOverlayAuction();');
    source=replaceOne(source,"    _takeOver.status = 'visible';","    _takeOver.status = 'visible';\n    tesseraRecordOverlayView();");
    source=replaceOne(source,'function takeOverOnSlotRenderEnded(ev){',`function takeOverOnSlotRenderEnded(ev){
    if(ev&&ev.slot===_takeOverSlot&&!ev.isEmpty&&ev.size&&ev.size[0]===1&&ev.size[1]===1&&HAS_PREBID&&TESSERA_OVERLAY.demand==='site'){
      var pending=window.__tesseraOverlayAuction;
      if(pending&&!pending.closed){pending.pendingRender=ev;tesseraConfirmOverlayRender();}
      return;
    }`);
  }
  if(Object.keys(input.lazyRules).length){
    source=replaceOne(source,"          if (cfg && String(cfg.type || 'BTF').toUpperCase() === 'ATF'){","          if (tesseraLazyRule(id)?.enabled || window.adSlots[id].__tesseraInitialAtf) return;\n          if (cfg && String(cfg.type || 'BTF').toUpperCase() === 'ATF'){");
    source=replaceOne(source,'    // Registruj oba observer-a za BTF slotove\n    Object.keys(window.adSlots).forEach(function(id){','    // Registruj oba observer-a za BTF slotove\n    Object.keys(window.adSlots).forEach(function(id){\n      if(tesseraLazyRule(id))return;');
    source=replaceOne(source,'        startATF(atfSlots);','        atfSlots.forEach(function(s){s.__tesseraInitialAtf=true;});\n        startATF(atfSlots);\n        TESSERA_LAZY_STARTED=true;\n        tesseraWireConfiguredLazy();');
    source=replaceOne(source,'                startATF(retry);','                retry.forEach(function(s){s.__tesseraInitialAtf=true;});\n                startATF(retry);');
    source=replaceOne(source,'    });\n  });\n}\n\n  /* ====== HB helper ====== */','    });\n    if(TESSERA_LAZY_STARTED)tesseraWireConfiguredLazy();\n  });\n}\n\n  /* ====== HB helper ====== */');
  }
  parse(source,{ecmaVersion:'latest'});
  // Final candidate formatting/minification follows this compiler. Both source
  // fields must already have the new behavior, never the old unpatched program.
  return {...result,adsJs:source,adsMinJs:source,minifier:'not-minified',patches:[...result.patches,'ad-unit TakeOver with optional Prebid and responsive map','explicit lazy fetch/render rules']};
}
