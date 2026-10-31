// Observes TCF changes only; never supplies consent, sets gdprApplies, opens a
// CMP or exports a TC string. Unknown/unsupported privacy contexts disable reuse.
export function createConsentEpoch(win) {
  let epoch=0,api=null,listenerId=null,signature=null,ready=false,stopped=false;
  let extraGpp=win.__gpp,extraUsp=win.__uspapi;
  function advance(){if(epoch<Number.MAX_SAFE_INTEGER)epoch++;else stopped=true;}
  function remove(old,id){if(typeof old==='function'&&id!=null)try{old('removeEventListener',2,()=>{},id);}catch{}}
  function connect(){
    if(stopped)return;
    if(extraGpp!==win.__gpp||extraUsp!==win.__uspapi){extraGpp=win.__gpp;extraUsp=win.__uspapi;advance();}
    if(api===win.__tcfapi)return;
    remove(api,listenerId);listenerId=null;signature=null;ready=false;api=win.__tcfapi;advance();
    if(typeof api!=='function')return;
    const owner=api;
    try{owner('addEventListener',2,(data,ok)=>{
      if(stopped||api!==owner||win.__tcfapi!==owner){remove(owner,data?.listenerId);return;}
      if(Number.isSafeInteger(data?.listenerId))listenerId=data.listenerId;
      const valid=ok===true&&data&&typeof data.gdprApplies==='boolean'&&data.cmpStatus!=='error'&&data.cmpStatus!=='loading'
        &&(data.addtlConsent===undefined||(typeof data.addtlConsent==='string'&&data.addtlConsent.length<=65536))
        &&(data.gdprApplies===false||(['tcloaded','useractioncomplete'].includes(data.eventStatus)&&typeof data.tcString==='string'&&data.tcString.length>0&&data.tcString.length<=65536));
      const next=valid?JSON.stringify([data.gdprApplies,data.tcString||'',data.addtlConsent||'',data.eventStatus||'',data.cmpStatus||'']):null;
      if(ready!==!!valid||signature!==next){ready=!!valid;signature=next;advance();}
    });}catch{ready=false;signature=null;advance();}
  }
  function invalidate(){advance();}
  for(const event of ['pagehide','pageshow','resize'])win.addEventListener?.(event,invalidate);
  connect();
  return {
    read(){connect();return {epoch,cacheAllowed:!stopped&&ready&&typeof extraGpp!=='function'&&typeof extraUsp!=='function'};},
    snapshot(){return {epoch,ready:!stopped&&ready,cacheAllowed:!stopped&&ready&&typeof extraGpp!=='function'&&typeof extraUsp!=='function',stopped};},
    stop(){if(stopped)return;stopped=true;ready=false;signature=null;advance();remove(api,listenerId);listenerId=null;
      for(const event of ['pagehide','pageshow','resize'])win.removeEventListener?.(event,invalidate);}
  };
}
