/** Saved commercial metadata. Never creates an SSP deal or a consent grant. */
const fail=message=>{throw Object.assign(Error(message),{status:422});};
const codes=['adform','connectad','criteo','eskimi','ix','magnite','ogury','openx','pubmatic','richaudience','rtbhouse','smartadserver','teads'];
export const DEAL_NOTICE='Prebid exposes one selected bid per bidder and position. A lower deal response from the same bidder may not reach GAM. A saved deal does not create or activate an SSP deal.';
function fields(value,expected,label){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==[...expected].sort().join('|'))fail('Check '+label+' fields.');}
function text(value,max,label){if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))fail('Check '+label+'.');return value;}
function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail('Use a valid UTC start and end date.');return value;}
export function assertDealTargetingKeys(bidders){
 const seen=new Map();
 for(const bidder of bidders)for(const prefix of ['hb_deal_','hb_adid_','hb_pb_','hb_size_','hb_format_']){
  const key=(prefix+bidder).slice(0,20),owner=seen.get(key);
  if(owner&&owner!==bidder)fail('Bidder names collide in GAM targeting. Use distinct supported bidder codes.');seen.set(key,bidder);
 }
}
export function normalizeDeals(value={schemaVersion:1,entries:[]},{bidders=[],units=[]}={}){
 fields(value,['schemaVersion','entries'],'Deals');
 if(value.schemaVersion!==1||!Array.isArray(value.entries)||value.entries.length>50)fail('Use at most 50 deals.');
 const configured=new Map(bidders.map(b=>[b.bidder,b])),positions=new Set(units.filter(u=>u.enabled===1||u.enabled===true).map(u=>u.code)),ids=new Set();
 const entries=value.entries.map(row=>{
  fields(row,['id','name','bidder','dealId','positions','startsAt','endsAt','enabled','mode'],'deal');
  const id=text(row.id,64,'deal identifier');if(!/^[a-zA-Z0-9_-]+$/.test(id)||ids.has(id))fail('Each deal needs a distinct identifier.');ids.add(id);
  const bidder=text(row.bidder,64,'bidder'),dealId=text(row.dealId,128,'Deal ID');
  if(typeof row.enabled!=='boolean'||!['price','contract-priority'].includes(row.mode))fail('Choose an explicit deal mode and active state.');
  if(!Array.isArray(row.positions)||row.positions.length>100||new Set(row.positions).size!==row.positions.length||row.positions.some(p=>typeof p!=='string'||!units.some(u=>u.code===p)))fail('Choose existing positions, or all site positions.');
  if(row.enabled&&(!configured.get(bidder)?.enabled||!codes.includes(bidder)))fail('An active deal requires an enabled supported bidder. Unverified aliases cannot be activated.');
  if(row.enabled&&row.positions.some(p=>!positions.has(p)))fail('Enable the selected positions before activating this deal.');
  if(bidder==='pubmatic'&&dealId.length<=3)fail('PubMatic Deal IDs must contain more than 3 characters.');
  const startsAt=date(row.startsAt),endsAt=date(row.endsAt);if(endsAt<=startsAt)fail('The deal end must follow its start.');
  return {id,name:text(row.name,100,'deal name'),bidder,dealId,positions:[...row.positions].sort(),startsAt,endsAt,enabled:row.enabled,mode:row.mode};
 }).sort((a,b)=>a.id.localeCompare(b.id,'en'));
 const active=entries.filter(e=>e.enabled);
 assertDealTargetingKeys(bidders.filter(b=>b.enabled).map(b=>b.bidder));
 for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++){
  const a=active[i],b=active[j];
  if(a.bidder===b.bidder&&a.startsAt<b.endsAt&&b.startsAt<a.endsAt&&(!a.positions.length||!b.positions.length||a.positions.some(p=>b.positions.includes(p))))fail('Active deals for the same bidder cannot overlap in time and position. Prebid exposes one selected bid per bidder.');
 }
 return {schemaVersion:1,entries};
}
export function activeDeals(settings,{code,now,bidder}={}){
 const time=typeof now==='number'?now:Date.parse(now);
 if(!Number.isFinite(time))throw Error('An explicit valid auction time is required.');
 return settings.entries.filter(e=>e.enabled&&(!bidder||e.bidder===bidder)&&(!e.positions.length||e.positions.includes(code))&&Date.parse(e.startsAt)<=time&&time<Date.parse(e.endsAt));
}
export function buildDealInput(snapshot){
 const config=JSON.parse(snapshot.config.config_json);
 if(config.enablePrebid!==true)return null;
 const settings=normalizeDeals(config.runtimeControls?.deals,{bidders:snapshot.bidders,units:snapshot.units});
 assertManagedDealParams(settings,snapshot);
 return settings;
}

export function assertManagedDealParams(settings,snapshot){
 if(settings.entries.some(e=>e.enabled&&e.bidder==='pubmatic'))for(const row of [...snapshot.bidders,...snapshot.overrides??[]])if(row.bidder==='pubmatic'&&Object.hasOwn(JSON.parse(row.params_json??'{}'),'deals'))fail('Move existing PubMatic deals from bidder parameters into Deals before activating a managed deal.');
}
