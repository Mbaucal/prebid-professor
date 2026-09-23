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
  createDeploymentTarget,
  deleteDeploymentTarget,
  deploymentCallback,
  dispatchExternalDeployment,
  listDeploymentTargets,
  updateDeploymentTarget,
  type ExternalDeployEnv,
} from './external-deployments';
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
import { getPrebidMode, updatePrebidMode } from './prebid-mode';
import {
  activatePrebidBuild,
  deletePrebidBuild,
  downloadPrebidBuild,
  listPrebidBuilds,
  type PrebidBuildEnv,
  uploadPrebidBuild,
} from './prebid-builds-identity';
import {
  generateRelease,
  listReleases,
  publishReleaseToProduction,
  publishReleaseToStaging,
  rollbackRelease,
  serveReleaseCdn,
  validateRelease,
  type ReleaseEnv,
} from './releases';
import { getUserIdConfig, updateUserIdConfig } from './user-id-config';

interface Env extends PrebidBuildEnv, GeneratorProfileEnv, ReleaseEnv, ExternalDeployEnv, AuthEnv {
  ASSETS: Fetcher;
}

const RUNTIME_BUILD = '2026-07-17-primary-demand-mode-v2';

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

async function releaseStatus(env: Env, siteId: string, releaseId: string): Promise<string | null> {
  if (!env.DB) return null;
  const row = await env.DB
    .prepare('SELECT status FROM releases WHERE publisher_id = ? AND id = ? LIMIT 1')
    .bind(siteId, releaseId)
    .first<{ status: string }>();
  return row?.status ?? null;
}

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
        externalDeploy: {
          github: env.GITHUB_ACTIONS_TOKEN ? 'configured' : 'not-configured',
          callback: env.DEPLOY_CALLBACK_SECRET ? 'configured' : 'not-configured',
        },
        runtimeBuild: RUNTIME_BUILD,
        workerEntrypoint: 'worker/app.ts',
        timestamp: new Date().toISOString(),
      });
    }

    if (pathname.startsWith('/cdn/')) {
      const cdnResponse = await serveReleaseCdn(request, env);
      if (cdnResponse) return cdnResponse;
    }

    if (pathname === '/api/deployments/callback') {
      return deploymentCallback(request, env);
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

    if (pathname === '/api/auth/login') return handleLogin(verifiedRequest, env);
    if (pathname === '/api/auth/logout') {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return handleLogout(verifiedRequest);
    }

    // Sign-in branding needs these exact public assets before a session exists.
    if ((pathname === '/tessera-logo.png' || pathname === '/favicon.ico') && (request.method === 'GET' || request.method === 'HEAD')) {
      return env.ASSETS.fetch(request);
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

    const prebidModeMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/prebid-mode$/);
    if (prebidModeMatch) {
      const siteId = decodeURIComponent(prebidModeMatch[1]);
      if (request.method === 'GET') return getPrebidMode(env, siteId);
      if (request.method === 'PUT') return updatePrebidMode(authenticatedRequest, env, siteId);
      return apiError('Method not allowed.', 405);
    }

    if (pathname === '/api/generator-profiles') {
      if (request.method === 'GET') return listGeneratorProfiles(env);
      if (request.method === 'POST') return createGeneratorProfile(authenticatedRequest, env);
      return apiError('Method not allowed.', 405);
    }

    const profileDuplicateMatch = pathname.match(/^\/api\/generator-profiles\/([^/]+)\/duplicate$/);
    if (profileDuplicateMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return duplicateGeneratorProfile(authenticatedRequest, env, decodeURIComponent(profileDuplicateMatch[1]));
    }

    const profileDownloadMatch = pathname.match(/^\/api\/generator-profiles\/([^/]+)\/(template|source)\/download$/);
    if (profileDownloadMatch) {
      if (request.method !== 'GET') return apiError('Method not allowed.', 405);
      return downloadGeneratorProfileFile(
        env,
        decodeURIComponent(profileDownloadMatch[1]),
        profileDownloadMatch[2] as 'template' | 'source',
      );
    }

    const profileMatch = pathname.match(/^\/api\/generator-profiles\/([^/]+)$/);
    if (profileMatch) {
      if (request.method !== 'DELETE') return apiError('Method not allowed.', 405);
      return deleteGeneratorProfile(authenticatedRequest, env, decodeURIComponent(profileMatch[1]));
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

    const advancedRuleMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/unit-rules-advanced\/([^/]+)$/);
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

    const releaseValidateMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/releases\/validate$/);
    if (releaseValidateMatch) {
      if (request.method !== 'GET') return apiError('Method not allowed.', 405);
      return validateRelease(env, decodeURIComponent(releaseValidateMatch[1]));
    }

    const releaseGenerateMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/releases\/generate$/);
    if (releaseGenerateMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return generateRelease(authenticatedRequest, env, decodeURIComponent(releaseGenerateMatch[1]));
    }

    const releaseActionMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/releases\/([^/]+)\/(staging|production|rollback)$/,
    );
    if (releaseActionMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      const siteId = decodeURIComponent(releaseActionMatch[1]);
      const releaseId = decodeURIComponent(releaseActionMatch[2]);
      const action = releaseActionMatch[3];
      const status = await releaseStatus(env, siteId, releaseId);
      if (!status) return apiError('Release not found.', 404);
      if (action === 'production' && status !== 'staging') {
        return apiError('A release must be published to staging before production.', 409);
      }
      if (action === 'rollback' && status !== 'archived') {
        return apiError('Rollback is only available for an archived production release.', 409);
      }
      if (action === 'staging') return publishReleaseToStaging(authenticatedRequest, env, siteId, releaseId);
      if (action === 'production') return publishReleaseToProduction(authenticatedRequest, env, siteId, releaseId);
      return rollbackRelease(authenticatedRequest, env, siteId, releaseId);
    }

    const releasesMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/releases$/);
    if (releasesMatch) {
      if (request.method !== 'GET') return apiError('Method not allowed.', 405);
      return listReleases(request, env, decodeURIComponent(releasesMatch[1]));
    }

    const deploymentDispatchMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/deployment-targets\/([^/]+)\/dispatch$/,
    );
    if (deploymentDispatchMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return dispatchExternalDeployment(
        authenticatedRequest,
        env,
        decodeURIComponent(deploymentDispatchMatch[1]),
        decodeURIComponent(deploymentDispatchMatch[2]),
      );
    }

    const deploymentTargetMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/deployment-targets\/([^/]+)$/,
    );
    if (deploymentTargetMatch) {
      const siteId = decodeURIComponent(deploymentTargetMatch[1]);
      const targetId = decodeURIComponent(deploymentTargetMatch[2]);
      if (request.method === 'PATCH') return updateDeploymentTarget(authenticatedRequest, env, siteId, targetId);
      if (request.method === 'DELETE') return deleteDeploymentTarget(authenticatedRequest, env, siteId, targetId);
      return apiError('Method not allowed.', 405);
    }

    const deploymentTargetsMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/deployment-targets$/);
    if (deploymentTargetsMatch) {
      const siteId = decodeURIComponent(deploymentTargetsMatch[1]);
      if (request.method === 'GET') return listDeploymentTargets(env, siteId);
      if (request.method === 'POST') return createDeploymentTarget(authenticatedRequest, env, siteId);
      return apiError('Method not allowed.', 405);
    }

    const buildDownloadMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/prebid-builds\/([^/]+)\/download$/);
    if (buildDownloadMatch) {
      if (request.method !== 'GET') return apiError('Method not allowed.', 405);
      return downloadPrebidBuild(env, decodeURIComponent(buildDownloadMatch[1]), decodeURIComponent(buildDownloadMatch[2]));
    }

    const buildActivateMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/prebid-builds\/([^/]+)\/activate$/);
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
