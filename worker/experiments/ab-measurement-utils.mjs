export const fail=(message,status=422,code='invalid-measurement')=>{throw Object.assign(new Error(message),{status,code});};
export const check=(ok,message,status=422,code='invalid-measurement')=>{if(!ok)fail(message,status,code);};
export const isRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:isRecord(value)?`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')}}`:JSON.stringify(value??null);
export const DAY=86400000;
export const HASH=/^[a-f0-9]{64}$/;
export function reportDate(value){
  check(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value),'Use dates in YYYY-MM-DD format.');
  const stamp=Date.parse(value+'T00:00:00.000Z');
  check(Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===value,'Invalid report date.');
  return stamp;
}
export const REPORT_FIELDS=Object.freeze(['networkCode','inventoryPath','startDate','endDate','currency','timeZone','revenueBasis','revenueMetric']);
export function normalizeInventoryPath(value){
  check(typeof value==='string'&&value.length<=512&&/^\/[1-9]\d{0,19}\/.+/.test(value)&&!/[\s\\?#\u0000-\u001f\u007f]/.test(value)&&!value.includes('//')&&!value.split('/').some(part=>part==='.'||part==='..'),'Use the saved GAM inventory path, starting with its network code.');
  return value.endsWith('/')?value:value+'/';
}
export function normalizeReport(input){
  check(isRecord(input)&&Object.keys(input).sort().join('|')===[...REPORT_FIELDS].sort().join('|'),'Use only the displayed reporting fields.');
  check(typeof input.networkCode==='string'&&/^[1-9]\d{0,19}$/.test(input.networkCode),'Enter the GAM network code.');
  const inventoryPath=normalizeInventoryPath(input.inventoryPath);
  check(inventoryPath.startsWith('/'+input.networkCode+'/'),'The inventory path belongs to a different GAM network.');
  const start=reportDate(input.startDate),end=reportDate(input.endDate);
  check(end>=start&&(end-start)/DAY<366,'Choose a report period of 1–366 days.');
  check(typeof input.currency==='string'&&/^[A-Z]{3}$/.test(input.currency),'Enter the three-letter currency from the GAM report.');
  check(['net','gross','unknown'].includes(input.revenueBasis),'Choose the revenue basis from the source report.');
  check(['total','cpm-cpc'].includes(input.revenueMetric),'Choose Total revenue or Total CPM and CPC revenue.');
  let timeZone;
  try{check(typeof input.timeZone==='string'&&input.timeZone.length<=64,'Invalid time zone.');timeZone=new Intl.DateTimeFormat('en-US',{timeZone:input.timeZone}).resolvedOptions().timeZone;}
  catch{fail('Enter a valid IANA time zone from the GAM report.');}
  return {networkCode:input.networkCode,inventoryPath,startDate:input.startDate,endDate:input.endDate,currency:input.currency,timeZone,revenueBasis:input.revenueBasis,revenueMetric:input.revenueMetric};
}
