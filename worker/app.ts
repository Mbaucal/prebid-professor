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
import { listAdvancedRules, updateAdvancedRule } from './advanced-rules';
import baseHandler from './index';
import {
  createGeneratorProfile,
  deleteGeneratorProfile,
  downloadGeneratorProfileFile,
  duplicateGeneratorProfile,
  getGeneratorSelection,
  listGeneratorProfiles,
  setGeneratorSelection,
  type GeneratorProfileEnv,
} from './generator-profiles';
import { apiError, json } from './http';
import {
  activatePrebidBuild,
  deletePrebidBuild,
  downloadPrebidBuild,
  listPrebidBuilds,
  type PrebidBuildEnv,
  uploadPrebidBuild,
} from './prebid-builds';
import { getUserIdConfig, updateUserIdConfig } from './user-id-config';

interface Env extends PrebidBuildEnv, GeneratorProfileEnv, AuthEnv {
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
 * Normalize fetch metadata only after the browser has independently marked the
 * request as same-origin, or after Origin/Referer exactly matches this Worker.
 * Chrome may send Origin:null for a normal top-level form submission.
 */
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

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const verifiedRequest = normalizeVerifiedSameOriginRequest(request);

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
        return new Response(null, { status: 303, headers: { location: '/', 'cache-control': 'no-store' } });
      }
      return renderLoginPage(request, env);
    }

    if (pathname === '/api/auth/login') return handleLogin(verifiedRequest, env);
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

    if (request.method === 'GET' && pathname === '/api/auth/me') return json({ ok: true, user });
    const authenticatedRequest = withAuthenticatedActor(verifiedRequest, user.email);

    // Platform-level immutable generator profiles stored in R2.
    if (pathname === '/api/generator-profiles') {
      if (request.method === 'GET') return listGeneratorProfiles(env);
      if (request.method === 'POST') return createGeneratorProfile(authenticatedRequest, env);
      return apiError('Method not allowed.', 405);
    }

    const generatorProfileDuplicateMatch = pathname.match(/^\/api\/generator-profiles\/([^/]+)\/duplicate$/);
    if (generatorProfileDuplicateMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return duplicateGeneratorProfile(
        authenticatedRequest,
        env,
        decodeURIComponent(generatorProfileDuplicateMatch[1]),
      );
    }

    const generatorProfileDownloadMatch = pathname.match(
      /^\/api\/generator-profiles\/([^/]+)\/(template|source)\/download$/,
    );
    if (generatorProfileDownloadMatch) {
      if (request.method !== 'GET') return apiError('Method not allowed.', 405);
      return downloadGeneratorProfileFile(
        env,
        decodeURIComponent(generatorProfileDownloadMatch[1]),
        generatorProfileDownloadMatch[2] as 'template' | 'source',
      );
    }

    const generatorProfileMatch = pathname.match(/^\/api\/generator-profiles\/([^/]+)$/);
    if (generatorProfileMatch) {
      if (request.method !== 'DELETE') return apiError('Method not allowed.', 405);
      return deleteGeneratorProfile(authenticatedRequest, env, decodeURIComponent(generatorProfileMatch[1]));
    }

    const generatorSelectionMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/generator-selection$/);
    if (generatorSelectionMatch) {
      const siteId = decodeURIComponent(generatorSelectionMatch[1]);
      if (request.method === 'GET') return getGeneratorSelection(env, siteId);
      if (request.method === 'PUT') return setGeneratorSelection(authenticatedRequest, env, siteId);
      return apiError('Method not allowed.', 405);
    }

    const advancedRulesMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/unit-rules-advanced$/);
    if (advancedRulesMatch) {
      if (request.method !== 'GET') return apiError('Method not allowed.', 405);
      return listAdvancedRules(env, decodeURIComponent(advancedRulesMatch[1]));
    }

    const advancedRuleMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/unit-rules-advanced\/([^/]+)$/,
    );
    if (advancedRuleMatch) {
      if (request.method !== 'PUT') return apiError('Method not allowed.', 405);
      return updateAdvancedRule(
        authenticatedRequest,
        env,
        decodeURIComponent(advancedRuleMatch[1]),
        decodeURIComponent(advancedRuleMatch[2]),
      );
    }

    const userIdConfigMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/user-id-config$/);
    if (userIdConfigMatch) {
      const siteId = decodeURIComponent(userIdConfigMatch[1]);
      if (request.method === 'GET') return getUserIdConfig(env, siteId);
      if (request.method === 'PUT') return updateUserIdConfig(authenticatedRequest, env, siteId);
      return apiError('Method not allowed.', 405);
    }

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

    const buildMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/prebid-builds\/([^/]+)$/);
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
