import {sha256} from '../runtime/prebid-artifact-check.mjs';
import {DAY,reportDate} from './ab-measurement-utils.mjs';
import {assertGamReportV2Plan} from './gam-report-v2-plan.mjs';
import {GAM_REPORT_V2_CSV_LIMIT,GAM_REPORT_V2_MAX_ROWS,GAM_REPORT_V2_BREAKDOWN_LIMIT,GAM_REPORT_V2_METRICS,gamReportV2Columns} from './gam-report-v2-contracts.mjs';
import {check,decimalV2,dimensionV2,isRecord,moneyV2,wholeV2} from './gam-report-v2-utils.mjs';

const optionalPairs=[['adRequests','responsesServed'],['measurableImpressions','viewableImpressions']];
const numericKeys=GAM_REPORT_V2_METRICS.filter(item=>item.key!=='revenue').map(item=>item.key);
function parseCsv(csv,width){
  check(typeof csv==='string'&&new TextEncoder().encode(csv).length<=GAM_REPORT_V2_CSV_LIMIT,'CSV must be at most 1 MiB.');
  const lines=csv.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').split('\n');if(lines.at(-1)==='')lines.pop();
  check(lines.length>=2&&lines.length<=GAM_REPORT_V2_MAX_ROWS+1,'Use 1–10,000 detail rows without totals or blank lines.');
  return lines.map((line,index)=>{
    check(line.length>0&&!line.includes('\r'),'Invalid or blank CSV row '+(index+1)+'.');const cells=[];let at=0;
    for(;;){
      let value='';
      if(line[at]==='"'){
        at++;let closed=false;
        while(at<line.length){if(line[at]==='"'){at++;if(line[at]==='"'){value+='"';at++;}else{closed=true;break;}}else value+=line[at++];}
        check(closed&&(at===line.length||line[at]===','),'Malformed quoted CSV cell on row '+(index+1)+'.');
      }else while(at<line.length&&line[at]!==','){check(line[at]!=='"','Unexpected CSV quote.');value+=line[at++];}
      cells.push(value);check(cells.length<=width,'Unexpected extra CSV columns.');if(at===line.length)break;at++;
    }
    check(cells.length===width,'Expected exactly '+width+' mapped CSV columns on row '+(index+1)+'.');return cells;
  });
}
const csvCell=value=>/[",\r\n]/.test(value)?'"'+value.replace(/"/g,'""')+'"':value;
export function gamReportV2Template(plan){
  assertGamReportV2Plan(plan);const report=plan.report,columns=gamReportV2Columns(report),rows=[columns.map(key=>csvCell(report.sourceColumns[key])).join(',')];
  for(let at=reportDate(report.startDate);at<=reportDate(report.endDate);at+=DAY)for(const side of ['A','B']){
    const values={date:new Date(at).toISOString().slice(0,10),VersionId:plan.versionId,Variant:side};
    if(report.scope.orderIds.length===1)values.orderId=report.scope.orderIds[0];
    if(report.scope.lineItemIds.length===1)values.lineItemId=report.scope.lineItemIds[0];
    rows.push(columns.map(key=>csvCell(values[key]??'')).join(','));
  }
  return rows.join('\r\n')+'\r\n';
}
function summarize(rows,metrics){
  const result={rowCount:rows.length,...Object.fromEntries(numericKeys.map(key=>[key,null])),revenueMicros:null,revenue:null,metricCoverage:{}};
  for(const key of metrics){
    const field=key==='revenue'?'revenueMicros':key;let sum=0,provided=0;
    for(const row of rows)if(row[field]!==null){provided++;sum+=row[field];check(Number.isSafeInteger(sum),'Report totals exceed supported precision. Reduce the report scope.');}
    result.metricCoverage[key]={provided,missing:rows.length-provided};
    result[field]=rows.length>0&&provided===rows.length?sum:null;
  }
  result.revenue=result.revenueMicros===null?null:decimalV2(result.revenueMicros);
  result.revenuePerThousandImpressions=result.impressions>0&&result.revenueMicros!==null?result.revenueMicros/1000/result.impressions:null;
  result.clickThroughRatePercent=result.impressions>0&&result.clicks!==null?100*result.clicks/result.impressions:null;
  result.responseRatePercent=result.adRequests>0&&result.responsesServed!==null?100*result.responsesServed/result.adRequests:null;
  result.viewabilityPercent=result.measurableImpressions>0&&result.viewableImpressions!==null?100*result.viewableImpressions/result.measurableImpressions:null;
  result.measurabilityPercent=result.eligibleImpressions>0&&result.measurableImpressions!==null?100*result.measurableImpressions/result.eligibleImpressions:null;
  result.pageRpm=result.receivedAssignments=result.impressionsPerAssignedPage=null;return result;
}
function breakdown(rows,dimension,metrics){
  const grouped=new Map();
  for(const row of rows){const value=row.dimensions[dimension];if(!grouped.has(value))grouped.set(value,{A:[],B:[]});grouped.get(value)[row.variant].push(row);}
  const sorted=[...grouped.keys()].sort((a,b)=>a.localeCompare(b,'en')),shown=sorted.slice(0,GAM_REPORT_V2_BREAKDOWN_LIMIT),remaining=sorted.slice(GAM_REPORT_V2_BREAKDOWN_LIMIT);
  const groups=shown.map(value=>({value,A:summarize(grouped.get(value).A,metrics),B:summarize(grouped.get(value).B,metrics)}));
  let other=null;
  if(remaining.length){const tail={A:[],B:[]};for(const value of remaining)for(const side of ['A','B'])for(const row of grouped.get(value)[side])tail[side].push(row);
    other={groupCount:remaining.length,A:summarize(tail.A,metrics),B:summarize(tail.B,metrics)};}
  return {dimension,groupCount:sorted.length,groups,other};
}
export async function previewGamReportV2(plan,input,now=Date.now()){
  assertGamReportV2Plan(plan);check(isRecord(input)&&Object.keys(input).join(',')==='csv','Use only the CSV field for this detailed plan.');
  const report=plan.report,columns=gamReportV2Columns(report),matrix=parseCsv(input.csv,columns.length),headers=matrix.shift();
  check(new Set(headers).size===headers.length,'Duplicate source CSV headers are ambiguous.');
  const sourceHeaders=columns.map(key=>report.sourceColumns[key]);
  check(headers.length===sourceHeaders.length&&headers.every(header=>sourceHeaders.includes(header)),'Use the exact mapped source headers, without unknown extra columns.');
  const offsets=Object.fromEntries(columns.map(key=>[key,headers.indexOf(report.sourceColumns[key])])),rows=[],seen=new Set(),days=new Set();
  const start=reportDate(report.startDate),end=reportDate(report.endDate);
  for(const cells of matrix){
    const raw=Object.fromEntries(columns.map(key=>[key,cells[offsets[key]]])),stamp=reportDate(raw.date);
    check(stamp>=start&&stamp<=end,'CSV contains a date outside the saved report period.');
    check(raw.VersionId===plan.versionId,'CSV VersionId does not match this saved experiment.');
    check(raw.Variant==='A'||raw.Variant==='B','CSV Variant must be exactly A or B.');
    const dimensions=Object.fromEntries(report.dimensions.map(key=>[key,dimensionV2(key,raw[key])]));
    if(report.scope.orderIds.length)check(report.scope.orderIds.includes(dimensions.orderId),'CSV Order ID is outside the declared scope.');
    if(report.scope.lineItemIds.length)check(report.scope.lineItemIds.includes(dimensions.lineItemId),'CSV Line item ID is outside the declared scope.');
    const tuple=JSON.stringify([raw.date,raw.VersionId,raw.Variant,...report.dimensions.map(key=>dimensions[key])]);
    check(!seen.has(tuple),'Duplicate full report grain. Remove totals, overlapping rows or duplicate exports.');seen.add(tuple);days.add(raw.date+':'+raw.Variant);
    const row={date:raw.date,variant:raw.Variant,dimensions,...Object.fromEntries(numericKeys.map(key=>[key,null])),revenueMicros:null};
    for(const key of report.metrics){const value=raw[key];row[key==='revenue'?'revenueMicros':key]=value===''?null:key==='revenue'?moneyV2(value):wholeV2(value);}
    for(const [denominator,numerator] of optionalPairs)if(report.metrics.includes(denominator)){
      check((row[denominator]===null)===(row[numerator]===null),'Provide both '+denominator+' and '+numerator+', or leave both blank.');
      check(row[numerator]===null||row[numerator]<=row[denominator],numerator+' cannot exceed '+denominator+' in this report.');
    }
    if(row.eligibleImpressions!==null&&row.measurableImpressions!==null)check(row.measurableImpressions<=row.eligibleImpressions,'Measurable impressions cannot exceed eligible impressions.');
    rows.push(row);
  }
  const totals={A:summarize(rows.filter(row=>row.variant==='A'),report.metrics),B:summarize(rows.filter(row=>row.variant==='B'),report.metrics)};
  const missingDays=[];
  for(let at=start;at<=end;at+=DAY)for(const variant of ['A','B']){const date=new Date(at).toISOString().slice(0,10);if(!days.has(date+':'+variant))missingDays.push({date,variant});}
  const blockers=['No verified all-assigned-pageview denominator is available; page RPM, uplift and a winner remain unavailable.',
    'GAM source, declared filters, metric family, currency, time zone and gross/net basis are operator declarations, not authenticated GAM evidence.',
    'Sparse dimension rows cannot establish complete source coverage. Missing dimensions, days or categories are unknown, not zero.'];
  if(missingDays.length)blockers.push('Some daily A/B groups are absent from the imported rows.');
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:report.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(part=>[part.type,part.value])),today=parts.year+'-'+parts.month+'-'+parts.day;
  if(report.endDate>=today)blockers.push('The report includes an unfinished or future day in its own time zone.');
  if(report.revenueBasis==='unknown'&&report.metrics.includes('revenue'))blockers.push('Confirm the revenue basis before interpreting financial results.');
  if(plan.trafficBPercent===0||plan.trafficBPercent===100)blockers.push('Both variants need traffic for an A/B comparison.');
  if(report.compatibilityMode!=='off')blockers.push(report.compatibilityMode==='on'?'GAM compatibility mode is declared on; it may exclude incompatible or incomplete data.':'GAM compatibility mode is unknown. Verify it in the original report before interpreting coverage.');
  if(report.metrics.some(key=>totals.A.metricCoverage[key].missing||totals.B.metricCoverage[key].missing))blockers.push('Some selected metrics are blank. Affected totals and rates remain unavailable; provided/missing row counts are shown.');
  const filtered=report.scope.orderIds.length>0||report.scope.lineItemIds.length>0;
  const notes=[filtered?'This is a declared delivery subset. It is not the overall site result or a denominator of all eligible requests.':'Totals describe only the imported rows from the declared inventory and metric family.',
    'VersionId is the normalized CSV identity. The actual saved GAM key is '+plan.identityKey+'='+plan.versionId+'.',
    'Rates use summed raw counts, never averages of daily percentages. Unselected or missing metrics remain unknown.',
    'Breakdowns are separate views of the same rows. Do not add their totals to one another or to the overall table.',
    'Blank dimension values mean unreported values, not a zero, none or a winning demand source.',
    'Rows must be a flat, mutually exclusive joint grain. Raw overlapping Key-values exports and subtotal rows are not supported.',
    'CSV and preview are processed in memory and are not stored. No GAM feature, paid setting or experiment is changed.'];
  if(report.dimensions.some(key=>['aq_bid_origin','hb_bidder','hb_pb','hb_size'].includes(key)))notes.push('Prebid targeting labels describe bids sent to GAM; they do not prove the bidder or cached creative that GAM rendered or paid.');
  if(report.dimensions.some(key=>['aq_first_request','aq_consent_wait'].includes(key)))notes.push('First-request and CMP buckets persist on later requests. GAM rows weight requests/impressions, not unique pages or latency percentiles.');
  return {schemaVersion:2,kind:'tessera-gam-report-preview-v2',planId:plan.id,experimentId:plan.experimentId,versionId:plan.versionId,identityKey:plan.identityKey,
    period:{startDate:report.startDate,endDate:report.endDate,timeZone:report.timeZone},
    source:{format:'tessera-gam-detailed-v2',csvSha256:await sha256(new TextEncoder().encode(input.csv)),currency:report.currency,revenueBasis:report.revenueBasis,revenueMetric:report.revenueMetric,metricFamily:report.metricFamily,purpose:report.purpose,scope:report.scope,dimensions:report.dimensions,metrics:report.metrics,sourceColumns:report.sourceColumns,compatibilityMode:report.compatibilityMode,gamReportSourceVerified:false,scopeDeclaration:'operator'},
    totals,breakdowns:report.dimensions.map(dimension=>breakdown(rows,dimension,report.metrics)),missingDays,providedRows:rows.length,dataComplete:false,coverage:'unknown',revenueReady:false,winner:null,upliftPercent:null,blockers,notes};
}
