import type { CsvImportInput, CsvImportPreview, CsvImportPreviewRow, JsonObject } from '../src/shared/types';
import { apiError, getActor, json } from './http';
import type { DatabaseEnv } from './publishers';

type FixedSize = [number, number];
type FlexibleSize = FixedSize | 'fluid';
type FlexibleBreakpoint = {
  minViewPort: [number, number];
  sizes: FlexibleSize[];
};

type ParsedCsvRow = {
  rowNumber: number;
  values: Record<string, string>;
};

type SizeMapRow = {
  id: string;
  publisher_id: string;
  name: string;
  map_json: string;
  created_at: string;
  updated_at: string;
};

type ImportBuild = {
  preview: CsvImportPreview;
  entities: JsonObject[];
};

const MAX_DATA_ROWS = 250;
const EMPTY_SIZE_TOKENS = new Set(['', 'none', 'off', 'disabled', '[]', '-']);

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sizeKey(size: FlexibleSize): string {
  return size === 'fluid' ? 'fluid' : `${size[0]}x${size[1]}`;
}

function normalizeFlexibleMap(value: unknown): FlexibleBreakpoint[] {
  if (!Array.isArray(value)) throw new Error('map must be an array of breakpoints.');
  if (!value.length) throw new Error('map must contain at least one breakpoint.');

  const grouped = new Map<string, FlexibleBreakpoint>();

  value.forEach((item, index) => {
    if (!isRecord(item)) throw new Error(`Breakpoint ${index + 1} must be an object.`);
    const viewport = item.minViewPort;
    if (!Array.isArray(viewport) || viewport.length !== 2) {
      throw new Error(`Breakpoint ${index + 1} minViewPort must be [width, height].`);
    }

    const minWidth = Number(viewport[0]);
    const minHeight = Number(viewport[1]);
    if (!Number.isInteger(minWidth) || !Number.isInteger(minHeight) || minWidth < 0 || minHeight < 0) {
      throw new Error(`Breakpoint ${index + 1} viewport values must be non-negative integers.`);
    }

    if (!Array.isArray(item.sizes)) {
      throw new Error(`Breakpoint ${index + 1} sizes must be an array. Use [] to disable the slot at this viewport.`);
    }

    const normalizedSizes: FlexibleSize[] = item.sizes.map((rawSize, sizeIndex) => {
      if (typeof rawSize === 'string' && rawSize.trim().toLowerCase() === 'fluid') return 'fluid';
      if (!Array.isArray(rawSize) || rawSize.length !== 2) {
        throw new Error(`Breakpoint ${index + 1}, size ${sizeIndex + 1} must be [width, height] or fluid.`);
      }
      const width = Number(rawSize[0]);
      const height = Number(rawSize[1]);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`Breakpoint ${index + 1}, size ${sizeIndex + 1} must use positive integers.`);
      }
      return [width, height] as FixedSize;
    });

    const key = `${minWidth}x${minHeight}`;
    const existing = grouped.get(key);
    const merged = existing ? [...existing.sizes, ...normalizedSizes] : normalizedSizes;
    const unique = Array.from(new Map(merged.map((size) => [sizeKey(size), size])).values());
    grouped.set(key, { minViewPort: [minWidth, minHeight], sizes: unique });
  });

  const map = Array.from(grouped.values()).sort(
    (a, b) => a.minViewPort[0] - b.minViewPort[0] || a.minViewPort[1] - b.minViewPort[1],
  );
  if (!map.some((breakpoint) => breakpoint.sizes.length > 0)) {
    throw new Error('The size map must contain at least one fixed size or fluid entry across all breakpoints.');
  }
  return map;
}

function parseStoredMap(value: string): FlexibleBreakpoint[] {
  try {
    return normalizeFlexibleMap(JSON.parse(value));
  } catch {
    return [];
  }
}

