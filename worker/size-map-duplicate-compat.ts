import { apiError } from './http';
import type { DatabaseEnv } from './publishers';
import { createFlexibleSizeMap } from './size-map-compat';

export async function duplicateFlexibleSizeMap(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
  sourceSizeMapId: string,
): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured yet.', 503);

  const source = await env.DB
    .prepare('SELECT name, map_json FROM size_maps WHERE publisher_id = ? AND id = ? LIMIT 1')
    .bind(siteId, sourceSizeMapId)
    .first<{ name: string; map_json: string }>();
  if (!source) return apiError('Source size map not found.', 404);

  let body: { name?: unknown };
  try {
    body = (await request.json()) as { name?: unknown };
  } catch {
    return apiError('Invalid JSON body.');
  }

  let map: unknown;
  try {
    map = JSON.parse(source.map_json);
  } catch {
    return apiError('Source size map JSON is invalid.', 422);
  }

  const syntheticRequest = new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify({ name: String(body.name ?? '').trim(), map }),
  });
  return createFlexibleSizeMap(syntheticRequest, env, siteId);
}
