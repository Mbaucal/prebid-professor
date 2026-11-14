import {agencyJs,agencyCss} from '../../.generated/agency-workspace.mjs';
import {organizationResponse} from '../organization/service.mjs';
import {inspectTestSchema} from './schema.mjs';
// Called after the existing isolated workspace boundary, authentication and Origin checks.
export async function agenciesResponse(request,env,actor,headers){
  const url=new URL(request.url),path=url.pathname;
  if(path==='/test-api/organization'||path.startsWith('/test-api/organization/')){
    if(!(await inspectTestSchema(env.DB)).ready)return new Response(JSON.stringify({error:'Prepare the TEST workspace from Home first, then reload agencies.'}),{status:409,headers:{...headers,'content-type':'application/json'}});
    return organizationResponse(request,env,actor.email,{prefix:'/test-api/organization',mode:'test'});
  }
  if(!['/agencies','/agencies.js'].includes(path))return null;
  if(request.method!=='GET'||url.search)return new Response('Not found',{status:404,headers});
  if(path==='/agencies.js')return new Response(agencyJs,{headers:{...headers,'content-type':'application/javascript; charset=utf-8'}});
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera · Agencies</title><style>${agencyCss.replace(/<\/style/gi,'<\\/style')}</style></head><body><div id="root"></div><script src="/agencies.js" defer></script></body></html>`,{headers:{...headers,'content-type':'text/html; charset=utf-8','content-security-policy':headers['content-security-policy']+"; img-src 'self' data:"}});
}
