// Synthetic adapters + GPT slots. The real vendored Prebid core does auctions
// and targeting; Playwright fulfills every fixture adapter URL without network.
window.fixtureState={epoch:0,sizes:[[300,250]],next:{a:{cpm:10,ttl:300},b:{cpm:4,ttl:300}}};
function fixtureSlot(id,path){
  const values={publisher:['preserved'],tessera_ab:['synthetic-experiment']};
  return {getSlotElementId:()=>id,getAdUnitPath:()=>path,getTargetingKeys:()=>Object.keys(values),getTargeting:key=>values[key]||[],
    setTargeting(key,value){values[key]=Array.isArray(value)?value.map(String):[String(value)];return this;},clearTargeting(key){delete values[key];return this;}};
}
window.fixtureSlots={P1:fixtureSlot('P1','/fixture/P1'),P2:fixtureSlot('P2','/fixture/P2')};
window.foreignSlot=fixtureSlot('foreign','P1'); // same GAM path must not leak targeting
window.googletag={apiReady:true,pubadsReady:true,cmd:{push:fn=>fn()},pubads:()=>({getSlots:()=>[...Object.values(fixtureSlots),foreignSlot]})};
window.setupCacheFixture=function(mode='auction-with-cache',maxAgeSeconds=30){
  pbjs.setConfig({deviceAccess:false,enableSendAllBids:false,priceGranularity:'high',userSync:{syncEnabled:false},
    consentManagement:{gdpr:{enabled:false}},currency:{adServerCurrency:'USD',rates:{USD:{USD:1}}},targetingControls:{alwaysIncludeDeals:true}});
  for(const name of ['a','b'])pbjs.registerBidAdapter(null,'cachefixture'+name,{
    code:'cachefixture'+name,supportedMediaTypes:['banner'],isBidRequestValid:()=>true,
    buildRequests(bids){return {method:'GET',url:'https://cache-fixture.invalid/bid',data:{payload:JSON.stringify(bids.map(b=>({requestId:b.bidId,...fixtureState.next[name],width:b.mediaTypes.banner.sizes[0][0],height:b.mediaTypes.banner.sizes[0][1]})))},options:{withCredentials:false}};},
    interpretResponse(response){return response.body.bids;}
  });
  window.cachePolicy=createBidCachePolicy({pbjs,siteId:'cache-fixture',mode,maxAgeSeconds,
    contextForCode:code=>fixtureSlots[code]?{epoch:fixtureState.epoch,sizes:fixtureState.sizes,slot:fixtureSlots[code]}:null});
};
window.fixtureAuction=function(next,code='P1'){
  fixtureState.next=next;
  // Match the existing wrapper's removeAdUnit + requestBids lifecycle.
  pbjs.removeAdUnit(code);
  return new Promise(resolve=>pbjs.requestBids({timeout:1000,adUnits:[{code,mediaTypes:{banner:{sizes:fixtureState.sizes}},bids:[{bidder:'cachefixturea',params:{}},{bidder:'cachefixtureb',params:{}}]}],bidsBackHandler:()=>resolve()}));
};
window.fixtureTarget=function(code='P1'){
  const ok=cachePolicy.target(code),id=fixtureSlots[code].getTargeting('hb_adid')[0],bid=id?pbjs.getBidResponseByAdId(id):null;
  return {ok,cpm:bid?.cpm??null,auctionId:bid?.auctionId??null,status:bid?.status??null,snapshot:cachePolicy.snapshot(),publisher:fixtureSlots[code].getTargeting('publisher'),foreign:foreignSlot.getTargeting('hb_adid')};
};
