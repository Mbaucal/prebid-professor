import {createMeasurementPlan,listMeasurementPlans,readMeasurementPlan} from './ab-report-plan.mjs';
import {abGamReportTemplate,previewAbGamReport} from './ab-gam-report.mjs';
import {REPORT_FIELDS,check,fail,isRecord} from './ab-measurement-utils.mjs';

const JSON_LIMIT=160*1024;
async function body(request,fields){
  check((request.headers.get('content-type')??'').split(';')[0].trim().toLowerCase()==='application/json','JSON body is required.',415);
  const reader=request.body?.getReader();check(reader,'Request body is required.',400);const chunks=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>JSON_LIMIT){await reader.cancel().catch(()=>{});fail('Reporting request exceeds 160 KB.',413);}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('Valid UTF-8 JSON is required.',400);}
  check(isRecord(parsed)&&Object.keys(parsed).every(key=>fields.includes(key)),'Unknown reporting field. Source records and coverage flags are not accepted.');return parsed;
}
/** Caller supplies the existing authenticated/site-scoped adapter; this is not public intake. */
export async function abMeasurementResponse(request,{bucket,site,actor,base,headers,readVersion}){
  const url=new URL(request.url),rest=url.pathname.slice(base.length);
  if(!/^\/abx-[a-f0-9]{64}\/measurement(?:\/|$)/.test(rest))return null;
  const match=rest.match(/^\/(abx-[a-f0-9]{64})\/measurement\/plans(?:\/(abm-[a-f0-9]{64})(?:\/(template\.csv|preview))?)?$/);
  const respond=(value,status=200,extra={})=>new Response(extra['content-type']?.startsWith('text/csv')?value:JSON.stringify(value),{status,headers:{...Object.fromEntries(new Headers(headers)), 'cache-control':'private, no-store','x-content-type-options':'nosniff','content-type':'application/json; charset=utf-8',...extra}});
  if(!match)return respond({error:'Reporting route not found.'},404);
  const [,id,planId,action]=match,methods=!planId?['GET','POST']:action==='preview'?['POST']:['GET'];
  if(!methods.includes(request.method))return respond({error:'Method not allowed.'},405,{allow:methods.join(', ')});
  try{
    check(!url.search,'Unknown query.',400);
    if(!planId){
      if(request.method==='GET')return respond(await listMeasurementPlans(bucket,{site,id,readVersion}));
      const result=await createMeasurementPlan(bucket,{site,id,actor,report:await body(request,REPORT_FIELDS),readVersion});
      return respond(result,result.created?201:200);
    }
    const saved=await readMeasurementPlan(bucket,{site,id,planId});
    if(action==='template.csv')return respond(abGamReportTemplate(saved.plan),200,{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="report-${saved.plan.testId}-${planId.slice(-8)}.csv"`});
    if(action==='preview')return respond(await previewAbGamReport(saved.plan,await body(request,['csv'])));
    return respond(saved);
  }catch(error){
    if([400,401,404,409,413,415,422,503].includes(error?.status))return respond({error:error.message,...(error.code?{code:error.code}:{})},error.status);
    return respond({error:'Reporting data could not be read or saved. Retry.'},503);
  }
}
