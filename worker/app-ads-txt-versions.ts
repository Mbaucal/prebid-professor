import {
  getAuthenticatedUser,
  isSameOriginMutation,
  type AuthEnv,
} from './auth';
import baseApp from './app-ads-txt-managed-file';
import {
  createAdsTxtVersion,
  getAdsTxtVersion,
  listAdsTxtVersions,
  type AdsTxtVersionsEnv,
} from './ads-txt-versions';
import { apiError } from './http';
import type { ReleaseEnv } from './releases';

const ADS_TXT_VERSIONS_BUILD = '2026-08-05-ads-txt-versions-v1';

interface Env extends ReleaseEnv, AuthEnv, AdsTxtVersionsEnv {
  ASSETS: Fetcher;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GMAIL_TOKEN_ENCRYPTION_KEY?: string;
  ADS_TXT_CONNECTOR_ENCRYPTION_KEY?: string;
}

const downstream = baseApp as {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  scheduled?(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> | void;
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
  headers.set('x-tessera-ads-txt-versions-build', ADS_TXT_VERSIONS_BUILD);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    const versionMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/ads-txt\/versions\/([^/]+)$/,
    );
    if (versionMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'GET') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await getAdsTxtVersion(
        env,
        decodeURIComponent(versionMatch[1]),
        decodeURIComponent(versionMatch[2]),
      ));
    }

    const collectionMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/ads-txt\/versions$/,
    );
    if (collectionMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      const siteId = decodeURIComponent(collectionMatch[1]);
      if (request.method === 'GET') {
        return withBuildHeader(await listAdsTxtVersions(env, siteId));
      }
      if (request.method === 'POST') {
        return withBuildHeader(await createAdsTxtVersion(verified, env, siteId));
      }
      return withBuildHeader(apiError('Method not allowed.', 405));
    }

    return withBuildHeader(await downstream.fetch(request, env, ctx));
  },

  scheduled(controller, env, ctx): Promise<void> | void {
    return downstream.scheduled?.(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
