import {
  authStatus,
  getAuthenticatedUser,
  handleLogin,
  handleLogout,
  isSameOriginMutation,
  redirectToLogin,
  renderLoginPage,
  type AuthEnv,
} from './auth';
import baseHandler from './index';
import { apiError, json } from './http';
import {
  activatePrebidBuild,
  deletePrebidBuild,
  downloadPrebidBuild,
  listPrebidBuilds,
  type PrebidBuildEnv,
  uploadPrebidBuild,
} from './prebid-builds';

interface Env extends PrebidBuildEnv, AuthEnv {
  ASSETS: Fetcher;
}

const legacyHandler = baseHandler as {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
};

async function databaseStatus(env: Env): Promise<'connected' | 'not-bound' | 'error'> {
  if (!env.DB) return 'not-bound';
  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    return 'connected';
  } catch {
    return 'error';
  }
}

function withAuthenticatedActor(request: Request, email: string): Request {
  const headers = new Headers(request.headers);
  headers.set('x-user-email', email);
  return new Request(request, { headers });
}

/**
 * Some browser/Cloudflare combinations report a normal form POST as
 * `Sec-Fetch-Site: same-site` even though the Origin is exactly the Worker
 * origin. The lower-level CSRF check intentionally accepts only
 * `same-origin`, so normalize the fetch metadata only after independently
 * proving the Origin or Referer is the exact same origin.
 */
function normalizeVerifiedSameOriginRequest(request: Request): Request {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return request;

  const requestOrigin = new URL(request.url).origin;
  const originHeader = request.headers.get('origin')?.trim() ?? '';
  const refererHeader = request.headers.get('referer')?.trim() ?? '';

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
  }

  if (!verifiedSameOrigin) return request;

  const headers = new Headers(request.headers);
  headers.set('origin', requestOrigin);
  headers.set('sec-fetch-site', 'same-origin');
  return new Request(request, { headers });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const verifiedRequest = normalizeVerifiedSameOriginRequest(request);

    // Health stays public so deployment, D1, R2 and auth configuration can be checked
    // even when a session has expired.
    if (request.method === 'GET' && pathname === '/api/health') {
      return json({
        ok: true,
        service: 'prebid-professor',
        environment: 'foundation',
        database: await databaseStatus(env),
        storage: env.BUILDS ? 'connected' : 'not-bound',
        auth: authStatus(env),
        timestamp: new Date().toISOString(),
      });
    }

    if (request.method === 'GET' && pathname === '/login') {
      const user = await getAuthenticatedUser(request, env);
      if (user) {
        return new Response(null, {
          status: 303,
          headers: { location: '/', 'cache-control': 'no-store' },
        });
      }
      return renderLoginPage(request, env);
    }

    if (pathname === '/api/auth/login') {
      return handleLogin(verifiedRequest, env);
    }

    if (pathname === '/api/auth/logout') {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return handleLogout(verifiedRequest);
    }

    const user = await getAuthenticatedUser(request, env);
    if (!user) {
      if (pathname.startsWith('/api/')) return apiError('Authentication required.', 401);
      return redirectToLogin(request);
    }

    if (!isSameOriginMutation(verifiedRequest)) {
      return apiError('Cross-site state-changing request blocked.', 403);
    }

    if (request.method === 'GET' && pathname === '/api/auth/me') {
      return json({ ok: true, user });
    }

    // Existing handlers already use getActor(), which reads x-user-email. Add the
    // authenticated account to the internal request so audit records show the real admin.
    const authenticatedRequest = withAuthenticatedActor(verifiedRequest, user.email);

    const buildDownloadMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/prebid-builds\/([^/]+)\/download$/,
    );
    if (buildDownloadMatch) {
      if (request.method !== 'GET') return apiError('Method not allowed.', 405);
      return downloadPrebidBuild(
        env,
        decodeURIComponent(buildDownloadMatch[1]),
        decodeURIComponent(buildDownloadMatch[2]),
      );
    }

    const buildActivateMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/prebid-builds\/([^/]+)\/activate$/,
    );
    if (buildActivateMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return activatePrebidBuild(
        authenticatedRequest,
        env,
        decodeURIComponent(buildActivateMatch[1]),
        decodeURIComponent(buildActivateMatch[2]),
      );
    }

    const buildMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/prebid-builds\/([^/]+)$/,
    );
    if (buildMatch) {
      if (request.method !== 'DELETE') return apiError('Method not allowed.', 405);
      return deletePrebidBuild(
        authenticatedRequest,
        env,
        decodeURIComponent(buildMatch[1]),
        decodeURIComponent(buildMatch[2]),
      );
    }

    const buildsMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/prebid-builds$/);
    if (buildsMatch) {
      const siteId = decodeURIComponent(buildsMatch[1]);
      if (request.method === 'GET') return listPrebidBuilds(env, siteId);
      if (request.method === 'POST') return uploadPrebidBuild(authenticatedRequest, env, siteId);
      return apiError('Method not allowed.', 405);
    }

    return legacyHandler.fetch(authenticatedRequest, env, ctx);
  },
} satisfies ExportedHandler<Env>;
