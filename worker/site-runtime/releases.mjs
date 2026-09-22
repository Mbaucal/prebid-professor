import { readPreviewSnapshot } from '../runtime/builtin-preview-service.mjs';
import { digest } from '../runtime/preview-snapshot.mjs';
import { sha256 } from '../runtime/prebid-artifact-check.mjs';
import { describeCandidate, saveDraftRelease, readDraftRelease } from '../runtime/draft-release-store.mjs';
import { runtimeCatalog, readPinnedSiteRuntime, buildArtifactCandidate } from '../test-workspace/runtime-catalog.mjs';
import { takeOverForBuild } from '../test-workspace/takeover-settings.mjs';
import { zipSync } from 'fflate';
import {requireSupportedCacheGenerator} from './prebid-cache-settings.mjs';
import { siteSetupState } from './setup-state.mjs';

const encode=new TextEncoder(),decode=new TextDecoder('utf-8',{fatal:true});
const ID=/^builtin-release-[a-f0-9]{64}$/;
const check=(ok,message,status=409)=>{if(!ok)throw Object.assign(new Error(message),{status});};
const db=env=>env.DB.withSession('first-primary');
const snapshot=(env,site)=>readPreviewSnapshot(db(env),site,{includePrebid:true});
const key=(site,id,name)=>`publishers/${site}/releases/${id}/${name}`;
const type=name=>name.endsWith('.js')?'application/javascript':name.endsWith('.json')?'application/json':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'text/plain';
const zip=files=>zipSync(Object.fromEntries(Object.entries(files).map(([n,b])=>[n,[b,{level:0,mtime:new Date(1980,0,1)}]])),{level:0});
const payload=row=>({id:row.id,version:row.version,status:row.status,notes:row.notes,createdAt:row.created_at,publishedAt:row.published_at});
export async function packageState(env,site,{testOnly=false}={}){
 const saved=await snapshot(env,site),revision=await digest(saved);let error=null,selected=null;
 try{selected=await readPinnedSiteRuntime({siteId:site,snapshot:saved,catalog:runtimeCatalog},env.BUILDS);}catch(e){error=e.message;}
 const setup=siteSetupState(saved);if(error&&setup.setupMessage)error=setup.setupMessage;
 let cacheBlocked=false;try{requireSupportedCacheGenerator(JSON.parse(saved.config.config_json));}catch(e){error=e.message;cacheBlocked=true;}
 const rows=await db(env).prepare("SELECT * FROM releases WHERE publisher_id=? AND version LIKE ? ORDER BY created_at DESC,id DESC LIMIT 50").bind(site,testOnly?'builtin-draft-%':'builtin-release-%').all();
 // Keep prior production packages reachable after selecting a built-in runtime.
 const earlier=testOnly?{results:[]}:await db(env).prepare(`SELECT r.*,
   EXISTS(SELECT 1 FROM audit_log a WHERE a.publisher_id=r.publisher_id AND
    ((a.entity_id=r.id AND a.action IN ('release.production_published','release.rolled_back')) OR
     (a.action='builtin_release.production' AND json_extract(a.details_json,'$.previousReleaseId')=r.id))) AS was_production
   FROM releases r WHERE r.publisher_id=? AND r.id NOT LIKE 'builtin-%' AND r.version NOT LIKE 'builtin-%'
   ORDER BY CASE WHEN r.status='production' OR EXISTS(SELECT 1 FROM audit_log a WHERE a.publisher_id=r.publisher_id AND a.action='builtin_release.production' AND json_extract(a.details_json,'$.previousReleaseId')=r.id) THEN 0 ELSE 1 END,was_production DESC,r.created_at DESC,r.id DESC LIMIT 50`).bind(site).all();
 return {site:saved.site,enablePrebid:JSON.parse(saved.config.config_json).enablePrebid===true,revision,ready:!error,error,nextStep:cacheBlocked?'demand':error?setup.nextStep:null,runtime:selected?.pin??null,testOnly,releases:rows.results.map(payload),earlierReleases:earlier.results.map(r=>({...payload(r),canRestore:r.status==='archived'&&Boolean(r.was_production)}))};
}
async function build(env,site,revision,stamp){
 const saved=await snapshot(env,site);check(await digest(saved)===revision,'Settings changed. Reload before generating.');
 const selected=await readPinnedSiteRuntime({siteId:site,snapshot:saved,catalog:runtimeCatalog},env.BUILDS);
 const candidate=await buildArtifactCandidate({snapshot:selected.snapshot,pin:selected.pin,prebid:selected.prebid,takeOver:takeOverForBuild(saved),buildTimestamp:stamp});
 check(await digest(await snapshot(env,site))===revision,'Settings changed during generation. Generate again.');
 await describeCandidate(site,candidate);
 return {candidate,saved};
}
/** Explicit generation creates a stored package, never changes a channel. */
export async function generatePackage(env,site,actor,body,{testOnly=false}={}){
 check(body&&Object.keys(body).sort().join('|')==='notes|revision','Use the displayed generation fields.',422);
 check(typeof body.notes==='string'&&body.notes.length<=160,'Use a release note of up to 160 characters.',422);
 const stamp=new Date().toISOString().replace(/[-:]/g,'').replace('T','_').slice(0,15);
 const {candidate,saved}=await build(env,site,body.revision,stamp);
 if(testOnly){
  check(site==='test-site','Only the existing TEST site is allowed.',403);
  const result=await saveDraftRelease({isolation:'explicit-test-store',db:env.DB,bucket:env.BUILDS},{siteId:site,candidate,actor,note:body.notes});
  return {release:{...result.draft,notes:result.draft.note},testOnly:true};
 }
 const {descriptor}=await describeCandidate(site,candidate);
 const id=`builtin-release-${descriptor.packageSha256}`,files={...candidate.files};
 // Store the reviewed output as a complete, immutable release with exact source pins.
 const created=new Date().toISOString();
 files['README.txt']=encode.encode(`Tessera release ${id}\nRuntime ${descriptor.runtime.runtimeVersion}\nGenerated from saved site settings. Stage and review before production. Use ads.js once; Prebid is ${descriptor.prebidBuild?'included':'disabled'}.\n`);
 files['ads.js']=files['ads.min.js'].slice();
 files['implementation.html']=encode.encode(decode.decode(files['implementation.html']).replace('REVIEW CANDIDATE ONLY.','STAGING REVIEW.').replace('Do not deploy to production.','Publish only after staging review.').replace('src="./ads.min.js"','src="./ads.js"'));
 const config={...JSON.parse(decode.decode(files['config.json'])),site:{id:site},version:id,enablePrebid:Boolean(descriptor.prebidBuild),demandMode:descriptor.prebidBuild?'prebid':'gam-adx-only'};
 files['config.json']=encode.encode(JSON.stringify(config,null,2)+'\n');
 const manifest={...candidate.manifest, snapshotHash:candidate.manifest.configHash,configHash:await sha256(files['config.json']),prebidEnabled:Boolean(descriptor.prebidBuild),demandMode:config.demandMode,kind:'builtin-runtime-release',completeRelease:true,releaseId:id,version:id,generatedAt:created,generatedBy:actor,status:'draft',files:{}};
 manifest.warnings=candidate.manifest.warnings.filter(w=>!w.startsWith('Candidate only.'));
 for(const [name,bytes] of Object.entries(files))if(name!=='manifest.json')manifest.files[name]={key:key(site,id,name),size:bytes.length,byteSize:bytes.length,sha256:await sha256(bytes)};
 files['manifest.json']=encode.encode(JSON.stringify(manifest,null,2)+'\n');
 // Never remove files after uncertain registration: a successful retry may own them.
 for(const [name,bytes] of Object.entries(files)){
  const hash=await sha256(bytes),path=key(site,id,name),existing=await env.BUILDS.get(path);
  if(existing){check(await sha256(await existing.arrayBuffer())===hash,'Existing package bytes differ.');continue;}
  await env.BUILDS.put(path,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:type(name),cacheControl:'private, no-store'},customMetadata:{sha256:hash,kind:'builtin-runtime-release'}});
  const stored=await env.BUILDS.get(path);check(stored&&await sha256(await stored.arrayBuffer())===hash,'Package upload is unconfirmed. Retry after reload.',503);
 }
 check(await digest(await snapshot(env,site))===body.revision,'Settings changed before registration. Generate again.');
 // Snapshot validation and registration are one SQL transaction. Configuration is never reset.
 const projections=[['publishers','id,name,domain,gam_path','id',saved.site,true],['publisher_configs','config_json','publisher_id',saved.config,true],['ad_units','code,type,media_type,size_map_key,enabled,sort_order','publisher_id',saved.units,false,'sort_order,code'],['bidders','bidder,params_json,enabled','publisher_id',saved.bidders,false,'bidder'],['bidder_overrides','bidder,scope_type,scope_key,params_json,enabled','publisher_id',saved.overrides,false,'bidder,scope_type,scope_key'],['size_maps','name,map_json','publisher_id',saved.maps,false,'name'],['unit_rules','rule_key,rule_json','publisher_id',saved.rules,false,'rule_key'],['prebid_builds','id,publisher_id,version,file_key,modules_json,status,uploaded_at','publisher_id',saved.prebidBuilds,false,'uploaded_at DESC,id'," AND status='current' LIMIT 2"]];
 const conditions=[],args=[];
 for(const [table,cols,where,rows,single,order,extra] of projections){conditions.push(`(SELECT json_group_array(json_array(${cols})) FROM (SELECT ${cols} FROM ${table} WHERE ${where}=?${extra?.includes('status')?" AND status='current'":''}${order?' ORDER BY '+order:''}${extra?' LIMIT 2':single?' LIMIT 1':''}))=?`);args.push(site,JSON.stringify((single?[rows]:rows).map(row=>cols.split(',').map(c=>row[c]))));}
 const result=await db(env).batch([
  db(env).prepare(`INSERT INTO releases(id,publisher_id,version,status,config_hash,ads_js_key,ads_min_js_key,prebid_js_key,config_key,manifest_key,notes,created_by,created_at) SELECT ?,?,?,'draft',?,?,?,?,?,?,?,?,? WHERE ${conditions.join(' AND ')} ON CONFLICT(id) DO NOTHING`).bind(id,site,id,manifest.configHash,key(site,id,'ads.js'),key(site,id,'ads.min.js'),manifest.prebidBuild?key(site,id,'prebid.js'):null,key(site,id,'config.json'),key(site,id,'manifest.json'),body.notes.trim()||null,actor,created,...args),
  db(env).prepare("INSERT INTO audit_log(id,actor,action,publisher_id,entity_type,entity_id,details_json) SELECT ?,?,'builtin_release.generated',?,'release',?,? WHERE changes()=1").bind(crypto.randomUUID(),actor,site,id,JSON.stringify({runtime:manifest.runtime.runtimeVersion})),
 ]);
 check(result[0].meta.changes===1,'Settings changed or package already exists. Reload releases.');
 return {release:payload(await db(env).prepare('SELECT * FROM releases WHERE publisher_id=? AND id=?').bind(site,id).first()),testOnly:false};
}
export async function readPackage(env,site,id,{testOnly=false,requestedFile=null}={}){
 if(testOnly){check(site==='test-site'&&/^builtin-draft-[a-f0-9]{64}$/.test(id),'Unknown TEST package.',404);const p=await readDraftRelease({isolation:'explicit-test-store',db:env.DB,bucket:env.BUILDS},{siteId:site,releaseId:id});check(p,'Package not found.',404);return {files:p.files,release:p.draft};}
 check(ID.test(id),'Unknown built-in release.',404);
 const row=await db(env).prepare('SELECT * FROM releases WHERE publisher_id=? AND id=?').bind(site,id).first();check(row&&row.version===id&&row.manifest_key===key(site,id,'manifest.json'),'Release not found.',404);
 const obj=await env.BUILDS.get(row.manifest_key);check(obj&&obj.size<=262144,'Release manifest is missing.');const bytes=new Uint8Array(await obj.arrayBuffer());
 check(await sha256(bytes)===obj.customMetadata?.sha256,'Manifest checksum differs.');const m=JSON.parse(decode.decode(bytes));
 check(m.kind==='builtin-runtime-release'&&m.completeRelease===true&&m.siteId===site&&m.releaseId===id&&m.version===id&&m.configHash===row.config_hash,'Release identity differs.');
 check(m.files&&typeof m.files==='object'&&!Array.isArray(m.files),'Invalid file inventory.');
 check(['README.txt','ads.js','ads.min.js','config.json','div-export.csv','implementation.html','min-height.css','sticky.css'].every(n=>Object.hasOwn(m.files,n))&&Object.hasOwn(m.files,'prebid.js')===Boolean(m.prebidBuild),'Release file set differs.');
 check(!requestedFile||requestedFile==='manifest.json'||Object.hasOwn(m.files,requestedFile),'File not found.',404);
 const files={'manifest.json':bytes};let total=bytes.length;
 for(const [name,entry] of Object.entries(m.files)){
  check(['README.txt','ads.js','ads.min.js','config.json','div-export.csv','implementation.html','min-height.css','sticky.css','prebid.js'].includes(name)&&name!=='manifest.json'&&entry.key===key(site,id,name)&&Number.isSafeInteger(entry.byteSize)&&entry.byteSize>0&&entry.byteSize<=8388608,'Invalid file inventory.');
  total+=entry.byteSize;check(total<=12582912,'Package exceeds limit.');if(requestedFile&&name!==requestedFile)continue;const object=await env.BUILDS.get(entry.key);check(object&&object.size===entry.byteSize,'Release file is missing.');const data=new Uint8Array(await object.arrayBuffer());check(data.length===entry.byteSize&&await sha256(data)===entry.sha256,'Release checksum differs.');files[name]=data;
 }
 return {files,release:row,manifest:m};
}
/** Authenticated browser downloads read one artifact per request; ZIP work stays in the browser. */
export async function packageAssetResponse(request,env,site,id,name){
 const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff'};
 const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{...headers,'content-type':'application/json'}});
 try{
  check(request.method==='GET','Method not allowed.',405);
  check(!new URL(request.url).search,'Unknown query.',400);
  const p=await readPackage(env,site,id,{requestedFile:name??'manifest.json'});
  if(name)return new Response(p.files[name],{headers:{...headers,'content-type':type(name)}});
  const files=Object.entries(p.manifest.files).map(([name,e])=>({name,byteSize:e.byteSize,sha256:e.sha256}));
  files.push({name:'manifest.json',byteSize:p.files['manifest.json'].length,sha256:await sha256(p.files['manifest.json'])});
  files.sort((a,b)=>a.name.localeCompare(b.name,'en'));
  return json({descriptor:{releaseId:id,siteId:site,files}});
 }catch(e){return json({error:e.message},e.status??422);}
}
export async function packageDownload(env,site,id,options){const p=await readPackage(env,site,id,options);return new Response(zip(p.files),{headers:{'content-type':'application/zip','cache-control':'private, no-store','content-disposition':`attachment; filename="${id}.zip"`}});}

