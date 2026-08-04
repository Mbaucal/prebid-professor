import { checkAdsTxt, type AdsTxtEnv } from './ads-txt';
import { apiError, getActor, json, readJson } from './http';

export const MAX_ADS_TXT_SOURCE_ROWS = 5_000;

const MAX_ENTRY_LENGTH = 2_000;
const MAX_SOURCE_LABEL_LENGTH = 120;
const MAX_ROWS_PER_CHUNK = 750;
const MAX_JSON_CHUNK_BYTES = 1_250_000;
const SOURCE_CLAIM_TTL_MS = 2 * 60 * 1000;

type SourceRow = {
  id: string;
  publisher_id: string;
  source_label: string;
  entry: string;
  monitor_entry: string;
  canonical_entry: string;
  required: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type SourceInput = {
  sourceLabel?: unknown;
  entry?: unknown;
  required?: unknown;
};

type NormalizedSource = {
  sourceLabel: string;
  entry: string;
  monitorEntry: string;
  canonicalEntry: string;
  required: boolean;
};

type StoredSource = NormalizedSource & {
  id: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type OriginalCheckPayload = {
  ok?: boolean;
  check?: Record<string, unknown> & {
    status?: string;
    results?: Array<Record<string, unknown> & { entry?: string; found?: boolean }>;
  };
  error?: string;
  details?: unknown;
};

let tablesReady: Promise<void> | null = null;

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function booleanValue(value: unknown, fallback = true): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'no', 'optional'].includes(normalized)) return false;
    if (['true', '1', 'yes', 'required'].includes(normalized)) return true;
  }
  return fallback;
}

