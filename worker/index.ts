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
