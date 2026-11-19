// CI only: queued before the native dependency loads. The packaged Prebid bytes
// and SRI remain exact. Replace two adapters with synthetic, intercepted responses.
window.pbjs={que:[function(){
  const rounds=new Map();
  window.__fixtureBidRounds=rounds;
  // Observation only: preserve each adapter request's identity at construction.
  // Counters at a later GPT dispatch are not authoritative auction lineage.
  const trace=window.__fixtureBidTrace=[];
  const callbacks=window.__fixtureCallbackTrace=[];
  const requestBids=pbjs.requestBids;
  const observedRequestBids=function(input,...rest){
    if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.bidsBackHandler!=='function')return requestBids.call(this,input,...rest);
    const callback=input.bidsBackHandler;
    const codes=Object.freeze([...(input.adUnitCodes||input.adUnits?.map(unit=>unit.code)||[])]);
    return requestBids.call(this,{...input,bidsBackHandler:function(...args){
      const previous=window.__fixtureCallbackContext;
      const context=Object.freeze({auctionId:typeof args[2]==='string'?args[2]:null,codes,at:Date.now()});
      callbacks.push(context);window.__fixtureCallbackContext=context;
      try{return callback.apply(this,args);}
      finally{window.__fixtureCallbackContext=previous;}
    }},...rest);
  };
  for(const key of Reflect.ownKeys(requestBids)){
    if(!Object.hasOwn(observedRequestBids,key))Object.defineProperty(observedRequestBids,key,Object.getOwnPropertyDescriptor(requestBids,key));
  }
  pbjs.requestBids=observedRequestBids;
  for(const name of ['pubmatic','openx'])pbjs.registerBidAdapter(null,name,{
    code:name,supportedMediaTypes:['banner'],isBidRequestValid:()=>true,
    buildRequests(bids,bidderRequest){return {method:'GET',url:'https://readiness-fixture.invalid/bid',
      data:{payload:JSON.stringify(bids.map(b=>{
        const round=(rounds.get(name+':'+b.adUnitCode)||0)+1;rounds.set(name+':'+b.adUnitCode,round);
        trace.push(Object.freeze({bidder:name,code:b.adUnitCode,round,requestId:b.bidId,
          bidAuctionId:b.auctionId||null,bidderAuctionId:bidderRequest?.auctionId||null,
          bidderRequestId:bidderRequest?.bidderRequestId||null,at:Date.now()}));
        const cpm=window.__positionCacheTest&&round===4?(name==='pubmatic'?12:.5):round===1?(name==='pubmatic'?10:4):(name==='pubmatic'?1:.5);
        const size=b.mediaTypes.banner.sizes.find(s=>Array.isArray(s)&&s[0]>1);
        return {requestId:b.bidId,cpm,ttl:120,width:size[0],height:size[1],fixtureRound:round,fixtureCode:b.adUnitCode};
      }))},options:{withCredentials:false}};},
    interpretResponse(response){return response.body.bids;}
  });
}]};
