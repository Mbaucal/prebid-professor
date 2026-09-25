// CI only: queued before the native dependency loads. The packaged Prebid bytes
// and SRI remain exact. Replace two adapters with synthetic, intercepted responses.
window.pbjs={que:[function(){
  const rounds=new Map();
  window.__fixtureBidRounds=rounds;
  for(const name of ['pubmatic','openx'])pbjs.registerBidAdapter(null,name,{
    code:name,supportedMediaTypes:['banner'],isBidRequestValid:()=>true,
    buildRequests(bids){return {method:'GET',url:'https://readiness-fixture.invalid/bid',
      data:{payload:JSON.stringify(bids.map(b=>{
        const round=(rounds.get(name+':'+b.adUnitCode)||0)+1;rounds.set(name+':'+b.adUnitCode,round);
        const cpm=window.__positionCacheTest&&round===4?(name==='pubmatic'?12:.5):round===1?(name==='pubmatic'?10:4):(name==='pubmatic'?1:.5);
        const size=b.mediaTypes.banner.sizes.find(s=>Array.isArray(s)&&s[0]>1);
        return {requestId:b.bidId,cpm,ttl:120,width:size[0],height:size[1],fixtureRound:round,fixtureCode:b.adUnitCode};
      }))},options:{withCredentials:false}};},
    interpretResponse(response){return response.body.bids;}
  });
}]};
