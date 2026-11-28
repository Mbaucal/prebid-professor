// Invented report identities/counters only. Same supported native GAM header sets as the original fixtures.
import {fixtureCsv,fixtureRows,headings} from './politika-gam-csv-fixture.mjs';
export {headings};
export const sites={
 politika:{name:'politika.rs',network:'Politika QA network',networkCode:'23330000001',root:'Politika.rs - Display',adUnitId:'111',orders:['501','502'],currency:'EUR',timeZone:'Europe/Belgrade'},
 tanjug:{name:'tanjug.rs',network:'Tanjug QA network',networkCode:'22850000002',root:'Tanjug.rs - Display',adUnitId:'222',orders:['601'],currency:'USD',timeZone:'UTC'},
 third:{name:'direktno.rs',network:'Direktno QA network',networkCode:'22030000003',root:'Direktno display',adUnitId:'333',orders:['701','702','703'],currency:'GBP',timeZone:'Europe/London'},
};
export function siteRows(id,site='tanjug') {return fixtureRows(id).map(row=>({...row,'Ad unit (all levels)':sites[site].root+' » QA slot',...(id==='04'&&row['Key-values']==='refresh_interval=30'?{'Key-values':'refresh_interval=45'}:{})}));}
export function siteCsv(id,{site='tanjug',rows=siteRows(id,site),properties=true,propertyPatch={},headers=headings[id]}={}) {
 const s=sites[site];const count={'01':2,'02':5,'03':0,'04':7,'05':14}[id];
 const filter=`Ad unit ID (all levels) = ${s.adUnitId}`+(id==='02'?` AND Order ID = ${s.orders.join(', ')}`:'')+(id==='03'?'':' AND Key-values ID = '+Array.from({length:count},(_,i)=>String(1001+i)).join(', '));
 return fixtureCsv(id,{rows,properties,headers,propertyPatch:{'Report name':`My chosen ${site} report name ${id}`,'Publisher network':s.network,'Network code':s.networkCode,'Report currency':s.currency,'Time zone':s.timeZone,Filters:filter,...propertyPatch}});
}
