import {DEAL_NOTICE} from './contract.mjs';
/** Review only: no GAM API calls, bid fabrication, or promises of eligibility. */
export function dealPlan(snapshot,settings){
 const path=snapshot.site.gam_path,network=/^\/(\d+(?:,\d+)?)\//.exec(path)?.[1]??null;
 return {schemaVersion:1,siteId:snapshot.site.id,network,adUnitPath:path,writeEnabled:false,notice:DEAL_NOTICE,
  entries:(settings?.entries??[]).map(e=>({id:[snapshot.site.id,network,e.id].join(':'),name:e.name,bidder:e.bidder,dealId:e.dealId,enabled:e.enabled,
   positions:e.positions.length?e.positions:snapshot.units.filter(u=>u.enabled===1).map(u=>u.code),startsAt:e.startsAt,endsAt:e.endsAt,
   inventory:snapshot.units.filter(u=>u.enabled===1&&(!e.positions.length||e.positions.includes(u.code))).map(u=>({code:u.code,adUnitPath:path+u.code,sizeMap:(snapshot.maps??[]).filter(m=>m.name===u.size_map_key).map(m=>JSON.parse(m.map_json))[0]??null})),
   mode:e.mode,priorityInstruction:e.mode==='contract-priority'?'Set the agreed GAM line-item priority above open-market lines. This preview does not assign a guaranteed line-item type.':'Compete at the agreed price; a deal key alone does not change priority.',
   targeting:{key:('hb_deal_'+e.bidder).slice(0,20),value:e.dealId},creativeAdIdMacro:'%%PATTERN:'+('hb_adid_'+e.bidder).slice(0,20)+'%%',
   eligibility:'Only when the current auction returns this exact Deal ID and the matching bidder-specific adId. No matching bid means no eligible deal.',
   adapterRequest:e.bidder==='pubmatic'?'params.deals (active per-position IDs)':'No outgoing deal parameter is added; the SSP must return the agreed deal.'}))};
}
