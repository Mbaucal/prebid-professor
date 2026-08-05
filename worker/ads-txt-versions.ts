import { getManagedAdsTxtFile } from './ads-txt-managed-file';
import { apiError, getActor, json, readJson } from './http';
import type { DatabaseEnv } from './publishers';

const MAX_VERSION_NOTE_LENGTH = 160;
const MAX_VERSION_LIST = 50;

export interface AdsTxtVersionsEnv extends DatabaseEnv {
  BUILDS?: R2Bucket;
}

type VersionRow = {
  id: string;
  site_id: string;
  version_number: number;
  status: 'saved' | 'published' | 'superseded';
  object_key: string;
  checksum: string;
  row_count: number;
  canonical_count: number;
  repeated_row_count: number;
  heading_count: number;
  line_count: number;
  byte_size: number;
  note: string | null;
  created_by: string;
  generated_at: string;
  created_at: string;
};

type ManagedFilePayload = {
  ok: true;
  file: {
    siteId: string;
    adsTxtUrl: string;
    fileName: string;
    content: string;
    generatedAt: string;
    rowCount: number;
    canonicalCount: number;
    repeatedRowCount: number;
    headingCount: number;
    lineCount: number;
    byteSize: number;
    checksum: string;
  };
};

type CreateVersionInput = {
  note?: unknown;
};

let tablesReady: Promise<void> | null = null;

