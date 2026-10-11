
window.__enforcement=[];window.__requests=[];window.__sent=[];window.__bids=[];window.__errors=[];window.__cmps=[];window.__auctionEnds=[];
function tc(allow){
 const bits=(n,w)=>Number(n).toString(2).padStart(w,'0');
 let s=bits(2,6)+bits(17909856000,36)+bits(17909856000,36)+bits(1,12)+bits(1,12)+bits(0,6)+bits(4,6)+bits(13,6)+bits(1,12)+bits(4,6)+'10'+'0'.repeat(12)+(allow?'1':'0').repeat(24)+'0'.repeat(24)+'0'+bits(4,6)+bits(4,6)+bits(1000,16)+'0'+(allow?'1':'0').repeat(1000)+bits(1000,16)+'0'+'0'.repeat(1000)+bits(0,12);
 s=s.padEnd(Math.ceil(s.length/8)*8,'0');return btoa(s.match(/.{8}/g).map(x=>String.fromCharCode(parseInt(x,2))).join('')).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
window.decision=kind=>kind==='outside'?{gdprApplies:false,cmpStatus:'loaded',eventStatus:'tcloaded',tcfPolicyVersion:4,cmpId:1,cmpVersion:1}:{gdprApplies:true,cmpStatus:'loaded',eventStatus:'useractioncomplete',tcfPolicyVersion:4,cmpId:1,cmpVersion:1,tcString:tc(kind==='accept'),purpose:{consents:Object.fromEntries(Array.from({length:24},(_,i)=>[i+1,kind==='accept'])),legitimateInterests:{}},vendor:{consents:Object.fromEntries(Array.from({length:1000},(_,i)=>[i+1,kind==='accept'])),legitimateInterests:{}}};
window.makeCmp=(name,kind=null)=>{
 const cmp={name,data:kind?decision(kind):null,live:new Map(),all:[],calls:[],seq:0};
 cmp.api=(cmd,v,cb,id)=>{cmp.calls.push({cmd,id:id??null});if(cmd==='addEventListener'){const n=++cmp.seq;cmp.live.set(n,cb);cmp.all.push({id:n,cb});if(cmp.data)cb({...cmp.data,listenerId:n},true);}else if(cmd==='removeEventListener'){cmp.live.delete(id);cb(true);}else if(cmd==='ping')cb({cmpLoaded:true,cmpStatus:'loaded',gdprApplies:cmp.data?.gdprApplies},true);else if(cmd==='getTCData')cb(cmp.data,!!cmp.data);};
 cmp.emit=kind=>{cmp.data=decision(kind);for(const [id,cb] of [...cmp.live])cb({...cmp.data,listenerId:id},true);};
 cmp.stale=kind=>{for(const {id,cb} of cmp.all)cb({...decision(kind),listenerId:id},true);};
 __cmps.push(cmp);return cmp;
};
window.install=(cmp)=>{window.__tcfapi=cmp.api;};

window.__now=1790985600000;window.__invalidations=[];window.__targeting={};window.__dispatches=[];window.__nativeCalls=[];window.__done=0;window.__attempts=0;
window.__site='geo-fixture';window.__page='page_00001';window.__nonce='nonce_00001';
window.startController=async function(scope){
 const geo=await fetchTrustedGeo({endpoint:'https://geo-scope.test/v1',siteId:__site,pageId:__page,nonce:__nonce,now:()=>__now});
 window.controller=createGeoCmpFallback({geo,siteId:__site,pageId:__page,nonce:__nonce,now:()=>__now,waitMs:30000,onInvalidate:s=>{__invalidations.push(s);__targeting={};}});
 window.loading={cmpStatus:'loading',gdprApplies:scope,listenerId:1};
 window.cmpCallbacks=[];window.cmpApiCalls=[];
 window.__tcfapi=(cmd,v,cb,id)=>{cmpApiCalls.push(cmd);if(cmd==='addEventListener'){cmpCallbacks.push(cb);cb(loading,true);}else if(cmd==='removeEventListener')cb(true);};
 window.emit=data=>{loading=data;cmpCallbacks.forEach(cb=>cb(data,true));};
 __tcfapi('addEventListener',2,(d,ok)=>controller.observeCmp(d,ok));
 window.originalApi=__tcfapi;
};
window.advanceLoading=()=>{for(let i=0;i<35;i++){__now+=1000;emit(loading);}};
window.nativeConfigured=false;
window.ask=()=>{
 __attempts++;const mode=controller.selectNativeMode();if(!mode)return false;
 if(!nativeConfigured){
  pbjs.setConfig({deviceAccess:false,userSync:{syncEnabled:false},consentManagement:{gdpr:{cmpApi:mode.mode,defaultGdprScope:true,timeout:200,actionTimeout:200,...(mode.mode==='static'?{consentData:{getTCData:mode.consentData}}:{})}}});nativeConfigured=true;
  pbjs.onEvent('bidRequested',r=>__nativeCalls.push({gdprApplies:r.gdprConsent?.gdprApplies,tcStringPresent:!!r.gdprConsent?.consentString}));
 }
 const epoch=controller.snapshot().epoch;if(!controller.canRequest(epoch))return false;
 pbjs.requestBids({adUnits:[{code:'Billboard',mediaTypes:{banner:{sizes:[[300,250]]}},bids:[{bidder:'pubmatic',params:{publisherId:'fixture',adSlot:'fixture'}}]}],timeout:1500,bidsBackHandler:()=>{
  __done++;if(!controller.canRequest(epoch)){__targeting={};return;}
  __targeting=pbjs.getAdserverTargetingForAdUnitCode('Billboard')||{};
  if(controller.canRequest(epoch))__dispatches.push({epoch,targetingKeys:Object.keys(__targeting)});
 }});return true;
};
window.nativeReport=()=>({state:controller.snapshot(),nativeCalls:__nativeCalls,simulatedDispatches:__dispatches,invalidations:__invalidations,attempts:__attempts,completedCallbacks:__done,cmpApiCalls,apiUnchanged:__tcfapi===originalApi,enabled:pbjs.getConfig('consentManagement')?.gdpr?.enabled!==false,nativeMode:pbjs.getConfig('consentManagement')?.gdpr?.cmpApi||null});