function cleanLabel(value: unknown): string {
  return String(value ?? '').trim().replace(/^#+\s*/, '').trim();
}

function parseSource(value: unknown, requestedLabel: unknown, required: unknown): NormalizedSource {
  const raw = String(value ?? '').replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('A complete ads.txt entry is required.');
  if (raw.length > MAX_ENTRY_LENGTH) {
    throw new Error(`An ads.txt entry must be ${MAX_ENTRY_LENGTH} characters or fewer.`);
  }

  const commentIndex = raw.indexOf('#');
  const recordText = (commentIndex >= 0 ? raw.slice(0, commentIndex) : raw).trim();
  const inlineComment = (commentIndex >= 0 ? raw.slice(commentIndex + 1) : '').trim();
  if (!recordText) throw new Error('A complete ads.txt entry is required.');

  const fields = recordText.split(',').map((field) => field.trim());
  if (fields.length < 3 || fields.length > 4) {
    throw new Error('Use the ads.txt format: advertising-system.com, seller-id, DIRECT|RESELLER, certification-id.');
  }

  const [rawDomain, rawSellerId, rawRelationship, rawCertificationId = ''] = fields;
  const domain = rawDomain.toLowerCase();
  const sellerId = rawSellerId.trim();
  const relationship = rawRelationship.toUpperCase();
  const certificationId = rawCertificationId.trim();

  if (!domain || !domain.includes('.') || /\s/.test(domain)) {
    throw new Error('The advertising-system domain is invalid.');
  }
  if (!sellerId) throw new Error('The seller ID is required.');
  if (!['DIRECT', 'RESELLER'].includes(relationship)) {
    throw new Error('The relationship must be DIRECT or RESELLER.');
  }

  const displayFields = [domain, sellerId, relationship];
  if (certificationId) displayFields.push(certificationId);
  const monitorEntry = displayFields.join(', ');
  const canonicalFields = [domain, sellerId.toLowerCase(), relationship.toLowerCase()];
  if (certificationId) canonicalFields.push(certificationId.toLowerCase());
  const canonicalEntry = canonicalFields.join(',');
  const sourceLabel = cleanLabel(requestedLabel) || cleanLabel(inlineComment) || domain;

  if (!sourceLabel) throw new Error('Source label is required.');
  if (sourceLabel.length > MAX_SOURCE_LABEL_LENGTH) {
    throw new Error(`Source label must be ${MAX_SOURCE_LABEL_LENGTH} characters or fewer.`);
  }

  return {
    sourceLabel,
    entry: inlineComment ? `${monitorEntry} #${inlineComment}` : monitorEntry,
    monitorEntry,
    canonicalEntry,
    required: booleanValue(required, true),
  };
}

function normalizeInput(value: unknown, fallback?: SourceRow): NormalizedSource {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as SourceInput
    : { entry: value };
  return parseSource(
    input.entry === undefined ? fallback?.entry : input.entry,
    input.sourceLabel === undefined ? fallback?.source_label : input.sourceLabel,
    input.required === undefined ? fallback ? fallback.required === 1 : true : input.required,
  );
}

function toPublicSource(row: SourceRow) {
  return {
    id: row.id,
    publisherId: row.publisher_id,
    sourceLabel: row.source_label,
    entry: row.entry,
    required: row.required === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storedSource(row: SourceRow): NormalizedSource {
  return {
    sourceLabel: row.source_label,
    entry: row.entry,
    monitorEntry: row.monitor_entry,
    canonicalEntry: row.canonical_entry,
    required: row.required === 1,
  };
}

async function ensureTables(db: D1Database): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_requirement_sources (
          id TEXT PRIMARY KEY,
          publisher_id TEXT NOT NULL,
          source_label TEXT NOT NULL,
          entry TEXT NOT NULL,
          monitor_entry TEXT NOT NULL,
          canonical_entry TEXT NOT NULL,
          required INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_requirement_source_claims (
          publisher_id TEXT PRIMARY KEY,
          token TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_requirement_source_assertions (
          id TEXT PRIMARY KEY,
          valid INTEGER NOT NULL CHECK (valid = 1)
        )`),
      ]);

      await db.batch([
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_ads_txt_sources_publisher
          ON ads_txt_requirement_sources(publisher_id, sort_order, created_at, id)`),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_ads_txt_sources_canonical
          ON ads_txt_requirement_sources(publisher_id, canonical_entry)`),
        db.prepare(`INSERT OR IGNORE INTO ads_txt_requirement_sources (
            id, publisher_id, source_label, entry, monitor_entry, canonical_entry,
            required, sort_order, created_at, updated_at
          )
          SELECT
            id,
            publisher_id,
            COALESCE(NULLIF(TRIM(source_label), ''),
              TRIM(SUBSTR(entry, 1, INSTR(entry || ',', ',') - 1))),
            TRIM(entry),
            TRIM(CASE
              WHEN INSTR(entry, '#') > 0 THEN SUBSTR(entry, 1, INSTR(entry, '#') - 1)
              ELSE entry
            END),
            LOWER(REPLACE(TRIM(CASE
              WHEN INSTR(entry, '#') > 0 THEN SUBSTR(entry, 1, INSTR(entry, '#') - 1)
              ELSE entry
            END), ' ', '')),
            required,
            ROW_NUMBER() OVER (
              PARTITION BY publisher_id
              ORDER BY required DESC, source_label COLLATE NOCASE, entry COLLATE NOCASE, id
            ) - 1,
            created_at,
            updated_at
          FROM ads_txt_requirements`),
      ]);
    })().catch((error) => {
      tablesReady = null;
      throw error;
    });
  }
  await tablesReady;
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1')
    .bind(siteId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function ready(env: AdsTxtEnv, siteId: string): Promise<D1Database | Response> {
  if (!env.DB) return databaseMissing();
  await ensureTables(env.DB);
  if (!await siteExists(env.DB, siteId)) return apiError('Site not found.', 404);
  return env.DB;
}

async function sourceRows(db: D1Database, siteId: string): Promise<SourceRow[]> {
  const result = await db.prepare(`SELECT
      id, publisher_id, source_label, entry, monitor_entry, canonical_entry,
      required, sort_order, created_at, updated_at
    FROM ads_txt_requirement_sources
    WHERE publisher_id = ?
    ORDER BY sort_order, created_at, id`)
    .bind(siteId)
    .all<SourceRow>();
  return result.results ?? [];
}

async function sourceRow(db: D1Database, siteId: string, sourceId: string): Promise<SourceRow | null> {
  return db.prepare(`SELECT
      id, publisher_id, source_label, entry, monitor_entry, canonical_entry,
      required, sort_order, created_at, updated_at
    FROM ads_txt_requirement_sources
    WHERE publisher_id = ? AND id = ?
    LIMIT 1`)
    .bind(siteId, sourceId)
    .first<SourceRow>();
}

async function nextSortOrder(db: D1Database, siteId: string): Promise<number> {
  const row = await db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
    FROM ads_txt_requirement_sources WHERE publisher_id = ?`)
    .bind(siteId)
    .first<{ next_order: number }>();
  return Number(row?.next_order ?? 0);
}

async function acquireClaim(db: D1Database, siteId: string): Promise<string | null> {
  const token = crypto.randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + SOURCE_CLAIM_TTL_MS).toISOString();

  await db.prepare(`INSERT INTO ads_txt_requirement_source_claims (
      publisher_id, token, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(publisher_id) DO UPDATE SET
      token = excluded.token,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
    WHERE ads_txt_requirement_source_claims.expires_at <= excluded.created_at`)
    .bind(siteId, token, expiresAt, nowIso, nowIso)
    .run();

  const row = await db.prepare(
    'SELECT token FROM ads_txt_requirement_source_claims WHERE publisher_id = ? LIMIT 1',
  ).bind(siteId).first<{ token: string }>();
  return row?.token === token ? token : null;
}

async function releaseClaim(db: D1Database, siteId: string, token: string): Promise<void> {
  await db.prepare(
    'DELETE FROM ads_txt_requirement_source_claims WHERE publisher_id = ? AND token = ?',
  ).bind(siteId, token).run();
}

function claimExistsSql(alias = 'c'): string {
  return `EXISTS (
    SELECT 1 FROM ads_txt_requirement_source_claims ${alias}
    WHERE ${alias}.publisher_id = ?
      AND ${alias}.token = ?
      AND ${alias}.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )`;
}

function claimAssertionStatement(
  db: D1Database,
  siteId: string,
  claimToken: string,
  assertionId: string,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO ads_txt_requirement_source_assertions (id, valid)
    SELECT ?, CASE WHEN ${claimExistsSql()} THEN 1 ELSE 0 END`)
    .bind(assertionId, siteId, claimToken);
}

function cleanupAssertionsStatement(
  db: D1Database,
  assertionIds: string[],
): D1PreparedStatement {
  const placeholders = assertionIds.map(() => '?').join(', ');
  return db.prepare(`DELETE FROM ads_txt_requirement_source_assertions
    WHERE id IN (${placeholders})`)
    .bind(...assertionIds);
}

function auditStatement(
  db: D1Database,
  actor: string,
  action: string,
  siteId: string,
  entityId: string,
  details: Record<string, unknown>,
  createdAt: string,
  claimToken: string,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO audit_log (
      id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
    )
    SELECT ?, ?, ?, ?, 'ads_txt_requirement_source', ?, ?, ?
    WHERE ${claimExistsSql()}`)
    .bind(
      crypto.randomUUID(), actor, action, siteId, entityId,
      JSON.stringify(details), createdAt, siteId, claimToken,
    );
}

