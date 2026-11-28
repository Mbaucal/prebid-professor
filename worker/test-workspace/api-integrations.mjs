import {GamError} from '../../shared/gam/plan.mjs';
import {readPreviewSnapshot} from '../runtime/builtin-preview-service.mjs';
import {readSiteDraft} from './site-draft.mjs';
import {inspectTestSchema} from './schema.mjs';
import {TEST_SITE} from './boundary.mjs';
import {integrationsJs,integrationsCss} from '../../.generated/api-integrations.mjs';
import {gamResponse} from '../integrations/gam-service.mjs';
// Called after the existing TEST boundary, TEST session and same-origin checks.
export async function testIntegrationsResponse(request,env,actor,headers){
  const url=new URL(request.url);
  if(url.pathname.startsWith('/test-api/integrations/gam/'))return gamResponse(request,env,actor.email,{base:'/test-api/integrations/gam',siteScope:TEST_SITE,inventoryGuard:async()=>{try{const schema=await inspectTestSchema(env.DB);if(!schema.ready)throw new GamError('Prvo pripremite TEST radno okruženje.',409);}catch(e){throw new GamError(e.message,e.status??503);}},inventoryValidator:async({maps,units})=>{try{const saved=await readPreviewSnapshot(env.DB.withSession('first-primary'),TEST_SITE,{includePrebid:true});readSiteDraft({...saved,maps:[...saved.maps,...maps],units:[...saved.units,...units.map(u=>({...u,media_type:'banner',enabled:1}))]});}catch(e){throw new GamError(e.message,e.status??422);}}});
  if(!['/api-integrations','/api-integrations.js'].includes(url.pathname))return null;
  if(request.method!=='GET'||url.search)return new Response('Not found',{status:404,headers});
  if(url.pathname.endsWith('.js'))return new Response(integrationsJs,{headers:{...headers,'content-type':'application/javascript; charset=utf-8'}});
  return new Response(`<!doctype html><html lang="sr-Latn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera · API integracije</title><style>${integrationsCss.replace(/<\/style/gi,'<\\/style')}</style></head><body><div id="root"></div><script src="/api-integrations.js" defer></script></body></html>`,{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
}
