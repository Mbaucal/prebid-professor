import {deletedPackage,changePackageDeletion} from './saved-package-trash.mjs';
import {Buffer} from 'node:buffer';
import {baseReadable,previousArchiveBase64,preparedTemplates} from '../../.generated/site-ab-baseline.mjs';
import {buildSavedScript,buildSavedTest,BASELINE_SHA} from '../../scripts/saved-script-package.mjs';
import {sha256} from '../../scripts/static-aa-package.mjs';
import {SCRIPT_ID,TEST_ID,displayName,scriptSettings} from '../experiments/saved-scripts-v1.mjs';

import {supportsNamedScripts, savedPrebidSettings, settingsForScript} from './prebid-cache-settings.mjs';

const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{...headers,'content-type':'application/json'}});
const check=(value,message,status=409)=>{if(!value)throw Object.assign(Error(message),{status});};
const key=(site,kind,id,ext)=>`site-script-library/v1/${site}/${kind}/${ext==='json'?'records':'archives'}/${id}.${ext}`;
const trashKey=(site,kind,id)=>`site-script-library/v1/${site}/deleted/${kind}/${id}.json`;
const validId=(kind,id)=>(kind==='scripts'?SCRIPT_ID:TEST_ID).test(id);
const readSite=(env,site)=>env.DB.withSession('first-primary').prepare('SELECT p.id,p.name,p.domain,p.gam_path,c.config_json FROM publishers p JOIN publisher_configs c ON c.publisher_id=p.id WHERE p.id=?').bind(site).first();
const supports=supportsNamedScripts;
const config=row=>JSON.parse(row.config_json);
const revision=row=>sha256(JSON.stringify({baseline:BASELINE_SHA,site:row.id,domain:row.domain,gamPath:row.gam_path,prebid:savedPrebidSettings(config(row))}));
const inputs=()=>({base:Buffer.from(baseReadable),previousArchive:Buffer.from(previousArchiveBase64,'base64'),preparedTemplates});
function summary(record) {
  check(record?.schemaVersion===1&&['scripts','tests'].includes(record.collection)&&validId(record.collection,record.id)
    &&typeof record.name==='string'&&displayName(record.name)===record.name
    &&Number.isSafeInteger(record.bytes)&&record.bytes>0&&record.bytes<1048576&&/^[a-f0-9]{64}$/.test(record.archiveSha256)
    &&Number.isFinite(Date.parse(record.createdAt)),'Saved version metadata differs.');
  const result={id:record.id,name:record.name,collection:record.collection,createdAt:record.createdAt,bytes:record.bytes,sha256:record.archiveSha256};
  if(record.collection==='scripts')result.settings=scriptSettings(record.settings);
  else {
    check(Number.isInteger(record.trafficBPercent)&&record.trafficBPercent>=0&&record.trafficBPercent<=100,'Saved traffic split differs.');
    result.trafficBPercent=record.trafficBPercent;result.scripts={};
    for(const v of ['A','B']){const s=record.scripts?.[v];check(SCRIPT_ID.test(s?.id),'Saved script reference differs.');result.scripts[v]={id:s.id,name:displayName(s.name),settings:scriptSettings(s.settings)};}
  }
  return result;
}
async function recordAt(env,site,kind,id,{allowDeleted=false}={}) {
  if(!allowDeleted)check(!await deletedPackage(env.BUILDS,trashKey(site,kind,id)),'This version was deleted. Restore it from Deleted scripts and tests first.',410);
  check(validId(kind,id),'Unknown saved version.',404);
  const object=await env.BUILDS.get(key(site,kind,id,'json'));check(object&&object.size<32768,'Saved version not found.',404);
  const bytes=Buffer.from(await object.arrayBuffer());check(sha256(bytes)===object.customMetadata?.sha256,'Saved version metadata checksum differs.');
  const record=JSON.parse(bytes.toString());
  check(record.siteId===site&&record.collection===kind&&record.id===id&&record.baseline===BASELINE_SHA,'Saved version identity differs.');
  summary(record);check(record.manifest?.id===id&&record.manifest.baseline===BASELINE_SHA&&record.manifest.name===record.name,'Saved manifest differs.');
  return record;
}
async function archiveAt(env,site,record) {
  const object=await env.BUILDS.get(key(site,record.collection,record.id,'zip'));check(object&&object.size===record.bytes,'Saved ZIP is incomplete.');
  const bytes=Buffer.from(await object.arrayBuffer());check(bytes.length===record.bytes&&sha256(bytes)===record.archiveSha256,'Saved ZIP checksum differs.');return bytes;
}
async function list(env,site,kind,cursor) {
  const page=await env.BUILDS.list({prefix:key(site,kind,'','json').slice(0,-5),limit:100,include:['customMetadata'],...(cursor?{cursor}:{})});
  const rows=await Promise.all(page.objects.map(async o=>{const s=JSON.parse(o.customMetadata?.summary||'null');check(o.key===key(site,kind,s?.id,'json'),'Saved version index differs.');return {...summary(s),deletedAt:(await deletedPackage(env.BUILDS,trashKey(site,kind,s.id)))?.deletedAt??null};}));
  rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return {collection:kind,items:rows.filter(r=>!r.deletedAt),deleted:rows.filter(r=>r.deletedAt),nextCursor:page.truncated?page.cursor:null};
}
async function bodyOf(request) {
  check(request.headers.get('content-type')?.split(';')[0]==='application/json','Send JSON settings.',415);
  check(request.body,'Missing settings.',400);const reader=request.body.getReader(),chunks=[];let total=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;check(total<=4096,'Settings are too large.',413);chunks.push(value);}}
  catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString());}catch{check(false,'Invalid JSON settings.',400);}
}
const put=(env,k,bytes,meta,type)=>env.BUILDS.put(k,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),customMetadata:meta,httpMetadata:{contentType:type,cacheControl:'private, no-store'}});

