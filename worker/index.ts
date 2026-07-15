import {
  createAdUnit,
  deleteAdUnit,
  duplicateAdUnit,
  listAdUnits,
  updateAdUnit,
} from './ad-units';
import { apiError, json } from './http';
import {
  createPublisher,
  duplicatePublisher,
  getPublisher,
  listPublishers,
  type DatabaseEnv,
} from './publishers';

interface Env extends DatabaseEnv {
  ASSETS: Fetcher;
}

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
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'GET' && pathname === '/api/health') {
      return json({
        ok: true,
        service: 'prebid-professor',
        environment: 'foundation',
        database: await databaseStatus(env),
        timestamp: new Date().toISOString(),
      });
    }

    if (pathname === '/api/publishers') {
      if (request.method === 'GET') return listPublishers(env);
      if (request.method === 'POST') return createPublisher(request, env);
      return apiError('Method not allowed.', 405);
    }

    const adUnitDuplicateMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/ad-units\/([^/]+)\/duplicate$/,
    );
    if (adUnitDuplicateMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return duplicateAdUnit(
        request,
        env,
        decodeURIComponent(adUnitDuplicateMatch[1]),
        decodeURIComponent(adUnitDuplicateMatch[2]),
      );
    }

    const adUnitMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ad-units\/([^/]+)$/);
    if (adUnitMatch) {
      const publisherId = decodeURIComponent(adUnitMatch[1]);
      const adUnitId = decodeURIComponent(adUnitMatch[2]);

      if (request.method === 'PATCH') return updateAdUnit(request, env, publisherId, adUnitId);
      if (request.method === 'DELETE') return deleteAdUnit(request, env, publisherId, adUnitId);
      return apiError('Method not allowed.', 405);
    }

    const adUnitsMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ad-units$/);
    if (adUnitsMatch) {
      const publisherId = decodeURIComponent(adUnitsMatch[1]);

      if (request.method === 'GET') return listAdUnits(env, publisherId);
      if (request.method === 'POST') return createAdUnit(request, env, publisherId);
      return apiError('Method not allowed.', 405);
    }

    const duplicateMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/duplicate$/);
    if (duplicateMatch) {
      if (request.method !== 'POST') return apiError('Method not allowed.', 405);
      return duplicatePublisher(request, env, decodeURIComponent(duplicateMatch[1]));
    }

    const publisherMatch = pathname.match(/^\/api\/publishers\/([^/]+)$/);
    if (publisherMatch) {
      if (request.method !== 'GET') return apiError('Method not allowed.', 405);
      return getPublisher(env, decodeURIComponent(publisherMatch[1]));
    }

    if (pathname.startsWith('/api/')) {
      return apiError('API route not found.', 404, { path: pathname });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
