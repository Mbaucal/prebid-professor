// Test-only GPT/TCF/visibility facade. Real pinned Prebid performs every auction.
delete window.pbjs;
googletag.apiReady=true;googletag.pubadsReady=true;
const cmpListeners=new Map();let cmpId=0;
window.fixtureConsent={gdprApplies:false,cmpStatus:'loaded',eventStatus:'tcloaded'};
window.__tcfapi=(command,version,callback,id)=>{
  if(command==='addEventListener'){const key=++cmpId;cmpListeners.set(key,callback);callback({...fixtureConsent,listenerId:key},true);}
  else if(command==='removeEventListener'){cmpListeners.delete(id);callback(true);}
};
window.fixtureEmitConsent=(patch,ok=true)=>{
  fixtureConsent={...fixtureConsent,...patch};
  for(const [id,cb] of [...cmpListeners])cb({...fixtureConsent,listenerId:id},ok);
};
window.changeFixtureConsent=()=>fixtureEmitConsent({eventStatus:'useractioncomplete',addtlConsent:'synthetic-change'});
const observers=[];
window.IntersectionObserver=class{
  constructor(callback,options={}){this.callback=callback;this.options=options;this.elements=new Set();observers.push(this);}
  observe(el){this.elements.add(el);}unobserve(el){this.elements.delete(el);}disconnect(){this.elements.clear();}
};
window.fixtureIntersect=(id,margin)=>{
  for(const observer of [...observers])if((margin===undefined||observer.options.rootMargin===margin)&&[...observer.elements].some(e=>e.id===id)){
    const el=document.getElementById(id);observer.callback([{target:el,isIntersecting:true,intersectionRatio:1,boundingClientRect:el.getBoundingClientRect()}],observer);
  }
};
window.fixtureObserverMargins=()=>observers.filter(o=>[...o.elements].some(e=>e.id==='P1')).map(o=>o.options.rootMargin??'');
window.fixtureNext={pubmatic:{cpm:10,ttl:300},openx:{cpm:4,ttl:300}};
window.fixtureRequests=[];window.fixtureBids=[];
__testAds.service.addEventListener('slotRequested',({slot})=>{
  const id=slot.getTargeting('hb_adid')[0],bid=id?pbjs.getBidResponseByAdId(id):null;
  fixtureRequests.push({id:slot.id,cpm:bid?.cpm??null,status:bid?.status??null,ageMs:bid?Date.now()-bid.responseTimestamp:null,
    version:slot.getTargeting('hb_ver'),experiment:slot.getTargeting('Varijant').length?slot.getTargeting('Varijant'):slot.getTargeting('tessera_ab'),publicVariant:slot.getTargeting('Varijant'),legacyExperiment:slot.getTargeting('tessera_ab')});
});
window.installFixtureAdapters=()=>{
  for(const bidder of ['pubmatic','openx'])pbjs.registerBidAdapter(null,bidder,{
    code:bidder,supportedMediaTypes:['banner'],isBidRequestValid:()=>true,
    buildRequests(bids){return {method:'GET',url:'https://cache-fixture.invalid/bid',data:{payload:JSON.stringify(bids.map(b=>({
      requestId:b.bidId,code:b.adUnitCode,...fixtureNext[bidder],width:b.mediaTypes.banner.sizes[0][0],height:b.mediaTypes.banner.sizes[0][1]
    })))},options:{withCredentials:false}};},interpretResponse(response){return response.body.bids;}
  });
  pbjs.onEvent('bidResponse',b=>fixtureBids.push({code:b.adUnitCode,cpm:b.cpm}));
};
