// All calls come from the new compiled wrapper, not a global pbjs/GPT monkeypatch.
// Selection is deferred until the actual GAM request, including delayed lazy slots.
export function createFullCacheLifecycle({win,pbjs,siteId,runtimeVersion,mode,maxAgeSeconds,contextForCode,codeForSlot,beforeRequest=()=>{},policyFactory,consentFactory,now=Date.now}) {
  const consent=consentFactory(win),records=new Map(),timers=new Set();
  const totals={auctions:0,submissionAttempts:0,fallbacks:0,blocked:0,lateCallbacks:0,errors:0};
  let policy=null,stopped=false;
  const increment=key=>{totals[key]=Math.min(Number.MAX_SAFE_INTEGER,totals[key]+1);};
  function context(code){
    const c=contextForCode(code),state=consent.read();
    if(!c||!c.slot||!Array.isArray(c.sizes)||!c.sizes.length)return null;
    return {slot:c.slot,sizes:c.sizes.map(s=>s.slice()),epoch:state.epoch};
  }
  const same=(a,b)=>a&&b&&a.slot===b.slot&&a.epoch===b.epoch&&JSON.stringify(a.sizes)===JSON.stringify(b.sizes);
  function clear(slot){for(const key of slot.getTargetingKeys())if(key.startsWith('hb_'))slot.clearTargeting(key);}
  function ensure(){
    if(stopped)throw Error('Cache lifecycle stopped.');
    if(!policy){
      // Preserve every other targeting option (including deals). Never let native
      // auction-end presets bypass the final eligibility/TTL check at GAM request.
      const controls=pbjs.getConfig('targetingControls')||{};
      pbjs.setConfig({targetingControls:{...controls,presetGPTTargeting:false}});
      policy=policyFactory({pbjs,siteId,mode,maxAgeSeconds,contextForCode:context,cacheAllowed:()=>consent.read().cacheAllowed,
        auctionAllowed:(id,code)=>{const r=records.get(code);return !!r&&r.auctionId===id&&!r.submitted&&!r.cancelled;},now});
    }
    if(pbjs.getConfig('targetingControls.presetGPTTargeting')!==false)throw Error('Native targeting presets changed.');
    return policy;
  }
  function onInit(event){
    // Native auctionInit follows CMP gating. Capture the actual eligible start,
    // not the time requestBids was queued while a CMP could still be loading.
    for(const r of records.values())if(r.auctionId===event?.auctionId&&!r.submitted&&!r.cancelled)r.started=context(r.code);
  }
  pbjs.onEvent('auctionInit',onInit);
  const api={
    requestBids(input){
      if(stopped)return;
      try{ensure();}catch(error){increment('errors');throw error;}
      const units=input?.adUnits;
      if(!Array.isArray(units)||!units.length||units.length>100||units.some(u=>!context(u.code)))throw Error('Only owned eligible banner units may enter this auction.');
      if(units.some(u=>{const r=records.get(u.code);return r&&!r.submitted;})){increment('blocked');return;}
      if(records.size+units.filter(u=>!records.has(u.code)).length>100)throw Error('Owned-slot tracking capacity exceeded.');
      const auctionId=win.crypto.randomUUID(),batch=[];
      for(const unit of units){const r={code:unit.code,auctionId,before:context(unit.code),started:null,ready:false,submitted:false};records.set(unit.code,r);batch.push(r);}
      increment('auctions');let settled=false,timer;
      function finish(ready,args){
        if(settled||stopped){increment('lateCallbacks');return;}
        settled=true;win.clearTimeout(timer);timers.delete(timer);
        const active=batch.filter(r=>records.get(r.code)===r&&!r.submitted);
        if(!active.length){increment('lateCallbacks');return;}
        // A CMP-blocked request can finish without auctionInit. It has no eligible
        // bids; retain the existing clean GAM fallback instead of targeting it.
        for(const r of active){r.ready=ready&&r.started!==null;if(!r.ready){r.cancelled=true;policy.discardAuction(auctionId,r.code);}}
        if(!ready)policy.discardAuction(auctionId);
        input.bidsBackHandler?.(...args);
      }
      timer=win.setTimeout(()=>finish(false,[{},true,auctionId]),Math.min(30000,Math.max(100,Number(input.timeout)||1000))+500);timers.add(timer);
      try{return pbjs.requestBids({...input,auctionId,bidsBackHandler:(...args)=>finish(true,args)});}
      catch{increment('errors');finish(false,[{},true,auctionId]);}
    },
    refresh(slots,options){
      if(stopped)return;
      const allowed=[];
      for(const slot of slots||[]){
        const code=codeForSlot(slot);
        // The existing TakeOver codeless fallback is GPT-only, never cached.
        if(!code){if(slot===win.__TAKEOVER_CODELESS_GUARD_SLOT&&win.__TAKEOVER_ALLOW_CODELESS_FALLBACK_REQUEST===true)allowed.push(slot);continue;}
        const r=records.get(code);
        if(r?.submitted){increment('blocked');continue;}
        try{
          const c=context(code);
          if(!c||c.slot!==slot||(r&&!same(r.started||r.before,c))){clear(slot);if(r){r.submitted=true;policy?.discardAuction(r.auctionId,code);}increment('blocked');continue;}
          if(r)r.submitted=true;
          clear(slot);
          if(r?.ready){if(!ensure().target(code,r.auctionId)){increment('blocked');continue;}}
          else {if(r)policy?.discardAuction(r.auctionId,code);increment('fallbacks');}
          allowed.push(slot);
        }catch{try{clear(slot);}catch{}increment('errors');}
      }
      if(allowed.length){beforeRequest(allowed);totals.submissionAttempts=Math.min(Number.MAX_SAFE_INTEGER,totals.submissionAttempts+allowed.length);return win.googletag.pubads().refresh(allowed,options);}
    },
    snapshot(){return {profile:'full-cache-lifecycle-v1',siteId,runtimeVersion,mode,maxAgeSeconds,stopped,trackedSlots:records.size,
      totals:{...totals},consent:consent.snapshot(),policy:policy?.snapshot()||null};},
    stop(){if(stopped)return;stopped=true;for(const timer of timers)win.clearTimeout(timer);timers.clear();records.clear();consent.stop();policy?.stop();pbjs.offEvent('auctionInit',onInit);}
  };
  return api;
}
