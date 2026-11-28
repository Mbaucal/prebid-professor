// Synthetic counters and names only; header shapes match the five saved GAM exports.
export const headings = {
 '01':['Date','Ad unit (all levels)','Device category','Key-values','Total impressions','Total CPM and CPC revenue','Total clicks','Total Active View viewable impressions','Total Active View eligible impressions','Total Active View measurable impressions','Total code served count','Unfilled impressions'],
 '02':['Date','Ad unit (all levels)','Line item ID','Key-values','Ad server impressions','Ad server CPM and CPC revenue','Ad server clicks','Ad server Active View eligible impressions','Ad server Active View measurable impressions','Ad server Active View viewable impressions'],
 '03':['Date','Ad unit (all levels)','Device category','Requested ad sizes','Total ad requests','Total code served count','Unfilled impressions'],
 '04':['Date','Ad unit (all levels)','Device category','Key-values','Total impressions','Total CPM and CPC revenue','Total clicks','Total Active View viewable impressions','Total Active View eligible impressions','Total Active View measurable impressions'],
 '05':['Date','Ad unit (all levels)','Device category','Key-values','Total impressions','Total code served count'],
};
const keys={'01':['Variant=A','Variant=B'],'02':['Variant=A','Variant=B','aq_bid_origin=cached','aq_bid_origin=fresh'],
 '03':[''],'04':['refresh_bucket=initial','refresh_bucket=r1_3','refresh_interval=initial','refresh_interval=30'],'05':['aq_first_request=lt_500','aq_first_request=3000_plus','aq_consent_wait=lt_500','aq_consent_wait=timeout']};
export const quote=value=>/[",\n]/.test(String(value))?'"'+String(value).replaceAll('"','""')+'"':String(value);
export function fixtureRows(id){return keys[id].map((key,i)=>Object.fromEntries(headings[id].map(h=>[h,h==='Date'?'2026-11-19':h==='Ad unit (all levels)'?'Politika.rs - Display » QA slot':h==='Device category'?'Desktop':h==='Line item ID'?'900001':h==='Requested ad sizes'?'300x250, 336x280':h==='Key-values'?key:h.includes('revenue')?(i?'2.50':'1.25'):h.includes('clicks')?'5':h.includes('viewable')?'60':h.includes('measurable')?'80':h.includes('eligible')?'90':h==='Unfilled impressions'?'50':h.includes('ad requests')?'150':'100'])));}
export function fixtureCsv(id,{rows=fixtureRows(id),properties=true,headers=headings[id],propertyPatch={},newline='\r\n'}={}){
 const filterIds=Array.from({length:{'01':2,'02':5,'03':0,'04':6,'05':14}[id]},(_,i)=>String(1001+i)).join(', ');
 const props={'Report name':`Politika | ${id} Synthetic QA`,'Report type':'Historical','Report currency':'EUR','Publisher network':'Politika novine i magazini doo','Date range':'Nov 19, 2026 - Nov 19, 2026','Time zone':'Europe/Belgrade',Filters:'Ad unit ID (all levels) = 23338702405'+(id==='02'?' AND Order ID = 4071347028, 4071372871, 4071372874, 4071347031, 4071372877':'')+(id==='03'?'':' AND Key-values ID = '+filterIds),...propertyPatch};
 return (properties?Object.entries(props).map(row=>row.map(quote).join(',')).join(newline)+newline+newline:'')+headers.map(quote).join(',')+newline+rows.map(row=>headers.map(h=>quote(row[h]??'')).join(',')).join(newline)+newline;
}
