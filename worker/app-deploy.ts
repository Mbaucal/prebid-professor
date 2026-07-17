import {
  getAuthenticatedUser,
  isSameOriginMutation,
  type AuthEnv,
} from './auth';
import compatApp from './app-compat';
import { apiError } from './http';
import { getPrebidMode, updatePrebidMode } from './prebid-mode';
import type { ReleaseEnv } from './releases';

const RUNTIME_BUILD = '2026-07-18-runtime-template-content-v4';
const RELEASE_COMPILE_ROUTE = /^\/api\/publishers\/[^/]+\/releases\/(?:validate|generate)$/;

interface Env extends ReleaseEnv, AuthEnv {
  ASSETS: Fetcher;
  GITHUB_ACTIONS_TOKEN?: string;
  GITHUB_DEPLOY_REPOSITORY?: string;
  GITHUB_DEPLOY_REF?: string;
  DEPLOY_CALLBACK_SECRET?: string;
}

const downstream = compatApp as {
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

function normalizeRuntimeBuildMarker(source: string): string {
  const canonical = 'window.ADS_BUILD_TS = "__PP_TEMPLATE_BUILD__";';
  const patterns = [
    /window\s*\.\s*ADS_BUILD_TS\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[A-Za-z0-9_.$-]+)\s*;?/,
    /window\s*\[\s*["']ADS_BUILD_TS["']\s*\]\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[A-Za-z0-9_.$-]+)\s*;?/,
    /(?:var|let|const)\s+ADS_BUILD_TS\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[A-Za-z0-9_.$-]+)\s*;?/,
  ];

  for (const pattern of patterns) {
    if (pattern.test(source)) return source.replace(pattern, canonical);
  }

  // The marker is release metadata only. Adding it does not alter auction,
  // targeting, lazy-load or refresh behavior in a frozen runtime.
  return `${canonical}\n${source}`;
}

function looksLikeRuntimeTemplate(source: string): boolean {
  return /\bvar\s+BIDDERS\s*=/.test(source)
    && /\bvar\s+EXPLICIT_UNITS\s*=/.test(source)
    && /\bvar\s+SIZE_MAPS_RAW\s*=/.test(source);
}

function textBackedR2Object(object: R2ObjectBody, text: string): R2ObjectBody {
  const bytes = new TextEncoder().encode(text);
  const toArrayBuffer = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  return new Proxy(object, {
    get(target, property) {
      if (property === 'text') return async () => text;
      if (property === 'arrayBuffer') return async () => toArrayBuffer();
      if (property === 'blob') return async () => new Blob([bytes], { type: 'application/javascript' });
      if (property === 'json') return async <T>() => JSON.parse(text) as T;
      if (property === 'size') return bytes.byteLength;
      if (property === 'bodyUsed') return false;
      if (property === 'body') {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as R2ObjectBody;
}

function withRuntimeTemplateCompatibility(env: Env): Env {
  if (!env.BUILDS) return env;
  const originalBucket = env.BUILDS;

  const bucket = new Proxy(originalBucket, {
    get(target, property) {
      if (property === 'get') {
        return async (key: string, options?: R2GetOptions) => {
          const object = await target.get(key, options);
          if (!object) return object;

          // During release validation/generation R2 returns manifests, the frozen
          // runtime template and prebid.js. Detect the runtime by its required
          // compiler variables instead of assuming a historical R2 key layout.
          if (key.includes('/source/') || /\.(?:zip|gz|wasm)$/i.test(key)) return object;
          const source = await object.text();
          const normalized = looksLikeRuntimeTemplate(source)
            ? normalizeRuntimeBuildMarker(source)
            : source;
          return textBackedR2Object(object, normalized);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as R2Bucket;

  return { ...env, BUILDS: bucket };
}

function withBuildHeader(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('x-prebid-professor-build', RUNTIME_BUILD);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function healthWithBuildMarker(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const response = await downstream.fetch(request, env, ctx);
  try {
    const payload = (await response.clone().json()) as Record<string, unknown>;
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store');
    headers.set('x-prebid-professor-build', RUNTIME_BUILD);
    return new Response(
      `${JSON.stringify({
        ...payload,
        runtimeBuild: RUNTIME_BUILD,
        workerEntrypoint: 'worker/app-deploy.ts',
      }, null, 2)}\n`,
      { status: response.status, headers },
    );
  } catch {
    return withBuildHeader(response);
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (request.method === 'GET' && pathname === '/api/health') {
      return healthWithBuildMarker(request, env, ctx);
    }

    const prebidModeMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/prebid-mode$/);
    if (prebidModeMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);

      const siteId = decodeURIComponent(prebidModeMatch[1]);
      if (request.method === 'GET') return withBuildHeader(await getPrebidMode(env, siteId));
      if (request.method === 'PUT') return withBuildHeader(await updatePrebidMode(verified, env, siteId));
      return withBuildHeader(apiError('Method not allowed.', 405));
    }

    const runtimeEnv = RELEASE_COMPILE_ROUTE.test(pathname)
      ? withRuntimeTemplateCompatibility(env)
      : env;

    return withBuildHeader(await downstream.fetch(request, runtimeEnv, ctx));
  },
} satisfies ExportedHandler<Env>;
