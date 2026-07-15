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

export function getActor(request: Request): string {
  return (
    request.headers.get('cf-access-authenticated-user-email') ??
    request.headers.get('x-user-email') ??
    'system'
  );
}
