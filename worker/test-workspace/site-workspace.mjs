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
import { TEST_SITE } from './boundary.mjs';
import {cleanupResponse,cleanupState} from './package-cleanup.mjs';
// Entered only after the TEST host, authentication and same-origin guards.
export async function siteWorkspaceResponse(request,env,actor,headers){
 const url=new URL(request.url);
 const testPage=url.pathname.match(/^\/test-api\/site-test-page\/(builtin-draft-[a-f0-9]{64})$/);
 if(testPage)return packageTestPageResponse(request,env,'test-site',testPage[1],{testOnly:true});
 if(!['/site-workspace','/site-workspace.js','/test-api/site-runtime','/test-api/site-packages','/test-api/package-cleanup','/test-api/deals','/test-api/outstream-settings','/test-api/contextual-signals','/test-api/contextual-signals/build-kit','/test-api/bidder-rules'].includes(url.pathname))return null;
 if(url.search)return new Response('Not found',{status:404,headers});
 if(['/test-api/site-runtime','/test-api/site-packages','/test-api/package-cleanup','/test-api/deals','/test-api/outstream-settings','/test-api/contextual-signals','/test-api/contextual-signals/build-kit','/test-api/bidder-rules'].includes(url.pathname)){
  if(!(await inspectTestSchema(env.DB)).ready)return new Response(JSON.stringify({error:'Prepare TEST data first.'}),{status:409,headers:{...headers,'content-type':'application/json'}});
  if(url.pathname==='/test-api/package-cleanup')return cleanupResponse(request,env,actor.email,headers);
  assertWorkspaceSiteScope(await readPreviewSnapshot(env.DB.withSession('first-primary'),'test-site',{includePrebid:true}));
  if(url.pathname==='/test-api/bidder-rules')return bidderRuleSettingsResponse(request,env,TEST_SITE,actor.email);
  if(url.pathname==='/test-api/contextual-signals')return contextualSignalSettingsResponse(request,env,TEST_SITE,actor.email);
  if(url.pathname==='/test-api/contextual-signals/build-kit')return contextualBuildKitResponse(request,env,TEST_SITE);
  if(url.pathname==='/test-api/deals')return dealSettingsResponse(request,env,TEST_SITE,actor.email);
  if(url.pathname==='/test-api/outstream-settings')return outstreamSettingsResponse(request,env,TEST_SITE,actor.email);
  if(url.pathname==='/test-api/site-packages'){
   const response=await packageResponse(request,env,TEST_SITE,actor.email,{testOnly:true});
   if(request.method==='GET'&&response.ok)return new Response(JSON.stringify({...await response.json(),cleanup:await cleanupState(env)}),{status:response.status,headers:response.headers});
   return response;
  }
  return siteRuntimeResponse(request,env,TEST_SITE,actor.email,{testOnly:true});
 }
 if(request.method!=='GET')return new Response('Method not allowed',{status:405,headers});
 if(url.pathname.endsWith('.js'))return new Response(workspaceJs,{headers:{...headers,'content-type':'application/javascript; charset=utf-8'}});
 return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera · Site workspace</title><style>body{margin:0;background:#edf0f5;font-family:system-ui,sans-serif}a{color:#a4430c}${workspaceCss.replace(/<\/style/gi,'<\\/style')}</style></head><body><div id="root"></div><script src="/site-workspace.js" defer></script></body></html>`,{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
}
