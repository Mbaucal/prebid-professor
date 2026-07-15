import type {
  CsvImportInput,
  CsvImportKind,
  CsvImportPreview,
  CsvImportPreviewRow,
  JsonObject,
} from '../src/shared/types';
import { apiError, getActor, json, readJson } from './http';
import type { DatabaseEnv } from './publishers';

type ParsedCsvRow = {
  rowNumber: number;
  values: Record<string, string>;
};

type ImportBuild = {
  preview: CsvImportPreview;
  entities: JsonObject[];
};

const MAX_DATA_ROWS = 250;

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  row.push(field);
  rows.push(row);

  return rows.filter((item) => item.some((value) => value.trim() !== ''));
}

function parseCsvRecords(csv: string): { headers: string[]; rows: ParsedCsvRow[] } {
  const matrix = parseCsv(String(csv ?? '').trim());
  if (matrix.length < 2) throw new Error('CSV must contain a header row and at least one data row.');

  const headers = matrix[0].map(normalizeHeader);
  if (headers.some((header) => !header)) throw new Error('CSV contains an empty column name.');
  if (new Set(headers).size !== headers.length) throw new Error('CSV contains duplicate column names.');

  const rows: ParsedCsvRow[] = matrix.slice(1).map((cells, index) => {
    const values: Record<string, string> = {};
    headers.forEach((header, columnIndex) => {
      values[header] = String(cells[columnIndex] ?? '').trim();
    });
    return { rowNumber: index + 2, values };
  });

  if (rows.length > MAX_DATA_ROWS) {
    throw new Error(`CSV imports are limited to ${MAX_DATA_ROWS} data rows per upload.`);
  }

  return { headers, rows };
}

function value(row: ParsedCsvRow, ...aliases: string[]): string {
  for (const alias of aliases) {
    const normalized = normalizeHeader(alias);
    if (normalized in row.values) return row.values[normalized];
  }
  return '';
}

function requireColumns(headers: string[], groups: string[][]): void {
  const missing = groups.filter(
    (aliases) => !aliases.some((alias) => headers.includes(normalizeHeader(alias))),
  );

  if (missing.length) {
    throw new Error(
      `Missing required CSV column(s): ${missing.map((aliases) => aliases[0]).join(', ')}.`,
    );
  }
}

function parseBoolean(raw: string, defaultValue = true): boolean {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['true', '1', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value "${raw}".`);
}

function parseInteger(raw: string, defaultValue = 0): number {
  if (!raw.trim()) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`Expected an integer, received "${raw}".`);
  return parsed;
}

function parseObject(raw: string, label: string): JsonObject {
  const input = raw.trim() || '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object, not an array or primitive.`);
  }
  return parsed as JsonObject;
}

function parseSizes(raw: string): number[][] {
  const tokens = raw
    .split(/[|;]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!tokens.length) throw new Error('At least one size is required. Use format 970x250|728x90.');

  const seen = new Set<string>();
  const sizes: number[][] = [];
  tokens.forEach((token) => {
    const match = token.match(/^(\d+)\s*x\s*(\d+)$/i);
    if (!match) throw new Error(`Invalid size "${token}". Use format 970x250.`);
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) throw new Error(`Invalid size "${token}".`);
    const key = `${width}x${height}`;
    if (!seen.has(key)) {
      seen.add(key);
      sizes.push([width, height]);
    }
  });
  return sizes;
}

function countPreview(kind: CsvImportKind, rows: CsvImportPreviewRow[]): CsvImportPreview {
  return {
    kind,
    totalRows: rows.length,
    createCount: rows.filter((row) => row.status === 'create').length,
    updateCount: rows.filter((row) => row.status === 'update').length,
    errorCount: rows.filter((row) => row.status === 'error').length,
    rows,
  };
}

