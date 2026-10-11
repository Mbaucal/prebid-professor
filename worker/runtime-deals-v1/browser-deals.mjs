/** New-version browser helper: called for each auction, after bidder overrides. */
export function applyDealParams(unit,settings,now){
 if(!unit||!settings)return unit;
 var active=settings.entries.filter(function(e){return e.enabled&&(!e.positions.length||e.positions.indexOf(unit.code)!==-1)&&Date.parse(e.startsAt)<=now&&now<Date.parse(e.endsAt);});
 return Object.assign({},unit,{bids:(unit.bids||[]).map(function(bid){
  if(bid.bidder!=='pubmatic')return bid;
  var ids=active.filter(function(e){return e.bidder==='pubmatic';}).map(function(e){return e.dealId;});
  if(!ids.length)return bid;
  var params=Object.assign({},bid.params);
  if(ids.length)params.deals=ids;
  return Object.assign({},bid,{params:params});
 })});
}
