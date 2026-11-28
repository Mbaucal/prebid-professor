import {parse} from 'acorn';
import {compileReporting} from '../runtime-reporting-v1/compiler.mjs';
import {browserSources} from '../../.generated/runtime-demand-browser-source.mjs';

function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Demand runtime insertion point changed: ' + before);
  return source.replace(before, () => after);
}

export function compileDemand(input) {
  // The frozen bridge predates MCM paths and rejects commas. Validate that
  // exact extension here, compile through its existing guards, then restore
  // only the GPT path declaration. Old runtime sources stay reproducible.
  const originalPath=input.core.gamPath;
  const mcm=/^\/\d+,\d+\/[A-Za-z0-9_.:/-]+\/$/.test(originalPath);
  const bridgePath=mcm?originalPath.replace(',', '_'):originalPath;
  const result = compileReporting(mcm?{...input,core:{...input.core,gamPath:bridgePath}}:input);
  if(mcm){
    const before='var adUnitPath = '+JSON.stringify(bridgePath)+';';
    result.adsJs=once(result.adsJs,before,'var adUnitPath = '+JSON.stringify(originalPath)+';');
    result.adsMinJs=result.adsJs;
    result.patches=[...result.patches,'preserves full MCM network path'];
  }
  // Explicit GAM-only keeps the accepted reporting runtime behavior.
  if (!input.options.enablePrebid) return result;
  if (!input.demandSignals) throw Error('Normalized demand signals are required.');
  let source = once(result.adsJs, 'enableSendAllBids: false,',
    'enableSendAllBids: true,\n        gptPreAuction: {enabled:true, mcmEnabled:false},');
  const placements = JSON.stringify(input.demandSignals.placements).replace(/</g, '\\u003c');
  source = once(source, 'function adUnitFromCode(code){',
    `var TESSERA_PLACEMENTS=${placements};\n${browserSources.tesseraDemandUnit}\nfunction adUnitFromCode(code){`);
  source = once(source, '    return unit;\n  }\n\nfunction applyHbVerTargetingForSlots',
    '    return tesseraDemandUnit(unit,TESSERA_PLACEMENTS);\n  }\n\nfunction applyHbVerTargetingForSlots');
  parse(source, {ecmaVersion:'latest'});
  return {...result, adsJs:source, adsMinJs:source, patches:[...result.patches,
    'Send All Bids with deal targeting; stable per-position GPID before initial, lazy, overlay and refresh auctions']};
}
