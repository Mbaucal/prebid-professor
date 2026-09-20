import {Buffer} from 'node:buffer';
import {baseReadable, previousArchiveBase64, preparedTemplates} from '../../.generated/site-ab-baseline.mjs';
import {buildConfigurableABPackage} from '../../scripts/configurable-ab-package.mjs';
import {sha256} from '../../scripts/static-aa-package.mjs';
import {DEFAULT_PACKAGE_SETTINGS, validatePackageSettings} from '../experiments/package-settings-v1.mjs';

const ID = /^tanjug-ab-2\.0\.0-[a-f0-9]{64}$/;
const BASELINE = 'tanjug-aa-1.0.2';
const ARCHIVE_SHA = 'bd0d9a6973903a3ec585f88e4b815eefb7a061ec8a32593f671b53ce211dfb1e';
const headers = {'cache-control':'private, no-store','x-content-type-options':'nosniff'};
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{...headers,'content-type':'application/json'}});
const check = (ok,message,status=409) => {if(!ok)throw Object.assign(Error(message),{status});};
const root = site => `site-ab-generated/v1/${site}/`;
const metaKey = (site,release) => root(site)+'records/'+release+'.json';
const zipKey = (site,release) => root(site)+'archives/'+release+'.zip';
const pinned = () => Buffer.from(previousArchiveBase64,'base64');
const supports = row => row && /^(?:https?:\/\/)?(?:www\.)?tanjug\.rs\/?$/i.test(row.domain?.trim()||'')
  && row.gam_path === '/22852026051/Tanjug.rs-Display/';
const readSite = (env,site) => env.DB.withSession('first-primary').prepare('SELECT id,name,domain,gam_path FROM publishers WHERE id=?').bind(site).first();
const revision = row => sha256(JSON.stringify({baseline:ARCHIVE_SHA,site:row.id,domain:row.domain,gamPath:row.gam_path}));

async function readBody(request) {
  check(request.headers.get('content-type')?.split(';')[0]==='application/json','Send JSON settings.',415);
  check(request.body,'Missing settings.',400);
  const reader=request.body.getReader();let total=0;const chunks=[];
  try {for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;check(total<=4096,'Settings are too large.',413);chunks.push(value);}}
  catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(Error('Invalid JSON settings.'),{status:400});}
}

function summary(record) {
  check(record?.schemaVersion===1 && ID.test(record.release) && /^[a-f0-9]{64}$/.test(record.archiveSha256)
    && Number.isSafeInteger(record.bytes) && record.bytes>0 && record.bytes<1048576
    && typeof record.notes==='string' && record.notes.length<=160 && Number.isFinite(Date.parse(record.createdAt)), 'Saved package metadata differs.');
  return {release:record.release,settings:validatePackageSettings(record.settings),notes:record.notes,
    createdAt:record.createdAt,bytes:record.bytes,sha256:record.archiveSha256,baseline:BASELINE};
}

async function readRecord(env,site,release) {
  const object=await env.BUILDS.get(metaKey(site,release));
  check(object && object.size<32768,'Saved package not found.',404);
  const bytes=Buffer.from(await object.arrayBuffer());
  check(sha256(bytes)===object.customMetadata?.sha256,'Saved metadata checksum differs.');
  const record=JSON.parse(bytes.toString('utf8'));
  check(record.siteId===site && record.release===release && record.baseline===BASELINE,'Saved package identity differs.');
  summary(record);return record;
}

async function archive(env,site,record) {
  const object=await env.BUILDS.get(zipKey(site,record.release));
  check(object && object.size===record.bytes,'Saved ZIP is missing or incomplete.');
  const bytes=Buffer.from(await object.arrayBuffer());
  check(bytes.length===record.bytes && sha256(bytes)===record.archiveSha256,'Saved ZIP checksum differs.');
  return bytes;
}

async function putOnce(env,key,bytes,customMetadata,contentType) {
  await env.BUILDS.put(key,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),customMetadata,
    httpMetadata:{contentType,cacheControl:'private, no-store'}});
}

