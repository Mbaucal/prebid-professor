import {sha256} from '../runtime/prebid-artifact-check.mjs';
import {assertReportPlan} from './ab-report-plan.mjs';
import {AB_GAM_COLUMNS as COLUMNS,AB_GAM_CSV_LIMIT} from './ab-measurement-contracts.mjs';
import {check,DAY,reportDate} from './ab-measurement-utils.mjs';

// Canonical CSV, integer-micros arithmetic and weighted aggregation adapted from
// PR63 / 0be3289:worker/experiments/gam-report.mjs. No private collector or old
// runtime-capability/label adapter is imported. The joint TestId/Variant is exact.
function whole(value){check(/^(0|[1-9]\d*)$/.test(value),'Counts must be non-negative whole numbers without separators.');const n=Number(value);check(Number.isSafeInteger(n),'Count is too large.');return n;}
function money(value){
  check(value.length<=32,'Revenue is too large.');
  check(/^-?(0|[1-9]\d*)(\.\d{1,6})?$/.test(value),'Revenue must use a decimal point and at most six decimal places, without currency symbols.');
  const [units,fraction='']=value.replace(/^-/,'').split('.'),n=BigInt(units)*1000000n+BigInt(fraction.padEnd(6,'0'));
  check(n<=BigInt(Number.MAX_SAFE_INTEGER),'Revenue is too large.');return Number(value.startsWith('-')?-n:n);
}
function decimal(n){const value=BigInt(n),abs=value<0n?-value:value;return (value<0n?'-':'')+String(abs/1000000n)+'.'+String(abs%1000000n).padStart(6,'0');}
function parseCsv(csv){
  check(typeof csv==='string'&&new TextEncoder().encode(csv).length<=AB_GAM_CSV_LIMIT,'CSV must be at most 128 KB.');
  const lines=csv.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').split('\n');if(lines.at(-1)==='')lines.pop();
  check(lines.length>=2&&lines.length<=733,'Use 1–732 daily rows, without totals or blank lines.');
  return lines.map((line,index)=>{
    check(!line.includes('\r'),'Invalid CSV line ending.');const cells=[];let at=0;
    for(;;){
      let value='';
      if(line[at]==='"'){
        at++;let closed=false;
        while(at<line.length){if(line[at]==='"'){at++;if(line[at]==='"'){value+='"';at++;}else{closed=true;break;}}else value+=line[at++];}
        check(closed&&(at===line.length||line[at]===','),'Malformed quoted CSV cell on row '+(index+1)+'.');
      }else while(at<line.length&&line[at]!==','){check(line[at]!=='"','Unexpected CSV quote.');value+=line[at++];}
      cells.push(value);check(cells.length<=COLUMNS.length,'Unexpected CSV columns.');if(at===line.length)break;at++;
    }
    check(cells.length===COLUMNS.length,'Expected all nine template columns on row '+(index+1)+'.');return cells;
  });
}
export function abGamReportTemplate(plan){
  assertReportPlan(plan);const rows=[COLUMNS.join(',')];
  for(let stamp=reportDate(plan.report.startDate);stamp<=reportDate(plan.report.endDate);stamp+=DAY)for(const variant of ['A','B'])rows.push([new Date(stamp).toISOString().slice(0,10),plan.testId,variant,'','','','','',''].join(','));
  return rows.join('\r\n')+'\r\n';
}
export async function previewAbGamReport(plan,input,now=Date.now()){
  assertReportPlan(plan);check(input&&Object.keys(input).join(',')==='csv','Use only the CSV field for this saved reporting plan.');
  const report=plan.report,start=reportDate(report.startDate),end=reportDate(report.endDate),matrix=parseCsv(input.csv);
  check(matrix.shift().join(',')===COLUMNS.join(','),'Use the exact CSV template headers and order.');
  const rows=[],seen=new Set();
  for(const cells of matrix){
    const raw=Object.fromEntries(COLUMNS.map((key,i)=>[key,cells[i]])),stamp=reportDate(raw.date);
    check(stamp>=start&&stamp<=end,'CSV contains a date outside the saved report period.');
    check(raw.TestId===plan.testId,'CSV TestId does not match this saved experiment.');
    check(raw.Variant==='A'||raw.Variant==='B','CSV Variant must be exactly A or B.');
    const identity=raw.date+':'+raw.TestId+':'+raw.Variant;
    check(!seen.has(identity),'Duplicate day/TestId/Variant row. Remove totals or additional dimensions before importing.');seen.add(identity);
    const row={date:raw.date,variant:raw.Variant,impressions:whole(raw.impressions),revenueMicros:money(raw.revenue)};
    for(const key of COLUMNS.slice(5))row[key]=raw[key]===''?null:whole(raw[key]);
    for(const [denominator,numerator] of [['adRequests','responsesServed'],['measurableImpressions','viewableImpressions']]){
      check((row[denominator]===null)===(row[numerator]===null),'Provide both '+denominator+' and '+numerator+', or leave both blank.');
      check(row[numerator]===null||row[numerator]<=row[denominator],numerator+' cannot exceed '+denominator+' for this display report.');
    }
    rows.push(row);
  }
  const missing=[];
  for(let stamp=start;stamp<=end;stamp+=DAY)for(const variant of ['A','B']){const day=new Date(stamp).toISOString().slice(0,10);if(!seen.has(day+':'+plan.testId+':'+variant))missing.push({date:day,variant});}
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:report.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value])),today=parts.year+'-'+parts.month+'-'+parts.day;
  const blockers=[];
  if(missing.length)blockers.push('Missing daily A/B rows are unknown, not zero.');
  if(report.endDate>=today)blockers.push('The report includes an unfinished or future day in its own time zone.');
  if(report.revenueBasis==='unknown')blockers.push('Confirm the revenue basis before comparing results.');
  if(plan.trafficBPercent===0||plan.trafficBPercent===100)blockers.push('Both variants need traffic for a comparison.');
  const dataComplete=blockers.length===0;
  blockers.push('No verified all-assigned-pageview denominator is available; page RPM and winners remain unavailable.');
  blockers.push('Verify this GAM report against the saved network, inventory, period, currency, time zone and revenue basis.');
  blockers.push('Assignment-day and impression-day cohorts can differ across midnight or Stop; matching time zones alone does not join them.');
  blockers.push('Post-assignment exclusions can leave unlabelled revenue. Missing revenue is never treated as zero.');
  const total=(selected,key)=>{
    if(!selected.length||selected.some(row=>row[key]===null))return null;
    return selected.reduce((sum,row)=>{const next=sum+row[key];check(Number.isSafeInteger(next),'Report totals exceed the supported precision.');return next;},0);
  };
  const totals={};
  for(const variant of ['A','B']){
    const selected=rows.filter(row=>row.variant===variant),result={rowCount:selected.length};
    for(const key of ['impressions','revenueMicros',...COLUMNS.slice(5)])result[key]=total(selected,key);
    result.revenue=result.revenueMicros===null?null:decimal(result.revenueMicros);
    result.revenuePerThousandImpressions=result.impressions>0?result.revenueMicros/1000/result.impressions:null;
    result.responseRatePercent=result.adRequests>0?100*result.responsesServed/result.adRequests:null;
    result.viewabilityPercent=result.measurableImpressions>0?100*result.viewableImpressions/result.measurableImpressions:null;
    result.receivedAssignments=result.pageRpm=result.impressionsPerAssignedPage=null;totals[variant]=result;
  }
  return {schemaVersion:1,kind:'tessera-ab-gam-report-preview',planId:plan.id,experimentId:plan.experimentId,testId:plan.testId,
    period:{startDate:report.startDate,endDate:report.endDate,timeZone:report.timeZone},
    source:{format:'tessera-ab-gam-daily-v1',csvSha256:await sha256(new TextEncoder().encode(input.csv)),currency:report.currency,revenueBasis:report.revenueBasis,revenueMetric:report.revenueMetric},
    totals,missingRows:missing,providedRows:rows.length,dataComplete,coverage:'unknown',revenueReady:false,winner:null,upliftPercent:null,blockers,
    notes:['Totals describe provided rows only; missing rows are never synthesized.','Rates use summed counts, not averages of daily percentages.','This is a normalized joint TestId/Variant report, not a guess at raw GAM Key-values exports.','CSV is computed in memory, never stored; no experiment or GAM setting is changed.']};
}
