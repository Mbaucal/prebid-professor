import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {instrumentCmpRuntime,cmpLoader,CMP_RELEASE} from './cmp-aa-v1.mjs';
import {createFullBidCachePolicy} from '../runtime-cache/full-policy-v1.mjs';
import {createFullCacheLifecycle} from '../runtime-cache/full-lifecycle-v1.mjs';
import {createConsentEpoch} from '../runtime-cache/consent-epoch.mjs';

export const CACHE_RELEASE='tanjug-cache-1.0.1';
export function cacheArm(source,variant){
  assert(['A','B'].includes(variant));
  let output=instrumentCmpRuntime(source).replaceAll(CMP_RELEASE,CACHE_RELEASE);
  if(variant==='A')return output;
  assert.equal(output.split('useBidCache: false,').length,2);
  output=output.replace('useBidCache: false,','useBidCache: true,');
  // Instrument the reviewed readable source, never a user's arbitrary script.
  const edits=[];let manual=0,requests=0,refreshes=0;
  function walk(n){
    if(!n||typeof n!=='object')return;
    if(n.type==='FunctionDeclaration'&&n.id?.name==='applyPrebidTargetingToSlots'){
      edits.push({start:n.start,end:n.end,text:'function applyPrebidTargetingToSlots(){}'});manual++;return;
    }
    if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'){
      const callee=output.slice(n.callee.start,n.callee.end);
      if(callee==='pbjs.requestBids'){edits.push({start:n.callee.start,end:n.callee.end,text:'cacheRequestBids'});requests++;}
      else if(['googletag.pubads().refresh','pa.refresh'].includes(callee)){edits.push({start:n.callee.start,end:n.callee.end,text:'cacheRefresh'});refreshes++;}
      else if(n.callee.property?.name==='refresh')throw Error('Unreviewed refresh path.');
    }
    for(const child of Object.values(n))if(Array.isArray(child))child.forEach(walk);else if(child&&typeof child==='object')walk(child);
  }
  walk(parse(output,{ecmaVersion:'latest'}));
  assert.deepEqual({manual,requests,refreshes},{manual:1,requests:3,refreshes:10});
  for(const e of edits.sort((a,b)=>b.start-a.start))output=output.slice(0,e.start)+e.text+output.slice(e.end);
  const marker='    pbjs.que = pbjs.que || [];';
  assert.equal(output.split(marker).length,2);
  output=output.replace(marker,marker+`
    var cacheLifecycle=null;
    function cacheContext(code){
      var slot=window.adSlots&&window.adSlots[code];
      var unit=adUnitFromCode(code);
      var sizes=unit&&unit.mediaTypes&&unit.mediaTypes.banner&&unit.mediaTypes.banner.sizes;
      return slot&&sizes&&sizes.length?{slot:slot,sizes:sizes}:null;
    }
    function cacheCode(slot){
      var code=slot&&slot.getSlotElementId&&slot.getSlotElementId();
      return window.adSlots&&window.adSlots[code]===slot?code:null;
    }
    function ensureCacheLifecycle(){
      if(!cacheLifecycle)cacheLifecycle=(${createFullCacheLifecycle.toString()})({win:window,pbjs:pbjs,
        siteId:'tanjug',runtimeVersion:${JSON.stringify(CACHE_RELEASE)},mode:'auction-with-cache',maxAgeSeconds:60,
        contextForCode:cacheContext,codeForSlot:cacheCode,
        policyFactory:${createFullBidCachePolicy.toString()},consentFactory:${createConsentEpoch.toString()}});
      return cacheLifecycle;
    }
    function cacheRequestBids(input){return ensureCacheLifecycle().requestBids(input);}
    function cacheRefresh(slots,options){return ensureCacheLifecycle().refresh(slots,options);}
    window.AdBidCache=Object.freeze({snapshot:function(){return cacheLifecycle?cacheLifecycle.snapshot():{mode:'auction-with-cache',status:'waiting'};},
      inspect:function(){var s=this.snapshot();console.table(s.policy?[s.policy.selections]:[s]);return s;}});
  `);
  // The existing configuration runs before the first request. The new lifecycle
  // installs native targeting and disables auction-end presets at that boundary.
  parse(output,{ecmaVersion:'latest'});return output;
}
export function fullCacheLoader(config){
  assert.equal(config.release,CACHE_RELEASE);
  // A new loader profile derived from the shipped CMP flow; old output is frozen.
  let source=cmpLoader({...config,release:CMP_RELEASE}).replaceAll(CMP_RELEASE,CACHE_RELEASE);
  const hash='scriptSha256:config.armSha256';
  assert(source.includes(hash));
  source=source.replace(hash,'scriptSha256:assigned?config.arms[assigned].sha256:null');
  assert(source.includes("mode:'fresh-only'"));
  source=source.replace("mode:'fresh-only'","mode:assigned==='B'?'auction-with-cache':'fresh-only',bidCache:window.AdBidCache?window.AdBidCache.snapshot():null");
  parse(source,{ecmaVersion:'latest'});return source;
}
