import { apiError, getActor, json, readJson } from './http';
import type { DatabaseEnv } from './publishers';

export interface AdsTxtEnv extends DatabaseEnv {}

type SiteRow = {
  id: string;
  domain: string;
  ads_txt_url: string | null;
};

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

type NormalizedEntry = {
  display: string;
  canonical: string;
  sourceDomain: string;
};

type NormalizedRequirement = {
  sourceLabel: string;
  entry: string;
  canonical: string;
  required: boolean;
};

const MAX_REQUIREMENTS_PER_IMPORT = 100;
const MAX_ADS_TXT_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
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

function parseAdsEntry(value: unknown): NormalizedEntry {
  const raw = lineWithoutComment(String(value ?? ''));
  if (!raw) throw new Error('A complete ads.txt entry is required.');

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

  const displayFields = [domain, sellerId, relationship];
  if (certificationId) displayFields.push(certificationId);
  const canonicalFields = [domain, sellerId.toLowerCase(), relationship.toLowerCase()];
  if (certificationId) canonicalFields.push(certificationId.toLowerCase());

  return {
    display: displayFields.join(', '),
    canonical: canonicalFields.join(','),
    sourceDomain: domain,
  };
}

function normalizeRequirement(input: RequirementInput, fallback?: RequirementRow): NormalizedRequirement {
  const parsed = parseAdsEntry(input.entry === undefined ? fallback?.entry : input.entry);
  const sourceLabel = String(
    input.sourceLabel === undefined ? fallback?.source_label ?? parsed.sourceDomain : input.sourceLabel,
  ).trim();

  if (!sourceLabel) throw new Error('Source label is required.');
  if (sourceLabel.length > 120) throw new Error('Source label must be 120 characters or fewer.');

  return {
    sourceLabel,
    entry: parsed.display,
    canonical: parsed.canonical,
    required: booleanValue(input.required, fallback ? fallback.required === 1 : true),
  };
}

async function fetchSite(db: D1Database, siteId: string): Promise<SiteRow | null> {
  return db
    .prepare('SELECT id, domain, ads_txt_url FROM publishers WHERE id = ? LIMIT 1')
    .bind(siteId)
    .first<SiteRow>();
}

async function fetchRequirement(
  db: D1Database,
  siteId: string,
  requirementId: string,
): Promise<RequirementRow | null> {
  return db
    .prepare(
      `SELECT id, publisher_id, source_label, entry, required, created_at, updated_at
       FROM ads_txt_requirements
       WHERE publisher_id = ? AND id = ?
       LIMIT 1`,
    )
    .bind(siteId, requirementId)
    .first<RequirementRow>();
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

async function duplicateRequirementId(
  db: D1Database,
  siteId: string,
  canonical: string,
  excludedId?: string,
): Promise<string | null> {
  const rows = await requirementRows(db, siteId);
  for (const row of rows) {
    if (excludedId && row.id === excludedId) continue;
    try {
      if (parseAdsEntry(row.entry).canonical === canonical) return row.id;
    } catch {
      // Keep legacy malformed rows editable instead of failing every request.
    }
  }
  return null;
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
  return db
    .prepare(
      `INSERT INTO audit_log (
        id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
      ) VALUES (?, ?, ?, ?, 'ads_txt_requirement', ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), actor, action, siteId, entityId, JSON.stringify(details), createdAt);
}

export async function listAdsTxtRequirements(env: AdsTxtEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const site = await fetchSite(env.DB, siteId);
  if (!site) return apiError('Site not found.', 404);
  const rows = await requirementRows(env.DB, siteId);
  return json({
    ok: true,
    siteId,
    adsTxtUrl: site.ads_txt_url || `https://${site.domain}/ads.txt`,
    requirements: rows.map(toRequirement),
  });
}

