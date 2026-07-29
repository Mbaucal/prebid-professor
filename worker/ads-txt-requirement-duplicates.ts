import { checkAdsTxt, type AdsTxtEnv } from './ads-txt';
import { ensureAdsTxtRequirementDuplicateSchema } from './ads-txt-requirement-schema';
import { apiError, getActor, json, readJson } from './http';

const MAX_ROWS = 5_000;
const MAX_ENTRY_LENGTH = 2_000;

type RequirementRow = {
  id: string;
  publisher_id: string;
  source_label: string | null;
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
  const clean = value.replace(/^\uFEFF/, '');
  const index = clean.indexOf('#');
  return (index >= 0 ? clean.slice(0, index) : clean).trim();
}

function inlineCommentLabel(value: string): string {
  const clean = value.replace(/^\uFEFF/, '').trim();
  const index = clean.indexOf('#');
  if (index < 0) return '';
  return clean.slice(index + 1).trim().replace(/^#+\s*/, '').slice(0, 120);
}

function parseRequirement(input: RequirementInput, fallback?: RequirementRow): NormalizedRequirement {
  const rawEntryValue = input.entry === undefined ? fallback?.entry ?? '' : String(input.entry ?? '');
  const raw = lineWithoutComment(rawEntryValue);
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
  if (!domain || !domain.includes('.') || /\s/.test(domain)) throw new Error('The advertising-system domain is invalid.');
  if (!sellerId) throw new Error('The seller ID is required.');
  if (!['DIRECT', 'RESELLER'].includes(relationship)) throw new Error('The relationship must be DIRECT or RESELLER.');

  const requestedLabel = input.sourceLabel === undefined
    ? fallback?.source_label ?? ''
    : String(input.sourceLabel ?? '');
  const sourceLabel = requestedLabel.trim()
    || inlineCommentLabel(rawEntryValue)
    || domain;
  if (sourceLabel.length > 120) throw new Error('Source label must be 120 characters or fewer.');

  const display = [domain, sellerId, relationship, certificationId].filter(Boolean).join(', ');
  const canonical = [domain, sellerId.toLowerCase(), relationship.toLowerCase(), certificationId.toLowerCase()]
    .filter(Boolean)
    .join(',');
  return {
    sourceLabel,
    entry: display,
    canonical,
    required: booleanValue(input.required, fallback ? fallback.required === 1 : true),
  };
}

function toRequirement(row: RequirementRow) {
  return {
    id: row.id,
    publisherId: row.publisher_id,
    sourceLabel: row.source_label ?? '',
    entry: row.entry,
    required: row.required === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  return Boolean(await db.prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1').bind(siteId).first());
}

async function rowsForSite(db: D1Database, siteId: string): Promise<RequirementRow[]> {
  const result = await db.prepare(`SELECT id, publisher_id, source_label, entry, required, created_at, updated_at
    FROM ads_txt_requirements
    WHERE publisher_id = ?
    ORDER BY required DESC, source_label COLLATE NOCASE, entry COLLATE NOCASE, created_at, id`).bind(siteId).all<RequirementRow>();
  return result.results ?? [];
}

async function rowById(db: D1Database, siteId: string, id: string): Promise<RequirementRow | null> {
  return db.prepare(`SELECT id, publisher_id, source_label, entry, required, created_at, updated_at
    FROM ads_txt_requirements WHERE publisher_id = ? AND id = ? LIMIT 1`).bind(siteId, id).first<RequirementRow>();
}

function auditStatement(
  db: D1Database,
  actor: string,
  action: string,
  siteId: string,
  entityId: string,
  details: Record<string, unknown>,
  createdAt: string,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO audit_log (
    id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
  ) VALUES (?, ?, ?, ?, 'ads_txt_requirement', ?, ?, ?)`)
    .bind(crypto.randomUUID(), actor, action, siteId, entityId, JSON.stringify(details), createdAt);
}

function duplicateExtraCount(rows: NormalizedRequirement[]): number {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.canonical, (counts.get(row.canonical) ?? 0) + 1);
  return Array.from(counts.values()).reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

function manualRows(body: RequirementInput): NormalizedRequirement[] {
  const baseLabel = String(body.sourceLabel ?? '').trim().replace(/^#+\s*/, '');
  const required = booleanValue(body.required, true);
  let activeLabel = baseLabel;
  const output: NormalizedRequirement[] = [];
  for (const rawLine of String(body.entry ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      activeLabel = line.replace(/^#+\s*/, '').trim() || activeLabel;
      continue;
    }
    output.push(parseRequirement({ sourceLabel: activeLabel, entry: line, required }));
  }
  return output;
}

async function ensureReady(env: AdsTxtEnv, siteId: string): Promise<Response | null> {
  if (!env.DB) return databaseMissing();
  await ensureAdsTxtRequirementDuplicateSchema(env.DB);
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);
  return null;
}

export async function listDuplicateReadyRequirements(env: AdsTxtEnv, siteId: string): Promise<Response> {
  const failure = await ensureReady(env, siteId);
  if (failure) return failure;
  const site = await env.DB!.prepare('SELECT domain, ads_txt_url FROM publishers WHERE id = ? LIMIT 1')
    .bind(siteId).first<{ domain: string; ads_txt_url: string | null }>();
  const rows = await rowsForSite(env.DB!, siteId);
  return json({
    ok: true,
    siteId,
    adsTxtUrl: site?.ads_txt_url || `https://${site?.domain ?? ''}/ads.txt`,
    requirements: rows.map(toRequirement),
  });
}

export async function createDuplicateReadyRequirements(request: Request, env: AdsTxtEnv, siteId: string): Promise<Response> {
  const failure = await ensureReady(env, siteId);
  if (failure) return failure;
  try {
    const body = await readJson<RequirementInput>(request);
    const normalized = manualRows(body);
    if (!normalized.length) normalized.push(parseRequirement(body));
    if (normalized.length > MAX_ROWS) return apiError(`Add at most ${MAX_ROWS.toLocaleString('en-US')} rows at once.`, 422);
    const now = new Date().toISOString();
    const actor = getActor(request);
    const ids = normalized.map(() => crypto.randomUUID());
    const statements: D1PreparedStatement[] = normalized.map((row, index) => env.DB!.prepare(`INSERT INTO ads_txt_requirements (
      id, publisher_id, source_label, entry, required, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(ids[index], siteId, row.sourceLabel, row.entry, row.required ? 1 : 0, now, now));
    statements.push(auditStatement(env.DB!, actor, 'ads_txt_requirements.created', siteId, siteId, {
      created: normalized.length,
      duplicateRowsKept: duplicateExtraCount(normalized),
    }, now));
    await env.DB!.batch(statements);
    const rows = await rowsForSite(env.DB!, siteId);
    return json({
      ok: true,
      created: normalized.length,
      duplicatesKept: duplicateExtraCount(normalized),
      requirement: normalized.length === 1 ? rows.find((row) => row.id === ids[0]) ? toRequirement(rows.find((row) => row.id === ids[0])!) : null : null,
      requirements: rows.map(toRequirement),
    }, { status: 201 });
  } catch (error) {
    return apiError('Ads.txt requirement could not be created.', 422, error instanceof Error ? error.message : String(error));
  }
}

export async function updateDuplicateReadyRequirement(
  request: Request,
  env: AdsTxtEnv,
  siteId: string,
  requirementId: string,
): Promise<Response> {
  const failure = await ensureReady(env, siteId);
  if (failure) return failure;
  const current = await rowById(env.DB!, siteId, requirementId);
  if (!current) return apiError('Ads.txt requirement not found.', 404);
  try {
    const normalized = parseRequirement(await readJson<RequirementInput>(request), current);
    const now = new Date().toISOString();
    await env.DB!.batch([
      env.DB!.prepare(`UPDATE ads_txt_requirements
        SET source_label = ?, entry = ?, required = ?, updated_at = ?
        WHERE publisher_id = ? AND id = ?`)
        .bind(normalized.sourceLabel, normalized.entry, normalized.required ? 1 : 0, now, siteId, requirementId),
      auditStatement(env.DB!, getActor(request), 'ads_txt_requirement.updated', siteId, requirementId, {
        before: toRequirement(current),
        after: normalized,
      }, now),
    ]);
    const row = await rowById(env.DB!, siteId, requirementId);
    return json({ ok: true, requirement: row ? toRequirement(row) : null });
  } catch (error) {
    return apiError('Ads.txt requirement could not be updated.', 422, error instanceof Error ? error.message : String(error));
  }
}

export async function deleteDuplicateReadyRequirement(
  request: Request,
  env: AdsTxtEnv,
  siteId: string,
  requirementId: string,
): Promise<Response> {
  const failure = await ensureReady(env, siteId);
  if (failure) return failure;
  const current = await rowById(env.DB!, siteId, requirementId);
  if (!current) return apiError('Ads.txt requirement not found.', 404);
  const now = new Date().toISOString();
  await env.DB!.batch([
    env.DB!.prepare('DELETE FROM ads_txt_requirements WHERE publisher_id = ? AND id = ?').bind(siteId, requirementId),
    auditStatement(env.DB!, getActor(request), 'ads_txt_requirement.deleted', siteId, requirementId, {
      requirement: toRequirement(current),
    }, now),
  ]);
  return json({ ok: true, deletedId: requirementId });
}

export async function importDuplicateReadyRequirements(request: Request, env: AdsTxtEnv, siteId: string): Promise<Response> {
  const failure = await ensureReady(env, siteId);
  if (failure) return failure;
  try {
    const body = await readJson<{ rows?: unknown; replaceExisting?: unknown }>(request);
    if (!Array.isArray(body.rows) || !body.rows.length) return apiError('The import does not contain any rows.', 422);
    if (body.rows.length > MAX_ROWS) return apiError(`Import at most ${MAX_ROWS.toLocaleString('en-US')} rows at once.`, 422);
    const normalized = body.rows.map((value) => parseRequirement(
      value && typeof value === 'object' && !Array.isArray(value) ? value as RequirementInput : { entry: value },
    ));
    const replaceExisting = booleanValue(body.replaceExisting, false);
    const now = new Date().toISOString();
    const actor = getActor(request);
    const statements: D1PreparedStatement[] = [];
    if (replaceExisting) statements.push(env.DB!.prepare('DELETE FROM ads_txt_requirements WHERE publisher_id = ?').bind(siteId));
    for (const row of normalized) {
      statements.push(env.DB!.prepare(`INSERT INTO ads_txt_requirements (
        id, publisher_id, source_label, entry, required, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), siteId, row.sourceLabel, row.entry, row.required ? 1 : 0, now, now));
    }
    const duplicatesKept = duplicateExtraCount(normalized);
    statements.push(auditStatement(env.DB!, actor, 'ads_txt_requirements.imported', siteId, siteId, {
      imported: normalized.length,
      skipped: 0,
      duplicatesKept,
      replaceExisting,
      inputRows: body.rows.length,
    }, now));
    await env.DB!.batch(statements);
    const rows = await rowsForSite(env.DB!, siteId);
    return json({
      ok: true,
      imported: normalized.length,
      skipped: 0,
      duplicatesKept,
      replaced: replaceExisting,
      requirements: rows.map(toRequirement),
    });
  } catch (error) {
    return apiError('Ads.txt requirements could not be imported.', 422, error instanceof Error ? error.message : String(error));
  }
}

