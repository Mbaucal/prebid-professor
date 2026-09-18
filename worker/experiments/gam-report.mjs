import { gamValue } from './reporting.mjs';
import { sha256 } from '../runtime/prebid-artifact-check.mjs';

export const GAM_COLUMNS = ['date','value','impressions','revenue','adRequests','responsesServed','measurableImpressions','viewableImpressions'];
export const GAM_CSV_LIMIT = 131072;
const check = (ok,message) => { if(!ok)throw Error(message); };
const dayMs=86400000;
function date(value) {
  check(typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value),'Use dates in YYYY-MM-DD format.');
  const time=Date.parse(value+'T00:00:00.000Z');
  check(Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value,'Invalid report date.');
  return time;
}
function whole(value) {
  check(/^(0|[1-9]\d*)$/.test(value),'Counts must be non-negative whole numbers without separators.');
  const n=Number(value);check(Number.isSafeInteger(n),'Count is too large.');return n;
}
function money(value) {
  check(value.length<=32,'Revenue is too large.');
  check(/^-?(0|[1-9]\d*)(\.\d{1,6})?$/.test(value),'Revenue must use a decimal point and at most six decimal places, without currency symbols.');
  const [units,fraction='']=value.replace(/^-/,'').split('.');
  const n=BigInt(units)*1000000n+BigInt(fraction.padEnd(6,'0'));
  check(n<=BigInt(Number.MAX_SAFE_INTEGER),'Revenue is too large.');
  return Number(value.startsWith('-')?-n:n);
}
function decimal(n) {
  const value=BigInt(n),abs=value<0n?-value:value;
  return (value<0n?'-':'')+String(abs/1000000n)+'.'+String(abs%1000000n).padStart(6,'0');
}
// Scalar canonical CSV: quoted cells/escaped quotes, BOM, CRLF and LF are accepted.
// Multiline cells, totals, extra dimensions and localized numeric formats are not.
function parseCsv(csv) {
  check(typeof csv==='string'&&new TextEncoder().encode(csv).length<=GAM_CSV_LIMIT,'CSV must be at most 128 KB.');
  const lines=csv.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').split('\n');
  if(lines.at(-1)==='')lines.pop();
  check(lines.length>=2&&lines.length<=733,'Use 1–732 daily rows, without totals or blank lines.');
  return lines.map((line,index)=>{
    check(!line.includes('\r'),'Invalid CSV line ending.');
    const cells=[];let at=0;
    for(;;){
      let value='';
      if(line[at]==='"'){
        at++;let closed=false;
        while(at<line.length){
          if(line[at]==='"'){
            at++;
            if(line[at]==='"'){value+='"';at++;}else{closed=true;break;}
          }else value+=line[at++];
        }
        check(closed&&(at===line.length||line[at]===','),'Malformed quoted CSV cell on row '+(index+1)+'.');
      }else{
        while(at<line.length&&line[at]!==','){check(line[at]!=='"','Unexpected CSV quote.');value+=line[at++];}
      }
      cells.push(value);check(cells.length<=GAM_COLUMNS.length,'Unexpected CSV columns.');
      if(at===line.length)break;
      at++;
    }
    check(cells.length===GAM_COLUMNS.length,'Expected all eight template columns on row '+(index+1)+'.');
    return cells;
  });
}
function validPlan(plan) {
  check(plan?.kind==='tessera-gam-reporting-plan'&&plan.labelsReady&&plan.arms?.length===2,'Both script versions need verified GAM labels.');
  for(const [i,variant] of ['A','B'].entries())check(plan.arms[i].variant===variant&&plan.arms[i].value===gamValue(plan.deliverySha256,variant,plan.key),'Invalid reporting mapping.');
}
export function gamReportTemplate(plan) {
  validPlan(plan);
  return GAM_COLUMNS.join(',')+'\r\n'+plan.arms.map(a=>['YYYY-MM-DD',a.value,'','','','','',''].join(',')).join('\r\n')+'\r\n';
}

