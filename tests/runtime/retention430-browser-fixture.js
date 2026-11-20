/* MBA-430 isolated fixture. No bidder/GPT library or paid demand is loaded here.
 * Observation queues contain scalars only and are drained by Python before GC. */
(() => {
  const options=window.__retention430Options,slots=[],listeners=new Map(),pageTargeting=new Map();
  const probe=window.__retention430={counts:{gam:0,bidder:0,responses:0,auctions:0,rendered:0,expired:0,renderFailed:0},
    dispatches:[],wire:[],renders:[],rounds:{},pendingRenders:0,lastDispatchAt:null};
  const emit=(type,event)=>{for(const callback of listeners.get(type)||[])callback(event);};
  const visibility=(slot,rendered)=>{
    const rect=document.getElementById(slot.id)?.getBoundingClientRect();
    const pct=rect?.height>0?Math.max(0,Math.min(rect.bottom,innerHeight)-Math.max(rect.top,0))/rect.height*100:0;
    emit('slotVisibilityChanged',{slot,inViewPercentage:pct});
    if(rendered&&document.visibilityState==='visible'&&pct>=50)emit('impressionViewable',{slot});
  };
  const service={
    addEventListener(type,callback){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(callback);return this;},
    removeEventListener(type,callback){listeners.get(type)?.delete(callback);return this;},getSlots:()=>slots.slice(),
    setTargeting(key,value){pageTargeting.set(key,Array.isArray(value)?value:[String(value)]);return this;},
    getTargeting:key=>pageTargeting.get(key)||[],getTargetingKeys:()=>[...pageTargeting.keys()],
    clearTargeting(key){pageTargeting.delete(key);return this;},
    collapseEmptyDivs(){},setCentering(){},disableInitialLoad(){},enableSingleRequest(){},setPrivacySettings(){},setPublisherProvidedId(){},
    refresh(list){for(const slot of list||[]){
      const id=slot.getTargeting('hb_adid')[0],bid=id&&window.pbjs?.getBidResponseByAdId?.(id);
      probe.counts.gam++;probe.lastDispatchAt=Date.now();
      probe.dispatches.push({code:slot.id,at:Date.now(),bidId:id||null,cpm:bid?.cpm??null,
        bidCode:bid?.adUnitCode??null,bidAuction:bid?.auctionId??null,
        responseAt:bid?.responseTimestamp??null,ttl:bid?.ttl??null,
        targets:Object.fromEntries(slot.getTargetingKeys().filter(key=>key==='hb_adid'||key.startsWith('hb_adid_')).map(key=>[key,slot.getTargeting(key)]))});
      emit('slotRequested',{slot});
      // GAM can finish inserting a creative before its PUC/native render begins.
      setTimeout(()=>{emit('slotResponseReceived',{slot});emit('slotRenderEnded',{slot,isEmpty:false,size:[300,250],lineItemId:1});emit('slotOnload',{slot});},10);
      // Model GPT's visible-impression input as well as its render lifecycle.
      // The runtime still owns every refresh decision and dispatch.
      setTimeout(()=>visibility(slot,false),1010);
      if(id&&options.autoRender){
        probe.pendingRenders++;
        setTimeout(()=>{probe.pendingRenders--;probe.render(id,slot.id);},options.renderDelayMs);
      }
    }},
  };
  function slot(path,sizes,id){
    const targeting={},s={id,path,sizes,addService(){return this;},defineSizeMapping(){return this;},
      setConfig(config){for(const [key,value]of Object.entries(config.targeting||{}))if(value==null)delete targeting[key];else targeting[key]=value;return this;},
      getConfig:()=>({targeting}),setTargeting(key,value){targeting[key]=value;return this;},
      getTargeting(key){const value=targeting[key];return value==null?[]:Array.isArray(value)?value:[String(value)];},
      getTargetingKeys:()=>Object.keys(targeting),clearTargeting(key){delete targeting[key];},
      getAdUnitPath:()=>path,getSlotElementId:()=>id,getSizes:()=>sizes,
      getResponseInformation:()=>({lineItemId:1,creativeId:1,advertiserId:1})};
    slots.push(s);return s;
  }
  window.googletag={cmd:{push:callback=>callback()},pubads:()=>service,
    setConfig(config){for(const [key,value]of Object.entries(config.targeting||{}))if(value==null)pageTargeting.delete(key);else service.setTargeting(key,value);},
    getConfig:()=>({targeting:Object.fromEntries(pageTargeting)}),enableServices(){},
    defineSlot:slot,display(){},destroySlots(list){for(const s of list){const i=slots.indexOf(s);if(i>=0)slots.splice(i,1);}return true;},
    defineOutOfPageSlot:()=>null,sizeMapping(){return{addSize(){return this;},build:()=>[]};},enums:{OutOfPageFormat:{INTERSTITIAL:1}}};
  window.__tcfapi=(command,version,callback)=>{
    if(command==='addEventListener'||command==='getTCData')callback({gdprApplies:false,listenerId:1,tcfPolicyVersion:4,cmpId:1,cmpVersion:1},true);
    else if(command==='ping')callback({cmpLoaded:true,gdprApplies:false,cmpStatus:'loaded'},true);
    else callback(true);
  };
  window.__AD_GEO={version:1,getSnapshot:()=>({version:1,status:'known',country:'RS',source:'synthetic'}),ready:()=>Promise.resolve({version:1,status:'known',country:'RS'})};
  window.__inflight430=0;
  const fetch=window.fetch.bind(window);window.fetch=(...args)=>{window.__inflight430++;return fetch(...args).finally(()=>window.__inflight430--);};
  const send=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send=function(...args){window.__inflight430++;this.addEventListener('loadend',()=>window.__inflight430--,{once:true});return send.apply(this,args);};
  probe.render=(id,code)=>{
    const bid=pbjs.getBidResponseByAdId(id),host=document.getElementById(code)||document.body;
    host.querySelectorAll('iframe[data-retention430]').forEach(frame=>frame.remove());
    const frame=document.createElement('iframe');frame.dataset.retention430='true';host.appendChild(frame);
    frame.contentDocument.open();frame.contentDocument.write('<!doctype html><html><body></body></html>');frame.contentDocument.close();
    probe.renders.push({kind:'attempt',code,bidId:id,at:Date.now(),found:!!bid,
      ageMs:bid?Date.now()-bid.responseTimestamp:null,ttl:bid?.ttl??null});
    pbjs.renderAd(frame.contentDocument,id);
  };
  window.pbjs={que:[()=>{
    pbjs.setConfig({...options.policy,debug:false,userSync:{syncEnabled:false,userIds:[]}});
    if(options.ttlBuffer!==null)pbjs.setConfig({ttlBuffer:options.ttlBuffer});
    if(options.suppressExpiredRender!==null)pbjs.setConfig({auctionOptions:{suppressExpiredRender:options.suppressExpiredRender}});
    for(const [event,count]of [['auctionInit','auctions'],['bidRequested','bidder'],['bidResponse','responses'],['adRenderSucceeded','rendered'],['expiredRender','expired'],['adRenderFailed','renderFailed']]){
      pbjs.onEvent(event,row=>{
        probe.counts[count]++;
        if(event==='adRenderSucceeded'){
          // Keep only a scalar code in this short-lived fixture timer. Report
          // a viewable impression one second after actual native rendering.
          const code=row.bid.adUnitCode;
          setTimeout(()=>{const slot=slots.find(value=>value.id===code);if(slot)visibility(slot,true);},1000);
        }
        if(['adRenderSucceeded','expiredRender','adRenderFailed'].includes(event))probe.renders.push({kind:event,bidId:row.adId,at:Date.now(),reason:row.reason||null});
      });
    }
    for(const name of ['pubmatic','openx'])pbjs.registerBidAdapter(null,name,{
      code:name,gvlid:name==='pubmatic'?76:69,supportedMediaTypes:['banner'],isBidRequestValid:()=>true,
      buildRequests(bids,request){
        const payload=bids.flatMap(bid=>{
          const key=name+':'+bid.adUnitCode,round=(probe.rounds[key]||0)+1;probe.rounds[key]=round;
          probe.wire.push({bidder:name,code:bid.adUnitCode,round,auctionId:request.auctionId,requestId:bid.bidId});
          const index=(round-1)%4,cpms=name==='pubmatic'?[[10,4],[1],[2],[12]][index]:[0.5];
          const size=bid.mediaTypes.banner.sizes.find(value=>Array.isArray(value)&&value[0]>1);
          return cpms.map(cpm=>({requestId:bid.bidId,cpm,ttl:options.bidTTL,width:size[0],height:size[1],round}));
        });
        return{method:'GET',url:options.bidUrl,options:{withCredentials:false},data:{payload:JSON.stringify(payload)}};
      },interpretResponse:response=>response.body.bids,
    });
  }]};
})();
//# sourceURL=retention430-browser-fixture.js
