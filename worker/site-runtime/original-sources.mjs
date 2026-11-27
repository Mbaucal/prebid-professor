import {sha256} from '../runtime/prebid-artifact-check.mjs';
import {ORIGINAL_PAIR,ORIGINAL_SOURCES,originalId,originalSource,originalRuntimeLabel} from '../experiments/original-source-catalog.mjs';

// Auth/origin/site checks run in the MAIN router before this adapter. No D1 writes or deployment.
const kind='original-script-source-1',encode=new TextEncoder(),decode=new TextDecoder('utf-8',{fatal:true});
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const key=(site,id)=>`original-script-sources/v1/${site}/${id}`;
const invalid=()=>fail(409,'This original script differs from its saved source. Nothing was overwritten.');

export async function verifyOriginalPackage(pkg,site){
  const source=originalSource(site,pkg?.release?.id);
  if(!source||pkg.release.siteId!==site||!pkg.files||Object.keys(pkg.files).sort().join(',')!=='ads.min.js,manifest.json')invalid();
  let manifest;
  try{manifest=JSON.parse(decode.decode(pkg.files['manifest.json']));}catch{invalid();}
  if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||Object.keys(manifest).sort().join(',')!=='createdAt,createdBy,id,kind,siteId,source'||
    manifest.kind!==kind||JSON.stringify(manifest.source)!==JSON.stringify(source)||manifest.siteId!==site||manifest.id!==originalId(source)||
    typeof manifest.createdAt!=='string'||!Number.isFinite(Date.parse(manifest.createdAt))||typeof manifest.createdBy!=='string'||!manifest.createdBy)invalid();
  const bytes=pkg.files['ads.min.js'];
  if(!(bytes instanceof Uint8Array)||bytes.length!==source.bytes||await sha256(bytes)!==source.sha256)invalid();
  return {source,manifest};
}
async function readBytes(bucket,path,max){
  const object=await bucket.get(path);if(!object)return null;
  if(object.customMetadata?.kind!==kind||object.size<=0||object.size>max)invalid();
  const bytes=new Uint8Array(await object.arrayBuffer());
  if(bytes.length!==object.size||await sha256(bytes)!==object.customMetadata.sha256)invalid();
  return bytes;
}
export async function readOriginalSource(bucket,site,id){
  const source=originalSource(site,id);if(!source)fail(404,'Original script not found for this site.');
  const manifest=await readBytes(bucket,key(site,id)+'/manifest.json',4096);
  if(!manifest)fail(404,'Original script has not been saved.');
  const bytes=await readBytes(bucket,key(site,id)+'/ads.js',source.bytes);if(!bytes)invalid();
  const pkg={release:{id,siteId:site,notes:source.name},files:{'ads.min.js':bytes,'manifest.json':manifest}};
  await verifyOriginalPackage(pkg,site);return pkg;
}
export async function listOriginalSources(bucket,site){
  const versions=[];
  for(const source of ORIGINAL_SOURCES.filter(s=>s.site===site)){
    const common={id:originalId(source),name:source.name,sourceKind:'original-script',sourceUrl:source.url,originalSide:source.side,
      runtimeVersion:originalRuntimeLabel(source),runtimeSha256:null,prebidVersion:null};
    try{
      const pkg=await readOriginalSource(bucket,site,common.id),{manifest}=await verifyOriginalPackage(pkg,site);
      versions.push({...common,createdAt:manifest.createdAt,state:'stored'});
    }catch(error){
      if(error.status===404)continue;
      if(error.status!==409)throw error;
      versions.push({...common,createdAt:null,state:'unavailable',unavailableReason:error.message});
    }
  }
  return versions;
}
async function immutablePut(bucket,path,bytes){
  const digest=await sha256(bytes),existing=await readBytes(bucket,path,Math.max(bytes.length,4096));
  if(existing){if(await sha256(existing)!==digest)invalid();return;}
  await bucket.put(path,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),sha256:digest,
    httpMetadata:{contentType:path.endsWith('.js')?'application/javascript':'application/json',cacheControl:'private, no-store'},customMetadata:{kind,sha256:digest}});
  const stored=await readBytes(bucket,path,bytes.length);
  if(!stored||await sha256(stored)!==digest)fail(503,'The original script save could not be confirmed. Retry.');
}
async function fetchOriginal(source){
  // Only reviewed public HTTPS URLs are fetched, no caller URL, cookies, redirects or internal hosts.
  const response=await fetch(source.url,{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{accept:'application/javascript'}});
  if(!response.ok||!response.body)fail(503,'The original script could not be downloaded. Retry.');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>source.bytes){await reader.cancel();invalid();}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  if(size!==source.bytes||await sha256(bytes)!==source.sha256)invalid();
  return bytes;
}
export async function saveOriginalSources(bucket,site,actor){
  const sources=ORIGINAL_SOURCES.filter(s=>s.site===site);if(!sources.length)fail(404,'No reviewed original scripts are available for this site.');
  const missing=[];
  for(const source of sources){try{await readOriginalSource(bucket,site,originalId(source));}catch(error){if(error.status!==404)throw error;missing.push(source);}}
  // Verify both downloads before any write. Partial storage failures are safe to retry.
  const files=await Promise.all(missing.map(fetchOriginal));
  for(let i=0;i<missing.length;i++){
    const source=missing[i],id=originalId(source),root=key(site,id);
    await immutablePut(bucket,root+'/ads.js',files[i]);
    // The first committed metadata wins in a concurrent save; its original audit data is preserved.
    const manifest=encode.encode(JSON.stringify({kind,id,siteId:site,source,createdAt:new Date().toISOString(),createdBy:actor}));
    await bucket.put(root+'/manifest.json',manifest,{onlyIf:new Headers({'If-None-Match':'*'}),sha256:await sha256(manifest),
      httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'},customMetadata:{kind,sha256:await sha256(manifest)}});
    await readOriginalSource(bucket,site,id);
  }
  return {pair:ORIGINAL_PAIR,versions:await listOriginalSources(bucket,site)};
}
export async function originalSourcesResponse(request,bucket,site,actor,headers){
  if(new URL(request.url).pathname!==`/api/publishers/${site}/ab-tests/original-sources`)return null;
  const respond=(body,status=200,extra={})=>Response.json(body,{status,headers:{...headers,...extra}});
  if(request.method!=='POST')return respond({error:'Method not allowed.'},405,{allow:'POST'});
  if(new URL(request.url).search)return respond({error:'This action accepts no body or query parameters.'},400);
  try{
    // workerd represents an empty POST as a readable stream too; inspect bytes, not body presence.
    const reader=request.body?.getReader();
    if(reader)try{for(;;){const {done,value}=await reader.read();if(done)break;if(value.byteLength){await reader.cancel();return respond({error:'This action accepts no body or query parameters.'},400);}}}finally{reader.releaseLock();}
    return respond(await saveOriginalSources(bucket,site,actor));
  }
  catch(error){return respond({error:[404,409].includes(error.status)?error.message:'The original scripts could not be saved completely. Retry to finish the same save.'},[404,409].includes(error.status)?error.status:503);}
}
