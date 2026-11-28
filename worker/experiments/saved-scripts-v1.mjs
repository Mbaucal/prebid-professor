import assert from 'node:assert/strict';
import {parse} from 'acorn';

export {SCRIPT_ID,TEST_ID,displayName,scriptSettings,DEFAULT_SCRIPT_SETTINGS} from './saved-script-settings.mjs';
const once=(source,marker,value)=>{assert.equal(source.split(marker).length,2,'Review saved-script marker: '+marker);return source.replace(marker,()=>value);};

// New profile built from the reviewed literal loader. Original profiles stay frozen.
export function savedScriptLoader(template,config) {
  assert(['single','ab'].includes(config.deliveryMode));
  let source=template;
  source=once(source,'assigned = null;', 'assigned = null, selected = null;');
  source=once(source,'release:config.release,\n    duplicate:', 'release:config.release,\n    get scriptRelease(){return selected&&selected.id;},\n    duplicate:');
  source=once(source,'script:assigned?new URL(config.arms[assigned].path,base).href:null,scriptSha256:assigned?config.arms[assigned].sha256:null',
    'script:selected?new URL(selected.path,base).href:null,scriptSha256:selected?selected.sha256:null');
  source=once(source,"mode:assigned==='B'?'auction-with-cache':'fresh-only'", "mode:selected?selected.settings.mode:null,deliveryMode:config.deliveryMode,scriptRelease:selected?selected.id:null,scriptName:selected?selected.name:null,testName:config.deliveryMode==='ab'?config.name:null,trafficBPercent:config.deliveryMode==='ab'?config.trafficBPercent:null,refreshSeconds:selected?selected.settings.refreshSeconds:null,maxBidAgeSeconds:selected?selected.settings.maxBidAgeSeconds||null:null");
  source=once(source,'if (!entries||!assigned||!slot||owned.has(slot)) return;', 'if (!entries||!selected||!slot||owned.has(slot)) return;');
  source=once(source,'slot.setConfig({targeting:{Variant:assigned}});', 'if(assigned)slot.setConfig({targeting:{Variant:assigned}});');
  source=once(source,"try {var sample=new Uint32Array(1);window.crypto.getRandomValues(sample);assigned=sample[0]<2147483648?'A':'B';}\n  catch (_) {fail('random-unavailable');return;}\n  event('assigned-'+assigned);",
    "if(config.deliveryMode==='single'){selected=config.script;event('single-script');}\n  else {try {var sample=new Uint32Array(1);window.crypto.getRandomValues(sample);assigned=sample[0]<4294967296*(100-config.trafficBPercent)/100?'A':'B';selected=config.scripts[assigned];}\n  catch (_) {fail('random-unavailable');return;}event('assigned-'+assigned);}");
  source=once(source,'insert(config.arms[assigned].path,config.arms[assigned].integrity,', 'insert(selected.path,selected.integrity,');
  source=once(source,'__AB_CONFIG_JSON__',JSON.stringify(config).replace(/</g,'\\u003c'));
  parse(source,{ecmaVersion:'latest'});return source;
}
