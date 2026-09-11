import baseApp from './app-ads-txt-managed-file';
import { getAuthenticatedUser, isSameOriginMutation, type AuthEnv } from './auth';
import { handleBuiltinPreview, readPreviewSnapshot, runtimeDescriptor } from './runtime/builtin-preview-service.mjs';
import { previewInput, digest } from './runtime/preview-snapshot.mjs';
import { handlePrebidPreflight } from './runtime/prebid-preflight-service.mjs';
import { handleArtifactBundle } from './runtime/artifact-bundle-service.mjs';
import type { ReleaseEnv } from './releases';
interface Env extends AuthEnv, ReleaseEnv { ASSETS: Fetcher }
const downstream = baseApp as {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  scheduled?(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> | void;
};
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
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
    if (bundle) return handleArtifactBundle(request, env, siteId);
    if (prebidCheck) return handlePrebidPreflight(request, env, siteId, {
      readSnapshot: readPreviewSnapshot, normalizeInput: previewInput, digest, runtime: runtimeDescriptor,
    });
    return handleBuiltinPreview(request, env, siteId);
  },
  scheduled(controller, env, ctx): Promise<void> | void { return downstream.scheduled?.(controller, env, ctx); },
} satisfies ExportedHandler<Env>;