function toSizeMap(row: SizeMapRow): JsonObject {
  return {
    id: row.id,
    publisherId: row.publisher_id,
    name: row.name,
    map: parseStoredMap(row.map_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateName(name: string): void {
  if (!name) throw new Error('name is required.');
  if (!/^[A-Za-z][A-Za-z0-9_:\-]{0,127}$/.test(name)) {
    throw new Error('name must start with a letter and use letters, numbers, underscore, dash or colon.');
  }
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1').bind(siteId).first<{ id: string }>();
  return Boolean(row);
}

async function fetchSizeMap(db: D1Database, siteId: string, sizeMapId: string): Promise<JsonObject | null> {
  const row = await db
    .prepare(`SELECT id, publisher_id, name, map_json, created_at, updated_at
              FROM size_maps WHERE publisher_id = ? AND id = ? LIMIT 1`)
    .bind(siteId, sizeMapId)
    .first<SizeMapRow>();
  return row ? toSizeMap(row) : null;
}

export async function createFlexibleSizeMap(request: Request, env: DatabaseEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiError('Invalid JSON body.');
  }

  const name = String(body.name ?? '').trim();
  let map: FlexibleBreakpoint[];
  try {
    validateName(name);
    map = normalizeFlexibleMap(body.map);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid size map.', 422);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const actor = getActor(request);
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO size_maps (id, publisher_id, name, map_json, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(id, siteId, name, JSON.stringify(map), now, now),
      env.DB.prepare(`INSERT INTO audit_log (
          id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
        ) VALUES (?, ?, 'size_map.created', ?, 'size_map', ?, ?, ?)`)
        .bind(crypto.randomUUID(), actor, siteId, id, JSON.stringify({ name, breakpoints: map.length }), now),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return apiError(/unique|constraint/i.test(message) ? `Size map "${name}" already exists on this site.` : 'Size map creation failed.', /unique|constraint/i.test(message) ? 409 : 500, message);
  }

  return json({ ok: true, sizeMap: await fetchSizeMap(env.DB, siteId, id) }, { status: 201 });
}

export async function updateFlexibleSizeMap(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
  sizeMapId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const existingRow = await env.DB
    .prepare('SELECT id, name, map_json FROM size_maps WHERE publisher_id = ? AND id = ? LIMIT 1')
    .bind(siteId, sizeMapId)
    .first<{ id: string; name: string; map_json: string }>();
  if (!existingRow) return apiError('Size map not found.', 404);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiError('Invalid JSON body.');
  }

  const name = body.name === undefined ? existingRow.name : String(body.name ?? '').trim();
  let map: FlexibleBreakpoint[];
  try {
    validateName(name);
    map = body.map === undefined ? normalizeFlexibleMap(JSON.parse(existingRow.map_json)) : normalizeFlexibleMap(body.map);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid size map.', 422);
  }

  const now = new Date().toISOString();
  const actor = getActor(request);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE size_maps SET name = ?, map_json = ?, updated_at = ?
                    WHERE publisher_id = ? AND id = ?`)
      .bind(name, JSON.stringify(map), now, siteId, sizeMapId),
  ];
  if (name !== existingRow.name) {
    statements.push(
      env.DB.prepare(`UPDATE ad_units SET size_map_key = ?, updated_at = ?
                      WHERE publisher_id = ? AND size_map_key = ?`)
        .bind(name, now, siteId, existingRow.name),
    );
  }
  statements.push(
    env.DB.prepare(`INSERT INTO audit_log (
        id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
      ) VALUES (?, ?, 'size_map.updated', ?, 'size_map', ?, ?, ?)`)
      .bind(
        crypto.randomUUID(),
        actor,
        siteId,
        sizeMapId,
        JSON.stringify({ previousName: existingRow.name, name, breakpoints: map.length }),
        now,
      ),
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return apiError(/unique|constraint/i.test(message) ? `Size map "${name}" already exists on this site.` : 'Size map update failed.', /unique|constraint/i.test(message) ? 409 : 500, message);
  }

  return json({ ok: true, sizeMap: await fetchSizeMap(env.DB, siteId, sizeMapId) });
}

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }
  row.push(field);
  rows.push(row);
  return rows.filter((item) => item.some((entry) => entry.trim() !== ''));
}

function parseCsvRecords(csv: string): { headers: string[]; rows: ParsedCsvRow[] } {
  const matrix = parseCsv(String(csv ?? '').trim());
  if (matrix.length < 2) throw new Error('CSV must contain a header row and at least one data row.');
  const headers = matrix[0].map(normalizeHeader);
  if (headers.some((header) => !header)) throw new Error('CSV contains an empty column name.');
  if (new Set(headers).size !== headers.length) throw new Error('CSV contains duplicate column names.');
  const rows = matrix.slice(1).map((cells, index) => {
    const values: Record<string, string> = {};
    headers.forEach((header, columnIndex) => { values[header] = String(cells[columnIndex] ?? '').trim(); });
    return { rowNumber: index + 2, values };
  });
  if (rows.length > MAX_DATA_ROWS) throw new Error(`CSV imports are limited to ${MAX_DATA_ROWS} data rows per upload.`);
  return { headers, rows };
}

function value(row: ParsedCsvRow, ...aliases: string[]): string {
  for (const alias of aliases) {
    const key = normalizeHeader(alias);
    if (key in row.values) return row.values[key];
  }
  return '';
}

function parseInteger(raw: string, fallback = 0): number {
  if (!raw.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`Expected an integer, received "${raw}".`);
  return parsed;
}

function parseCsvSizes(raw: string): FlexibleSize[] {
  const normalizedWhole = raw.trim().toLowerCase();
  if (EMPTY_SIZE_TOKENS.has(normalizedWhole)) return [];
  const tokens = raw.split(/[|;]/).map((item) => item.trim()).filter(Boolean);
  const sizes: FlexibleSize[] = tokens.map((token) => {
    if (token.toLowerCase() === 'fluid') return 'fluid';
    const match = token.match(/^(\d+)\s*x\s*(\d+)$/i);
    if (!match) throw new Error(`Invalid size "${token}". Use 970x250, fluid, or leave the cell empty.`);
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) throw new Error(`Invalid size "${token}".`);
    return [width, height] as FixedSize;
  });
  return Array.from(new Map(sizes.map((size) => [sizeKey(size), size])).values());
}

async function buildSizeMapImport(db: D1Database, siteId: string, csv: string): Promise<ImportBuild> {
  const parsed = parseCsvRecords(csv);
  for (const required of ['name', 'minwidth', 'sizes']) {
    if (!parsed.headers.includes(required)) throw new Error(`Missing required CSV column: ${required}.`);
  }
  const existingResult = await db.prepare('SELECT name FROM size_maps WHERE publisher_id = ?').bind(siteId).all<{ name: string }>();
  const existing = new Set((existingResult.results ?? []).map((row) => row.name));

  type Group = {
    firstRow: number;
    breakpoints: Map<string, { minWidth: number; minHeight: number; sizes: FlexibleSize[] }>;
    errors: string[];
  };
  const groups = new Map<string, Group>();

  parsed.rows.forEach((row) => {
    const name = value(row, 'name', 'sizeMap', 'mapName').trim();
    const group = groups.get(name) ?? { firstRow: row.rowNumber, breakpoints: new Map(), errors: [] };
    if (!name) group.errors.push(`Row ${row.rowNumber}: name is required.`);
    try {
      const minWidth = parseInteger(value(row, 'minWidth', 'viewportWidth'), 0);
      const minHeight = parseInteger(value(row, 'minHeight', 'viewportHeight'), 0);
      if (minWidth < 0 || minHeight < 0) throw new Error('minWidth and minHeight cannot be negative.');
      const sizes = parseCsvSizes(value(row, 'sizes'));
      const key = `${minWidth}x${minHeight}`;
      const previous = group.breakpoints.get(key);
      const merged = previous ? [...previous.sizes, ...sizes] : sizes;
      const unique = Array.from(new Map(merged.map((size) => [sizeKey(size), size])).values());
      group.breakpoints.set(key, { minWidth, minHeight, sizes: unique });
    } catch (error) {
      group.errors.push(`Row ${row.rowNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
    groups.set(name, group);
  });

  const rows: CsvImportPreviewRow[] = [];
  const entities: JsonObject[] = [];
  groups.forEach((group, name) => {
    const map: FlexibleBreakpoint[] = Array.from(group.breakpoints.values())
      .sort((a, b) => a.minWidth - b.minWidth || a.minHeight - b.minHeight)
      .map((breakpoint) => ({ minViewPort: [breakpoint.minWidth, breakpoint.minHeight], sizes: breakpoint.sizes }));
    if (!map.length) group.errors.push('No valid breakpoint rows were found.');
    if (map.length && !map.some((breakpoint) => breakpoint.sizes.length)) {
      group.errors.push('At least one breakpoint must contain a fixed size or fluid.');
    }
    const entryCount = map.reduce((sum, breakpoint) => sum + breakpoint.sizes.length, 0);
    const disabledCount = map.filter((breakpoint) => breakpoint.sizes.length === 0).length;
    const data: JsonObject = { name, map };
    const status = group.errors.length ? 'error' : existing.has(name) ? 'update' : 'create';
    rows.push({
      rowNumber: group.firstRow,
      key: name || '(missing name)',
      status,
      summary: `${map.length} breakpoint(s) · ${entryCount} size entries${disabledCount ? ` · ${disabledCount} disabled` : ''}`,
      errors: group.errors,
      data,
    });
    if (!group.errors.length) entities.push(data);
  });

  const preview: CsvImportPreview = {
    kind: 'size-maps',
    totalRows: rows.length,
    createCount: rows.filter((row) => row.status === 'create').length,
    updateCount: rows.filter((row) => row.status === 'update').length,
    errorCount: rows.filter((row) => row.status === 'error').length,
    rows,
  };
  return { preview, entities };
}

async function readSizeMapInput(request: Request): Promise<CsvImportInput> {
  const input = (await request.json()) as CsvImportInput;
  if (input.kind !== 'size-maps') throw new Error('This compatibility endpoint only handles size-maps imports.');
  if (!String(input.csv ?? '').trim()) throw new Error('CSV content is empty.');
  return input;
}

export async function previewFlexibleSizeMapCsv(request: Request, env: DatabaseEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);
  try {
    const input = await readSizeMapInput(request);
    const build = await buildSizeMapImport(env.DB, siteId, input.csv);
    return json({ ok: true, preview: build.preview });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'CSV preview failed.', 422);
  }
}

