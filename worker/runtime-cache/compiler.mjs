import { parse } from 'acorn';
import { compileMeasured } from '../runtime-measured/compiler.mjs';
import { createBidCachePolicy } from './policy.mjs';
import { createConsentEpoch } from './consent-epoch.mjs';
import { createCacheLifecycle } from './lifecycle.mjs';

export function compileCached(input,descriptor) {
  const generated=compileMeasured(input,descriptor);
  let source=generated.adsJs;
  const literal=v=>JSON.stringify(v).replace(/</g,'\\u003c');
  function replace(before,after){if(source.split(before).length!==2)throw Error('Cache insertion point changed; source review required.');source=source.replace(before,()=>after);}
  // Manual prefetch targeting must not consume bids or freeze an expired lazy
  // offer. All owned-slot selection happens synchronously at the final refresh.
  const edits=[];let manual=0,requests=0,refreshes=0;
  function walk(node){
    if(!node||typeof node!=='object')return;
    if(node.type==='FunctionDeclaration'&&node.id?.name==='applyPrebidTargetingToSlots'){
      edits.push({start:node.start,end:node.end,text:'function applyPrebidTargetingToSlots(){ /* deferred to actual GAM request */ }'});manual++;return;
    }
    if(node.type==='CallExpression'){
      const callee=source.slice(node.callee.start,node.callee.end);
      if(callee==='pbjs.requestBids'){edits.push({start:node.callee.start,end:node.callee.end,text:'tesseraCacheRequestBids'});requests++;}
      else if(['googletag.pubads().refresh','pa.refresh'].includes(callee)){edits.push({start:node.callee.start,end:node.callee.end,text:'tesseraCacheRefresh'});refreshes++;}
      else if(node.callee.type==='MemberExpression'&&node.callee.property?.name==='refresh')throw Error('Unreviewed GPT refresh path.');
    }
    for(const child of Object.values(node))if(Array.isArray(child))child.forEach(walk);else if(child&&typeof child==='object')walk(child);
  }
  walk(parse(source,{ecmaVersion:'latest'}));
  if(manual!==1||requests!==(input.overlay?5:4)||refreshes!==11)throw Error('Auction/targeting path count changed; review every path. '+JSON.stringify({manual,requests,refreshes}));
  for(const edit of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  if(input.overlay)replace('clearPrebidTargetingFromSlot(slot);applyTargetingMapToSlot(slot,pbjs.getAdserverTargetingForAdUnitCode(code)||{});','/* final-request cache targeting */');
  replace('useBidCache: false,','useBidCache: '+String(input.bidCache.mode==='auction-with-cache')+',');
  replace('targetingControls: { alwaysIncludeDeals: true },','targetingControls: { alwaysIncludeDeals: true, presetGPTTargeting: false },');
  // Configure the unchanged bidder/CMP/floor settings before the independent
  // TakeOver queue can request bidders. This does not bypass the consent gate.
  for(const [slots,event] of [['atfSlots','start-error'],['retry','start-retry-error']]){
    const call="try { initTakeOver(); } catch(e) { takeOverEvent('"+event+"', {message:e && e.message}); }";
    replace(call,'/* TakeOver follows Prebid setup below. */');
    replace('startATF('+slots+');','startATF('+slots+');\n'+call);
  }
  const bootstrap='var pbjs      = (window.pbjs      = window.pbjs      || {}); pbjs.que      = pbjs.que      || [];';
  replace(bootstrap,bootstrap+'\n'+`
  var tesseraCacheLifecycle=null;
  function tesseraCacheContext(code){
    var slot=window.adSlots&&window.adSlots[code];
    if(TESSERA_OVERLAY&&code===TESSERA_OVERLAY.code)slot=_takeOverSlot;
    if(!slot)return null;
    var unit=adUnitFromCode(code),sizes=unit&&unit.mediaTypes&&unit.mediaTypes.banner&&unit.mediaTypes.banner.sizes;
    if(!sizes||!sizes.length)return null;
    return {slot:slot,sizes:sizes};
  }
  function tesseraCacheCode(slot){
    if(TESSERA_OVERLAY&&slot===_takeOverSlot)return TESSERA_OVERLAY.code;
    var id=slot&&slot.getSlotElementId&&slot.getSlotElementId();
    return window.adSlots&&window.adSlots[id]===slot?id:null;
  }
  function tesseraCacheRequestBids(input){if(!tesseraCacheLifecycle)throw Error('Cache lifecycle unavailable.');return tesseraCacheLifecycle.requestBids(input);}
  function tesseraCacheRefresh(slots,options){if(tesseraCacheLifecycle)return tesseraCacheLifecycle.refresh(slots,options);}
  pbjs.que.push(function(){
    var registry=window.__tesseraBidCache||(window.__tesseraBidCache=Object.create(null));
    try{
      tesseraCacheLifecycle=(${createCacheLifecycle.toString()})({win:window,pbjs:pbjs,siteId:${literal(input.core.siteId)},runtimeVersion:${literal(descriptor.version)},
        mode:${literal(input.bidCache.mode)},maxAgeSeconds:${input.bidCache.maxAgeSeconds},contextForCode:tesseraCacheContext,codeForSlot:tesseraCacheCode,
        beforeRequest:function(slots){applyHbVerTargetingForSlots(slots.filter(function(slot){return !!tesseraCacheCode(slot);}));},
        policyFactory:${createBidCachePolicy.toString()},consentFactory:${createConsentEpoch.toString()}});
      registry[${literal(input.core.siteId)}]={snapshot:function(){return tesseraCacheLifecycle.snapshot();}};
    }catch(_){registry[${literal(input.core.siteId)}]={snapshot:function(){return {siteId:${literal(input.core.siteId)},runtimeVersion:${literal(descriptor.version)},stopped:true,error:'initialization-unavailable'};}};}
  });`);
  parse(source,{ecmaVersion:'latest'});
  return {...generated,adsJs:source,adsMinJs:source,patches:[...generated.patches,'new version: CMP-aware bid reuse and final-request native targeting for every auction path']};
}