export async function copyDuplicateReadyRequirements(request: Request, env: AdsTxtEnv, siteId: string): Promise<Response> {
  const failure = await ensureReady(env, siteId);
  if (failure) return failure;
  try {
    const body = await readJson<{ sourceSiteId?: unknown; replaceExisting?: unknown }>(request);
    const sourceSiteId = String(body.sourceSiteId ?? '').trim();
    if (!sourceSiteId || sourceSiteId === siteId) return apiError('Choose a different source site.', 422);
    if (!(await siteExists(env.DB!, sourceSiteId))) return apiError('Source site not found.', 404);
    const sourceRows = await rowsForSite(env.DB!, sourceSiteId);
    if (!sourceRows.length) return apiError('The source site has no saved ads.txt requirements.', 422);
    if (sourceRows.length > MAX_ROWS) return apiError(`Copy at most ${MAX_ROWS.toLocaleString('en-US')} rows at once.`, 422);
    const replaceExisting = booleanValue(body.replaceExisting, false);
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    if (replaceExisting) statements.push(env.DB!.prepare('DELETE FROM ads_txt_requirements WHERE publisher_id = ?').bind(siteId));
    for (const row of sourceRows) {
      statements.push(env.DB!.prepare(`INSERT INTO ads_txt_requirements (
        id, publisher_id, source_label, entry, required, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), siteId, row.source_label, row.entry, row.required, now, now));
    }
    const normalized = sourceRows.map((row) => parseRequirement({ sourceLabel: row.source_label, entry: row.entry, required: row.required === 1 }));
    const duplicatesKept = duplicateExtraCount(normalized);
    statements.push(auditStatement(env.DB!, getActor(request), 'ads_txt_requirements.copied', siteId, siteId, {
      sourceSiteId,
      copied: sourceRows.length,
      skipped: 0,
      duplicatesKept,
      replaceExisting,
    }, now));
    await env.DB!.batch(statements);
    const rows = await rowsForSite(env.DB!, siteId);
    return json({
      ok: true,
      copied: sourceRows.length,
      skipped: 0,
      duplicatesKept,
      replaced: replaceExisting,
      requirements: rows.map(toRequirement),
    });
  } catch (error) {
    return apiError('Ads.txt requirements could not be copied.', 422, error instanceof Error ? error.message : String(error));
  }
}

function canonicalKey(entry: unknown): string {
  try {
    return parseRequirement({ entry, sourceLabel: 'canonical' }).canonical;
  } catch {
    return String(entry ?? '').trim().toLowerCase();
  }
}

function uniqueByCanonical<T extends { entry?: unknown }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = canonicalKey(item.entry);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function checkDuplicateReadyRequirements(request: Request, env: AdsTxtEnv, siteId: string): Promise<Response> {
  const failure = await ensureReady(env, siteId);
  if (failure) return failure;
  const response = await checkAdsTxt(request, env, siteId);
  try {
    const payload = await response.clone().json() as {
      ok?: boolean;
      check?: {
        missing?: Array<{ entry?: unknown }>;
        optionalMissing?: Array<{ entry?: unknown }>;
        requiredMissingCount?: number;
        optionalMissingCount?: number;
      };
    };
    if (payload.check) {
      const missing = uniqueByCanonical(payload.check.missing ?? []);
      const optionalMissing = uniqueByCanonical(payload.check.optionalMissing ?? []);
      payload.check.missing = missing;
      payload.check.optionalMissing = optionalMissing;
      payload.check.requiredMissingCount = missing.length;
      payload.check.optionalMissingCount = optionalMissing.length;
    }
    return json(payload, { status: response.status });
  } catch {
    return response;
  }
}