export async function applyFlexibleSizeMapCsv(request: Request, env: DatabaseEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  let build: ImportBuild;
  try {
    const input = await readSizeMapInput(request);
    build = await buildSizeMapImport(env.DB, siteId, input.csv);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'CSV import failed.', 422);
  }
  if (build.preview.errorCount) {
    return apiError('CSV contains validation errors. Preview and fix the failing rows first.', 422, build.preview);
  }

  const now = new Date().toISOString();
  const actor = getActor(request);
  const statements: D1PreparedStatement[] = [];
  build.entities.forEach((entity) => {
    statements.push(
      env.DB!.prepare(`INSERT INTO size_maps (id, publisher_id, name, map_json, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT(publisher_id, name) DO UPDATE SET
                         map_json = excluded.map_json,
                         updated_at = excluded.updated_at`)
        .bind(crypto.randomUUID(), siteId, entity.name, JSON.stringify(entity.map), now, now),
    );
  });
  statements.push(
    env.DB.prepare(`INSERT INTO audit_log (
      id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
    ) VALUES (?, ?, 'csv_import.applied', ?, 'csv_import', ?, ?, ?)`)
      .bind(
        crypto.randomUUID(),
        actor,
        siteId,
        crypto.randomUUID(),
        JSON.stringify({ kind: 'size-maps', imported: build.entities.length }),
        now,
      ),
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    return apiError('CSV size-map import could not be applied.', 500, error instanceof Error ? error.message : String(error));
  }

  return json({
    ok: true,
    kind: 'size-maps',
    imported: build.entities.length,
    created: build.preview.createCount,
    updated: build.preview.updateCount,
  });
}