export async function createAdsTxtRequirement(
  request: Request,
  env: AdsTxtEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await fetchSite(env.DB, siteId))) return apiError('Site not found.', 404);

  try {
    const input = await readJson<RequirementInput>(request);
    const normalized = normalizeRequirement(input);
    if (await duplicateRequirementId(env.DB, siteId, normalized.canonical)) {
      return apiError('This ads.txt entry is already saved for the site.', 409);
    }

    const actor = getActor(request);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO ads_txt_requirements (
            id, publisher_id, source_label, entry, required, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, siteId, normalized.sourceLabel, normalized.entry, normalized.required ? 1 : 0, now, now),
      auditStatement(
        env.DB,
        actor,
        'ads_txt_requirement.created',
        siteId,
        id,
        { sourceLabel: normalized.sourceLabel, entry: normalized.entry, required: normalized.required },
        now,
      ),
    ]);

    const row = await fetchRequirement(env.DB, siteId, id);
    return json({ ok: true, requirement: row ? toRequirement(row) : null }, { status: 201 });
  } catch (error) {
    return apiError('Ads.txt requirement could not be created.', 422, error instanceof Error ? error.message : String(error));
  }
}

export async function updateAdsTxtRequirement(
  request: Request,
  env: AdsTxtEnv,
  siteId: string,
  requirementId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const current = await fetchRequirement(env.DB, siteId, requirementId);
  if (!current) return apiError('Ads.txt requirement not found.', 404);

  try {
    const input = await readJson<RequirementInput>(request);
    const normalized = normalizeRequirement(input, current);
    if (await duplicateRequirementId(env.DB, siteId, normalized.canonical, requirementId)) {
      return apiError('This ads.txt entry is already saved for the site.', 409);
    }

    const actor = getActor(request);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE ads_txt_requirements
           SET source_label = ?, entry = ?, required = ?, updated_at = ?
           WHERE publisher_id = ? AND id = ?`,
        )
        .bind(
          normalized.sourceLabel,
          normalized.entry,
          normalized.required ? 1 : 0,
          now,
          siteId,
          requirementId,
        ),
      auditStatement(
        env.DB,
        actor,
        'ads_txt_requirement.updated',
        siteId,
        requirementId,
        {
          before: toRequirement(current),
          after: {
            sourceLabel: normalized.sourceLabel,
            entry: normalized.entry,
            required: normalized.required,
          },
        },
        now,
      ),
    ]);

    const row = await fetchRequirement(env.DB, siteId, requirementId);
    return json({ ok: true, requirement: row ? toRequirement(row) : null });
  } catch (error) {
    return apiError('Ads.txt requirement could not be updated.', 422, error instanceof Error ? error.message : String(error));
  }
}

export async function deleteAdsTxtRequirement(
  request: Request,
  env: AdsTxtEnv,
  siteId: string,
  requirementId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const current = await fetchRequirement(env.DB, siteId, requirementId);
  if (!current) return apiError('Ads.txt requirement not found.', 404);

  const actor = getActor(request);
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB
        .prepare('DELETE FROM ads_txt_requirements WHERE publisher_id = ? AND id = ?')
        .bind(siteId, requirementId),
      auditStatement(
        env.DB,
        actor,
        'ads_txt_requirement.deleted',
        siteId,
        requirementId,
        { requirement: toRequirement(current) },
        now,
      ),
    ]);
    return json({ ok: true, deletedId: requirementId });
  } catch (error) {
    return apiError('Ads.txt requirement could not be deleted.', 500, error instanceof Error ? error.message : String(error));
  }
}

function normalizeImportRows(rows: unknown[]): { requirements: NormalizedRequirement[]; errors: string[] } {
  const requirements: NormalizedRequirement[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  rows.forEach((value, index) => {
    try {
      const input = value && typeof value === 'object' && !Array.isArray(value)
        ? value as RequirementInput
        : { entry: value };
      const requirement = normalizeRequirement(input);
      if (seen.has(requirement.canonical)) return;
      seen.add(requirement.canonical);
      requirements.push(requirement);
    } catch (error) {
      errors.push(`Row ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return { requirements, errors };
}

export async function importAdsTxtRequirements(
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
    if (body.rows.length > MAX_REQUIREMENTS_PER_IMPORT) {
      return apiError(`Import at most ${MAX_REQUIREMENTS_PER_IMPORT} ads.txt rows at once.`, 422);
    }

    const normalized = normalizeImportRows(body.rows);
    if (normalized.errors.length) {
      return apiError('Ads.txt import validation failed.', 422, { errors: normalized.errors });
    }

    const replaceExisting = booleanValue(body.replaceExisting, false);
    const existingRows = replaceExisting ? [] : await requirementRows(env.DB, siteId);
    const existing = new Set<string>();
    for (const row of existingRows) {
      try {
        existing.add(parseAdsEntry(row.entry).canonical);
      } catch {
        // Ignore malformed legacy rows during duplicate detection.
      }
    }

    const imported = normalized.requirements.filter((requirement) => !existing.has(requirement.canonical));
    const skipped = normalized.requirements.length - imported.length;
    const actor = getActor(request);
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];

    if (replaceExisting) {
      statements.push(env.DB.prepare('DELETE FROM ads_txt_requirements WHERE publisher_id = ?').bind(siteId));
    }

    for (const requirement of imported) {
      statements.push(
        env.DB
          .prepare(
            `INSERT INTO ads_txt_requirements (
              id, publisher_id, source_label, entry, required, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            siteId,
            requirement.sourceLabel,
            requirement.entry,
            requirement.required ? 1 : 0,
            now,
            now,
          ),
      );
    }

    statements.push(
      auditStatement(
        env.DB,
        actor,
        'ads_txt_requirements.imported',
        siteId,
        siteId,
        { imported: imported.length, skipped, replaceExisting },
        now,
      ),
    );

    await env.DB.batch(statements);
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

export async function copyAdsTxtRequirements(
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
    if (sourceRows.length > MAX_REQUIREMENTS_PER_IMPORT) {
      return apiError(`Copy at most ${MAX_REQUIREMENTS_PER_IMPORT} ads.txt rows at once.`, 422);
    }

    const normalized = normalizeImportRows(
      sourceRows.map((row) => ({ sourceLabel: row.source_label, entry: row.entry, required: row.required === 1 })),
    );
    if (normalized.errors.length) {
      return apiError('Source ads.txt requirements contain invalid entries.', 422, { errors: normalized.errors });
    }

    const replaceExisting = booleanValue(body.replaceExisting, false);
    const existingRows = replaceExisting ? [] : await requirementRows(env.DB, siteId);
    const existing = new Set<string>();
    for (const row of existingRows) {
      try {
        existing.add(parseAdsEntry(row.entry).canonical);
      } catch {
        // Ignore malformed legacy rows during duplicate detection.
      }
    }

    const copied = normalized.requirements.filter((requirement) => !existing.has(requirement.canonical));
    const skipped = normalized.requirements.length - copied.length;
    const actor = getActor(request);
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];

    if (replaceExisting) {
      statements.push(env.DB.prepare('DELETE FROM ads_txt_requirements WHERE publisher_id = ?').bind(siteId));
    }

    for (const requirement of copied) {
      statements.push(
        env.DB
          .prepare(
            `INSERT INTO ads_txt_requirements (
              id, publisher_id, source_label, entry, required, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            siteId,
            requirement.sourceLabel,
            requirement.entry,
            requirement.required ? 1 : 0,
            now,
            now,
          ),
      );
    }

    statements.push(
      auditStatement(
        env.DB,
        actor,
        'ads_txt_requirements.copied',
        siteId,
        siteId,
        { sourceSiteId, copied: copied.length, skipped, replaceExisting },
        now,
      ),
    );

    await env.DB.batch(statements);
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

function blockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    return true;
  }
  if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) {
    return true;
  }

  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return true;
  const [a, b] = octets;
  return a === 10
    || a === 127
    || a === 0
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function validatedPublicUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS ads.txt URLs are allowed.');
  if (url.username || url.password) throw new Error('Ads.txt URLs cannot contain credentials.');
  if (blockedHostname(url.hostname)) throw new Error('The ads.txt URL must use a public hostname.');
  return url;
}

