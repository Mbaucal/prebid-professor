import type { ApiErrorResponse } from '../src/shared/types';

const baseHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      ...baseHeaders,
      ...(init.headers ?? {}),
    },
  });
}

export function apiError(error: string, status = 400, details?: unknown): Response {
  const payload: ApiErrorResponse = {
    ok: false,
    error,
    ...(details === undefined ? {} : { details }),
  };

  return json(payload, { status });
}

export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get('content-type') ?? '';

  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error('Content-Type must be application/json.');
  }

  return (await request.json()) as T;
}

// This Symbol cannot arrive over HTTP. Keep identity on the verified request,
// rather than trusting Cloudflare Access or x-user-email headers from callers.
const actorKey = Symbol('verified-server-actor');
type ActorRequest = Request & { [actorKey]?: string };

export function withAuthenticatedActor(request: Request, actor: string): Request {
  const headers = new Headers(request.headers);
  headers.delete('cf-access-authenticated-user-email');
  // Some legacy helpers still consume this internal header. Always overwrite it.
  headers.set('x-user-email', actor);
  const verified: ActorRequest = new Request(request, { headers });
  Object.defineProperty(verified, actorKey, { value: actor });
  return verified;
}

export function getActor(request: Request): string {
  return (request as ActorRequest)[actorKey] ?? 'system';
}

// Internal adapters must carry the verified identity when rebuilding a body.
export function copyAuthenticatedActor(source: Request, target: Request): Request {
  return withAuthenticatedActor(target, getActor(source));
}

export function cloneAuthenticatedRequest(request: Request): Request {
  return copyAuthenticatedActor(request, request.clone());
}
