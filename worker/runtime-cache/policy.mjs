// Development policy only. No existing runtime imports this module.
// The future versioned compiler must supply a context epoch that changes with
// consent/eligibility and derive sizes + slot identity from its owned live slot.
export function createBidCachePolicy({pbjs,siteId,contextForCode,cacheAllowed=()=>true,mode='fresh-only',maxAgeSeconds=30,now=Date.now}) {
  if(!pbjs||!/^v?11\.34\.0$/.test(pbjs.version||''))throw Error('This candidate requires the reviewed Prebid 11.34.0 build.');
  if(typeof siteId!=='string'||!siteId||typeof contextForCode!=='function'||typeof cacheAllowed!=='function'||typeof now!=='function')throw Error('Explicit site and eligibility context are required.');
  if(!['fresh-only','auction-with-cache'].includes(mode)||!Number.isInteger(maxAgeSeconds)||maxAgeSeconds<1||maxAgeSeconds>300)throw Error('Unsupported bid cache policy.');
  for(const name of ['setConfig','getConfig','onEvent','offEvent','setTargetingForGPTAsync','getBidResponseByAdId'])if(typeof pbjs[name]!=='function')throw Error('Required Prebid API unavailable: '+name);
  if(pbjs.getConfig('bidCacheFilterFunction')||pbjs.getConfig('customGptSlotMatching'))throw Error('Review existing custom bid-cache or GPT matching rules before installing this policy.');
  const auctions=new Map(),latest=new Map(),submitted=new Map(),limit=128,submittedLimit=4096;
  const checks={accepted:0,rejected:{}},selections={fresh:0,cache:0,none:0,errors:0,blockedDuplicates:0};
  let stopped=false,lastSelection=null,capacityBlocked=false;
  const increment=(object,key)=>{object[key]=Math.min(Number.MAX_SAFE_INTEGER,(object[key]||0)+1);};
  function context(code) {
    try{
      const c=contextForCode(code);
      if(!c||!Number.isSafeInteger(c.epoch)||c.epoch<0||!c.slot||!Array.isArray(c.sizes)||c.sizes.length<1||c.sizes.length>32)return null;
      if(c.sizes.some(s=>!Array.isArray(s)||s.length!==2||!s.every(v=>Number.isInteger(v)&&v>1&&v<=10000)))return null;
      return {epoch:c.epoch,slot:c.slot,sizes:c.sizes.map(s=>s.join('x')).sort(),targeted:false};
    }catch{return null;}
  }
  function auctionInit(event) {
    if(stopped||typeof event?.auctionId!=='string')return;
    const codes=event.adUnitCodes||event.adUnits?.map(u=>u.code);
    if(!Array.isArray(codes)||codes.length>100)return;
    const contexts=new Map();
    for(const code of codes){const c=context(code);if(c){contexts.set(code,c);latest.set(code,event.auctionId);}}
    auctions.set(event.auctionId,contexts);
    while(auctions.size>limit)auctions.delete(auctions.keys().next().value);
    // Retain only tracked codes; page memory remains bounded by the auction cap.
    for(const [code,id] of latest)if(!auctions.has(id))latest.delete(code);
  }
  function reason(bid) {
    if(stopped||mode!=='auction-with-cache')return 'disabled';
    try{if(cacheAllowed()!==true)return 'consent';}catch{return 'consent';}
    if(capacityBlocked)return 'capacity';
    if(!bid||bid.mediaType!=='banner')return 'format';
    if(submitted.has(bid.adId))return 'used';
    if(['targetingSet','rendered','bidRejected'].includes(bid.status))return 'used';
    const before=auctions.get(bid.auctionId)?.get(bid.adUnitCode),current=context(bid.adUnitCode);
    if(!before||!current)return 'untracked';
    if(before.slot!==current.slot||before.epoch!==current.epoch)return 'context';
    if(before.sizes.join(',')!==current.sizes.join(',')||!current.sizes.includes(bid.width+'x'+bid.height))return 'size';
    const age=now()-bid.responseTimestamp;
    if(!Number.isFinite(age)||age<0||!Number.isFinite(bid.ttl)||bid.ttl<=0||age>=bid.ttl*1000||age>=maxAgeSeconds*1000)return 'expired';
    return null; // Prebid still applies its native TTL buffer/status/auction rules.
  }
  function filter(bid) {
    const why=reason(bid);
    if(why){increment(checks.rejected,why);return false;}
    increment(checks,'accepted');return true;
  }
  function match(slot){return code=>!stopped&&context(code)?.slot===slot;}
  function clear(slot){for(const key of slot.getTargetingKeys())if(key.startsWith('hb_'))slot.clearTargeting(key);}
  pbjs.onEvent('auctionInit',auctionInit);
  try{pbjs.setConfig({useBidCache:mode==='auction-with-cache',bidCacheFilterFunction:filter,customGptSlotMatching:match});}
  catch(error){pbjs.offEvent('auctionInit',auctionInit);throw error;}
  return {
    // Native targeting marks the primary bid targetingSet; also record every
    // secondary/deal offer submitted. Do not mark any of them rendered here.
    target(code,auctionId) {
      if(stopped)return false;
      const c=context(code);if(!c){increment(selections,'errors');return false;}
      let stage='clear-targeting';
      try{
        const started=auctions.get(latest.get(code))?.get(code);
        if(started?.targeted){increment(selections,'blockedDuplicates');return false;}
        clear(c.slot);
        stage='context-changed';
        if(auctionId!==undefined&&latest.get(code)!==auctionId)throw Error('Auction ownership changed.');
        if(!started||started.epoch!==c.epoch||started.slot!==c.slot||started.sizes.join(',')!==c.sizes.join(','))throw Error('Eligibility changed during the auction.');
        stage='configuration-changed';
        if(pbjs.getConfig('customGptSlotMatching')!==match||pbjs.getConfig('bidCacheFilterFunction')!==filter||pbjs.getConfig('useBidCache')!==(mode==='auction-with-cache'))throw Error('Policy configuration changed.');
        started.targeted=true;
        stage='native-targeting';
        pbjs.setTargetingForGPTAsync([code]);
        stage='targeting-status';
        const ids=new Set(c.slot.getTargetingKeys().filter(k=>k==='hb_adid'||k.startsWith('hb_adid_')).flatMap(k=>c.slot.getTargeting(k)||[]));
        if(!ids.size){increment(selections,'none');lastSelection={code,origin:'none',ageMs:null};return true;}
        for(const [id,expiry] of submitted)if(expiry<=now())submitted.delete(id);
        const primary=(c.slot.getTargeting('hb_adid')||[])[0];
        for(const id of ids){
          const bid=pbjs.getBidResponseByAdId(id);
          if(!bid||bid.adUnitCode!==code||(id===primary&&bid.status!=='targetingSet'))throw Error('Targeting status was not recorded.');
          // Prebid marks the primary bid targetingSet; secondary/deal targeting
          // is tracked here too, without falsely marking it rendered.
          if(submitted.size>=submittedLimit){capacityBlocked=true;submitted.clear();}
          if(!capacityBlocked)submitted.set(id,now()+maxAgeSeconds*1000);
          if(id!==primary)continue;
          const origin=bid.auctionId===latest.get(code)?'fresh':'cache';increment(selections,origin);
          lastSelection={code,origin,ageMs:Math.max(0,now()-bid.responseTimestamp)};
        }
        return true;
      }catch{try{clear(c.slot);}catch{}increment(selections,'errors');lastSelection={code,origin:'error',ageMs:null,reason:stage};return false;}
    },
    snapshot(){return {profile:'prebid-cache-policy-candidate-v1',siteId,prebidVersion:pbjs.version,mode,maxAgeSeconds,stopped,
      trackedAuctions:auctions.size,auctionLimit:limit,trackedSubmittedBids:submitted.size,submittedLimit,capacityBlocked,checks:{accepted:checks.accepted,rejected:{...checks.rejected}},
      selections:{...selections},lastSelection:lastSelection?{...lastSelection}:null};},
    discardAuction(id,code){
      if(code!==undefined){const rows=auctions.get(id);rows?.delete(code);if(!rows?.size)auctions.delete(id);if(latest.get(code)===id)latest.delete(code);}
      else {auctions.delete(id);for(const [key,current] of latest)if(current===id)latest.delete(key);}
    },
    stop(){
      if(stopped)return;stopped=true;auctions.clear();latest.clear();submitted.clear();pbjs.offEvent('auctionInit',auctionInit);
      // Do not overwrite configuration installed by another owner after us.
      if(pbjs.getConfig('bidCacheFilterFunction')===filter)pbjs.setConfig({useBidCache:false,bidCacheFilterFunction:null});
      if(pbjs.getConfig('customGptSlotMatching')===match)pbjs.setConfig({customGptSlotMatching:null});
    }
  };
}