function reconcileStatements(
  db: D1Database,
  siteId: string,
  claimToken: string,
  updatedAt: string,
): D1PreparedStatement[] {
  return [
    db.prepare(`DELETE FROM ads_txt_requirements
      WHERE publisher_id = ? AND ${claimExistsSql()}`)
      .bind(siteId, siteId, claimToken),
    db.prepare(`INSERT INTO ads_txt_requirements (
        id, publisher_id, source_label, entry, required, created_at, updated_at
      )
      SELECT id, publisher_id, source_label, monitor_entry, canonical_required, created_at, ?
      FROM (
        SELECT
          source.*,
          MAX(required) OVER (
            PARTITION BY publisher_id, canonical_entry
          ) AS canonical_required,
          ROW_NUMBER() OVER (
            PARTITION BY publisher_id, canonical_entry
            ORDER BY required DESC, sort_order, created_at, id
          ) AS canonical_rank
        FROM ads_txt_requirement_sources source
        WHERE publisher_id = ? AND ${claimExistsSql('claim')}
      )
      WHERE canonical_rank = 1`)
      .bind(updatedAt, siteId, siteId, claimToken),
  ];
}

function chunkStoredRows(rows: StoredSource[]): StoredSource[][] {
  const encoder = new TextEncoder();
  const chunks: StoredSource[][] = [];
  let current: StoredSource[] = [];
  let bytes = 2;

  for (const row of rows) {
    const rowBytes = encoder.encode(JSON.stringify(row)).byteLength + (current.length ? 1 : 0);
    if (rowBytes + 2 > MAX_JSON_CHUNK_BYTES) {
      throw new Error('One ads.txt source row is too large to store safely.');
    }
    if (current.length >= MAX_ROWS_PER_CHUNK || bytes + rowBytes > MAX_JSON_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 2;
    }
    current.push(row);
    bytes += rowBytes;
  }

  if (current.length) chunks.push(current);
  return chunks;
}

