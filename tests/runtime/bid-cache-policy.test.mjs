import test from 'node:test';
import assert from 'node:assert/strict';
import { createBidCachePolicy } from '../../worker/runtime-cache/policy.mjs';
function fixture(options={}){
  let time=10000,epoch=0,sizes=[[300,250]],targetCalls=0;
  const values={publisher:['keep'],hb_old:['stale']},slot={getTargetingKeys:()=>Object.keys(values),getTargeting:k=>values[k]||[],clearTargeting:k=>delete values[k]};
  const config={},events=new Map(),bid={adId:'private-ad-id',adUnitCode:'P1',auctionId:'old',mediaType:'banner',status:'good',width:300,height:250,responseTimestamp:9900,ttl:60};
  const pbjs={version:'v11.34.0',getConfig:k=>config[k],setConfig:c=>Object.assign(config,c),onEvent:(n,f)=>events.set(n,f),offEvent:(n,f)=>{if(events.get(n)===f)events.delete(n);},
    setTargetingForGPTAsync:()=>{targetCalls++;bid.status='targetingSet';values.hb_adid=[bid.adId];},getBidResponseByAdId:()=>bid};
  const policy=createBidCachePolicy({pbjs,siteId:'test-site',contextForCode:code=>code==='P1'?{slot,epoch,sizes}:null,mode:'auction-with-cache',now:()=>time,...options});
  const auction=id=>events.get('auctionInit')?.({auctionId:id,adUnitCodes:['P1']});auction('old');auction('new');
  return {policy,config,pbjs,slot,bid,values,events,auction,targetCalls:()=>targetCalls,advance:n=>time+=n,epoch:n=>epoch=n,sizes:s=>sizes=s};
}
test('cache eligibility is limited to tracked page/slot/context, banner size and bid lifetime',()=>{
  const f=fixture(),accept=patch=>f.config.bidCacheFilterFunction({...f.bid,...patch});
  assert(accept({}));
  for(const patch of [{mediaType:'video'},{status:'targetingSet'},{status:'rendered'},{status:'bidRejected'},{adUnitCode:'P2'},{auctionId:'untracked'},{width:728},{ttl:0},{ttl:NaN},{responseTimestamp:NaN},{responseTimestamp:10001}])assert.equal(accept(patch),false);
  f.epoch(1);assert.equal(accept({}),false);f.epoch(0);
  f.sizes([[300,250],[300,600]]);assert.equal(accept({}),false);f.sizes([[300,250]]);
  f.advance(29900);assert.equal(accept({}),false);
  const s=f.policy.snapshot();assert.equal(s.checks.accepted,1);assert(s.checks.rejected.used===3);assert(s.checks.rejected.context===1);
  assert(!JSON.stringify(s).includes('private-ad-id'));s.checks.rejected.used=999;assert.equal(f.policy.snapshot().checks.rejected.used,3);
});
test('native targeting marks submitted bids, clears only hb keys and blocks a second submission in the same auction',()=>{
  const f=fixture();assert.equal(f.policy.target('P1'),true);assert.equal(f.targetCalls(),1);
  assert.equal(f.values.hb_old,undefined);assert.deepEqual(f.values.publisher,['keep']);assert.equal(f.bid.status,'targetingSet');
  assert.equal(f.policy.snapshot().selections.cache,1);assert.equal(f.policy.snapshot().lastSelection.ageMs,100);
  assert.equal(f.policy.target('P1'),false);assert.equal(f.targetCalls(),1);assert.equal(f.policy.snapshot().selections.blockedDuplicates,1);
  assert.deepEqual(f.values.hb_adid,['private-ad-id']); // leave the already-submitted request intact
});
test('consent/size changes during an auction and overwritten configuration fail closed',()=>{
  for(const change of [f=>f.epoch(1),f=>f.sizes([[728,90]]),f=>f.config.customGptSlotMatching=()=>()=>true,f=>f.config.useBidCache=false]){
    const f=fixture();change(f);assert.equal(f.policy.target('P1'),false);assert.equal(f.targetCalls(),0);assert.equal(f.values.hb_old,undefined);assert.equal(f.policy.snapshot().selections.errors,1);
  }
});
test('bounded tracking, explicit fresh-only mode and teardown cannot silently turn caching on',()=>{
  const f=fixture({mode:'fresh-only'});assert.equal(f.config.useBidCache,false);assert.equal(f.config.bidCacheFilterFunction(f.bid),false);
  for(let i=0;i<300;i++)f.auction('auction-'+i);assert.equal(f.policy.snapshot().trackedAuctions,128);
  f.policy.stop();f.policy.stop();assert.equal(f.config.useBidCache,false);assert.equal(f.events.size,0);assert.equal(f.policy.target('P1'),false);assert.equal(f.policy.snapshot().trackedAuctions,0);
  assert.throws(()=>createBidCachePolicy({pbjs:{version:'11.33.0'}}),/11.34.0/);
  assert.throws(()=>fixture({mode:'cache-first'}),/Unsupported/);
  assert.throws(()=>fixture({maxAgeSeconds:0}),/Unsupported/);
});
test('submitted-ID capacity disables cached reuse rather than forgetting consumed offers',()=>{
  const f=fixture();
  for(let i=0;i<4097;i++){
    f.bid.adId='submitted-'+i;f.bid.auctionId='round-'+i;f.bid.status='good';f.auction(f.bid.auctionId);
    assert.equal(f.policy.target('P1'),true);
  }
  assert.equal(f.policy.snapshot().capacityBlocked,true);assert.equal(f.policy.snapshot().trackedSubmittedBids,0);
  assert.equal(f.config.bidCacheFilterFunction({...f.bid,status:'good'}),false);
  f.bid.auctionId='another-fresh-auction';f.auction(f.bid.auctionId);assert.equal(f.policy.target('P1'),true);
});
