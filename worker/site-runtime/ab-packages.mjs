import {sha256} from '../runtime/prebid-artifact-check.mjs';

// Reviewed complete delivery archives. A new version gets a new entry; these
// pins never follow a moving GitHub URL or accept arbitrary uploaded code.
export const AB_PACKAGES=Object.freeze([
  Object.freeze({release:'tanjug-aa-1.0.2',sha256:'bd0d9a6973903a3ec585f88e4b815eefb7a061ec8a32593f671b53ce211dfb1e',bytes:272833,
    label:'A/A · same script',a:'Fresh auction',b:'Fresh auction',positions:19,trafficB:50}),
]);
const check=(ok,message,status=422)=>{if(!ok)throw Object.assign(Error(message),{status});};
const key=(site,release)=>`site-ab-packages/v1/${site}/${release}.zip`;
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...headers,'content-type':'application/json'}});
function supported(domain){return typeof domain==='string'&&/^(?:https?:\/\/)?(?:www\.)?tanjug\.rs\/?$/i.test(domain.trim());}
async function readBytes(body,limit){
  check(body,'Choose the complete ZIP.',400);const reader=body.getReader();let length=0;const chunks=[];
  try{for(;;){const r=await reader.read();if(r.done)break;length+=r.value.length;check(length<=limit,'ZIP size differs from this release.',413);chunks.push(r.value);}}
  catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  const result=new Uint8Array(length);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
async function verify(object,pin){
  check(object&&object.size===pin.bytes,'Saved ZIP is missing or its size differs.',409);
  const bytes=new Uint8Array(await object.arrayBuffer());
  check(bytes.length===pin.bytes&&await sha256(bytes)===pin.sha256,'ZIP checksum differs from the reviewed release.',409);return bytes;
}
// Called only behind the app's authentication and same-origin write boundary.
export async function abPackageResponse(request,env,site,release,actor){
  try{
    check(/^[a-z0-9][a-z0-9-]{0,97}$/.test(site),'Invalid site.',404);
    check(!new URL(request.url).search,'Unknown query.',400);
    const row=await env.DB.withSession('first-primary').prepare('SELECT domain FROM publishers WHERE id=?').bind(site).first();
    check(row,'Site not found.',404);
    if(!release&&request.method==='GET'){
      if(!supported(row.domain))return json({supported:false,packages:[]});
      const packages=await Promise.all(AB_PACKAGES.map(async pin=>{
        const object=await env.BUILDS.head(key(site,pin.release));
        const saved=!!object;
        return {...pin,saved,storedAt:object?.customMetadata?.storedAt??null};
      }));return json({supported:true,packages});
    }
    check(supported(row.domain),'This reviewed package belongs to tanjug.rs.',409);
    const pin=AB_PACKAGES.find(p=>p.release===release);check(pin,'Unknown reviewed A/B package.',404);
    const path=key(site,release);
    if(request.method==='GET'){
      const bytes=await verify(await env.BUILDS.get(path),pin);
      return new Response(bytes,{headers:{...headers,'content-type':'application/zip','content-disposition':`attachment; filename="${release}.zip"`,'x-package-sha256':pin.sha256}});
    }
    check(request.method==='PUT','Method not allowed.',405);
    check(request.headers.get('content-type')?.split(';')[0]==='application/zip','Upload the original complete ZIP.',415);
    const bytes=await readBytes(request.body,pin.bytes);
    check(bytes.length===pin.bytes&&await sha256(bytes)===pin.sha256,'Choose the original ZIP for this version. The uploaded file differs.',422);
    const existing=await env.BUILDS.get(path);
    if(!existing)await env.BUILDS.put(path,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),
      httpMetadata:{contentType:'application/zip',cacheControl:'private, no-store'},
      customMetadata:{sha256:pin.sha256,release,siteId:site,storedAt:new Date().toISOString(),storedBy:actor}});
    await verify(await env.BUILDS.get(path),pin);
    return json({release,saved:true,sha256:pin.sha256},existing?200:201);
  }catch(e){return json({error:e.message},e.status??500);}
}
