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
// Entered only after the TEST host, authentication and same-origin guards.
export async function siteWorkspaceResponse(request,env,actor,headers){
 const url=new URL(request.url);
 const testPage=url.pathname.match(/^\/test-api\/site-test-page\/(builtin-draft-[a-f0-9]{64})$/);
 if(testPage)return packageTestPageResponse(request,env,'test-site',testPage[1],{testOnly:true});
 if(!['/site-workspace','/site-workspace.js','/test-api/site-runtime','/test-api/site-packages','/test-api/deals','/test-api/outstream-settings'].includes(url.pathname))return null;
 if(url.search)return new Response('Not found',{status:404,headers});
 if(['/test-api/site-runtime','/test-api/site-packages','/test-api/deals','/test-api/outstream-settings'].includes(url.pathname)){
  if(!(await inspectTestSchema(env.DB)).ready)return new Response(JSON.stringify({error:'Prepare TEST data first.'}),{status:409,headers:{...headers,'content-type':'application/json'}});
  assertWorkspaceSiteScope(await readPreviewSnapshot(env.DB.withSession('first-primary'),'test-site',{includePrebid:true}));
  if(url.pathname==='/test-api/deals')return dealSettingsResponse(request,env,TEST_SITE,actor.email);
  if(url.pathname==='/test-api/outstream-settings')return outstreamSettingsResponse(request,env,TEST_SITE,actor.email);
  return url.pathname==='/test-api/site-packages'?packageResponse(request,env,'test-site',actor.email,{testOnly:true}):siteRuntimeResponse(request,env,'test-site',actor.email);
 }
 if(request.method!=='GET')return new Response('Method not allowed',{status:405,headers});
 if(url.pathname.endsWith('.js'))return new Response(workspaceJs,{headers:{...headers,'content-type':'application/javascript; charset=utf-8'}});
 return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera · Site workspace</title><style>body{margin:0;background:#edf0f5;font-family:system-ui,sans-serif}a{color:#a4430c}${workspaceCss.replace(/<\/style/gi,'<\\/style')}</style></head><body><div id="root"></div><script src="/site-workspace.js" defer></script></body></html>`,{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
}
