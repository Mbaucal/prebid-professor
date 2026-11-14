import {parse} from 'acorn';
import {compilePositions} from '../runtime-next/compiler.mjs';
import {installCreativeBridge} from './browser-bridge.mjs';
function once(source,before,after){if(source.split(before).length!==2)throw Error('Creative bridge insertion point changed: '+before);return source.replace(before,()=>after);}
export function compileCreatives(input){
 const result=compilePositions(input);let source=result.adsJs;
 const anchor='  var _stickyTop = { everFilled:false, closed:false, currentH:0, timer:null, retryIdx:0 };';
 source=once(source,anchor,`${anchor}\n${installCreativeBridge.toString()}
  var TESSERA_CREATIVES=installCreativeBridge({window:window,document:document,stickyId:STICKY_TARGET_ID,
    getSlot:function(id){return window.adSlots&&window.adSlots[id];},
    canClaim:function(id){return id!==STICKY_TARGET_ID||!_sticky.closed;},
    onClaim:function(id){if(id!==STICKY_TARGET_ID)return;hideSticky();clearStickyTimer();clearStickyEmptyRetryTimer();_sticky.remainingMs=null;_sticky.emptyRemainingMs=null;var b=document.getElementById('close_sticky_ad');if(b)b.remove();},
    onRelease:function(id,reason){if(id!==STICKY_TARGET_ID)return;hideSticky();if(reason==='close'){_sticky.closed=true;clearStickyTimer();clearStickyEmptyRetryTimer();}else if(reason==='error'){scheduleStickyEmptyRetry();}}
  });
  googletag.cmd.push(function(){googletag.pubads().addEventListener('slotRequested',function(ev){var id=ev.slot&&ev.slot.getSlotElementId();if(id)TESSERA_CREATIVES.requested(id);});});
  `);
 for(const name of ['ensureStickyClose','showSticky','scheduleStickyTimerDelay','scheduleStickyEmptyRetryDelay']){
  const needle=name==='showSticky'?'function showSticky(h){':name.endsWith('Delay')?`function ${name}(delayMs){`:`function ${name}(){`;
  source=once(source,needle,needle+'\n  if(TESSERA_CREATIVES && TESSERA_CREATIVES.owns(STICKY_TARGET_ID))return;');
 }
 source=once(source,'  function tryRefresh(id, slot, minGapSec){','  function tryRefresh(id, slot, minGapSec){\n    if(TESSERA_CREATIVES && TESSERA_CREATIVES.owns(id))return;');
 // Check ownership before the historical sticky/normal render handlers. A
 // friendly template may execute before OR after slotRenderEnded.
 source=once(source,'    // --- STICKY TOP (neće raditi jer ti je STICKY_TOP_TARGET_ID prazan) ---',`    if(TESSERA_CREATIVES.owns(id)){if(ev.isEmpty)TESSERA_CREATIVES.empty(id);else return;}
    // --- STICKY TOP (neće raditi jer ti je STICKY_TOP_TARGET_ID prazan) ---`);
 parse(source,{ecmaVersion:'latest'});
 return {...result,adsJs:source,adsMinJs:source,patches:[...result.patches,'friendly creative display ownership v1; one InCorner close control; sticky refresh suspension and frame lifecycle cleanup']};
}