// Caller owns authentication/CSRF. This service never changes a delivery channel.
export async function abEditorResponse(request,env,site,resource,actor,{build=buildConfigurableABPackage}={}) {
  try {
    check(/^[a-z0-9][a-z0-9-]{0,97}$/.test(site),'Invalid site.',404);
    const url=new URL(request.url),cursor=url.searchParams.get('cursor');
    check([...url.searchParams.keys()].every(k=>k==='cursor') && url.searchParams.getAll('cursor').length<=1
      && (!cursor||cursor.length<=2048) && (!url.search||(!resource&&request.method==='GET')),'Unknown query.',400);
    check(['GET','POST'].includes(request.method) && !(resource&&request.method!=='GET'),'Method not allowed.',405);
    const row=await readSite(env,site);check(row,'Site not found.',404);
    if(!supports(row)) {
      if(!resource&&request.method==='GET')return json({supported:false});
      check(false,'This baseline belongs to the reviewed Tanjug site and GAM path.');
    }
    if(resource==='baseline')return new Response(pinned(),{headers:{...headers,'content-type':'application/zip',
      'content-disposition':`attachment; filename="${BASELINE}.zip"`,'x-package-sha256':ARCHIVE_SHA}});
    if(resource) {
      check(ID.test(resource),'Unknown package.',404);
      const record=await readRecord(env,site,resource);
      return new Response(await archive(env,site,record),{headers:{...headers,'content-type':'application/zip',
        'content-disposition':`attachment; filename="${record.release}.zip"`,'x-package-sha256':record.archiveSha256}});
    }
    if(request.method==='GET') {
      const page=await env.BUILDS.list({prefix:root(site)+'records/',limit:100,include:['customMetadata'],...(cursor?{cursor}:{})});
      const packages=page.objects.map(object=>{
        const record=JSON.parse(object.customMetadata?.summary||'null');
        check(object.key===metaKey(site,record?.release),'Saved package index differs.');return summary(record);
      }).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      return json({supported:true,baseline:{release:BASELINE,positions:19,prebidVersion:'11.34.0',sha256:ARCHIVE_SHA,bytes:pinned().length},
        revision:revision(row),defaults:DEFAULT_PACKAGE_SETTINGS,packages,nextCursor:page.truncated?page.cursor:null});
    }
    const body=await readBody(request);
    check(body&&Object.keys(body).sort().join(',')==='notes,revision,settings','Use the displayed generation fields.',422);
    check(typeof body.notes==='string'&&body.notes.length<=160,'Use a release note of up to 160 characters.',422);
    check(body.revision===revision(row),'The baseline or site identity changed. Reload before generating.');
    let settings;try{settings=validatePackageSettings(body.settings);}catch(e){check(false,e.message,422);}
    const result=await build({base:Buffer.from(baseReadable),previousArchive:pinned(),settings,preparedTemplates});
    check(ID.test(result.release)&&result.archive.length<1048576&&sha256(result.archive)===result.archiveSha256,'Generated package verification failed.',500);
    const current=await readSite(env,site);
    check(supports(current)&&revision(current)===body.revision,'Site identity changed during generation. Reload.');
    let existing=await env.BUILDS.get(metaKey(site,result.release));
    if(existing) {
      const record=await readRecord(env,site,result.release);await archive(env,site,record);
      check(record.archiveSha256===result.archiveSha256,'Existing release differs.');
      return json({package:summary(record),alreadySaved:true});
    }
    await putOnce(env,zipKey(site,result.release),result.archive,{sha256:result.archiveSha256},'application/zip');
    const record={schemaVersion:1,siteId:site,release:result.release,baseline:BASELINE,settings,notes:body.notes.trim(),
      createdAt:new Date().toISOString(),createdBy:actor,archiveSha256:result.archiveSha256,bytes:result.archive.length};
    await archive(env,site,record);
    // Register only a verified complete archive. Concurrent identical generation
    // keeps the first record and its timestamp/note; never overwrites history.
    const bytes=Buffer.from(JSON.stringify(record));
    await putOnce(env,metaKey(site,result.release),bytes,{sha256:sha256(bytes),summary:JSON.stringify(record)},'application/json');
    const saved=await readRecord(env,site,result.release);
    check(saved.archiveSha256===result.archiveSha256,'Saved release differs.');
    return json({package:summary(saved),alreadySaved:false},201);
  } catch(e) {return json({error:e.status?e.message:'Could not complete the A/B package request. Reload and retry.'},e.status??500);}
}