async function limitedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_ADS_TXT_BYTES) throw new Error('The ads.txt response is larger than 2 MB.');
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_ADS_TXT_BYTES) {
      await reader.cancel();
      throw new Error('The ads.txt response is larger than 2 MB.');
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchAdsTxt(initialUrl: string): Promise<{
  text: string;
  finalUrl: string;
  httpStatus: number;
  contentType: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('ads.txt fetch timed out'), FETCH_TIMEOUT_MS);
  let current = validatedPublicUrl(initialUrl);

  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const response = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/plain,text/*;q=0.9,*/*;q=0.5',
          'user-agent': 'Prebid-Professor-AdsTxt-Checker/1.0',
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`Redirect ${response.status} did not include a Location header.`);
        current = validatedPublicUrl(new URL(location, current).toString());
        continue;
      }

      const text = response.ok ? await limitedText(response) : '';
      return {
        text,
        finalUrl: current.toString(),
        httpStatus: response.status,
        contentType: response.headers.get('content-type') ?? '',
      };
    }
    throw new Error('The ads.txt URL redirected too many times.');
  } finally {
    clearTimeout(timeout);
  }
}

function actualAdsEntries(text: string): {
  canonical: Set<string>;
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  duplicateEntries: Array<{
    entry: string;
    occurrences: number;
    lineNumbers: number[];
  }>;
} {
  const canonical = new Set<string>();
  const occurrences = new Map<string, { entry: string; lineNumbers: number[] }>();
  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = lineWithoutComment(rawLine);
    if (!line) return;
    try {
      const parsed = parseAdsEntry(line);
      validCount += 1;
      const current = occurrences.get(parsed.canonical);
      if (current) {
        duplicateCount += 1;
        current.lineNumbers.push(index + 1);
      } else {
        occurrences.set(parsed.canonical, {
          entry: parsed.display,
          lineNumbers: [index + 1],
        });
      }
      canonical.add(parsed.canonical);
    } catch {
      invalidCount += 1;
    }
  });

  const duplicateEntries = Array.from(occurrences.values())
    .filter((item) => item.lineNumbers.length > 1)
    .map((item) => ({
      entry: item.entry,
      occurrences: item.lineNumbers.length,
      lineNumbers: item.lineNumbers,
    }))
    .sort((left, right) => right.occurrences - left.occurrences || left.entry.localeCompare(right.entry));

  return { canonical, validCount, invalidCount, duplicateCount, duplicateEntries };
}