function bulkInsertStatement(
  db: D1Database,
  siteId: string,
  rows: StoredSource[],
  claimToken: string,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO ads_txt_requirement_sources (
      id, publisher_id, source_label, entry, monitor_entry, canonical_entry,
      required, sort_order, created_at, updated_at
    )
    SELECT
      json_extract(value, '$.id'),
      ?,
      json_extract(value, '$.sourceLabel'),
      json_extract(value, '$.entry'),
      json_extract(value, '$.monitorEntry'),
      json_extract(value, '$.canonicalEntry'),
      CAST(json_extract(value, '$.required') AS INTEGER),
      CAST(json_extract(value, '$.sortOrder') AS INTEGER),
      json_extract(value, '$.createdAt'),
      json_extract(value, '$.updatedAt')
    FROM json_each(?)
    WHERE ${claimExistsSql()}`)
    .bind(siteId, JSON.stringify(rows), siteId, claimToken);
}

function normalizeRows(rows: unknown[]): { rows: NormalizedSource[]; errors: string[] } {
  const normalized: NormalizedSource[] = [];
  const errors: string[] = [];
  rows.forEach((value, index) => {
    try {
      normalized.push(normalizeInput(value));
    } catch (error) {
      errors.push(`Row ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { rows: normalized, errors };
}

function manualRows(body: SourceInput): SourceInput[] {
  const required = booleanValue(body.required, true);
  const baseLabel = cleanLabel(body.sourceLabel);
  let activeLabel = baseLabel;
  const rows: SourceInput[] = [];

  for (const rawLine of String(body.entry ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const heading = cleanLabel(line);
      if (heading) activeLabel = heading;
      continue;
    }
    rows.push({ sourceLabel: activeLabel, entry: line, required });
  }
  return rows;
}

async function persistMany(
  db: D1Database,
  siteId: string,
  normalizedRows: NormalizedSource[],
  replaceExisting: boolean,
  actor: string,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  const claimToken = await acquireClaim(db, siteId);
  if (!claimToken) throw new Error('Another ads.txt requirement change is already in progress for this site.');

  try {
    const now = new Date().toISOString();
    const firstSortOrder = replaceExisting ? 0 : await nextSortOrder(db, siteId);
    const storedRows: StoredSource[] = normalizedRows.map((row, index) => ({
      ...row,
      id: crypto.randomUUID(),
      required: row.required,
      sortOrder: firstSortOrder + index,
      createdAt: now,
      updatedAt: now,
    }));
    const startAssertionId = crypto.randomUUID();
    const endAssertionId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      claimAssertionStatement(db, siteId, claimToken, startAssertionId),
    ];
    const insertIndexes: number[] = [];

    if (replaceExisting) {
      statements.push(
        db.prepare(`DELETE FROM ads_txt_requirement_sources
          WHERE publisher_id = ? AND ${claimExistsSql()}`)
          .bind(siteId, siteId, claimToken),
      );
    }
    for (const chunk of chunkStoredRows(storedRows)) {
      insertIndexes.push(statements.length);
      statements.push(bulkInsertStatement(db, siteId, chunk, claimToken));
    }
    statements.push(...reconcileStatements(db, siteId, claimToken, now));
    statements.push(auditStatement(db, actor, action, siteId, siteId, details, now, claimToken));
    statements.push(claimAssertionStatement(db, siteId, claimToken, endAssertionId));
    statements.push(cleanupAssertionsStatement(db, [startAssertionId, endAssertionId]));

    const results = await db.batch(statements);
    const inserted = insertIndexes.reduce(
      (total, index) => total + Number(results[index]?.meta?.changes ?? 0),
      0,
    );
    if (inserted !== storedRows.length) {
      throw new Error('Not all ads.txt requirement rows were saved. Try again.');
    }
  } finally {
    await releaseClaim(db, siteId, claimToken).catch(() => undefined);
  }
}

