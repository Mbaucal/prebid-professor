import {canonical,check,fail,isRecord,normalizeReport} from './ab-measurement-utils.mjs';
import {GAM_REPORT_V2_DIMENSIONS,GAM_REPORT_V2_METRICS,GAM_REPORT_V2_PURPOSES,gamReportV2Columns} from './gam-report-v2-contracts.mjs';

export {canonical,check,fail,isRecord};
export const GAM_REPORT_V2_FIELDS=Object.freeze(['networkCode','inventoryPath','startDate','endDate','currency','timeZone','revenueBasis','revenueMetric','purpose','metricFamily','scope','dimensions','metrics','sourceColumns','compatibilityMode']);
const FINANCIAL=['networkCode','inventoryPath','startDate','endDate','currency','timeZone','revenueBasis','revenueMetric'];
const DELIVERY=['orderId','lineItemId','creativeId'];
const REQUESTS=['adRequests','responsesServed','unfilledImpressions'];
const ID=/^[1-9]\d{0,19}$/;
const CONTROL=/[\u0000-\u001f\u007f-\u009f]/;
// Only exact published metric labels are recognized. Arbitrary source labels remain declarations.
const KNOWN_HEADERS=new Map([
  ...[['impressions','impressions'],['revenue','revenue'],['CPM and CPC revenue','revenue'],['clicks','clicks'],['ad requests','adRequests'],['code served count','responsesServed'],['Active View eligible impressions','eligibleImpressions'],['Active View measurable impressions','measurableImpressions'],['Active View viewable impressions','viewableImpressions']].map(([label,key])=>['Total '+label,{family:'total',key}]),
  ...[['impressions','impressions'],['revenue','revenue'],['CPM and CPC revenue','revenue'],['clicks','clicks'],['Active View eligible impressions','eligibleImpressions'],['Active View measurable impressions','measurableImpressions'],['Active View viewable impressions','viewableImpressions']].map(([label,key])=>['Ad server '+label,{family:'ad-server',key}]),
  ...['Ad Exchange','AdSense'].flatMap(prefix=>[['impressions','impressions'],['revenue','revenue'],['clicks','clicks']].map(([label,key])=>[prefix+' '+label,{family:'unsupported-subset',key}])),
  ['Unfilled impressions',{family:'total',key:'unfilledImpressions'}],
]);

