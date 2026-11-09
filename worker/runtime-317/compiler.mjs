import {parse} from 'acorn';
import {compileRuntime3162} from '../runtime-3162/compiler.mjs';
import {browserSources} from '../../.generated/runtime-317-browser-source.mjs';
export {idempotentStickyStyles} from '../runtime-3162/compiler.mjs';
const literal = value => JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
export function compileRuntime317(input) {
  const result = compileRuntime3162(input);
  const marker = 'function getUnitConfigById(id){';
  if (result.adsJs.split(marker).length !== 2) throw Error('Conditional map insertion point changed.');
  const injected = `var AD_CONDITIONAL_UNITS=${literal(input.conditionalUnits)};
  var AD_CONDITIONAL_DECISIONS=Object.create(null);
  ${browserSources.adRuleMatches}
  ${browserSources.adConditionalConfig}
  if(Object.keys(AD_CONDITIONAL_UNITS).length){
    var adRuleStyle=document.createElement('style');
    adRuleStyle.textContent=${literal(input.conditionalCss)};
    (document.head||document.documentElement).appendChild(adRuleStyle);
  }
  function getUnitConfigById(id){return adConditionalConfig(id,baseUnitConfigById(id));}
  function baseUnitConfigById(id){`;
  const source = result.adsJs.replace(marker, () => injected);
  parse(source,{ecmaVersion:2015});
  return {...result,adsJs:source,adsMinJs:source,patches:[...result.patches,
    '3.17.0: saved key-value rules select one shared Banner/Sticky map for GPT, Prebid and responsive placeholders on the page; absent values use the assigned map']};
}
