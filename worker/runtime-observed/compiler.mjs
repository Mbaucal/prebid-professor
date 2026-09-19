import { compilePositions } from '../runtime-next/compiler.mjs';
import { observeRuntime } from './observer.mjs';
export function compileObserved(input,descriptor) {
  const generated=compilePositions(input);
  const marker='if (window.__TESSERA_RUNTIME_STARTED) return;';
  if(generated.adsJs.split(marker).length!==2)throw Error('Runtime entry changed; review instrumentation.');
  const metadata={siteId:input.core.siteId,runtimeVersion:descriptor.version,units:input.core.explicitUnits.map(u=>u.id)};
  const code='var tesseraObservation=('+observeRuntime.toString()+')('+JSON.stringify(metadata).replace(/</g,'\\u003c')+', function(slot){if(!slot)return null;if(typeof _takeOverSlot!=="undefined" && _takeOverSlot===slot)return '+JSON.stringify(input.overlay?.code||null)+';var id=slot.getSlotElementId();return window.adSlots && window.adSlots[id]===slot?id:null;});\n  if(!tesseraObservation.start())return;\n  '+marker;
  const source=generated.adsJs.replace(marker,()=>code);
  return {...generated,adsJs:source,adsMinJs:source,patches:[...generated.patches,'versioned runtime entry and local GPT lifecycle diagnostics']};
}
