import {contextualSignalSettingsResponse} from '../site-runtime/contextual-signals-settings.mjs';
import {bidderRuleSettingsResponse} from '../site-runtime/bidder-rule-settings.mjs';
import {contextualBuildKitResponse} from '../site-runtime/contextual-signals-build-kit.mjs';
import { workspaceJs,workspaceCss } from '../../.generated/site-workspace.mjs';
import { siteRuntimeResponse } from '../site-runtime/service.mjs';
import { packageResponse } from '../site-runtime/releases.mjs';
import { packageTestPageResponse } from '../site-runtime/test-page.mjs';
import { inspectTestSchema } from './schema.mjs';
import { readPreviewSnapshot } from '../runtime/builtin-preview-service.mjs';
import { assertWorkspaceSiteScope } from './site-draft.mjs';
import { dealSettingsResponse } from '../site-runtime/deal-settings.mjs';
import { outstreamSettingsResponse } from '../site-runtime/outstream-settings.mjs';
import { TEST_SITE, jsonBody } from './boundary.mjs';
import {cleanupResponse,cleanupState} from './package-cleanup.mjs';
import {getPrebidMode,updatePrebidMode} from '../prebid-mode.ts';
import {withAuthenticatedActor} from '../http.ts';
import {BID_CACHE_GENERATOR_MESSAGE} from '../site-runtime/prebid-cache-settings.mjs';
import {digest} from '../runtime/preview-snapshot.mjs';
import {testBidCacheMessage} from './bid-cache-messages.mjs';

// The shared generator refusal names the production Config menus; this workspace has a Bid caching view instead.
export {TEST_BID_CACHE_GENERATOR_MESSAGE} from './bid-cache-messages.mjs';
// The shared Demand → Prebid API for the TEST site, at the path the production panels use.
const PREBID_MODE='/api/publishers/'+TEST_SITE+'/prebid-mode';
export const siteWorkspaceMethodAllowed=request=>new URL(request.url).pathname===PREBID_MODE&&request.method==='PUT';
// Entered only after the TEST host, authentication and same-origin guards.
export async function siteWorkspaceResponse(request,env,actor,headers){
 const url=new URL(request.url);
 const testPage=url.pathname.match(/^\/test-api\/site-test-page\/(builtin-draft-[a-f0-9]{64})$/);
 if(testPage)return packageTestPageResponse(request,env,'test-site',testPage[1],{testOnly:true});
 if(url.pathname===PREBID_MODE){
  if(url.search)return new Response(JSON.stringify({error:'Unknown query.'}),{status:400,headers:{...headers,'content-type':'application/json'}});
  if(!['GET','PUT'].includes(request.method))return new Response(JSON.stringify({error:'Method not allowed.'}),{status:405,headers:{...headers,'content-type':'application/json'}});
  if(!(await inspectTestSchema(env.DB)).ready)return new Response(JSON.stringify({error:'Prepare TEST data first.'}),{status:409,headers:{...headers,'content-type':'application/json'}});
  const saved=assertWorkspaceSiteScope(await readPreviewSnapshot(env.DB.withSession('first-primary'),TEST_SITE,{includePrebid:true}));
  // Only the isolated storage bindings reach the shared service.
  const store={DB:env.DB,BUILDS:env.BUILDS};
  if(request.method==='GET')return getPrebidMode(store,TEST_SITE);
  const body=await jsonBody(request,['enabled','revision','bidCache'],65536);
  // The TEST Prebid editor owns Prebid on/off, its build and its draft marker; this route saves bid caching only.
  // A form without a true/false mode is left to the shared validation (422).
  // A form loaded before Prebid changed elsewhere is stale: ask for a reload (the shared message), not for a Prebid change.
  if(typeof body.enabled==='boolean'&&body.enabled!==saved.enablePrebid){
   const error=body.revision!==await digest(saved)?'Prebid settings changed. Reload before saving.':'Turn Prebid on or off in Prebid and bidders. Here you can change bid caching only.';
   return new Response(JSON.stringify({error}),{status:409,headers:{...headers,'content-type':'application/json'}});
  }
  return updatePrebidMode(withAuthenticatedActor(new Request(request.url,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),actor.email),store,TEST_SITE);
 }
 if(!['/site-workspace','/site-workspace.js','/test-api/site-runtime','/test-api/site-packages','/test-api/package-cleanup','/test-api/deals','/test-api/outstream-settings','/test-api/contextual-signals','/test-api/contextual-signals/build-kit','/test-api/bidder-rules'].includes(url.pathname))return null;
 if(url.search)return new Response('Not found',{status:404,headers});
 if(['/test-api/site-runtime','/test-api/site-packages','/test-api/package-cleanup','/test-api/deals','/test-api/outstream-settings','/test-api/contextual-signals','/test-api/contextual-signals/build-kit','/test-api/bidder-rules'].includes(url.pathname)){
  if(!(await inspectTestSchema(env.DB)).ready)return new Response(JSON.stringify({error:'Prepare TEST data first.'}),{status:409,headers:{...headers,'content-type':'application/json'}});
  if(url.pathname==='/test-api/package-cleanup')return cleanupResponse(request,env,actor.email,headers);
  const siteConfig=assertWorkspaceSiteScope(await readPreviewSnapshot(env.DB.withSession('first-primary'),'test-site',{includePrebid:true}));
  if(url.pathname==='/test-api/bidder-rules')return bidderRuleSettingsResponse(request,env,TEST_SITE,actor.email);
  if(url.pathname==='/test-api/contextual-signals')return contextualSignalSettingsResponse(request,env,TEST_SITE,actor.email);
  if(url.pathname==='/test-api/contextual-signals/build-kit')return contextualBuildKitResponse(request,env,TEST_SITE);
  if(url.pathname==='/test-api/deals')return dealSettingsResponse(request,env,TEST_SITE,actor.email);
  if(url.pathname==='/test-api/outstream-settings')return outstreamSettingsResponse(request,env,TEST_SITE,actor.email);
  if(url.pathname==='/test-api/site-packages'){
   const response=await packageResponse(request,env,TEST_SITE,actor.email,{testOnly:true});
   if(request.method==='GET'&&response.ok){
    const state=await response.json();
    return new Response(JSON.stringify({...state,error:testBidCacheMessage(state.error,siteConfig),cleanup:await cleanupState(env)}),{status:response.status,headers:response.headers});
   }
   if(response.status===409&&response.headers.get('content-type')?.includes('application/json')){
    const body=await response.clone().json();
    if(body.error===BID_CACHE_GENERATOR_MESSAGE)return new Response(JSON.stringify({...body,error:testBidCacheMessage(body.error,siteConfig)}),{status:409,headers:response.headers});
   }
   return response;
  }
  return siteRuntimeResponse(request,env,TEST_SITE,actor.email,{testOnly:true});
 }
 if(request.method!=='GET')return new Response('Method not allowed',{status:405,headers});
 if(url.pathname.endsWith('.js'))return new Response(workspaceJs,{headers:{...headers,'content-type':'application/javascript; charset=utf-8'}});
 return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera · Site workspace</title><style>body{margin:0;background:#edf0f5;font-family:system-ui,sans-serif}a{color:#a4430c}${workspaceCss.replace(/<\/style/gi,'<\\/style')}</style></head><body><div id="root"></div><script src="/site-workspace.js" defer></script></body></html>`,{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
}
