// CI only: queued before the native dependency loads. The packaged Prebid bytes
// and SRI remain exact. Replace two adapters with synthetic, intercepted responses.
window.pbjs={que:[function(){
  for(const name of ['pubmatic','openx'])pbjs.registerBidAdapter(null,name,{
    code:name,supportedMediaTypes:['banner'],isBidRequestValid:()=>true,
    buildRequests(bids){return {method:'GET',url:'https://readiness-fixture.invalid/bid',
      data:{payload:JSON.stringify(bids.map(b=>({requestId:b.bidId,cpm:name==='pubmatic'?1:.5,ttl:120,
        width:b.mediaTypes.banner.sizes[0][0],height:b.mediaTypes.banner.sizes[0][1]})))},options:{withCredentials:false}};},
    interpretResponse(response){return response.body.bids;}
  });
}]};
