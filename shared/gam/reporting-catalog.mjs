import {GamError} from './plan.mjs';
import {normalizeCountry} from '../geo-country.mjs';
import {reportingContract} from '../../worker/runtime-reporting-v1/contract.mjs';
import {requestReportingContract} from '../../worker/runtime-325/contract.mjs';

export const REPORTING_PROFILE = 'ads-js-3.25';
export const OPEN_REPORTING_KEYS = Object.freeze([
  'refresh_count','refresh_interval','aq_bid_count','aq_bidder_count',
]);
const COUNTRIES = Object.freeze(Array.from({length:26*26},(_,index)=>
  String.fromCharCode(65+Math.floor(index/26),65+index%26)).filter(normalizeCountry));
const seeds = {refresh_count:['0'],refresh_interval:['initial','unscheduled'],aq_bid_count:['0'],aq_bidder_count:['0']};
const fail = message => {throw new GamError(message);};

function additionalValues(value) {
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))fail('Reporting vrednosti moraju biti objekat poznatih numeričkih ključeva.');
  const result=Object.create(null);
  let total=0;
  for(const [key,values] of Object.entries(value)) {
    if(!OPEN_REPORTING_KEYS.includes(key))fail('Dodatne reporting vrednosti su dozvoljene samo za četiri numerička ključa.');
    if(!Array.isArray(values)||values.length>1000||(total+=values.length)>4000)fail('Najviše 1.000 dodatnih reporting vrednosti po ključu i 4.000 ukupno.');
    result[key]=[...new Set(values.map(item=>{
      if(typeof item!=='string'&&typeof item!=='number')fail('Reporting vrednost mora biti broj ili tekstualni broj.');
      const raw=String(item);
      if(key==='refresh_interval'&&['initial','unscheduled'].includes(raw.toLowerCase()))return raw.toLowerCase();
      if(!/^(0|[1-9]\d{0,15})(?:\.\d{1,6})?$/.test(raw))fail('Reporting brojači zahtevaju nenegativne cele brojeve; interval zahteva pozitivan broj sekundi.');
      const number=Number(raw);
      if(!Number.isFinite(number)||number>Number.MAX_SAFE_INTEGER||
        (key==='refresh_interval'?number<=0:!Number.isSafeInteger(number)))fail('Neispravna numerička reporting vrednost.');
      return String(number);
    }))].sort((a,b)=>Number(a)-Number(b)||a.localeCompare(b,'en'));
  }
  return result;
}

/** A saved plan owns this materialized catalog; older jobs are never upgraded. */
export function reportingSetup(extra) {
  const additional=additionalValues(extra);
  const definitions={...reportingContract.keys,...requestReportingContract.keys,
    geo_country:{values:COUNTRIES},Variant:{values:['A','B']}};
  return {schemaVersion:1,profile:REPORTING_PROFILE,keys:Object.entries(definitions).map(([key,definition])=>{
    const openDomain=OPEN_REPORTING_KEYS.includes(key);
    const values=openDomain?[...new Set([...seeds[key],...(additional[key]??[])])]:[...definition.values];
    return {key,type:openDomain?'FREEFORM':'PREDEFINED',reportableType:'ON',values,openDomain};
  })};
}

/** Key/value-only setup can prepare an existing network without an ad plan. */
export function reportingOnlyPlan(networkCode, extra) {
  return {schemaVersion:2,mode:'reporting',networkCode,allowOverbook:false,
    advertiser:{mode:'none',name:''},orders:[],inventory:{kind:'none',ids:[]},
    currency:'',sizes:'',creative:{mode:'none'},rules:[],ranges:[],rows:[],
    namePrefix:'GAM reporting',type:'REPORTING',costType:'',
    goal:{goalType:'NONE',unitType:'IMPRESSIONS',units:0},start:null,end:null,
    counts:{lineItems:0,orders:0,creatives:0,associations:0},reporting:reportingSetup(extra)};
}
