import { apiError, getActor, json, readJson } from './http';
import { fetchSite } from './publishers';
import type { AdsTxtEnv } from './ads-txt';

export const MAX_ADS_TXT_BULK_ROWS = 5_000;

const MAX_JSON_CHUNK_BYTES = 1_500_000;
const MAX_ROWS_PER_CHUNK = 1_000;
const MAX_ENTRY_LENGTH = 2_000;

type RequirementRow = {
  id: string;
  publisher_id: string;
  source_label: string;
  entry: string;
  required: number;
  created_at: string;
  updated_at: string;
};

type RequirementInput = {
  sourceLabel?: unknown;
  entry?: unknown;
  required?: unknown;
};

type NormalizedRequirement = {
  sourceLabel: string;
  entry: string;
  canonical: string;
  required: boolean;
};

type StoredBulkRow = {
  id: string;
  sourceLabel: string;
  entry: string;
  required: number;
};

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

function lineWithoutComment(value: string): string {
  const withoutBom = value.replace(/^\uFEFF/, '');
  const commentIndex = withoutBom.indexOf('#');
  return (commentIndex >= 0 ? withoutBom.slice(0, commentIndex) : withoutBom).trim();
}

function normalizeRequirement(value: unknown): NormalizedRequirement {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as RequirementInput
    : { entry: value };
  const raw = lineWithoutComment(String(input.entry ?? ''));
  if (!raw) throw new Error('A complete ads.txt entry is required.');
  if (raw.length > MAX_ENTRY_LENGTH) {
    throw new Error(`An ads.txt entry must be ${MAX_ENTRY_LENGTH} characters or fewer.`);
  }

  const fields = raw.split(',').map((field) => field.trim());
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

  const sourceLabel = String(input.sourceLabel ?? domain).trim().replace(/^#+\s*/, '').trim();
  if (!sourceLabel) throw new Error('Source label is required.');
  if (sourceLabel.length > 120) throw new Error('Source label must be 120 characters or fewer.');

  const displayFields = [domain, sellerId, relationship];
  if (certificationId) displayFields.push(certificationId);
  const canonicalFields = [domain, sellerId.toLowerCase(), relationship.toLowerCase()];
  if (certificationId) canonicalFields.push(certificationId.toLowerCase());

  return {
    sourceLabel,
    entry: displayFields.join(', '),
    canonical: canonicalFields.join(','),
    required: booleanValue(input.required, true),
  };
}

function normalizeRows(rows: unknown[]): { requirements: NormalizedRequirement[]; errors: string[] } {
  const requirements: NormalizedRequirement[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  rows.forEach((value, index) => {
    try {
      const requirement = normalizeRequirement(value);
      if (seen.has(requirement.canonical)) return;
      seen.add(requirement.canonical);
      requirements.push(requirement);
    } catch (error) {
      errors.push(`Row ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return { requirements, errors };
}

function canonicalEntry(entry: string): string | null {
  try {
    return normalizeRequirement({ entry }).canonical;
  } catch {
    return null;
  }
}

function toRequirement(row: RequirementRow) {
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

async function requirementRows(db: D1Database, siteId: string): Promise<RequirementRow[]> {
  const result = await db
    .prepare(
      `SELECT id, publisher_id, source_label, entry, required, created_at, updated_at
       FROM ads_txt_requirements
       WHERE publisher_id = ?
       ORDER BY required DESC, source_label COLLATE NOCASE, entry COLLATE NOCASE`,
    )
    .bind(siteId)
    .all<RequirementRow>();
  return result.results ?? [];
}

function auditStatement(
  db: D1Database,
  actor: string,
  action: string,
  siteId: string,
  details: Record<string, unknown>,
  createdAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (
        id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
      ) VALUES (?, ?, ?, ?, 'ads_txt_requirement', ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), actor, action, siteId, siteId, JSON.stringify(details), createdAt);
}

function chunkRows(rows: StoredBulkRow[]): StoredBulkRow[][] {
  const encoder = new TextEncoder();
  const chunks: StoredBulkRow[][] = [];
  let current: StoredBulkRow[] = [];
  let currentBytes = 2;

  for (const row of rows) {
    const rowBytes = encoder.encode(JSON.stringify(row)).byteLength + (current.length ? 1 : 0);
    if (rowBytes + 2 > MAX_JSON_CHUNK_BYTES) {
      throw new Error('One ads.txt row is too large to store safely.');
    }
    if (current.length >= MAX_ROWS_PER_CHUNK || currentBytes + rowBytes > MAX_JSON_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  }

  if (current.length) chunks.push(current);
  return chunks;
}

function bulkInsertStatement(
  db: D1Database,
  siteId: string,
  rows: StoredBulkRow[],
  createdAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ads_txt_requirements (
        id, publisher_id, source_label, entry, required, created_at, updated_at
      )
      SELECT
        json_extract(value, '$.id'),
        ?,
        json_extract(value, '$.sourceLabel'),
        json_extract(value, '$.entry'),
        CAST(json_extract(value, '$.required') AS INTEGER),
        ?,
        ?
      FROM json_each(?)`,
    )
    .bind(siteId, createdAt, createdAt, JSON.stringify(rows));
}

async function persistRows(
  db: D1Database,
  siteId: string,
  requirements: NormalizedRequirement[],
  replaceExisting: boolean,
  actor: string,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  const storedRows: StoredBulkRow[] = requirements.map((requirement) => ({
    id: crypto.randomUUID(),
    sourceLabel: requirement.sourceLabel,
    entry: requirement.entry,
    required: requirement.required ? 1 : 0,
  }));
  const statements: D1PreparedStatement[] = [];

  if (replaceExisting) {
    statements.push(db.prepare('DELETE FROM ads_txt_requirements WHERE publisher_id = ?').bind(siteId));
  }
  for (const chunk of chunkRows(storedRows)) {
    statements.push(bulkInsertStatement(db, siteId, chunk, now));
  }
  statements.push(auditStatement(db, actor, action, siteId, details, now));

  await db.batch(statements);
}

export async function importAdsTxtRequirementsLarge(
  request: Request,
  env: AdsTxtEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await fetchSite(env.DB, siteId))) return apiError('Site not found.', 404);

  try {
    const body = await readJson<{ rows?: unknown; replaceExisting?: unknown }>(request);
    if (!Array.isArray(body.rows)) return apiError('rows must be an array.', 422);
    if (!body.rows.length) return apiError('The import does not contain any rows.', 422);
    if (body.rows.length > MAX_ADS_TXT_BULK_ROWS) {
      return apiError(`Import at most ${MAX_ADS_TXT_BULK_ROWS.toLocaleString('en-US')} ads.txt rows at once.`, 422);
    }

    const normalized = normalizeRows(body.rows);
    if (normalized.errors.length) {
      return apiError('Ads.txt import validation failed.', 422, { errors: normalized.errors });
    }

    const replaceExisting = booleanValue(body.replaceExisting, false);
    const existingRows = replaceExisting ? [] : await requirementRows(env.DB, siteId);
    const existing = new Set(existingRows.map((row) => canonicalEntry(row.entry)).filter(Boolean));
    const imported = normalized.requirements.filter((requirement) => !existing.has(requirement.canonical));
    const skipped = normalized.requirements.length - imported.length;
    const actor = getActor(request);

    await persistRows(
      env.DB,
      siteId,
      imported,
      replaceExisting,
      actor,
      'ads_txt_requirements.imported',
      { imported: imported.length, skipped, replaceExisting, inputRows: body.rows.length },
    );

    const rows = await requirementRows(env.DB, siteId);
    return json({
      ok: true,
      imported: imported.length,
      skipped,
      replaced: replaceExisting,
      requirements: rows.map(toRequirement),
    });
  } catch (error) {
    return apiError('Ads.txt requirements could not be imported.', 422, error instanceof Error ? error.message : String(error));
  }
}

export async function copyAdsTxtRequirementsLarge(
  request: Request,
  env: AdsTxtEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await fetchSite(env.DB, siteId))) return apiError('Target site not found.', 404);

  try {
    const body = await readJson<{ sourceSiteId?: unknown; replaceExisting?: unknown }>(request);
    const sourceSiteId = String(body.sourceSiteId ?? '').trim();
    if (!sourceSiteId) return apiError('sourceSiteId is required.', 422);
    if (sourceSiteId === siteId) return apiError('Choose a different source site.', 422);
    if (!(await fetchSite(env.DB, sourceSiteId))) return apiError('Source site not found.', 404);

    const sourceRows = await requirementRows(env.DB, sourceSiteId);
    if (!sourceRows.length) return apiError('The source site has no saved ads.txt requirements.', 422);
    if (sourceRows.length > MAX_ADS_TXT_BULK_ROWS) {
      return apiError(`Copy at most ${MAX_ADS_TXT_BULK_ROWS.toLocaleString('en-US')} ads.txt rows at once.`, 422);
    }

    const normalized = normalizeRows(
      sourceRows.map((row) => ({
        sourceLabel: row.source_label,
        entry: row.entry,
        required: row.required === 1,
      })),
    );
    if (normalized.errors.length) {
      return apiError('Source ads.txt requirements contain invalid entries.', 422, { errors: normalized.errors });
    }

    const replaceExisting = booleanValue(body.replaceExisting, false);
    const existingRows = replaceExisting ? [] : await requirementRows(env.DB, siteId);
    const existing = new Set(existingRows.map((row) => canonicalEntry(row.entry)).filter(Boolean));
    const copied = normalized.requirements.filter((requirement) => !existing.has(requirement.canonical));
    const skipped = normalized.requirements.length - copied.length;
    const actor = getActor(request);

    await persistRows(
      env.DB,
      siteId,
      copied,
      replaceExisting,
      actor,
      'ads_txt_requirements.copied',
      { sourceSiteId, copied: copied.length, skipped, replaceExisting },
    );

    const rows = await requirementRows(env.DB, siteId);
    return json({
      ok: true,
      copied: copied.length,
      skipped,
      replaced: replaceExisting,
      requirements: rows.map(toRequirement),
    });
  } catch (error) {
    return apiError('Ads.txt requirements could not be copied.', 422, error instanceof Error ? error.message : String(error));
  }
}