export async function previewGamReport(plan,input,assignments=null,now=Date.now()) {
  validPlan(plan);
  const fields=['csv','startDate','endDate','currency','timeZone','revenueBasis','revenueMetric'];
  check(input&&Object.keys(input).sort().join(',')===[...fields].sort().join(','),'Unexpected report metadata.');
  const start=date(input.startDate),end=date(input.endDate);
  check(end>=start&&(end-start)/dayMs<366,'Choose a report period of 1–366 days.');
  check(typeof input.currency==='string'&&/^[A-Z]{3}$/.test(input.currency),'Enter the three-letter currency from the GAM report.');
  check(['net','gross','unknown'].includes(input.revenueBasis),'Choose the revenue basis from the source report.');
  check(['total','cpm-cpc'].includes(input.revenueMetric),'Choose Total revenue or Total CPM and CPC revenue.');
  let reportTimeZone,today;
  try {
    check(typeof input.timeZone==='string'&&input.timeZone.length<=64,'Invalid time zone.');
    const formatter=new Intl.DateTimeFormat('en-US',{timeZone:input.timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
    reportTimeZone=formatter.resolvedOptions().timeZone;
    const parts=Object.fromEntries(formatter.formatToParts(now).map(p=>[p.type,p.value]));
    today=parts.year+'-'+parts.month+'-'+parts.day;
  }catch{throw Error('Enter a valid IANA time zone from the GAM report.');}
  const matrix=parseCsv(input.csv);
  check(matrix.shift().join(',')===GAM_COLUMNS.join(','),'Use the exact CSV template headers and order.');
  const rows=[],seen=new Set();
  for(const cells of matrix){
    const raw=Object.fromEntries(GAM_COLUMNS.map((k,i)=>[k,cells[i]]));
    const time=date(raw.date);check(time>=start&&time<=end,'CSV contains a date outside the chosen period.');
    const arm=plan.arms.find(a=>a.value===raw.value);
    check(arm,'CSV contains an unsupported variant value or an unlabeled row.');
    const identity=raw.date+':'+arm.variant;
    check(!seen.has(identity),'Duplicate day/variant row. Remove totals or additional dimensions before importing.');seen.add(identity);
    const row={date:raw.date,variant:arm.variant,impressions:whole(raw.impressions),revenueMicros:money(raw.revenue)};
    for(const k of GAM_COLUMNS.slice(4))row[k]=raw[k]===''?null:whole(raw[k]);
    for(const [denominator,numerator] of [['adRequests','responsesServed'],['measurableImpressions','viewableImpressions']]){
      check((row[denominator]===null)===(row[numerator]===null),'Provide both '+denominator+' and '+numerator+', or leave both blank.');
      check(row[numerator]===null||row[numerator]<=row[denominator],numerator+' cannot exceed '+denominator+' for this display report.');
    }
    rows.push(row);
  }
  const missing=[];
  for(let time=start;time<=end;time+=dayMs)for(const variant of ['A','B']){
    const day=new Date(time).toISOString().slice(0,10);if(!seen.has(day+':'+variant))missing.push({date:day,variant});
  }
  const blockers=[];
  if(missing.length)blockers.push('Missing daily A/B rows are unknown, not zero.');
  if(input.endDate>=today)blockers.push('The report includes an unfinished or future day in its own time zone.');
  if(input.revenueBasis==='unknown')blockers.push('Confirm the revenue basis before comparing results.');
  if(plan.arms.some(a=>a.trafficPercent===0))blockers.push('Both variants need traffic for a comparison.');
  const dataComplete=blockers.length===0;
  const aligned=reportTimeZone==='UTC'&&assignments?.timeZone==='UTC';
  if(assignments)check(assignments.kind==='tessera-assignment-analysis'&&assignments.deliverySha256===plan.deliverySha256,'Assignment summary belongs to a different delivery.');
  if(!aligned)blockers.push(assignments?'GAM and assignment time zones do not align; daily samples are not joined.':'No assignment collection is available for this experiment.');
  if(assignments?.atCapacity)blockers.push('The private assignment sample reached its limit.');
  blockers.push('Total assignment coverage is unknown; revenue per assigned page cannot be calculated.');
  blockers.push('Imported GAM data and inventory scope require verification against the source report.');
  if(['Varijant','Variant'].includes(plan.key))blockers.push('A/B values do not identify a test. Verify the GAM site, ad units and date filters; do not combine overlapping tests or revisions.');
  const total=(selected,key)=>{
    if(selected.length===0||selected.some(r=>r[key]===null))return null;
    return selected.reduce((n,r)=>{const sum=n+r[key];check(Number.isSafeInteger(sum),'Report totals exceed the supported precision.');return sum;},0);
  };
  const totals={};
  for(const arm of plan.arms){
    const selected=rows.filter(r=>r.variant===arm.variant),n={rowCount:selected.length};
    for(const k of ['impressions','revenueMicros',...GAM_COLUMNS.slice(4)])n[k]=total(selected,k);
    n.revenue=n.revenueMicros===null?null:decimal(n.revenueMicros);
    n.revenuePerThousandImpressions=n.impressions>0?n.revenueMicros/1000/n.impressions:null;
    n.responseRatePercent=n.adRequests>0?100*n.responsesServed/n.adRequests:null;
    n.viewabilityPercent=n.measurableImpressions>0?100*n.viewableImpressions/n.measurableImpressions:null;
    n.receivedAssignments=aligned?assignments.daily.filter(d=>d.date>=input.startDate&&d.date<=input.endDate).reduce((s,d)=>s+d[arm.variant].assigned,0):null;
    n.pageRpm=null;n.impressionsPerAssignedPage=null;totals[arm.variant]=n;
  }
  return {schemaVersion:1,kind:'tessera-gam-report-preview',scope:'private-test-preview',experimentId:plan.experimentId,
    deliverySha256:plan.deliverySha256,comparison:plan.comparison,period:{startDate:input.startDate,endDate:input.endDate,timeZone:reportTimeZone},
    source:{format:'tessera-gam-daily-v1',csvSha256:await sha256(new TextEncoder().encode(input.csv)),currency:input.currency,revenueBasis:input.revenueBasis,revenueMetric:input.revenueMetric},
    totals,missingRows:missing,providedRows:rows.length,dataComplete,coverage:'unknown',revenueReady:false,winner:null,upliftPercent:null,blockers,
    notes:['Totals describe the provided rows only; missing rows are never synthesized.',
      'Rates are calculated from summed counts, not averages of daily percentages.',
      'Received assignments are a separate private TEST sample, not site pageviews.',
      'Preview only. No report is stored and no experiment is started or changed.']};
}