export async function listAdsTxtRequirementSources(env: AdsTxtEnv, siteId: string): Promise<Response> {
  const db = await ready(env, siteId);
  if (db instanceof Response) return db;
  const site = await db.prepare('SELECT domain, ads_txt_url FROM publishers WHERE id = ? LIMIT 1')
    .bind(siteId)
    .first<{ domain: string; ads_txt_url: string | null }>();
  const rows = await sourceRows(db, siteId);
  return json({
    ok: true,
    siteId,
    adsTxtUrl: site?.ads_txt_url || `https://${site?.domain ?? ''}/ads.txt`,
    requirements: rows.map(toPublicSource),
    requirementRowCount: rows.length,
    canonicalRequirementCount: new Set(rows.map((row) => row.canonical_entry)).size,
  });
}

export async function createAdsTxtRequirementSources(
  request: Request,
  env: AdsTxtEnv,
  siteId: string,
): Promise<Response> {
  const db = await ready(env, siteId);
  if (db instanceof Response) return db;

  let body: SourceInput;
  try {
    body = await readJson<SourceInput>(request);
  } catch (error) {
    return apiError('Ads.txt requirement could not be read.', 400, error instanceof Error ? error.message : String(error));
  }

  const inputRows = manualRows(body);
  if (!inputRows.length) return apiError('Paste at least one valid ads.txt line.', 422);
  if (inputRows.length > MAX_ADS_TXT_SOURCE_ROWS) {
    return apiError(`Add at most ${MAX_ADS_TXT_SOURCE_ROWS.toLocaleString('en-US')} ads.txt entries at once.`, 422);
  }
  const normalized = normalizeRows(inputRows);
  if (normalized.errors.length) {
    return apiError('Ads.txt validation failed.', 422, { errors: normalized.errors });
  }

  try {
    const actor = getActor(request);
    await persistMany(db, siteId, normalized.rows, false, actor, 'ads_txt_requirement_sources.created', {
      added: normalized.rows.length,
      duplicateRowsPreserved: true,
    });
    const rows = await sourceRows(db, siteId);
    return json({
      ok: true,
      added: normalized.rows.length,
      requirements: rows.map(toPublicSource),
    }, { status: 201 });
  } catch (error) {
    return apiError('Ads.txt requirement could not be created.', 422, error instanceof Error ? error.message : String(error));
  }
}

export async function updateAdsTxtRequirementSource(
  request: Request,
  env: AdsTxtEnv,
  siteId: string,
  sourceId: string,
): Promise<Response> {
  const db = await ready(env, siteId);
  if (db instanceof Response) return db;

  let input: SourceInput;
  try {
    input = await readJson<SourceInput>(request);
  } catch (error) {
    return apiError('Ads.txt requirement could not be updated.', 422, error instanceof Error ? error.message : String(error));
  }

  const claimToken = await acquireClaim(db, siteId);
  if (!claimToken) return apiError('Another ads.txt requirement change is already in progress for this site.', 409);
  try {
    const current = await sourceRow(db, siteId, sourceId);
    if (!current) return apiError('Ads.txt requirement not found.', 404);

    let normalized: NormalizedSource;
    try {
      normalized = normalizeInput(input, current);
    } catch (error) {
      return apiError('Ads.txt requirement could not be updated.', 422, error instanceof Error ? error.message : String(error));
    }

    const actor = getActor(request);
    const now = new Date().toISOString();
    const startAssertionId = crypto.randomUUID();
    const endAssertionId = crypto.randomUUID();
    const results = await db.batch([
      claimAssertionStatement(db, siteId, claimToken, startAssertionId),
      db.prepare(`UPDATE ads_txt_requirement_sources
        SET source_label = ?, entry = ?, monitor_entry = ?, canonical_entry = ?,
            required = ?, updated_at = ?
        WHERE publisher_id = ? AND id = ? AND ${claimExistsSql()}`)
        .bind(
          normalized.sourceLabel, normalized.entry, normalized.monitorEntry,
          normalized.canonicalEntry, normalized.required ? 1 : 0, now,
          siteId, sourceId, siteId, claimToken,
        ),
      ...reconcileStatements(db, siteId, claimToken, now),
      auditStatement(db, actor, 'ads_txt_requirement_source.updated', siteId, sourceId, {
        before: toPublicSource(current),
        after: normalized,
      }, now, claimToken),
      claimAssertionStatement(db, siteId, claimToken, endAssertionId),
      cleanupAssertionsStatement(db, [startAssertionId, endAssertionId]),
    ]);
    if (Number(results[1]?.meta?.changes ?? 0) < 1) {
      return apiError('The ads.txt requirement change could not be saved. Try again.', 409);
    }
    const updated = await sourceRow(db, siteId, sourceId);
    return json({ ok: true, requirement: updated ? toPublicSource(updated) : null });
  } catch (error) {
    return apiError('Ads.txt requirement could not be updated.', 409, error instanceof Error ? error.message : String(error));
  } finally {
    await releaseClaim(db, siteId, claimToken).catch(() => undefined);
  }
}

