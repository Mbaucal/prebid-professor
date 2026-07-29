import {
  getAuthenticatedUser,
  isSameOriginMutation,
  type AuthEnv,
} from './auth';
import baseApp from './app-deploy';
import {
  checkDuplicateReadyRequirements,
  copyDuplicateReadyRequirements,
  createDuplicateReadyRequirements,
  deleteDuplicateReadyRequirement,
  importDuplicateReadyRequirements,
  listDuplicateReadyRequirements,
  updateDuplicateReadyRequirement,
} from './ads-txt-requirement-duplicates';
import { apiError } from './http';
import type { ReleaseEnv } from './releases';

interface Env extends ReleaseEnv, AuthEnv {
  ASSETS: Fetcher;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GMAIL_TOKEN_ENCRYPTION_KEY?: string;
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
  if (!isSameOriginMutation(normalized)) return apiError('Cross-site state-changing request blocked.', 403);
  return withAuthenticatedActor(normalized, user.email);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    const checkMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ads-txt\/check$/);
    if (checkMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return verified;
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return checkDuplicateReadyRequirements(verified, env, decodeURIComponent(checkMatch[1]));
    }

    const importMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ads-txt\/requirements\/import$/);
    if (importMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return verified;
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return importDuplicateReadyRequirements(verified, env, decodeURIComponent(importMatch[1]));
    }

    const copyMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ads-txt\/requirements\/copy$/);
    if (copyMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return verified;
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return copyDuplicateReadyRequirements(verified, env, decodeURIComponent(copyMatch[1]));
    }

    const itemMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ads-txt\/requirements\/([^/]+)$/);
    if (itemMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return verified;
      const siteId = decodeURIComponent(itemMatch[1]);
      const requirementId = decodeURIComponent(itemMatch[2]);
      if (request.method === 'PATCH') return updateDuplicateReadyRequirement(verified, env, siteId, requirementId);
      if (request.method === 'DELETE') return deleteDuplicateReadyRequirement(verified, env, siteId, requirementId);
      return apiError('Method not allowed.', 405);
    }

    const collectionMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ads-txt\/requirements$/);
    if (collectionMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return verified;
      const siteId = decodeURIComponent(collectionMatch[1]);
      if (request.method === 'GET') return listDuplicateReadyRequirements(env, siteId);
      if (request.method === 'POST') return createDuplicateReadyRequirements(verified, env, siteId);
      return apiError('Method not allowed.', 405);
    }

    return downstream.fetch(request, env, ctx);
  },

  scheduled(controller, env, ctx): Promise<void> | void {
    return downstream.scheduled?.(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
