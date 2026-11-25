import {checkAbCompatibility} from './ab-bundle.mjs';
import {AB_LIMITS,addAbTestEvent,changeAbTestDeletion,createAbTest,listAbTests,proposeTestId,readAbRecordBytes,readAbTest,readAbZip} from './ab-store.mjs';
import {abMeasurementResponse} from './ab-measurement-api.mjs';
import {gamReportV2Response} from './gam-report-v2-api.mjs';

/* The A/B tests API of one site (MBA-416), shared by both lines. The caller mounts it under
 * `base` after its own host, sign-in, method and same-origin checks, and passes the bucket, the
 * site, the actor and how to read saved versions. It returns a Response, or null when the path is
 * not one of its routes.
 *   GET    base                    list, defaults and the saved versions to choose from
 *   POST   base/check              dry run: the compatibility result of A and B (a refusal is 200)
 *   POST   base                    create (201), or the same test saved before (200)
 *   GET    base/<abx>              record, recordSha256, deletedAt and events
 *   GET    base/<abx>/download     the stored bundle ZIP
 *   GET    base/<abx>/record       the exact stored record bytes
 *   DELETE base/<abx>, PUT base/<abx>   trash and restore, body {confirmId, sha256}
 *   POST   base/<abx>/events       {type: 'marked-live' | 'marked-stopped'} */
const DRAFT=/^builtin-draft-[a-f0-9]{64}$/,SAVED=/^builtin-(?:draft|release)-[a-f0-9]{64}$/;
const CURSOR=/^[A-Za-z0-9_=+/.-]{1,1024}$/;
const CONTROL=/[\u0000-\u001f\u007f-\u009f]/;
const MAX_BODY=4096;
const CREATE_FIELDS=['a','b','name','testId','trafficBPercent','reportingKey'];
// A storage fault can come after a write (the TestId claim, an event), so these never say that nothing was changed.
const UNEXPECTED='The A/B test could not be read or saved. Retry.';
// A failed create is completed by the same values: they give the same test id, which reuses its TestId claim.
const NOT_SAVED='The A/B test could not be saved. Retry with the same values.';
const fail=(status,message,extra={})=>{throw Object.assign(new Error(message),{status},extra);};

/** A bounded JSON body with the semantics of the TEST workspace reader: 415, 413, 400 and 422 for an unknown field. */
async function jsonBody(request,allowed){
  if((request.headers.get('content-type')||'').split(';')[0].trim().toLowerCase()!=='application/json')fail(415,'JSON body is required.');
  const reader=request.body?.getReader();
  if(!reader)fail(400,'Request body is required.');
  const chunks=[];let size=0;
  try{
    for(;;){
      const {value,done}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>MAX_BODY){await reader.cancel().catch(()=>{});fail(413,`Request exceeds ${MAX_BODY/1024} KB.`);}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;
  for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  let text,value;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail(400,'UTF-8 input is required.');}
  try{value=JSON.parse(text);}catch{fail(400,'Invalid JSON.');}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))
    fail(422,'Unknown request field. Source code and uploaded files are not accepted.');
  return value;
}

/** One saved version through the caller's readVersion. A missing version is a refusal in plain words. */
async function readSaved(readVersion,id,side){
  let pkg;
  try{pkg=await readVersion(id);}
  catch(error){if(error?.status!==404)fail(503,`Version ${side} could not be read. Nothing was saved. Retry.`);}
  if(!pkg)fail(422,`Version ${side} is no longer in Saved versions. Choose another saved version. Saved A/B tests keep their own copies.`,{code:'package-missing',check:'packages'});
  return pkg;
}
function armOf(id,pkg){
  const note=pkg.release?.note??pkg.release?.notes;
  let runtimeVersion=pkg.release?.runtime?.runtimeVersion??null;
  try{runtimeVersion=JSON.parse(new TextDecoder().decode(pkg.files['manifest.json'])).runtime.runtimeVersion??runtimeVersion;}catch{}
  return {id,name:typeof note==='string'&&note.trim()?note.trim():'Generated package',runtimeVersion};
}
function savedIds(body,testOnly){
  const pattern=testOnly?DRAFT:SAVED;
  if(typeof body.a!=='string'||typeof body.b!=='string'||!pattern.test(body.a)||!pattern.test(body.b))
    fail(400,'Choose a saved version for A and B.',{code:'invalid-request'});
  return [body.a,body.b];
}

/** Routes one request. options: {bucket, site, actor, base, headers, testOnly, readVersion(id) -> {files, release},
 * listVersions() -> [{id, name, createdAt, runtimeVersion, prebidVersion}], current() -> versionId|null, defaults: {trafficBPercent}} */