export async function deleteAdsTxtRequirementSource(
  request: Request,
  env: AdsTxtEnv,
  siteId: string,
  sourceId: string,
): Promise<Response> {
  const db = await ready(env, siteId);
  if (db instanceof Response) return db;

  const claimToken = await acquireClaim(db, siteId);
  if (!claimToken) return apiError('Another ads.txt requirement change is already in progress for this site.', 409);
  try {
    const current = await sourceRow(db, siteId, sourceId);
    if (!current) return apiError('Ads.txt requirement not found.', 404);

    const actor = getActor(request);
    const now = new Date().toISOString();
    const startAssertionId = crypto.randomUUID();
    const endAssertionId = crypto.randomUUID();
    const results = await db.batch([
      claimAssertionStatement(db, siteId, claimToken, startAssertionId),
      db.prepare(`DELETE FROM ads_txt_requirement_sources
        WHERE publisher_id = ? AND id = ? AND ${claimExistsSql()}`)
        .bind(siteId, sourceId, siteId, claimToken),
      ...reconcileStatements(db, siteId, claimToken, now),
      auditStatement(db, actor, 'ads_txt_requirement_source.deleted', siteId, sourceId, {
        requirement: toPublicSource(current),
      }, now, claimToken),
      claimAssertionStatement(db, siteId, claimToken, endAssertionId),
      cleanupAssertionsStatement(db, [startAssertionId, endAssertionId]),
    ]);
    if (Number(results[1]?.meta?.changes ?? 0) < 1) {
      return apiError('The ads.txt requirement could not be removed. Try again.', 409);
    }
    return json({ ok: true, deletedId: sourceId });
  } catch (error) {
    return apiError('Ads.txt requirement could not be removed.', 409, error instanceof Error ? error.message : String(error));
  } finally {
    await releaseClaim(db, siteId, claimToken).catch(() => undefined);
  }
}

export async function importAdsTxtRequirementSources(
  request: Request,
  env: AdsTxtEnv,
  siteId: string,
): Promise<Response> {
  const db = await ready(env, siteId);
  if (db instanceof Response) return db;

  try {
    const body = await readJson<{ rows?: unknown; replaceExisting?: unknown }>(request);
    if (!Array.isArray(body.rows)) return apiError('rows must be an array.', 422);
    if (!body.rows.length) return apiError('The import does not contain any rows.', 422);
    if (body.rows.length > MAX_ADS_TXT_SOURCE_ROWS) {
      return apiError(`Import at most ${MAX_ADS_TXT_SOURCE_ROWS.toLocaleString('en-US')} ads.txt rows at once.`, 422);
    }
    const normalized = normalizeRows(body.rows);
    if (normalized.errors.length) {
      return apiError('Ads.txt import validation failed.', 422, { errors: normalized.errors });
    }
    const replaceExisting = booleanValue(body.replaceExisting, false);
    const canonicalCount = new Set(normalized.rows.map((row) => row.canonicalEntry)).size;
    await persistMany(
      db,
      siteId,
      normalized.rows,
      replaceExisting,
      getActor(request),
      'ads_txt_requirement_sources.imported',
      {
        imported: normalized.rows.length,
        canonicalRecords: canonicalCount,
        repeatedRowsPreserved: normalized.rows.length - canonicalCount,
        replaceExisting,
      },
    );
    const rows = await sourceRows(db, siteId);
    return json({
      ok: true,
      imported: normalized.rows.length,
      skipped: 0,
      preservedDuplicates: normalized.rows.length - canonicalCount,
      replaced: replaceExisting,
      requirements: rows.map(toPublicSource),
    });
  } catch (error) {
    return apiError('Ads.txt requirements could not be imported.', 422, error instanceof Error ? error.message : String(error));
  }
}

