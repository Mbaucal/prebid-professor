import type {
  CreateSizeMapInput,
  DuplicateSizeMapInput,
  SizeMap,
  SizeMapBreakpoint,
  UpdateSizeMapInput,
} from '../src/shared/types';
import { apiError, getActor, json, readJson } from './http';
import type { DatabaseEnv } from './publishers';

type SizeMapRow = {
  id: string;
  publisher_id: string;
  name: string;
  map_json: string;
  created_at: string;
  updated_at: string;
};

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function parseStoredMap(value: string): SizeMapBreakpoint[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as SizeMapBreakpoint[]) : [];
  } catch {
    return [];
  }
}

function toSizeMap(row: SizeMapRow): SizeMap {
  return {
    id: row.id,
    publisherId: row.publisher_id,
    name: row.name,
    map: parseStoredMap(row.map_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeName(value: unknown): string {
  return String(value ?? '').trim();
}

function validateName(name: string): string[] {
  if (!name) return ['name is required.'];
  if (!/^[A-Za-z][A-Za-z0-9_:\-]{0,127}$/.test(name)) {
    return ['name must start with a letter and use letters, numbers, underscore, dash or colon.'];
  }
  return [];
}

function normalizeMap(value: unknown): SizeMapBreakpoint[] {
  if (!Array.isArray(value)) throw new Error('map must be an array of breakpoints.');
  if (!value.length) throw new Error('map must contain at least one breakpoint.');

  const grouped = new Map<string, SizeMapBreakpoint>();

  value.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Breakpoint ${index + 1} must be an object.`);
    }

    const candidate = item as Record<string, unknown>;
    const viewport = candidate.minViewPort;
    if (!Array.isArray(viewport) || viewport.length !== 2) {
      throw new Error(`Breakpoint ${index + 1} minViewPort must be [width, height].`);
    }

    const minWidth = Number(viewport[0]);
    const minHeight = Number(viewport[1]);
    if (!Number.isInteger(minWidth) || !Number.isInteger(minHeight) || minWidth < 0 || minHeight < 0) {
      throw new Error(`Breakpoint ${index + 1} viewport values must be non-negative integers.`);
    }

    if (!Array.isArray(candidate.sizes) || !candidate.sizes.length) {
      throw new Error(`Breakpoint ${index + 1} must contain at least one size.`);
    }

    const sizes = candidate.sizes.map((size, sizeIndex) => {
      if (!Array.isArray(size) || size.length !== 2) {
        throw new Error(`Breakpoint ${index + 1}, size ${sizeIndex + 1} must be [width, height].`);
      }
      const width = Number(size[0]);
      const height = Number(size[1]);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`Breakpoint ${index + 1}, size ${sizeIndex + 1} must use positive integers.`);
      }
      return [width, height] as [number, number];
    });

    const key = `${minWidth}x${minHeight}`;
    const existing = grouped.get(key);
    const merged = existing ? [...existing.sizes, ...sizes] : sizes;
    const unique = Array.from(
      new Map(merged.map((size) => [`${size[0]}x${size[1]}`, size])).values(),
    );
    grouped.set(key, { minViewPort: [minWidth, minHeight], sizes: unique });
  });

  return Array.from(grouped.values()).sort(
    (a, b) => a.minViewPort[0] - b.minViewPort[0] || a.minViewPort[1] - b.minViewPort[1],
  );
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1')
    .bind(siteId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function fetchSizeMap(
  db: D1Database,
  siteId: string,
  sizeMapId: string,
): Promise<SizeMap | null> {
  const row = await db
    .prepare(
      `SELECT id, publisher_id, name, map_json, created_at, updated_at
       FROM size_maps
       WHERE publisher_id = ? AND id = ?
       LIMIT 1`,
    )
    .bind(siteId, sizeMapId)
    .first<SizeMapRow>();
  return row ? toSizeMap(row) : null;
}

export async function listSizeMaps(env: DatabaseEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  const result = await env.DB
    .prepare(
      `SELECT id, publisher_id, name, map_json, created_at, updated_at
       FROM size_maps
       WHERE publisher_id = ?
       ORDER BY name COLLATE NOCASE`,
    )
    .bind(siteId)
    .all<SizeMapRow>();

  return json({ ok: true, sizeMaps: (result.results ?? []).map(toSizeMap) });
}

export async function createSizeMap(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  let input: CreateSizeMapInput;
  try {
    input = await readJson<CreateSizeMapInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const name = normalizeName(input.name);
  const errors = validateName(name);
  if (errors.length) return apiError('Size map validation failed.', 422, errors);

  let map: SizeMapBreakpoint[];
  try {
    map = normalizeMap(input.map);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid size map.', 422);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const actor = getActor(request);

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO size_maps (id, publisher_id, name, map_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, siteId, name, JSON.stringify(map), now, now),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'size_map.created', ?, 'size_map', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          id,
          JSON.stringify({ name, breakpoints: map.length }),
          now,
        ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict ? `Size map "${name}" already exists on this site.` : 'Size map creation failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  return json({ ok: true, sizeMap: await fetchSizeMap(env.DB, siteId, id) }, { status: 201 });
}

export async function updateSizeMap(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
  sizeMapId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const current = await fetchSizeMap(env.DB, siteId, sizeMapId);
  if (!current) return apiError('Size map not found.', 404);

  let input: UpdateSizeMapInput;
  try {
    input = await readJson<UpdateSizeMapInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const name = input.name === undefined ? current.name : normalizeName(input.name);
  const errors = validateName(name);
  if (errors.length) return apiError('Size map validation failed.', 422, errors);

  let map = current.map;
  if (input.map !== undefined) {
    try {
      map = normalizeMap(input.map);
    } catch (error) {
      return apiError(error instanceof Error ? error.message : 'Invalid size map.', 422);
    }
  }

  const now = new Date().toISOString();
  const actor = getActor(request);

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE size_maps
           SET name = ?, map_json = ?, updated_at = ?
           WHERE publisher_id = ? AND id = ?`,
        )
        .bind(name, JSON.stringify(map), now, siteId, sizeMapId),
      env.DB
        .prepare(
          `UPDATE ad_units
           SET size_map_key = ?, updated_at = ?
           WHERE publisher_id = ? AND size_map_key = ?`,
        )
        .bind(name, now, siteId, current.name),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'size_map.updated', ?, 'size_map', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          sizeMapId,
          JSON.stringify({ previousName: current.name, name, breakpoints: map.length }),
          now,
        ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict ? `Size map "${name}" already exists on this site.` : 'Size map update failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  return json({ ok: true, sizeMap: await fetchSizeMap(env.DB, siteId, sizeMapId) });
}

export async function duplicateSizeMap(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
  sourceSizeMapId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const source = await fetchSizeMap(env.DB, siteId, sourceSizeMapId);
  if (!source) return apiError('Source size map not found.', 404);

  let input: DuplicateSizeMapInput;
  try {
    input = await readJson<DuplicateSizeMapInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const syntheticRequest = new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify({ name: input.name, map: source.map }),
  });
  return createSizeMap(syntheticRequest, env, siteId);
}

export async function deleteSizeMap(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
  sizeMapId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const current = await fetchSizeMap(env.DB, siteId, sizeMapId);
  if (!current) return apiError('Size map not found.', 404);

  const references = await env.DB
    .prepare('SELECT code FROM ad_units WHERE publisher_id = ? AND size_map_key = ? ORDER BY code')
    .bind(siteId, current.name)
    .all<{ code: string }>();
  const usedBy = (references.results ?? []).map((item) => item.code);
  if (usedBy.length) {
    return apiError(
      `Size map "${current.name}" is still used by ${usedBy.length} ad unit(s).`,
      409,
      { usedBy },
    );
  }

  const actor = getActor(request);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO audit_log (
           id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
         ) VALUES (?, ?, 'size_map.deleted', ?, 'size_map', ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        actor,
        siteId,
        sizeMapId,
        JSON.stringify({ name: current.name }),
        now,
      ),
    env.DB.prepare('DELETE FROM size_maps WHERE publisher_id = ? AND id = ?').bind(siteId, sizeMapId),
  ]);

  return json({ ok: true, deletedId: sizeMapId });
}
