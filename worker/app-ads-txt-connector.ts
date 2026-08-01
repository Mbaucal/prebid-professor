import {
  getAuthenticatedUser,
  isSameOriginMutation,
  type AuthEnv,
} from './auth';
import baseApp from './app-deploy';
import {
  enableMockAdsTxtConnector,
  getAdsTxtConnectorStatus,
  getMockCmsAdsTxt,
  prepareMockAdsTxtVersion,
  publishMockAdsTxtVersion,
  rollbackMockAdsTxtVersion,
  testMockAdsTxtConnector,
  verifyMockAdsTxtVersion,
  type AdsTxtConnectorEnv,
} from './ads-txt-connector-safe';
import {
  deleteAdsTxtRealConnector,
  getAdsTxtRealConnector,
  saveAdsTxtRealConnector,
  type AdsTxtRealConnectorEnv,
} from './ads-txt-real-connector';
import { apiError } from './http';
import type { ReleaseEnv } from './releases';

const CONNECTOR_BUILD = '2026-08-02-ads-txt-cms-connection-v1';

interface Env extends ReleaseEnv, AuthEnv, AdsTxtConnectorEnv, AdsTxtRealConnectorEnv {
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

function withConnectorHeader(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('x-tessera-connector-build', CONNECTOR_BUILD);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    const realConnectionMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/ads-txt\/cms-connection$/,
    );
    if (realConnectionMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withConnectorHeader(verified);
      const siteId = decodeURIComponent(realConnectionMatch[1]);

      if (request.method === 'GET') {
        return withConnectorHeader(await getAdsTxtRealConnector(env, siteId));
      }
      if (request.method === 'PUT') {
        return withConnectorHeader(await saveAdsTxtRealConnector(verified, env, siteId));
      }
      if (request.method === 'DELETE') {
        return withConnectorHeader(await deleteAdsTxtRealConnector(verified, env, siteId));
      }
      return withConnectorHeader(apiError('Method not allowed.', 405));
    }

    const mockEndpointMatch = pathname.match(/^\/api\/mock-cms\/sites\/([^/]+)\/ads\.txt$/);
    if (mockEndpointMatch) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return withConnectorHeader(apiError('Method not allowed.', 405));
      }
      return withConnectorHeader(await getMockCmsAdsTxt(
        env,
        decodeURIComponent(mockEndpointMatch[1]),
      ));
    }

    const connectorMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/ads-txt\/connector(?:\/(enable-mock|test|prepare|publish|verify|rollback))?$/,
    );
    if (connectorMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withConnectorHeader(verified);

      const siteId = decodeURIComponent(connectorMatch[1]);
      const action = connectorMatch[2] ?? '';
      if (!action) {
        if (request.method !== 'GET') return withConnectorHeader(apiError('Method not allowed.', 405));
        return withConnectorHeader(await getAdsTxtConnectorStatus(verified, env, siteId));
      }
      if (request.method !== 'POST') return withConnectorHeader(apiError('Method not allowed.', 405));

      if (action === 'enable-mock') {
        return withConnectorHeader(await enableMockAdsTxtConnector(verified, env, siteId));
      }
      if (action === 'test') {
        return withConnectorHeader(await testMockAdsTxtConnector(verified, env, siteId));
      }
      if (action === 'prepare') {
        return withConnectorHeader(await prepareMockAdsTxtVersion(verified, env, siteId));
      }
      if (action === 'publish') {
        return withConnectorHeader(await publishMockAdsTxtVersion(verified, env, siteId));
      }
      if (action === 'verify') {
        return withConnectorHeader(await verifyMockAdsTxtVersion(verified, env, siteId));
      }
      if (action === 'rollback') {
        return withConnectorHeader(await rollbackMockAdsTxtVersion(verified, env, siteId));
      }
      return withConnectorHeader(apiError('Unknown connector action.', 404));
    }

    return downstream.fetch(request, env, ctx);
  },

  scheduled(controller, env, ctx): Promise<void> | void {
    return downstream.scheduled?.(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