async function ensureTables(db: D1Database): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_versions (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'saved' CHECK (status IN ('saved', 'published', 'superseded')),
        object_key TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        canonical_count INTEGER NOT NULL,
        repeated_row_count INTEGER NOT NULL,
        heading_count INTEGER NOT NULL,
        line_count INTEGER NOT NULL,
        byte_size INTEGER NOT NULL,
        note TEXT,
        created_by TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE,
        UNIQUE (site_id, version_number),
        UNIQUE (site_id, checksum)
      )`).run();
      await db.prepare(`CREATE INDEX IF NOT EXISTS idx_ads_txt_versions_site_created
        ON ads_txt_versions(site_id, version_number DESC, created_at DESC)`).run();
    })().catch((error) => {
      tablesReady = null;
      throw error;
    });
  }
  await tablesReady;
}

function publicVersion(row: VersionRow) {
  return {
    id: row.id,
    siteId: row.site_id,
    versionNumber: row.version_number,
    status: row.status,
    checksum: row.checksum,
    rowCount: row.row_count,
    canonicalCount: row.canonical_count,
    repeatedRowCount: row.repeated_row_count,
    headingCount: row.heading_count,
    lineCount: row.line_count,
    byteSize: row.byte_size,
    note: row.note,
    createdBy: row.created_by,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  };
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1')
    .bind(siteId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function ready(env: AdsTxtVersionsEnv, siteId: string): Promise<D1Database | Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);
  if (!env.BUILDS) return apiError('R2 storage binding is not configured.', 503);
  await ensureTables(env.DB);
  if (!await siteExists(env.DB, siteId)) return apiError('Site not found.', 404);
  return env.DB;
}

async function versionRow(
  db: D1Database,
  siteId: string,
  versionId: string,
): Promise<VersionRow | null> {
  return db.prepare(`SELECT
      id, site_id, version_number, status, object_key, checksum,
      row_count, canonical_count, repeated_row_count, heading_count,
      line_count, byte_size, note, created_by, generated_at, created_at
    FROM ads_txt_versions
    WHERE site_id = ? AND id = ?
    LIMIT 1`)
    .bind(siteId, versionId)
    .first<VersionRow>();
}

async function versionByChecksum(
  db: D1Database,
  siteId: string,
  checksum: string,
): Promise<VersionRow | null> {
  return db.prepare(`SELECT
      id, site_id, version_number, status, object_key, checksum,
      row_count, canonical_count, repeated_row_count, heading_count,
      line_count, byte_size, note, created_by, generated_at, created_at
    FROM ads_txt_versions
    WHERE site_id = ? AND checksum = ?
    LIMIT 1`)
    .bind(siteId, checksum)
    .first<VersionRow>();
}

function auditStatement(
  db: D1Database,
  actor: string,
  action: string,
  siteId: string,
  versionId: string,
  details: Record<string, unknown>,
  createdAt: string,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO audit_log (
      id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
    ) VALUES (?, ?, ?, ?, 'ads_txt_version', ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      actor,
      action,
      siteId,
      versionId,
      JSON.stringify(details),
      createdAt,
    );
}

async function managedFile(env: AdsTxtVersionsEnv, siteId: string): Promise<ManagedFilePayload | Response> {
  const response = await getManagedAdsTxtFile(env, siteId);
  if (!response.ok) return response;
  try {
    return await response.json() as ManagedFilePayload;
  } catch (error) {
    return apiError(
      'The current managed ads.txt file could not be read.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function listAdsTxtVersions(
  env: AdsTxtVersionsEnv,
  siteId: string,
): Promise<Response> {
  const db = await ready(env, siteId);
  if (db instanceof Response) return db;

  const result = await db.prepare(`SELECT
      id, site_id, version_number, status, object_key, checksum,
      row_count, canonical_count, repeated_row_count, heading_count,
      line_count, byte_size, note, created_by, generated_at, created_at
    FROM ads_txt_versions
    WHERE site_id = ?
    ORDER BY version_number DESC
    LIMIT ?`)
    .bind(siteId, MAX_VERSION_LIST)
    .all<VersionRow>();

  return json({
    ok: true,
    siteId,
    versions: (result.results ?? []).map(publicVersion),
  });
}

export async function createAdsTxtVersion(
  request: Request,
  env: AdsTxtVersionsEnv,
  siteId: string,
): Promise<Response> {
  const db = await ready(env, siteId);
  if (db instanceof Response) return db;

  let input: CreateVersionInput = {};
  try {
    input = await readJson<CreateVersionInput>(request);
  } catch (error) {
    return apiError(
      'Version details are not valid JSON.',
      400,
      error instanceof Error ? error.message : String(error),
    );
  }

  const note = String(input.note ?? '').trim();
  if (note.length > MAX_VERSION_NOTE_LENGTH) {
    return apiError(`Version note must be ${MAX_VERSION_NOTE_LENGTH} characters or fewer.`, 422);
  }

  const current = await managedFile(env, siteId);
  if (current instanceof Response) return current;
  if (!current.file.content || current.file.rowCount < 1) {
    return apiError('Add at least one managed ads.txt row before saving a version.', 422);
  }

  const existing = await versionByChecksum(db, siteId, current.file.checksum);
  if (existing) {
    return json({
      ok: true,
      created: false,
      message: `The current file is already saved as version ${existing.version_number}.`,
      version: publicVersion(existing),
    });
  }

  const actor = getActor(request);
  const id = crypto.randomUUID();
  const objectKey = `ads-txt-versions/${encodeURIComponent(siteId)}/${id}.txt`;
  const createdAt = new Date().toISOString();

  try {
    await env.BUILDS!.put(objectKey, current.file.content, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      customMetadata: {
        siteId,
        versionId: id,
        checksum: current.file.checksum,
      },
    });

    await db.batch([
      db.prepare(`INSERT INTO ads_txt_versions (
          id, site_id, version_number, status, object_key, checksum,
          row_count, canonical_count, repeated_row_count, heading_count,
          line_count, byte_size, note, created_by, generated_at, created_at
        )
        SELECT
          ?, ?, COALESCE(MAX(version_number), 0) + 1, 'saved', ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM ads_txt_versions
        WHERE site_id = ?`)
        .bind(
          id,
          siteId,
          objectKey,
          current.file.checksum,
          current.file.rowCount,
          current.file.canonicalCount,
          current.file.repeatedRowCount,
          current.file.headingCount,
          current.file.lineCount,
          current.file.byteSize,
          note || null,
          actor,
          current.file.generatedAt,
          createdAt,
          siteId,
        ),
      auditStatement(db, actor, 'ads_txt_version.created', siteId, id, {
        checksum: current.file.checksum,
        rowCount: current.file.rowCount,
        canonicalCount: current.file.canonicalCount,
        repeatedRowCount: current.file.repeatedRowCount,
        byteSize: current.file.byteSize,
        note: note || null,
      }, createdAt),
    ]);
  } catch (error) {
    await env.BUILDS!.delete(objectKey).catch(() => undefined);
    const concurrentExisting = await versionByChecksum(db, siteId, current.file.checksum);
    if (concurrentExisting) {
      return json({
        ok: true,
        created: false,
        message: `The current file is already saved as version ${concurrentExisting.version_number}.`,
        version: publicVersion(concurrentExisting),
      });
    }
    return apiError(
      'The ads.txt version could not be saved. Try again.',
      409,
      error instanceof Error ? error.message : String(error),
    );
  }

  const saved = await versionRow(db, siteId, id);
  if (!saved) {
    await env.BUILDS!.delete(objectKey).catch(() => undefined);
    return apiError('The saved version metadata could not be loaded.', 500);
  }

  return json({
    ok: true,
    created: true,
    message: `Version ${saved.version_number} saved.`,
    version: publicVersion(saved),
  }, { status: 201 });
}

export async function getAdsTxtVersion(
  env: AdsTxtVersionsEnv,
  siteId: string,
  versionId: string,
): Promise<Response> {
  const db = await ready(env, siteId);
  if (db instanceof Response) return db;

  const row = await versionRow(db, siteId, versionId);
  if (!row) return apiError('Ads.txt version not found.', 404);

  const object = await env.BUILDS!.get(row.object_key);
  if (!object) {
    return apiError('The version file is missing from storage.', 500);
  }

  const content = await object.text();
  return json({
    ok: true,
    version: {
      ...publicVersion(row),
      content,
      fileName: `ads-v${row.version_number}.txt`,
    },
  });
}
