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

interface Env extends PrebidBuildEnv {
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

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'GET' && pathname === '/api/health') {
      return json({
        ok: true,
        service: 'prebid-professor',
        environment: 'foundation',
        database: await databaseStatus(env),
        storage: env.BUILDS ? 'connected' : 'not-bound',
        timestamp: new Date().toISOString(),
      });
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
        request,
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
        request,
        env,
        decodeURIComponent(buildMatch[1]),
        decodeURIComponent(buildMatch[2]),
      );
    }

    const buildsMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/prebid-builds$/);
    if (buildsMatch) {
      const siteId = decodeURIComponent(buildsMatch[1]);
      if (request.method === 'GET') return listPrebidBuilds(env, siteId);
      if (request.method === 'POST') return uploadPrebidBuild(request, env, siteId);
      return apiError('Method not allowed.', 405);
    }

    return legacyHandler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
