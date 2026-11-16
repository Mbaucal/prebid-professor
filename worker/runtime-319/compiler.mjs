import {parse} from 'acorn';
import {compileRuntime318} from '../runtime-318/compiler.mjs';
import {once} from '../runtime-3161/compiler.mjs';
import {browserSources} from '../../.generated/runtime-319-browser-source.mjs';
export {idempotentStickyStyles} from '../runtime-318/compiler.mjs';
const literal = value => JSON.stringify(value).replace(/</g,'\\u003c');
function replaceFunction(source, name, replacement) {
  const matches=[];
  function visit(node) {
    if(!node||typeof node!=='object')return;
    if(node.type==='FunctionDeclaration'&&node.id?.name===name)matches.push(node);
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
  }
  visit(parse(source,{ecmaVersion:2015}));
  if(matches.length!==1)throw Error('Country rules expected one '+name);
  const node=matches[0];return source.slice(0,node.start)+replacement+source.slice(node.end);
}
export function compileRuntime319(input) {
  const result = compileRuntime318(input);
  let source = replaceFunction(result.adsJs,'adConditionalConfig',browserSources.adConditionalConfig);
  const functions=Object.entries(browserSources).filter(([name])=>name!=='adConditionalConfig').map(([,value])=>value).join('\n');
  source=once(source,'var AD_CONDITIONAL_UNITS=',`var AD_GEO_STATE={settled:false,country:null,initialized:false,fallbackReason:null,fallbackAllowed:null,stickyCheck:null};
  var AD_INTERSTITIAL_RULES=${literal(input.interstitialRules)};
  ${functions}
  var AD_CONDITIONAL_UNITS=`);
  source=once(source,'function setKV(k, v){',"function setKV(k, v){\n    if(k==='geo_country')return;");
  source=once(source,'function applyImmediateTargeting(){','function applyImmediateTargeting(){\n    adGeoApplyTargeting();');
  source=once(source,'    _takeOverCodelessReleased = true;',"    if(!adGeoFallbackAllowed(reason))return false;\n    _takeOverCodelessReleased = true;");
  source=once(source,'function init(){','function init(){\n    AD_GEO_STATE.initialized=true;');
  source=once(source,"  if(document.readyState==='loading'){", "  adGeoStart();\n  if(document.readyState==='loading'){");
  // A scroll while GEO is pending must not consume a Sticky's initial request.
  source=once(source,'STICKY_TARGET_ID &&\n          y >= STICKY_LAZY_SCROLL_PX',
    'STICKY_TARGET_ID && window.adSlots[STICKY_TARGET_ID] &&\n          y >= STICKY_LAZY_SCROLL_PX');
  source=once(source,'STICKY_TOP_TARGET_ID &&\n          y >= STICKY_TOP_LAZY_SCROLL_PX',
    'STICKY_TOP_TARGET_ID && window.adSlots[STICKY_TOP_TARGET_ID] &&\n          y >= STICKY_TOP_LAZY_SCROLL_PX');
  source=once(source,'    function onScroll(){ check(); }','    AD_GEO_STATE.stickyCheck=check;\n    function onScroll(){ check(); }');
  parse(source,{ecmaVersion:2015});
  return {...result,adsJs:source,adsMinJs:source,patches:[...result.patches,
    '3.19.0: authoritative geo_country GAM key, conditional country maps and slot actions; only dependent positions wait, no GEO-triggered refresh',
    '3.19.0: optional rules for the existing TakeOver Interstitial fallback; external codeless remains managed in GAM']};
}