export async function checkAdsTxt(
  _request: Request,
  env: AdsTxtEnv,
  siteId: string,
): Promise<Response> {
  const includeInternalSnapshot = _request.headers.get('x-tessera-monitoring-snapshot') === '1';
  if (!env.DB) return databaseMissing();
  const site = await fetchSite(env.DB, siteId);
  if (!site) return apiError('Site not found.', 404);

  const requirements = await requirementRows(env.DB, siteId);
  const requestedUrl = site.ads_txt_url || `https://${site.domain}/ads.txt`;
  const fetchedAt = new Date().toISOString();

  try {
    const fetched = await fetchAdsTxt(requestedUrl);
    if (fetched.httpStatus < 200 || fetched.httpStatus >= 300) {
      return json({
        ok: true,
        check: {
          status: 'fetch-error',
          url: requestedUrl,
          finalUrl: fetched.finalUrl,
          fetchedAt,
          httpStatus: fetched.httpStatus,
          message: `ads.txt returned HTTP ${fetched.httpStatus}.`,
          results: [],
          missing: [],
          optionalMissing: [],
        },
      });
    }

    const actual = actualAdsEntries(fetched.text);
    const results = requirements.map((row) => {
      let found = false;
      try {
        found = actual.canonical.has(parseAdsEntry(row.entry).canonical);
      } catch {
        found = false;
      }
      return { ...toRequirement(row), found };
    });
    const missing = results.filter((item) => item.required && !item.found);
    const optionalMissing = results.filter((item) => !item.required && !item.found);
    const status = requirements.length === 0 ? 'empty' : missing.length === 0 ? 'ok' : 'missing';

    return json({
      ok: true,
      check: {
        status,
        url: requestedUrl,
        finalUrl: fetched.finalUrl,
        fetchedAt,
        httpStatus: fetched.httpStatus,
        contentType: fetched.contentType,
        actualEntryCount: actual.canonical.size,
        validLineCount: actual.validCount,
        invalidLineCount: actual.invalidCount,
        duplicateLineCount: actual.duplicateCount,
        duplicateEntries: actual.duplicateEntries,
        requirementCount: requirements.length,
        foundCount: results.filter((item) => item.found).length,
        requiredMissingCount: missing.length,
        optionalMissingCount: optionalMissing.length,
        results,
        missing,
        optionalMissing,
        ...(includeInternalSnapshot ? { content: fetched.text } : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({
      ok: true,
      check: {
        status: 'fetch-error',
        url: requestedUrl,
        finalUrl: null,
        fetchedAt,
        httpStatus: null,
        message,
        results: [],
        missing: [],
        optionalMissing: [],
      },
    });
  }
}
