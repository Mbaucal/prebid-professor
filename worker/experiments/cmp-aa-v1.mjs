import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {bootStaticAA,instrumentFullRuntime} from './static-aa-v1.mjs';

export const CMP_RELEASE='tanjug-aa-1.0.2';
export function instrumentCmpRuntime(source) {
  const start='            var hasTcfCmp = typeof window.__tcfapi === "function";\n            var gdprConsentConfig = hasTcfCmp ? {';
  const end='            } : {\n                enabled: false\n            };\n            try {';
  assert.equal(source.split(start).length,2);assert.equal(source.split(end).length,2);
  const result=source.replace(start,'            var gdprConsentConfig = {\n                enabled: true,')
    .replace(end,'            };\n            try {');
  return instrumentFullRuntime(result,CMP_RELEASE);
}

// Wait for the real API/stub; never manufacture consent or alter CMP geography.
export function waitForCmpEntry(start,win) {
  if(win.__adCmpEntry){if(win.__adCmpEntry.finished)start();return;}
  const state={finished:false,status:'waiting',waitedMs:0};
  win.__adCmpEntry=state;
  win.AdConsent=Object.freeze({snapshot:()=>({api:typeof win.__tcfapi,status:state.status,waitedMs:state.waitedMs})});
  const began=Date.now();let timer;
  function poll(){
    state.waitedMs=Date.now()-began;
    if(typeof win.__tcfapi==='function'||state.waitedMs>=8000){
      state.finished=true;state.status=typeof win.__tcfapi==='function'?'available':'api-timeout';
      if(timer)clearTimeout(timer);
      // On timeout native Prebid handles missing consent with its module ON.
      // Existing GAM fallback remains available; no enabled:false bypass.
      start();return;
    }
    timer=setTimeout(poll,50);
  }
  poll();
}
export function cmpLoader(config){
  assert.equal(config.release,CMP_RELEASE);
  const old='var tag = document.currentScript;';
  const boot=bootStaticAA.toString();assert.equal(boot.split(old).length,2);
  const source='(function(config,entryTag){if(!entryTag||!entryTag.src)return;('+waitForCmpEntry.toString()+')(function(){('
    +boot.replace(old,'var tag = entryTag;')+')(config);},window);})('
    +JSON.stringify(config).replace(/</g,'\\u003c')+',document.currentScript);';
  parse(source,{ecmaVersion:'latest'});return source;
}
