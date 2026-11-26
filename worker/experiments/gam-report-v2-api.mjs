import {GAM_REPORT_V2_CSV_LIMIT} from './gam-report-v2-contracts.mjs';
import {createGamReportV2Plan,listGamReportV2Plans,readGamReportV2Plan} from './gam-report-v2-plan.mjs';
import {gamReportV2Template,previewGamReportV2} from './gam-report-v2.mjs';
import {GAM_REPORT_V2_FIELDS,check,fail,isRecord} from './gam-report-v2-utils.mjs';

const JSON_LIMIT=2*GAM_REPORT_V2_CSV_LIMIT+64*1024;
async function body(request,allowed){
  check((request.headers.get('content-type')??'').split(';')[0].trim().toLowerCase()==='application/json','JSON body is required.',415);
  const reader=request.body?.getReader();check(reader,'Request body is required.',400);const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>JSON_LIMIT){await reader.cancel().catch(()=>{});fail('Detailed report request exceeds its bounded JSON limit.',413);}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('Valid UTF-8 JSON is required.',400);}
  check(isRecord(parsed)&&Object.keys(parsed).every(key=>allowed.includes(key)),'Unknown detailed report field. Stored source pins and coverage flags are not accepted.');return parsed;
}
/** Caller supplies the existing authenticated, same-origin and site-scoped A/B adapter. */
export async function gamReportV2Response(request,{bucket,site,actor,base,headers,readVersion}){
  const url=new URL(request.url),rest=url.pathname.slice(base.length);
  if(!/^\/abx-[a-f0-9]{64}\/measurement\/v2(?:\/|$)/.test(rest))return null;
  const respond=(value,status=200,extra={})=>new Response(extra['content-type']?.startsWith('text/csv')?value:JSON.stringify(value),{status,headers:{...Object.fromEntries(new Headers(headers)),'cache-control':'private, no-store','x-content-type-options':'nosniff','content-type':'application/json; charset=utf-8',...extra}});
  const match=rest.match(/^\/(abx-[a-f0-9]{64})\/measurement\/v2\/plans(?:\/(abr-[a-f0-9]{64})(?:\/(template\.csv|preview))?)?$/);
  if(!match)return respond({error:'Detailed reporting route not found.'},404);
  const [,id,planId,action]=match,methods=!planId?['GET','POST']:action==='preview'?['POST']:['GET'];
  if(!methods.includes(request.method))return respond({error:'Method not allowed.'},405,{allow:methods.join(', ')});
  try{
    check(!url.search,'Unknown query.',400);
    if(!planId){
      if(request.method==='GET')return respond(await listGamReportV2Plans(bucket,{site,id,readVersion}));
      const result=await createGamReportV2Plan(bucket,{site,id,actor,report:await body(request,GAM_REPORT_V2_FIELDS),readVersion});return respond(result,result.created?201:200);
    }
    const saved=await readGamReportV2Plan(bucket,{site,id,planId});
    if(action==='template.csv')return respond(gamReportV2Template(saved.plan),200,{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="gam-detailed-${saved.plan.versionId}-${planId.slice(-8)}.csv"`});
    if(action==='preview')return respond(await previewGamReportV2(saved.plan,await body(request,['csv'])));
    return respond(saved);
  }catch(error){
    if([400,401,404,409,413,415,422,503].includes(error?.status))return respond({error:error.message,...(error.code?{code:error.code}:{})},error.status);
    return respond({error:'Detailed reporting data could not be read or saved. Retry.'},503);
  }
}
