import * as privateRuntime from './private-runtime-catalog.mjs';
import { workspaceJs,workspaceCss } from '../../.generated/site-workspace.mjs';
import { siteRuntimeResponse } from '../site-runtime/service.mjs';
import { packageResponse } from '../site-runtime/releases.mjs';
import { inspectTestSchema } from './schema.mjs';
import { readPreviewSnapshot } from '../runtime/builtin-preview-service.mjs';
import { assertWorkspaceSiteScope } from './site-draft.mjs';
// Entered only after the TEST host, authentication and same-origin guards.
export async function siteWorkspaceResponse(request,env,actor,headers){
 const url=new URL(request.url);if(!['/site-workspace','/site-workspace.js','/test-api/site-runtime','/test-api/site-packages'].includes(url.pathname))return null;
 if(url.search)return new Response('Not found',{status:404,headers});
 if(url.pathname==='/test-api/site-runtime'||url.pathname==='/test-api/site-packages'){
  if(!(await inspectTestSchema(env.DB)).ready)return new Response(JSON.stringify({error:'Prepare TEST data first.'}),{status:409,headers:{...headers,'content-type':'application/json'}});
  assertWorkspaceSiteScope(await readPreviewSnapshot(env.DB.withSession('first-primary'),'test-site',{includePrebid:true}));
  return url.pathname==='/test-api/site-packages'?packageResponse(request,env,'test-site',actor.email,{testOnly:true,runtime:privateRuntime}):siteRuntimeResponse(request,env,'test-site',actor.email,privateRuntime);
 }
 if(request.method!=='GET')return new Response('Method not allowed',{status:405,headers});
 if(url.pathname.endsWith('.js'))return new Response(workspaceJs,{headers:{...headers,'content-type':'application/javascript; charset=utf-8'}});
 return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera · Site workspace</title><style>body{margin:0;background:#edf0f5;font-family:system-ui,sans-serif}a{color:#a4430c}${workspaceCss.replace(/<\/style/gi,'<\\/style')}</style></head><body><div id="root"></div><script src="/site-workspace.js" defer></script></body></html>`,{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
}