export async function abTestsResponse(request,{bucket,site,actor,base,headers,testOnly=false,readVersion,listVersions,current,defaults}){
  const url=new URL(request.url),path=url.pathname;
  if(path!==base&&!path.startsWith(base+'/'))return null;
  const detailed=await gamReportV2Response(request,{bucket,site,actor,base,headers,readVersion});
  if(detailed)return detailed;
  const measurement=await abMeasurementResponse(request,{bucket,site,actor,base,headers,readVersion});
  if(measurement)return measurement;
  const rest=path.slice(base.length),item=rest.match(/^\/(abx-[a-f0-9]{64})(?:\/(download|record|events))?$/);
  const route=rest===''?{name:'list',methods:['GET','POST']}:rest==='/check'?{name:'check',methods:['POST']}
    :item?{name:item[2]??'item',id:item[1],methods:item[2]==='events'?['POST']:item[2]?['GET']:['GET','PUT','DELETE']}:null;
  if(!route)return null;
  const respond=(body,status=200,extra={})=>{
    const out=new Headers(headers);
    for(const [name,value] of Object.entries(extra))out.set(name,value);
    if(!extra['content-type'])out.set('content-type','application/json; charset=utf-8');
    return new Response(body instanceof Uint8Array?body:JSON.stringify(body),{status,headers:out});
  };
  try{
    if(!route.methods.includes(request.method))return respond({error:'Method not allowed.'},405,{allow:route.methods.join(', ')});
    const listing=route.name==='list'&&request.method==='GET';
    if(listing?[...url.searchParams].some(([key,value])=>key!=='cursor'||!CURSOR.test(value))||url.searchParams.getAll('cursor').length>1:url.search)
      fail(400,'Unknown query.');
    if(listing){
      const [saved,proposedTestId,versions,selected]=await Promise.all([listAbTests(bucket,site),proposeTestId(bucket,site),listVersions(),current?current():null]);
      return respond({supported:true,site,testOnly:Boolean(testOnly),defaults:{trafficBPercent:defaults?.trafficBPercent??50},proposedTestId,current:selected??null,
        versions,tests:saved.tests,deleted:saved.deleted,nextCursor:null,limits:{tests:AB_LIMITS.tests,name:AB_LIMITS.name}});
    }
    if(route.name==='check'){
      const body=await jsonBody(request,CREATE_FIELDS),[a,b]=savedIds(body,testOnly);
      if(body.reportingKey!==undefined&&!['TestId','VersionId'].includes(body.reportingKey))fail(400,'Choose TestId or VersionId reporting identity.',{code:'invalid-request'});
      const packages={},arms={A:null,B:null};let missing=null;
      for(const [side,id] of [['A',a],['B',b]]){
        if(side==='B'&&b===a){packages.B=packages.A;arms.B=arms.A;continue;}
        try{packages[side]=await readSaved(readVersion,id,side);arms[side]=armOf(id,packages[side]);}
        catch(error){if(error?.code!=='package-missing')throw error;missing??=error;}
      }
      if(missing)return respond({compatible:false,refusal:{code:missing.code,check:missing.check,message:missing.message},checks:[],warnings:[],configDiff:null,arms});
      return respond({...await checkAbCompatibility({site,a:packages.A,b:packages.B,...(body.reportingKey==='VersionId'?{loaderVersion:'1.2.0'}:{})}),arms});
    }
    if(route.name==='list'){
      const body=await jsonBody(request,CREATE_FIELDS);
      if(body.reportingKey!==undefined&&!['TestId','VersionId'].includes(body.reportingKey))fail(400,'Choose TestId or VersionId reporting identity.',{code:'invalid-request'});
      if(typeof body.name==='string'&&CONTROL.test(body.name))fail(400,'Use a test name without line breaks, tabs or other control characters.',{code:'invalid-request'});
      const [a,b]=savedIds(body,testOnly);
      const A=await readSaved(readVersion,a,'A'),B=b===a?A:await readSaved(readVersion,b,'B');
      const result=await createAbTest(bucket,{site,actor,a:A,b:B,name:typeof body.name==='string'?body.name.trim():body.name,testId:body.testId,trafficBPercent:body.trafficBPercent,reportingKey:body.reportingKey});
      return result.created?respond({created:true,record:result.record,recordSha256:result.recordSha256},201)
        :respond({created:false,record:result.record,recordSha256:result.recordSha256,deletedAt:result.deletedAt});
    }
    const id=route.id;
    if(route.name==='download'){
      const {bytes,record,zipSha256}=await readAbZip(bucket,site,id);
      return respond(bytes,200,{'content-type':'application/zip','content-disposition':`attachment; filename="ab-${record.testId}-${id.slice(-8)}.zip"`,'x-package-sha256':zipSha256});
    }
    if(route.name==='record'){
      const {bytes,record,recordSha256}=await readAbRecordBytes(bucket,site,id);
      return respond(bytes,200,{'content-type':'application/json','content-disposition':`attachment; filename="ab-${record.testId}-${id.slice(-8)}.json"`,'x-record-sha256':recordSha256});
    }
    if(route.name==='events'){
      const body=await jsonBody(request,['type']);
      return respond({event:await addAbTestEvent(bucket,site,id,actor,body.type)},201);
    }
    if(request.method==='GET')return respond(await readAbTest(bucket,site,id));
    return respond(await changeAbTestDeletion(bucket,site,id,actor,await jsonBody(request,['confirmId','sha256']),request.method==='DELETE'));
  }catch(error){
    if([400,404,409,413,415,422,503].includes(error?.status)&&typeof error.message==='string')
      return respond({error:error.message,...(error.code?{code:error.code}:{}),...(error.check?{check:error.check}:{})},error.status);
    return respond({error:route.name==='list'&&request.method==='POST'?NOT_SAVED:UNEXPECTED},503);
  }
}
