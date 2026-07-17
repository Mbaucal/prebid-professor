import {
  getAuthenticatedUser,
  isSameOriginMutation,
  type AuthEnv,
} from './auth';
import baseApp from './app';
import { apiError } from './http';
import { getPrebidMode, updatePrebidMode } from './prebid-mode';
import {
  generateReleaseForDemandMode,
  validateReleaseForDemandMode,
} from './prebid-mode-release';
import {
  applyFlexibleSizeMapCsv,
  createFlexibleSizeMap,
  previewFlexibleSizeMapCsv,
  updateFlexibleSizeMap,
} from './size-map-compat';
import { duplicateFlexibleSizeMap } from './size-map-duplicate-compat';
import type { ReleaseEnv } from './releases';

interface Env extends ReleaseEnv, AuthEnv {
  ASSETS: Fetcher;
  GITHUB_ACTIONS_TOKEN?: string;
  GITHUB_DEPLOY_REPOSITORY?: string;
  GITHUB_DEPLOY_REF?: string;
  DEPLOY_CALLBACK_SECRET?: string;
}

const legacyApp = baseApp as {
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

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    const importMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/imports\/(preview|apply)$/);
    if (importMatch && request.method === 'POST') {
      let kind = '';
      try {
        const body = (await request.clone().json()) as { kind?: unknown };
        kind = String(body.kind ?? '');
      } catch {
        // Let the existing endpoint return the normal malformed JSON response.
      }
      if (kind === 'size-maps') {
        const verified = await authenticatedRequest(request, env);
        if (verified instanceof Response) return verified;
        const siteId = decodeURIComponent(importMatch[1]);
        return importMatch[2] === 'preview'
          ? previewFlexibleSizeMapCsv(verified, env, siteId)
          : applyFlexibleSizeMapCsv(verified, env, siteId);
      }
    }

    const sizeMapDuplicateMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/size-maps\/([^/]+)\/duplicate$/,
    );
    if (sizeMapDuplicateMatch && request.method === 'POST') {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return verified;
      return duplicateFlexibleSizeMap(
        verified,
        env,
        decodeURIComponent(sizeMapDuplicateMatch[1]),
        decodeURIComponent(sizeMapDuplicateMatch[2]),
      );
    }

    const sizeMapCollectionMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/size-maps$/);
    if (sizeMapCollectionMatch && request.method === 'POST') {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return verified;
      return createFlexibleSizeMap(verified, env, decodeURIComponent(sizeMapCollectionMatch[1]));
    }

    const sizeMapItemMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/size-maps\/([^/]+)$/);
    if (sizeMapItemMatch && request.method === 'PATCH') {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return verified;
      return updateFlexibleSizeMap(
        verified,
        env,
        decodeURIComponent(sizeMapItemMatch[1]),
        decodeURIComponent(sizeMapItemMatch[2]),
      );
    }

    const prebidModeMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/prebid-mode$/);
    if (prebidModeMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return verified;
      const siteId = decodeURIComponent(prebidModeMatch[1]);
      if (request.method === 'GET') return getPrebidMode(env, siteId);
      if (request.method === 'PUT') return updatePrebidMode(verified, env, siteId);
      return apiError('Method not allowed.', 405);
    }

    const releaseValidateMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/releases\/validate$/);
    if (releaseValidateMatch && request.method === 'GET') {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return verified;
      return validateReleaseForDemandMode(env, decodeURIComponent(releaseValidateMatch[1]));
    }

    const releaseGenerateMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/releases\/generate$/);
    if (releaseGenerateMatch && request.method === 'POST') {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return verified;
      return generateReleaseForDemandMode(verified, env, decodeURIComponent(releaseGenerateMatch[1]));
    }

    return legacyApp.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
