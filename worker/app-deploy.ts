import {
  getAuthenticatedUser,
  isSameOriginMutation,
  type AuthEnv,
} from './auth';
import compatApp from './app-compat';
import {
  checkAdsTxt,
  copyAdsTxtRequirements,
  deleteAdsTxtRequirement,
  importAdsTxtRequirements,
  listAdsTxtRequirements,
  updateAdsTxtRequirement,
} from './ads-txt';
import { createAdsTxtRequirementFlexible } from './ads-txt-flexible';
import { copyAdsTxtRequirementsLarge, importAdsTxtRequirementsLarge } from './ads-txt-bulk';
import { apiError } from './http';
import { getPrebidMode, updatePrebidMode } from './prebid-mode';
import { deleteRelease } from './release-deletion';
import type { ReleaseEnv } from './releases';

const RUNTIME_BUILD = '2026-07-19-ads-txt-large-bulk-v15';

interface Env extends ReleaseEnv, AuthEnv {
  ASSETS: Fetcher;
  GITHUB_ACTIONS_TOKEN?: string;
  GITHUB_DEPLOY_REPOSITORY?: string;
  GITHUB_DEPLOY_REF?: string;
  DEPLOY_CALLBACK_SECRET?: string;
}

const downstream = compatApp as {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
};

function withAuthenticatedActor(request: Request, email: string): Request {
  const headers = new Headers(request.headers);
  headers.set('x-user-email', email);
  return new Request(request, { headers });
}

function normalizeVerifiedSameOriginRequest(request: Request): Request {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return request;

  const requestOrigin = new URL(request.url).origin;
  const originHeader = request.headers.get('origin')?.trim() ?? '';
  const refererHeader = request.headers.get('referer')?.trim() ?? '';
  const fetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase() ?? '';

  let verifiedSameOrigin = false;
  if (originHeader && originHeader !== 'null') {
    try {
      verifiedSameOrigin = new URL(originHeader).origin === requestOrigin;
    } catch {
      verifiedSameOrigin = false;
    }
  } else if (refererHeader) {
    try {
      verifiedSameOrigin = new URL(refererHeader).origin === requestOrigin;
    } catch {
      verifiedSameOrigin = false;
    }
  } else if (originHeader === 'null' && fetchSite === 'same-origin') {
    verifiedSameOrigin = true;
  }

  if (!verifiedSameOrigin) return request;
  const headers = new Headers(request.headers);
  headers.set('origin', requestOrigin);
  headers.set('sec-fetch-site', 'same-origin');
  return new Request(request, { headers });
}

async function authenticatedRequest(request: Request, env: Env): Promise<Request | Response> {
  const user = await getAuthenticatedUser(request, env);
  if (!user) return apiError('Authentication required.', 401);

  const normalized = normalizeVerifiedSameOriginRequest(request);
  if (!isSameOriginMutation(normalized)) {
    return apiError('Cross-site state-changing request blocked.', 403);
  }
  return withAuthenticatedActor(normalized, user.email);
}

function withBuildHeader(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('x-prebid-professor-build', RUNTIME_BUILD);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function healthWithBuildMarker(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const response = await downstream.fetch(request, env, ctx);
  try {
    const payload = (await response.clone().json()) as Record<string, unknown>;
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store');
    headers.set('x-prebid-professor-build', RUNTIME_BUILD);
    return new Response(
      `${JSON.stringify({
        ...payload,
        runtimeBuild: RUNTIME_BUILD,
        workerEntrypoint: 'worker/app-deploy.ts',
      }, null, 2)}\n`,
      { status: response.status, headers },
    );
  } catch {
    return withBuildHeader(response);
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (request.method === 'GET' && pathname === '/api/health') {
      return healthWithBuildMarker(request, env, ctx);
    }

    const adsTxtCheckMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ads-txt\/check$/);
    if (adsTxtCheckMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await checkAdsTxt(verified, env, decodeURIComponent(adsTxtCheckMatch[1])));
    }

    const adsTxtImportMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ads-txt\/requirements\/import$/);
    if (adsTxtImportMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await importAdsTxtRequirementsLarge(
        verified,
        env,
        decodeURIComponent(adsTxtImportMatch[1]),
      ));
    }

    const adsTxtCopyMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ads-txt\/requirements\/copy$/);
    if (adsTxtCopyMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await copyAdsTxtRequirementsLarge(
        verified,
        env,
        decodeURIComponent(adsTxtCopyMatch[1]),
      ));
    }

    const adsTxtItemMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ads-txt\/requirements\/([^/]+)$/);
    if (adsTxtItemMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      const siteId = decodeURIComponent(adsTxtItemMatch[1]);
      const requirementId = decodeURIComponent(adsTxtItemMatch[2]);
      if (request.method === 'PATCH') {
        return withBuildHeader(await updateAdsTxtRequirement(verified, env, siteId, requirementId));
      }
      if (request.method === 'DELETE') {
        return withBuildHeader(await deleteAdsTxtRequirement(verified, env, siteId, requirementId));
      }
      return withBuildHeader(apiError('Method not allowed.', 405));
    }

    const adsTxtCollectionMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ads-txt\/requirements$/);
    if (adsTxtCollectionMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      const siteId = decodeURIComponent(adsTxtCollectionMatch[1]);
      if (request.method === 'GET') return withBuildHeader(await listAdsTxtRequirements(env, siteId));
      if (request.method === 'POST') {
        return withBuildHeader(await createAdsTxtRequirementFlexible(verified, env, siteId));
      }
      return withBuildHeader(apiError('Method not allowed.', 405));
    }

    const releaseDeleteMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/releases\/([^/]+)$/);
    if (releaseDeleteMatch && request.method === 'DELETE') {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      return withBuildHeader(await deleteRelease(
        verified,
        env,
        decodeURIComponent(releaseDeleteMatch[1]),
        decodeURIComponent(releaseDeleteMatch[2]),
      ));
    }

    const prebidModeMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/prebid-mode$/);
    if (prebidModeMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);

      const siteId = decodeURIComponent(prebidModeMatch[1]);
      if (request.method === 'GET') return withBuildHeader(await getPrebidMode(env, siteId));
      if (request.method === 'PUT') return withBuildHeader(await updatePrebidMode(verified, env, siteId));
      return withBuildHeader(apiError('Method not allowed.', 405));
    }

    return withBuildHeader(await downstream.fetch(request, env, ctx));
  },
} satisfies ExportedHandler<Env>;
