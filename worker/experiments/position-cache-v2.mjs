import assert from 'node:assert/strict';
import {cacheArm} from './full-cache-v2.mjs';
import {configurePreparedArm} from './configurable-cache-v1.mjs';
import {createFullBidCachePolicy} from '../runtime-cache/full-policy-v1.mjs';
import {createPositionBidCachePolicy} from '../runtime-cache/position-policy-v2.mjs';
import {savedScriptLoader} from './saved-scripts-v1.mjs';
import {scriptSettings} from './saved-script-settings.mjs';

const once=(source,marker,replacement)=>{
  assert.equal(source.split(marker).length,2,'Review position-cache compiler marker.');
  return source.replace(marker,()=>replacement);
};

// Capture literal source at repository build time, before bundler rewriting.
export function preparePositionCacheTemplate(source) {
  return once(cacheArm(source,'B'),'policyFactory:'+createFullBidCachePolicy.toString(),
    'policyFactory:function(options){return ('+createPositionBidCachePolicy.toString()+')(Object.assign({},options,__POSITION_CACHE_OPTIONS__));}');
}

export function configurePositionCacheArm(template,input,release) {
  const settings=scriptSettings(input);
  assert(settings.positionOverrides,'Explicit position settings are required.');
  const arm={mode:'auction-with-cache',refreshSeconds:settings.refreshSeconds,maxBidAgeSeconds:settings.maxBidAgeSeconds};
  const output=configurePreparedArm(template,'A',{schemaVersion:1,trafficBPercent:50,arms:{A:arm,B:arm}},release);
  return once(output,'__POSITION_CACHE_OPTIONS__',JSON.stringify({
    defaultCacheEnabled:settings.mode==='auction-with-cache',positionOverrides:settings.positionOverrides,
  }).replace(/</g,'\\u003c'));
}

export function positionScriptLoader(template,config) {
  return once(savedScriptLoader(template,config),'deliveryMode:config.deliveryMode,',
    'positionOverrides:selected?selected.settings.positionOverrides||{}:{},deliveryMode:config.deliveryMode,');
}