// Authentication and same-origin mutation checks are owned by the main router.
export async function scriptLibraryResponse(request,env,site,kind,id,actor,{scriptBuilder=buildSavedScript,testBuilder=buildSavedTest}={}) {
  try {
    check(/^[a-z0-9][a-z0-9-]{0,97}$/.test(site),'Unknown site.',404);
    const url=new URL(request.url),collection=url.searchParams.get('collection'),cursor=url.searchParams.get('cursor');
    check(!url.search||(!kind&&request.method==='GET'&&['scripts','tests'].includes(collection)&&cursor&&cursor.length<=2048
      &&[...url.searchParams.keys()].sort().join(',')==='collection,cursor'),'Unknown query.',400);
    check((id?['GET','DELETE','PUT']:['GET','POST']).includes(request.method)&&(request.method!=='POST'||['scripts','tests'].includes(kind)),'Method not allowed.',405);
    const row=await readSite(env,site);check(row,'Site not found.',404);
    if(!supports(row)){if(!kind&&request.method==='GET')return json({supported:false});check(false,'This baseline belongs to the reviewed Tanjug site and GAM path.');}
    if(id&&request.method!=='GET'){
      const record=await recordAt(env,site,kind,id,{allowDeleted:true});
      return json(await changePackageDeletion(env.BUILDS,trashKey(site,kind,id),{id,sha256:record.archiveSha256,actor},await bodyOf(request),request.method==='DELETE'));
    }
    if(id){const record=await recordAt(env,site,kind,id);return new Response(await archiveAt(env,site,record),{headers:{...headers,'content-type':'application/zip','content-disposition':`attachment; filename="${record.id}.zip"`,'x-package-sha256':record.archiveSha256}});}
    if(request.method==='GET') {
      check(!kind,'Unknown library route.',404);if(cursor)return json(await list(env,site,collection,cursor));
      const [scripts,tests]=await Promise.all([list(env,site,'scripts'),list(env,site,'tests')]);
      return json({supported:true,revision:revision(row),baseline:{release:'tanjug-aa-1.0.2',positions:19,prebidVersion:'11.34.0'},prebid:savedPrebidSettings(config(row)),
        scripts:scripts.items,tests:tests.items,deletedScripts:scripts.deleted,deletedTests:tests.deleted,nextCursors:{scripts:scripts.nextCursor,tests:tests.nextCursor}});
    }
    const body=await bodyOf(request),expected=kind==='scripts'?['revision','name','refreshSeconds']:['revision','name','scriptA','scriptB','trafficBPercent'];
    check(body&&Object.keys(body).sort().join(',')===expected.sort().join(','),'Use the displayed fields.',422);
    check(body.revision===revision(row),'Site or Prebid settings changed. Reload before saving.');
    let name,settings;try{name=displayName(body.name);if(kind==='scripts')settings=scriptSettings(settingsForScript(config(row),body.refreshSeconds));}catch(e){check(false,e.message,e.status??422);}
    let result;
    if(kind==='scripts')result=await scriptBuilder({...inputs(),name,settings});
    else {
      check(SCRIPT_ID.test(body.scriptA)&&SCRIPT_ID.test(body.scriptB),'Choose two saved script versions.',422);
      check(Number.isInteger(body.trafficBPercent)&&body.trafficBPercent>=0&&body.trafficBPercent<=100,'B traffic must be 0–100%.',422);
      const scripts={};
      for(const [v,scriptId] of [['A',body.scriptA],['B',body.scriptB]]){const record=await recordAt(env,site,'scripts',scriptId);scripts[v]={manifest:record.manifest,archive:await archiveAt(env,site,record)};}
      result=await testBuilder({...inputs(),name,trafficBPercent:body.trafficBPercent,scripts});
    }
    check(validId(kind,result.id)&&result.archive.length<1048576&&sha256(result.archive)===result.archiveSha256,'Generated version verification failed.',500);
    const current=await readSite(env,site);check(supports(current)&&revision(current)===body.revision,'Site identity changed during generation. Reload.');
    if(await env.BUILDS.get(key(site,kind,result.id,'json'))){const record=await recordAt(env,site,kind,result.id);await archiveAt(env,site,record);check(record.archiveSha256===result.archiveSha256,'Existing version differs.');return json({item:summary(record),alreadySaved:true});}
    await put(env,key(site,kind,result.id,'zip'),result.archive,{sha256:result.archiveSha256},'application/zip');
    const record={schemaVersion:1,siteId:site,collection:kind,id:result.id,name,baseline:BASELINE_SHA,createdAt:new Date().toISOString(),createdBy:actor,
      bytes:result.archive.length,archiveSha256:result.archiveSha256,manifest:result.manifest,
      ...(kind==='scripts'?{settings}:{trafficBPercent:result.trafficBPercent,scripts:result.scripts})};
    await archiveAt(env,site,record);
    const finalSite=await readSite(env,site);check(supports(finalSite)&&revision(finalSite)===body.revision,'Site identity changed during save. Reload.');
    const bytes=Buffer.from(JSON.stringify(record)),index={...summary(record),schemaVersion:1,archiveSha256:record.archiveSha256};
    await put(env,key(site,kind,record.id,'json'),bytes,{sha256:sha256(bytes),summary:JSON.stringify(index)},'application/json');
    const saved=await recordAt(env,site,kind,record.id);check(saved.archiveSha256===result.archiveSha256,'Saved version differs.');
    return json({item:summary(saved),alreadySaved:false},201);
  }catch(e){return json({error:e.status?e.message:'Could not complete the script library request. Reload and retry.'},e.status??500);}
}