async function publisherExists(db: D1Database, publisherId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1')
    .bind(publisherId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function buildAdUnits(db: D1Database, publisherId: string, csv: string): Promise<ImportBuild> {
  const parsed = parseCsvRecords(csv);
  requireColumns(parsed.headers, [['code']]);

  const existingResult = await db
    .prepare('SELECT code FROM ad_units WHERE publisher_id = ?')
    .bind(publisherId)
    .all<{ code: string }>();
  const existing = new Set((existingResult.results ?? []).map((item) => item.code));
  const seen = new Set<string>();
  const previewRows: CsvImportPreviewRow[] = [];
  const entities: JsonObject[] = [];

  parsed.rows.forEach((row) => {
    const errors: string[] = [];
    const code = value(row, 'code', 'adUnit', 'adUnitCode', 'divId').trim();
    const type = (value(row, 'type', 'inventoryGroup') || 'BTF').toUpperCase();
    const mediaType = value(row, 'mediaType', 'media') || 'banner';
    const sizeMapKey = value(row, 'sizeMapKey', 'sizeMap', 'map') || null;
    let enabled = true;
    let sortOrder = 0;

    if (!/^[A-Za-z][A-Za-z0-9_:\-]{0,127}$/.test(code)) {
      errors.push('code must start with a letter and use letters, numbers, underscore, dash or colon.');
    }
    if (!['ATF', 'BTF', 'DRAFT'].includes(type)) errors.push('type must be ATF, BTF or DRAFT.');
    if (seen.has(code)) errors.push(`Duplicate ad unit code "${code}" inside this CSV.`);
    if (code) seen.add(code);

    try {
      enabled = parseBoolean(value(row, 'enabled'), true);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      sortOrder = parseInteger(value(row, 'sortOrder', 'sort'), 0);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    const data: JsonObject = {
      code,
      type,
      mediaType,
      sizeMapKey,
      enabled,
      sortOrder,
      notes: value(row, 'notes') || null,
    };
    const status = errors.length ? 'error' : existing.has(code) ? 'update' : 'create';
    previewRows.push({
      rowNumber: row.rowNumber,
      key: code || '(missing code)',
      status,
      summary: `${type} · ${mediaType} · ${sizeMapKey || 'no size map'}`,
      errors,
      data,
    });
    if (!errors.length) entities.push(data);
  });

  return { preview: countPreview('ad-units', previewRows), entities };
}

async function buildBidders(db: D1Database, publisherId: string, csv: string): Promise<ImportBuild> {
  const parsed = parseCsvRecords(csv);
  requireColumns(parsed.headers, [['bidder']]);

  const existingResult = await db
    .prepare('SELECT bidder FROM bidders WHERE publisher_id = ?')
    .bind(publisherId)
    .all<{ bidder: string }>();
  const existing = new Set((existingResult.results ?? []).map((item) => item.bidder));
  const seen = new Set<string>();
  const previewRows: CsvImportPreviewRow[] = [];
  const entities: JsonObject[] = [];

  parsed.rows.forEach((row) => {
    const errors: string[] = [];
    const bidder = value(row, 'bidder', 'bidderCode').trim().toLowerCase();
    let enabled = true;
    let params: JsonObject = {};

    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(bidder)) {
      errors.push('bidder must use lowercase letters, numbers, underscore or dash.');
    }
    if (seen.has(bidder)) errors.push(`Duplicate bidder "${bidder}" inside this CSV.`);
    if (bidder) seen.add(bidder);

    try {
      enabled = parseBoolean(value(row, 'enabled'), true);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      params = parseObject(value(row, 'paramsJson', 'params', 'json'), 'paramsJson');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    const data: JsonObject = { bidder, params, enabled };
    const status = errors.length ? 'error' : existing.has(bidder) ? 'update' : 'create';
    previewRows.push({
      rowNumber: row.rowNumber,
      key: bidder || '(missing bidder)',
      status,
      summary: `${Object.keys(params).length} base param(s) · ${enabled ? 'enabled' : 'disabled'}`,
      errors,
      data,
    });
    if (!errors.length) entities.push(data);
  });

  return { preview: countPreview('bidders', previewRows), entities };
}

async function buildOverrides(db: D1Database, publisherId: string, csv: string): Promise<ImportBuild> {
  const parsed = parseCsvRecords(csv);
  requireColumns(parsed.headers, [['bidder'], ['scopeType'], ['scopeKey']]);

  const [existingOverridesResult, biddersResult, adUnitsResult] = await Promise.all([
    db
      .prepare('SELECT bidder, scope_type, scope_key FROM bidder_overrides WHERE publisher_id = ?')
      .bind(publisherId)
      .all<{ bidder: string; scope_type: string; scope_key: string }>(),
    db
      .prepare('SELECT bidder FROM bidders WHERE publisher_id = ?')
      .bind(publisherId)
      .all<{ bidder: string }>(),
    db
      .prepare('SELECT code FROM ad_units WHERE publisher_id = ?')
      .bind(publisherId)
      .all<{ code: string }>(),
  ]);

  const existingOverrides = new Set(
    (existingOverridesResult.results ?? []).map(
      (item) => `${item.bidder}|${item.scope_type}|${item.scope_key}`,
    ),
  );
  const existingBidders = new Set((biddersResult.results ?? []).map((item) => item.bidder));
  const adUnits = new Set((adUnitsResult.results ?? []).map((item) => item.code));
  const seen = new Set<string>();
  const previewRows: CsvImportPreviewRow[] = [];
  const entities: JsonObject[] = [];

  parsed.rows.forEach((row) => {
    const errors: string[] = [];
    const bidder = value(row, 'bidder', 'bidderCode').trim().toLowerCase();
    const scopeType = value(row, 'scopeType', 'scope').trim().toLowerCase();
    const scopeKey = value(row, 'scopeKey', 'target', 'adUnit').trim();
    let enabled = true;
    let params: JsonObject = {};

    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(bidder)) {
      errors.push('bidder must use lowercase letters, numbers, underscore or dash.');
    }
    if (!['slot', 'device', 'adunit'].includes(scopeType)) {
      errors.push('scopeType must be slot, device or adunit.');
    }
    if (!scopeKey) errors.push('scopeKey is required.');
    if (scopeType === 'adunit' && scopeKey && !adUnits.has(scopeKey)) {
      errors.push(`Ad unit "${scopeKey}" does not exist. Import ad units first or fix the spelling.`);
    }

    const uniqueKey = `${bidder}|${scopeType}|${scopeKey}`;
    if (seen.has(uniqueKey)) errors.push(`Duplicate override "${uniqueKey}" inside this CSV.`);
    seen.add(uniqueKey);

    try {
      enabled = parseBoolean(value(row, 'enabled'), true);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      params = parseObject(value(row, 'paramsJson', 'params', 'json'), 'paramsJson');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    const data: JsonObject = {
      bidder,
      scopeType,
      scopeKey,
      params,
      enabled,
      createBaseBidder: !existingBidders.has(bidder),
    };
    const status = errors.length
      ? 'error'
      : existingOverrides.has(uniqueKey)
        ? 'update'
        : 'create';
    previewRows.push({
      rowNumber: row.rowNumber,
      key: uniqueKey,
      status,
      summary: `${scopeType} / ${scopeKey}${existingBidders.has(bidder) ? '' : ' · base bidder will be created'}`,
      errors,
      data,
    });
    if (!errors.length) entities.push(data);
  });

  return { preview: countPreview('bidder-overrides', previewRows), entities };
}

async function buildSizeMaps(db: D1Database, publisherId: string, csv: string): Promise<ImportBuild> {
  const parsed = parseCsvRecords(csv);
  requireColumns(parsed.headers, [['name'], ['minWidth'], ['sizes']]);

  const existingResult = await db
    .prepare('SELECT name FROM size_maps WHERE publisher_id = ?')
    .bind(publisherId)
    .all<{ name: string }>();
  const existing = new Set((existingResult.results ?? []).map((item) => item.name));

  type MapGroup = {
    firstRow: number;
    breakpoints: Map<string, { minWidth: number; minHeight: number; sizes: number[][] }>;
    errors: string[];
  };
  const groups = new Map<string, MapGroup>();

  parsed.rows.forEach((row) => {
    const name = value(row, 'name', 'sizeMap', 'mapName').trim();
    const group = groups.get(name) ?? {
      firstRow: row.rowNumber,
      breakpoints: new Map(),
      errors: [],
    };
    if (!name) group.errors.push(`Row ${row.rowNumber}: name is required.`);

    try {
      const minWidth = parseInteger(value(row, 'minWidth', 'viewportWidth'), 0);
      const minHeight = parseInteger(value(row, 'minHeight', 'viewportHeight'), 0);
      if (minWidth < 0 || minHeight < 0) throw new Error('minWidth and minHeight cannot be negative.');
      const sizes = parseSizes(value(row, 'sizes'));
      const key = `${minWidth}x${minHeight}`;
      const previous = group.breakpoints.get(key);
      const merged = previous ? [...previous.sizes, ...sizes] : sizes;
      const unique = Array.from(new Map(merged.map((size) => [`${size[0]}x${size[1]}`, size])).values());
      group.breakpoints.set(key, { minWidth, minHeight, sizes: unique });
    } catch (error) {
      group.errors.push(`Row ${row.rowNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
    groups.set(name, group);
  });

  const previewRows: CsvImportPreviewRow[] = [];
  const entities: JsonObject[] = [];
  groups.forEach((group, name) => {
    const map = Array.from(group.breakpoints.values())
      .sort((a, b) => a.minWidth - b.minWidth || a.minHeight - b.minHeight)
      .map((breakpoint) => ({
        minViewPort: [breakpoint.minWidth, breakpoint.minHeight],
        sizes: breakpoint.sizes,
      }));
    if (!map.length) group.errors.push('No valid breakpoint rows were found.');

    const data: JsonObject = { name, map };
    const status = group.errors.length ? 'error' : existing.has(name) ? 'update' : 'create';
    previewRows.push({
      rowNumber: group.firstRow,
      key: name || '(missing name)',
      status,
      summary: `${map.length} breakpoint(s) · ${map.reduce((sum, item) => sum + item.sizes.length, 0)} size entries`,
      errors: group.errors,
      data,
    });
    if (!group.errors.length) entities.push(data);
  });

  return { preview: countPreview('size-maps', previewRows), entities };
}

async function buildImport(
  db: D1Database,
  publisherId: string,
  input: CsvImportInput,
): Promise<ImportBuild> {
  if (!String(input.csv ?? '').trim()) throw new Error('CSV content is empty.');

  switch (input.kind) {
    case 'ad-units':
      return buildAdUnits(db, publisherId, input.csv);
    case 'bidders':
      return buildBidders(db, publisherId, input.csv);
    case 'bidder-overrides':
      return buildOverrides(db, publisherId, input.csv);
    case 'size-maps':
      return buildSizeMaps(db, publisherId, input.csv);
    default:
      throw new Error('Unsupported import kind.');
  }
}

export async function previewCsvImport(
  request: Request,
  env: DatabaseEnv,
  publisherId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await publisherExists(env.DB, publisherId))) return apiError('Publisher not found.', 404);

  let input: CsvImportInput;
  try {
    input = await readJson<CsvImportInput>(request);
    const build = await buildImport(env.DB, publisherId, input);
    return json({ ok: true, preview: build.preview });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'CSV preview failed.', 422);
  }
}

export async function applyCsvImport(
  request: Request,
  env: DatabaseEnv,
  publisherId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await publisherExists(env.DB, publisherId))) return apiError('Publisher not found.', 404);

  let input: CsvImportInput;
  let build: ImportBuild;
  try {
    input = await readJson<CsvImportInput>(request);
    build = await buildImport(env.DB, publisherId, input);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'CSV import failed.', 422);
  }

  if (build.preview.errorCount) {
    return apiError('CSV contains validation errors. Preview and fix the failing rows first.', 422, build.preview);
  }

  const actor = getActor(request);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  if (input.kind === 'ad-units') {
    build.entities.forEach((entity) => {
      statements.push(
        env.DB!.prepare(
          `INSERT INTO ad_units (
             id, publisher_id, code, type, media_type, size_map_key, enabled, sort_order,
             notes, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(publisher_id, code) DO UPDATE SET
             type = excluded.type,
             media_type = excluded.media_type,
             size_map_key = excluded.size_map_key,
             enabled = excluded.enabled,
             sort_order = excluded.sort_order,
             notes = excluded.notes,
             updated_at = excluded.updated_at`,
        ).bind(
          crypto.randomUUID(),
          publisherId,
          entity.code,
          entity.type,
          entity.mediaType,
          entity.sizeMapKey,
          entity.enabled ? 1 : 0,
          entity.sortOrder,
          entity.notes,
          now,
          now,
        ),
      );
    });
  }

  if (input.kind === 'bidders') {
    build.entities.forEach((entity) => {
      statements.push(
        env.DB!.prepare(
          `INSERT INTO bidders (
             id, publisher_id, bidder, params_json, enabled, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(publisher_id, bidder) DO UPDATE SET
             params_json = excluded.params_json,
             enabled = excluded.enabled,
             updated_at = excluded.updated_at`,
        ).bind(
          crypto.randomUUID(),
          publisherId,
          entity.bidder,
          JSON.stringify(entity.params ?? {}),
          entity.enabled ? 1 : 0,
          now,
          now,
        ),
      );
    });
  }

  if (input.kind === 'bidder-overrides') {
    const bidders = Array.from(new Set(build.entities.map((entity) => String(entity.bidder))));
    bidders.forEach((bidder) => {
      statements.push(
        env.DB!.prepare(
          `INSERT INTO bidders (id, publisher_id, bidder, params_json, enabled, created_at, updated_at)
           VALUES (?, ?, ?, '{}', 1, ?, ?)
           ON CONFLICT(publisher_id, bidder) DO NOTHING`,
        ).bind(crypto.randomUUID(), publisherId, bidder, now, now),
      );
    });
    build.entities.forEach((entity) => {
      statements.push(
        env.DB!.prepare(
          `INSERT INTO bidder_overrides (
             id, publisher_id, bidder, scope_type, scope_key, params_json, enabled, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(publisher_id, bidder, scope_type, scope_key) DO UPDATE SET
             params_json = excluded.params_json,
             enabled = excluded.enabled,
             updated_at = excluded.updated_at`,
        ).bind(
          crypto.randomUUID(),
          publisherId,
          entity.bidder,
          entity.scopeType,
          entity.scopeKey,
          JSON.stringify(entity.params ?? {}),
          entity.enabled ? 1 : 0,
          now,
          now,
        ),
      );
    });
  }

  if (input.kind === 'size-maps') {
    build.entities.forEach((entity) => {
      statements.push(
        env.DB!.prepare(
          `INSERT INTO size_maps (id, publisher_id, name, map_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(publisher_id, name) DO UPDATE SET
             map_json = excluded.map_json,
             updated_at = excluded.updated_at`,
        ).bind(
          crypto.randomUUID(),
          publisherId,
          entity.name,
          JSON.stringify(entity.map ?? []),
          now,
          now,
        ),
      );
    });
  }

  statements.push(
    env.DB.prepare('UPDATE publishers SET updated_at = ? WHERE id = ?').bind(now, publisherId),
    env.DB
      .prepare(
        `INSERT INTO audit_log (
           id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
         ) VALUES (?, ?, 'csv_import.applied', ?, 'csv_import', ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        actor,
        publisherId,
        `${input.kind}:${now}`,
        JSON.stringify({
          kind: input.kind,
          created: build.preview.createCount,
          updated: build.preview.updateCount,
          imported: build.entities.length,
        }),
        now,
      ),
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    return apiError(
      'CSV import could not be applied.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  return json({
    ok: true,
    kind: input.kind,
    imported: build.entities.length,
    created: build.preview.createCount,
    updated: build.preview.updateCount,
  });
}
