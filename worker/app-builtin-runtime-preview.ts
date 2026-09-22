import { organizationResponse } from './organization/service.mjs';
import { gamResponse } from './integrations/gam-service.mjs';
import { blockStoredDraftCdn } from './runtime/stored-draft-safety.mjs';
import baseApp from './app-ads-txt-managed-file';
import { getAuthenticatedUser, isSameOriginMutation, type AuthEnv } from './auth';
import { handleBuiltinPreview, readPreviewSnapshot, runtimeDescriptor } from './runtime/builtin-preview-service.mjs';
import { previewInput, digest } from './runtime/preview-snapshot.mjs';
import { handlePrebidPreflight } from './runtime/prebid-preflight-service.mjs';
import { handleArtifactBundle } from './runtime/artifact-bundle-service.mjs';
import type { ReleaseEnv } from './releases';
import { siteRuntimeResponse } from './site-runtime/service.mjs';
import { packageResponse, packageAssetResponse, builtInCdn } from './site-runtime/releases.mjs';
import { abEditorResponse } from './site-runtime/ab-editor.mjs';
import {requireSupportedCacheGenerator} from './site-runtime/prebid-cache-settings.mjs';
import { scriptLibraryResponse } from './site-runtime/script-library.mjs';
interface Env extends AuthEnv, ReleaseEnv { ASSETS: Fetcher; GAM_CREDENTIALS_KEY?: string }
const downstream = baseApp as {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  scheduled?(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> | void;
};
export default {
  async fetch(request, env, ctx): Promise<Response> {
    try { const cdn = await builtInCdn(request,env); if(cdn)return cdn; }
    catch { return new Response('Release file unavailable',{status:404,headers:{'cache-control':'no-store'}}); }
    const draftBlock = blockStoredDraftCdn(request);
    if (draftBlock) return draftBlock;
    const url = new URL(request.url);
    if (url.pathname === '/api/organization' || url.pathname.startsWith('/api/organization/')) {
      const actor = await getAuthenticatedUser(request, env);
      return organizationResponse(request, env, actor?.email);
    }
    const libraryMatch=url.pathname.match(/^\/api\/publishers\/([a-z0-9][a-z0-9-]{0,97})\/script-library(?:\/(scripts|tests)(?:\/(tanjug-(?:script|test)-1\.0\.0-[a-f0-9]{64})\.zip)?)?$/);
    if(libraryMatch){
      const actor=await getAuthenticatedUser(request,env);
      const fail=(error:string,status:number)=>new Response(JSON.stringify({error}),{status,headers:{'content-type':'application/json','cache-control':'private, no-store'}});
      if(!actor)return fail('Authentication required.',401);
      if(!isSameOriginMutation(request)||(['POST','DELETE','PUT'].includes(request.method)&&request.headers.get('origin')!==url.origin))return fail('Same-origin request required.',403);
      return scriptLibraryResponse(request,env,libraryMatch[1],libraryMatch[2]??null,libraryMatch[3]??null,actor.email);
    }
    const abEditorMatch=url.pathname.match(/^\/api\/publishers\/([a-z0-9][a-z0-9-]{0,97})\/ab-experiments(?:\/(baseline|tanjug-ab-2\.0\.0-[a-f0-9]{64})\.zip)?$/);
    if(abEditorMatch){
      const actor=await getAuthenticatedUser(request,env);
      const fail=(error:string,status:number)=>new Response(JSON.stringify({error}),{status,headers:{'content-type':'application/json','cache-control':'private, no-store'}});
      if(!actor)return fail('Authentication required.',401);
      if(!isSameOriginMutation(request)||(['POST','DELETE','PUT'].includes(request.method)&&request.headers.get('origin')!==url.origin))return fail('Same-origin request required.',403);
      return abEditorResponse(request,env,abEditorMatch[1],abEditorMatch[2]??null,actor.email);
    }
    if (url.pathname.startsWith('/api/integrations/gam/')) {
      const actor = await getAuthenticatedUser(request, env);
      if (!actor) return new Response(JSON.stringify({error:'Authentication required.'}), {status:401,headers:{'content-type':'application/json','cache-control':'no-store'}});
      return gamResponse(request,env,actor.email);
    }

    const packageMatch=url.pathname.match(/^\/api\/publishers\/([a-z0-9][a-z0-9-]{0,97})\/builtin-releases(?:\/(builtin-release-[a-f0-9]{64})\/(index|files\/([a-zA-Z][a-zA-Z0-9.-]*)))?$/);
    if(packageMatch){
      const actor=await getAuthenticatedUser(request,env);
      const fail=(error:string,status:number)=>new Response(JSON.stringify({error}),{status,headers:{'content-type':'application/json','cache-control':'private, no-store'}});
      if(!actor)return fail('Authentication required.',401);
      if(!isSameOriginMutation(request)||(request.method==='POST'&&request.headers.get('origin')!==url.origin))return fail('Same-origin request required.',403);
      if(packageMatch[2])return packageAssetResponse(request,env,packageMatch[1],packageMatch[2],packageMatch[4]??null);
      return packageResponse(request,env,packageMatch[1],actor.email);
    }
    // Built-in releases are changed only through the verified package workflow.
    if(/^\/api\/publishers\/[^/]+\/releases\/builtin-release-[a-f0-9]{64}(?:\/|$)/.test(url.pathname)&&!['GET','HEAD'].includes(request.method))return new Response(JSON.stringify({error:'Use Generate and releases for this built-in package.'}),{status:409,headers:{'content-type':'application/json','cache-control':'no-store'}});
    const oldGenerate=url.pathname.match(/^\/api\/publishers\/([a-z0-9][a-z0-9-]{0,97})\/releases\/(generate|validate)$/);
    if(oldGenerate){
      if(!await getAuthenticatedUser(request,env))return new Response('Authentication required.',{status:401});
      const row=await env.DB?.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id=?').bind(oldGenerate[1]).first<{config_json:string}>();
      if(row){try{requireSupportedCacheGenerator(JSON.parse(row.config_json));}catch(e){return new Response(JSON.stringify({error:(e as Error).message}),{status:409,headers:{'content-type':'application/json','cache-control':'no-store'}});}}
      if(row&&JSON.parse(row.config_json).builtinRuntimeSelection)return new Response(JSON.stringify({error:'Use Generate and releases with the saved built-in script version.'}),{status:409,headers:{'content-type':'application/json','cache-control':'no-store'}});
    }
    const settingsMatch=url.pathname.match(/^\/api\/publishers\/([a-z0-9][a-z0-9-]{0,97})\/builtin-site-settings$/);
    if(settingsMatch){
      const actor=await getAuthenticatedUser(request,env);
      const fail=(error:string,status:number)=>new Response(JSON.stringify({error}),{status,headers:{'content-type':'application/json','cache-control':'private, no-store'}});
      if(!actor)return fail('Authentication required.',401);
      if(url.search)return fail('Unknown query.',400);
      if(!['GET','POST'].includes(request.method))return fail('Method not allowed.',405);
      if(!isSameOriginMutation(request)||(request.method==='POST'&&request.headers.get('origin')!==url.origin))return fail('Same-origin request required.',403);
      return siteRuntimeResponse(request,env,settingsMatch[1],actor.email);
    }
    const match = url.pathname.match(/^\/api\/publishers\/([^/]+)\/(builtin-runtime-preview|builtin-runtime-prebid-check|builtin-runtime-bundle)$/);
    if (!match) return downstream.fetch(request, env, ctx);
    const headers = { 'content-type': 'application/json', 'cache-control': 'private, no-store' };
    const fail = (error: string, status: number) => new Response(JSON.stringify({ error }), { status, headers });
    if (!await getAuthenticatedUser(request, env)) return fail('Authentication required.', 401);
    const prebidCheck = match[2] === 'builtin-runtime-prebid-check';
    const bundle = match[2] === 'builtin-runtime-bundle';
    if (bundle ? request.method !== 'POST' : prebidCheck ? request.method !== 'GET' : !['GET', 'POST'].includes(request.method)) return fail('Method not allowed.', 405);
    if (!isSameOriginMutation(request) || (request.method === 'POST' && request.headers.get('origin') !== url.origin)) return fail('Same-origin request required.', 403);
    let siteId: string;
    try { siteId = decodeURIComponent(match[1]); } catch { return fail('Invalid site ID.', 400); }
    if (bundle) {
      const row=await env.DB?.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id=?').bind(siteId).first<{config_json:string}>();
      if(row){try{requireSupportedCacheGenerator(JSON.parse(row.config_json));}catch(e){return fail((e as Error).message,409);}}
      return handleArtifactBundle(request, env, siteId);
    }
    if (prebidCheck) return handlePrebidPreflight(request, env, siteId, {
      readSnapshot: readPreviewSnapshot, normalizeInput: previewInput, digest, runtime: runtimeDescriptor,
    });
    return handleBuiltinPreview(request, env, siteId);
  },
  scheduled(controller, env, ctx): Promise<void> | void { return downstream.scheduled?.(controller, env, ctx); },
} satisfies ExportedHandler<Env>;