export async function copyAdsTxtRequirementSources(
  request: Request,
  env: AdsTxtEnv,
  siteId: string,
): Promise<Response> {
  const db = await ready(env, siteId);
  if (db instanceof Response) return db;

  try {
    const body = await readJson<{ sourceSiteId?: unknown; replaceExisting?: unknown }>(request);
    const sourceSiteId = String(body.sourceSiteId ?? '').trim();
    if (!sourceSiteId) return apiError('sourceSiteId is required.', 422);
    if (sourceSiteId === siteId) return apiError('Choose a different source site.', 422);
    if (!await siteExists(db, sourceSiteId)) return apiError('Source site not found.', 404);
    await ensureTables(db);
    const source = await sourceRows(db, sourceSiteId);
    if (!source.length) return apiError('The source site has no saved ads.txt requirements.', 422);
    if (source.length > MAX_ADS_TXT_SOURCE_ROWS) {
      return apiError(`Copy at most ${MAX_ADS_TXT_SOURCE_ROWS.toLocaleString('en-US')} ads.txt rows at once.`, 422);
    }
    const normalized = source.map(storedSource);
    const replaceExisting = booleanValue(body.replaceExisting, false);
    const canonicalCount = new Set(normalized.map((row) => row.canonicalEntry)).size;
    await persistMany(
      db,
      siteId,
      normalized,
      replaceExisting,
      getActor(request),
      'ads_txt_requirement_sources.copied',
      {
        sourceSiteId,
        copied: normalized.length,
        canonicalRecords: canonicalCount,
        repeatedRowsPreserved: normalized.length - canonicalCount,
        replaceExisting,
      },
    );
    const rows = await sourceRows(db, siteId);
    return json({
      ok: true,
      copied: normalized.length,
      skipped: 0,
      preservedDuplicates: normalized.length - canonicalCount,
      replaced: replaceExisting,
      requirements: rows.map(toPublicSource),
    });
  } catch (error) {
    return apiError('Ads.txt requirements could not be copied.', 422, error instanceof Error ? error.message : String(error));
  }
}

export async function copyAdsTxtSourcesForDuplicatedSite(
  env: AdsTxtEnv,
  sourceSiteId: string,
  targetSiteId: string,
  actor: string,
): Promise<void> {
  if (!env.DB) throw new Error('D1 database binding is not configured yet.');
  await ensureTables(env.DB);
  if (!await siteExists(env.DB, sourceSiteId)) throw new Error('Source site not found.');
  if (!await siteExists(env.DB, targetSiteId)) throw new Error('Duplicated target site not found.');

  const source = await sourceRows(env.DB, sourceSiteId);
  const normalized = source.map(storedSource);
  const canonicalCount = new Set(normalized.map((row) => row.canonicalEntry)).size;

  await persistMany(
    env.DB,
    targetSiteId,
    normalized,
    true,
    actor,
    'ads_txt_requirement_sources.site_duplicated',
    {
      sourceSiteId,
      targetSiteId,
      copied: normalized.length,
      canonicalRecords: canonicalCount,
      repeatedRowsPreserved: normalized.length - canonicalCount,
    },
  );
}

export async function checkAdsTxtRequirementSources(
  request: Request,
  env: AdsTxtEnv,
  siteId: string,
): Promise<Response> {
  const db = await ready(env, siteId);
  if (db instanceof Response) return db;
  const rows = await sourceRows(db, siteId);
  const response = await checkAdsTxt(request, env, siteId);
  let payload: OriginalCheckPayload;
  try {
    payload = await response.json() as OriginalCheckPayload;
  } catch {
    return response;
  }
  if (!response.ok || !payload.check) return json(payload, { status: response.status });

  const canonicalFound = new Map<string, boolean>();
  for (const result of payload.check.results ?? []) {
    try {
      const normalized = parseSource(result.entry, '', true);
      canonicalFound.set(normalized.canonicalEntry, Boolean(result.found));
    } catch {
      // Keep malformed legacy rows unchecked.
    }
  }

  const sourceResults = rows.map((row) => ({
    ...toPublicSource(row),
    found: canonicalFound.get(row.canonical_entry) ?? false,
  }));
  const canonicalCount = new Set(rows.map((row) => row.canonical_entry)).size;
  payload.check.results = sourceResults;
  payload.check.requirementRowCount = rows.length;
  payload.check.canonicalRequirementCount = canonicalCount;
  payload.check.savedDuplicateRowCount = rows.length - canonicalCount;
  payload.check.foundRowCount = sourceResults.filter((row) => row.found).length;

  return json(payload, { status: response.status });
}