function selected(value,catalog,label){
  check(Array.isArray(value)&&value.length<=catalog.length,'Choose known '+label+'.');
  check(value.every(key=>typeof key==='string'&&catalog.some(item=>item.key===key))&&new Set(value).size===value.length,'Unknown or duplicate '+label+'.');
  return catalog.filter(item=>value.includes(item.key)).map(item=>item.key);
}
function ids(value){
  check(Array.isArray(value)&&value.length<=5000&&value.every(id=>typeof id==='string'&&ID.test(id)),'Use at most 5,000 exact positive order or line item IDs.');
  check(new Set(value).size===value.length,'Remove duplicate order or line item IDs.');
  return [...value].sort((a,b)=>a.length-b.length||a.localeCompare(b,'en'));
}
export function normalizeGamReportV2Input(input){
  check(isRecord(input)&&Object.keys(input).every(key=>GAM_REPORT_V2_FIELDS.includes(key)),'Use only the displayed detailed report fields.');
  const financial=normalizeReport(Object.fromEntries(FINANCIAL.map(key=>[key,input[key]])));
  check(GAM_REPORT_V2_PURPOSES.some(item=>item.key===input.purpose),'Choose a known report purpose.');
  check(['total','ad-server'].includes(input.metricFamily),'Choose Total or Ad server metric family.');
  check(isRecord(input.scope)&&Object.keys(input.scope).sort().join(',')==='lineItemIds,orderIds','Use exact orderIds and lineItemIds scope arrays.');
  const scope={orderIds:ids(input.scope.orderIds),lineItemIds:ids(input.scope.lineItemIds)};
  check(scope.orderIds.length+scope.lineItemIds.length<=5000,'Use at most 5,000 selected IDs in one report.');
  const dimensions=selected(input.dimensions,GAM_REPORT_V2_DIMENSIONS,'dimensions'),metrics=selected(input.metrics,GAM_REPORT_V2_METRICS,'metrics');
  check(metrics.length>0,'Select at least one raw metric.');
  const filtered=scope.orderIds.length>0||scope.lineItemIds.length>0;
  if(input.purpose==='overall'||input.purpose==='inventory')check(input.metricFamily==='total'&&!filtered,'Overall and inventory reports require Total metrics without order or line item filters.');
  if(input.purpose==='overall')check(metrics.includes('impressions')&&metrics.includes('revenue'),'Overall reports require impressions and revenue.');
  if(input.purpose==='refresh')check(dimensions.some(key=>key.startsWith('refresh_')),'Refresh reports need at least one refresh dimension.');
  if(input.purpose==='startup')check(dimensions.includes('aq_first_request')||dimensions.includes('aq_consent_wait'),'Startup reports need first request or CMP wait dimension.');
  if(input.purpose==='inventory')check(metrics.some(key=>REQUESTS.includes(key)),'Inventory reports need a request, response or unfilled count.');
  if(input.purpose==='prebid')check(input.metricFamily==='ad-server'&&filtered,'Prebid reports require Ad server metrics and exact Prebid order or line item IDs.');
  if(filtered)check(input.metricFamily==='ad-server','Delivery-filtered reports use Ad server metrics and describe a subset.');
  if(scope.orderIds.length)check(dimensions.includes('orderId'),'Include the Order ID dimension to verify the declared filter in every row.');
  if(scope.lineItemIds.length)check(dimensions.includes('lineItemId'),'Include the Line item ID dimension to verify the declared filter in every row.');
  if(filtered||dimensions.some(key=>DELIVERY.includes(key)))check(!metrics.some(key=>REQUESTS.includes(key)),'Request, response and unfilled metrics cannot use delivery filters or order, line item or creative dimensions.');
  if(metrics.includes('unfilledImpressions'))check(!dimensions.includes('creativeSize'),'Unfilled requests require requested ad sizes, not creative size.');
  if(metrics.some(key=>REQUESTS.includes(key)))check(input.metricFamily==='total','Request, response and unfilled counts require the matching Total request population.');
  for(const pair of [['adRequests','responsesServed'],['measurableImpressions','viewableImpressions']])check(metrics.includes(pair[0])===metrics.includes(pair[1]),'Select both '+pair.join(' and ')+', or neither.');
  const compatibilityMode=input.compatibilityMode??'unknown';
  check(['off','on','unknown'].includes(compatibilityMode),'Choose the declared report compatibility mode.');
  const columns=gamReportV2Columns({dimensions,metrics}),mapping=input.sourceColumns??{};
  check(isRecord(mapping),'Source columns must map canonical names to exact source headers.');
  if(Object.keys(mapping).length)check(Object.keys(mapping).length===columns.length&&Object.keys(mapping).every(key=>columns.includes(key)),'Map every selected canonical column exactly once, without extra source fields.');
  const sourceColumns=Object.fromEntries(columns.map(key=>[key,Object.keys(mapping).length?mapping[key]:key]));
  check(Object.values(sourceColumns).every(value=>typeof value==='string'&&value.trim().length>0&&value.length<=160&&!CONTROL.test(value)),'Source header names must be nonempty exact text without control characters.');
  check(new Set(Object.values(sourceColumns)).size===columns.length,'Each canonical column needs a different exact source header.');
  for(const [key,header] of Object.entries(sourceColumns)){
    check(!['Key-values','Key values','Key-values (dynamic)'].includes(header),'Raw Key-values rows overlap and cannot map to a joint report column.');
    check(!/^[=+@-]/.test(header.trimStart()),'Source headers cannot begin with spreadsheet formula characters.');
    const known=KNOWN_HEADERS.get(header);
    if(known)check(known.family===input.metricFamily&&known.key===key,'The recognized source metric header contradicts the selected metric family or canonical field.');
  }
  return {...financial,purpose:input.purpose,metricFamily:input.metricFamily,scope,dimensions,metrics,sourceColumns,compatibilityMode};
}

export function wholeV2(value){
  check(typeof value==='string'&&/^(0|[1-9]\d*)$/.test(value),'Counts must be non-negative whole numbers without separators.');
  const count=Number(value);check(Number.isSafeInteger(count),'Count exceeds supported precision.');return count;
}
export function moneyV2(value){
  check(typeof value==='string'&&value.length<=32&&/^-?(0|[1-9]\d*)(\.\d{1,6})?$/.test(value),'Revenue must use a decimal point and at most six decimals, without currency symbols.');
  const [units,fraction='']=value.replace(/^-/,'').split('.'),micros=BigInt(units)*1000000n+BigInt(fraction.padEnd(6,'0'));
  check(micros<=BigInt(Number.MAX_SAFE_INTEGER),'Revenue exceeds supported precision.');return Number(value.startsWith('-')?-micros:micros);
}
export function decimalV2(micros){const value=BigInt(micros),absolute=value<0n?-value:value;return (value<0n?'-':'')+String(absolute/1000000n)+'.'+String(absolute%1000000n).padStart(6,'0');}
export function dimensionV2(key,value){
  check(typeof value==='string'&&value.length<=512&&!CONTROL.test(value),'Dimension values must be bounded text without control characters.');
  if(value==='')return value;
  const spec=GAM_REPORT_V2_DIMENSIONS.find(item=>item.key===key);
  if(spec.values)check(spec.values.includes(value),'Unknown '+key+' value. Normalize it explicitly; missing values must remain blank.');
  if(DELIVERY.includes(key))check(value==='0'||ID.test(value),'Use an exact numeric '+key+' or leave an unreported value blank.');
  if(['refresh_count','aq_bid_count','aq_bidder_count'].includes(key))wholeV2(value);
  if(key==='refresh_interval'&&!['initial','unscheduled'].includes(value))check(/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)&&Number(value)>0&&Number(value)<=Number.MAX_SAFE_INTEGER,'Use a positive selected refresh interval, initial or unscheduled.');
  return value;
}