export async function changePackageChannel(env,site,id,actor,action,body,{testOnly=false}={}){
 check(!testOnly,'TEST packages use the existing preview deployment workspace; production channels are disabled.',403);
 check(['staging','production','rollback'].includes(action)&&body?.acknowledge===true,'Confirm the selected package and channel.',422);
 const current=await db(env).prepare('SELECT id,status,published_at FROM releases WHERE publisher_id=? ORDER BY id').bind(site).all();
 const rows=current.results,review=await sha256(encode.encode(JSON.stringify(rows)));
 check(body.channelRevision===review,'Release channels changed. Reload before publishing.');
 const p=await readPackage(env,site,id);const channel=action==='staging'?'staging':'production';
 check(p.release.status!=='failed','A failed release cannot be published.');
 if(action==='production')check(p.release.status==='staging','Stage this package before production.');
 if(action==='rollback'){
  const previous=await db(env).prepare("SELECT id FROM audit_log WHERE publisher_id=? AND entity_id=? AND action IN ('builtin_release.production','builtin_release.rollback') LIMIT 1").bind(site,id).first();
  check(previous&&p.release.status==='archived','Choose an earlier published package for rollback.');
 }
 if(action==='staging')check(['draft','archived','staging'].includes(p.release.status),'This package is already in production.');
 const auditId=crypto.randomUUID(),time=new Date().toISOString();
 const result=await db(env).batch([
  db(env).prepare(`INSERT INTO audit_log(id,actor,action,publisher_id,entity_type,entity_id,details_json,created_at) SELECT ?,?,?,?,'release',?,?,? WHERE (SELECT json_group_array(json_array(id,status,published_at)) FROM (SELECT id,status,published_at FROM releases WHERE publisher_id=? ORDER BY id))=?`).bind(auditId,actor,`builtin_release.${action}`,site,id,JSON.stringify({version:id,channel,previousReleaseId:channel==='production'?rows.find(r=>r.status==='production')?.id??null:null}),time,site,JSON.stringify(rows.map(r=>[r.id,r.status,r.published_at]))),
  db(env).prepare("UPDATE releases SET status='archived' WHERE publisher_id=? AND status=? AND id<>? AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)").bind(site,channel,id,auditId),
  db(env).prepare('UPDATE releases SET status=?,published_at=? WHERE publisher_id=? AND id=? AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)').bind(channel,time,site,id,auditId),
  ...(channel==='production'?[db(env).prepare("UPDATE publishers SET current_release_id=?,current_version=?,last_published_at=?,status='live',updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)").bind(id,id,time,time,site,auditId)]:[]),
 ]);
 check(result[0].meta.changes===1,'Release channels changed. Reload before publishing.');
 return {ok:true,channel,releaseId:id};
}
export async function channelRevision(env,site){const r=await db(env).prepare('SELECT id,status,published_at FROM releases WHERE publisher_id=? ORDER BY id').bind(site).all();return sha256(encode.encode(JSON.stringify(r.results)));}
/** Resolve a channel to one immutable package; no sequential file-copy window. */
export async function builtInCdn(request,env){
 const u=new URL(request.url),m=u.pathname.match(/^\/cdn\/([a-z0-9][a-z0-9-]{0,97})\/(?:releases\/(builtin-release-[a-f0-9]{64})|(current|staging))\/([a-zA-Z][a-zA-Z0-9.-]*)$/);
 if(!m||!['GET','HEAD'].includes(request.method))return null;
 const [,site,version,channel,name]=m;let id=version;
 if(channel){let rows;try{rows=await db(env).prepare('SELECT id FROM releases WHERE publisher_id=? AND status=? LIMIT 2').bind(site,channel==='current'?'production':'staging').all();}catch{return null;}if(!rows.results.some(r=>ID.test(r.id)))return null;check(rows.results.length===1,'Channel is ambiguous.');id=rows.results[0].id;}
 // Registered immutable draft URLs are workflow sources; channel URLs still require a published channel.
 const p=await readPackage(env,site,id,{requestedFile:name});check(p.files[name],'File not found.',404);
 return new Response(request.method==='HEAD'?null:p.files[name],{headers:{'content-type':type(name),'cache-control':channel?'no-cache':'public, max-age=31536000, immutable','access-control-allow-origin':'*','x-content-type-options':'nosniff','etag':`"${await sha256(p.files[name])}"`}});
}
export async function packageResponse(request,env,site,actor,options={}){
 const headers={'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'};
 const json=(d,status=200)=>new Response(JSON.stringify(d),{status,headers});
 try{
  const url=new URL(request.url);check(!url.search,'Unknown query.',400);
  if(request.method==='GET')return json({...await packageState(env,site,options),channelRevision:await channelRevision(env,site)});
  check(request.method==='POST','Method not allowed.',405);
  check(request.headers.get('content-type')?.split(';')[0]==='application/json','JSON required.',415);
  const reader=request.body?.getReader();check(reader,'JSON required.',400);let size=0;const chunks=[];
  try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;check(size<=8192,'Request too large.',413);chunks.push(r.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}const body=JSON.parse(decode.decode(bytes));
  if(body.action==='generate')return json(await generatePackage(env,site,actor,{notes:body.notes,revision:body.revision},options),201);
  if(body.action==='download')return await packageDownload(env,site,body.releaseId,options);
  return json(await changePackageChannel(env,site,body.releaseId,actor,body.action,body,options));
 }catch(e){return json({error:e.message},e.status??422);}
}
