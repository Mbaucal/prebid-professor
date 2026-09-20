import { apiError, getActor, json } from './http';
import type { DatabaseEnv } from './publishers';
import { readPreviewSnapshot } from './runtime/builtin-preview-service.mjs';
import { digest } from './runtime/preview-snapshot.mjs';
import { runtimeCatalog, prepareSiteRuntimeSelection } from './test-workspace/runtime-catalog.mjs';
import { commitSiteConfiguration } from './site-runtime/service.mjs';

export interface PrebidBuildEnv extends DatabaseEnv {
  BUILDS?: R2Bucket;
}

type PrebidBuildStatus = 'current' | 'archived' | 'invalid';

type PrebidBuildRow = {
  id: string;
  publisher_id: string;
  version: string;
  file_key: string;
  file_url: string | null;
  modules_json: string;
  status: PrebidBuildStatus;
  uploaded_by: string | null;
  uploaded_at: string;
};

type ParsedBuild = {
  version: string | null;
  modules: string[];
  error: string | null;
};

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const HEADER_SCAN_BYTES = 500_000;

const BIDDER_MODULE_ALIASES: Record<string, string> = {
  connectad: 'connectadBidAdapter',
  criteo: 'criteoBidAdapter',
  eskimi: 'eskimiBidAdapter',
  ix: 'ixBidAdapter',
  magnite: 'magniteBidAdapter',
  ogury: 'oguryBidAdapter',
  openx: 'openxBidAdapter',
  pubmatic: 'pubmaticBidAdapter',
  richaudience: 'richaudienceBidAdapter',
  rtbhouse: 'rtbhouseBidAdapter',
  teads: 'teadsBidAdapter',
};

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function storageMissing(): Response {
  return apiError('R2 build storage binding is not configured yet.', 503);
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function adapterModuleForBidder(bidder: string): string {
  const normalized = bidder.trim().toLowerCase();
  return BIDDER_MODULE_ALIASES[normalized] ?? `${normalized}BidAdapter`;
}

function parseModules(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? uniqueSorted(parsed.filter((item): item is string => typeof item === 'string'))
      : [];
  } catch {
    return [];
  }
}

function parseBuildHeader(text: string): ParsedBuild {
  const versionMatch = text.match(
    /prebid\.js\s+v?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?)/i,
  );
  const modulesMatch = text.match(/Modules:\s*([\s\S]*?)\s*\*\//i);

  const modules = modulesMatch?.[1]
    ? uniqueSorted(
        modulesMatch[1]
          .replace(/[\r\n]+/g, ' ')
          .split(',')
          .map((module) => module.trim()),
      )
    : [];

  let error: string | null = null;
  if (!versionMatch?.[1]) error = 'Prebid version could not be read from the file header.';
  else if (!modules.length) error = 'Installed modules could not be read from the file header.';

  return {
    version: versionMatch?.[1] ?? null,
    modules,
    error,
  };
}

function safeFileName(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'prebid.js';
}

function fileNameFromKey(key: string): string {
  const value = key.split('/').pop() ?? 'prebid.js';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1')
    .bind(siteId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function requiredAdapters(db: D1Database, siteId: string): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT bidder
       FROM bidders
       WHERE publisher_id = ? AND enabled = 1
       ORDER BY bidder COLLATE NOCASE`,
    )
    .bind(siteId)
    .all<{ bidder: string }>();

  return uniqueSorted((result.results ?? []).map((row) => adapterModuleForBidder(row.bidder)));
}

async function fetchBuildRow(
  db: D1Database,
  siteId: string,
  buildId: string,
): Promise<PrebidBuildRow | null> {
  return db
    .prepare(
      `SELECT id, publisher_id, version, file_key, file_url, modules_json, status,
              uploaded_by, uploaded_at
       FROM prebid_builds
       WHERE publisher_id = ? AND id = ?
       LIMIT 1`,
    )
    .bind(siteId, buildId)
    .first<PrebidBuildRow>();
}

async function toBuildPayload(
  env: PrebidBuildEnv,
  row: PrebidBuildRow,
  required: string[],
): Promise<Record<string, unknown>> {
  const modules = parseModules(row.modules_json);
  const moduleSet = new Set(modules);
  const missingAdapters = required.filter((module) => !moduleSet.has(module));
  const object = env.BUILDS ? await env.BUILDS.head(row.file_key) : null;
  const fileName = object?.customMetadata?.originalName || fileNameFromKey(row.file_key);

  return {
    id: row.id,
    publisherId: row.publisher_id,
    version: row.version,
    fileKey: row.file_key,
    fileName,
    fileSize: object?.size ?? 0,
    modules,
    status: row.status,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    missingAdapters,
    valid: missingAdapters.length === 0 && row.status !== 'invalid',
    downloadUrl:
      row.file_url ??
      `/api/publishers/${encodeURIComponent(row.publisher_id)}/prebid-builds/${encodeURIComponent(row.id)}/download`,
    contentHash: object?.customMetadata?.sha256 ?? null,
  };
}

export async function listPrebidBuilds(env: PrebidBuildEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!env.BUILDS) return storageMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  const required = await requiredAdapters(env.DB, siteId);
  const result = await env.DB
    .prepare(
      `SELECT id, publisher_id, version, file_key, file_url, modules_json, status,
              uploaded_by, uploaded_at
       FROM prebid_builds
       WHERE publisher_id = ?
       ORDER BY CASE status WHEN 'current' THEN 0 WHEN 'invalid' THEN 2 ELSE 1 END,
                uploaded_at DESC`,
    )
    .bind(siteId)
    .all<PrebidBuildRow>();

  const builds = await Promise.all(
    (result.results ?? []).map((row) => toBuildPayload(env, row, required)),
  );

  return json({
    ok: true,
    requiredAdapters: required,
    builds,
  });
}

export async function uploadPrebidBuild(
  request: Request,
  env: PrebidBuildEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!env.BUILDS) return storageMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return apiError('Content-Type must be multipart/form-data.');
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Upload form could not be read.');
  }

  const value = formData.get('file');
  if (!(value instanceof File)) return apiError('A prebid.js file is required.');
  if (!/\.js$/i.test(value.name)) return apiError('The uploaded file must end in .js.', 422);
  if (value.size <= 0) return apiError('The uploaded file is empty.', 422);
  if (value.size > MAX_FILE_SIZE) return apiError('The uploaded file is larger than 20 MB.', 413);

  const bytes = await value.arrayBuffer();
  const scanLength = Math.min(bytes.byteLength, HEADER_SCAN_BYTES);
  const headerText = new TextDecoder().decode(new Uint8Array(bytes, 0, scanLength));
  const parsed = parseBuildHeader(headerText);
  const required = await requiredAdapters(env.DB, siteId);
  const moduleSet = new Set(parsed.modules);
  const missingAdapters = required.filter((module) => !moduleSet.has(module));

  const id = crypto.randomUUID();
  const fileName = safeFileName(value.name);
  const key = `publishers/${siteId}/prebid-builds/${id}/${encodeURIComponent(fileName)}`;
  const actor = getActor(request);
  const now = new Date().toISOString();
  const hash = await sha256Hex(bytes);

  const current = await env.DB
    .prepare(
      `SELECT id
       FROM prebid_builds
       WHERE publisher_id = ? AND status = 'current'
       LIMIT 1`,
    )
    .bind(siteId)
    .first<{ id: string }>();

  const valid = !parsed.error && missingAdapters.length === 0;
  const status: PrebidBuildStatus = valid ? (current ? 'archived' : 'current') : 'invalid';
  const downloadUrl = `/api/publishers/${encodeURIComponent(siteId)}/prebid-builds/${encodeURIComponent(id)}/download`;

  try {
    await env.BUILDS.put(key, bytes, {
      httpMetadata: {
        contentType: 'application/javascript; charset=utf-8',
        cacheControl: 'private, no-store',
      },
      customMetadata: {
        originalName: value.name,
        version: parsed.version ?? 'unknown',
        sha256: hash,
        uploadedBy: actor,
      },
    });

    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO prebid_builds (
             id, publisher_id, version, file_key, file_url, modules_json, status,
             uploaded_by, uploaded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          siteId,
          parsed.version ?? 'unknown',
          key,
          downloadUrl,
          JSON.stringify(parsed.modules),
          status,
          actor,
          now,
        ),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'prebid_build.uploaded', ?, 'prebid_build', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          id,
          JSON.stringify({
            fileName: value.name,
            fileSize: value.size,
            version: parsed.version,
            modules: parsed.modules.length,
            status,
            missingAdapters,
            parseError: parsed.error,
            sha256: hash,
          }),
          now,
        ),
    ]);
  } catch (error) {
    await env.BUILDS.delete(key).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    return apiError('Prebid build upload failed.', 500, message);
  }

  const row = await fetchBuildRow(env.DB, siteId, id);
  return json(
    {
      ok: true,
      build: row ? await toBuildPayload(env, row, required) : null,
      warnings: [parsed.error, ...missingAdapters.map((module) => `Missing ${module}`)].filter(Boolean),
    },
    { status: 201 },
  );
}

export async function activatePrebidBuild(
  request: Request,
  env: PrebidBuildEnv,
  siteId: string,
  buildId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!env.BUILDS) return storageMissing();

  const row = await fetchBuildRow(env.DB, siteId, buildId);
  if (!row) return apiError('Prebid build not found.', 404);

  const object = await env.BUILDS.head(row.file_key);
  if (!object) return apiError('The build file is missing from R2.', 409);

  const required = await requiredAdapters(env.DB, siteId);
  const modules = parseModules(row.modules_json);
  const moduleSet = new Set(modules);
  const missingAdapters = required.filter((module) => !moduleSet.has(module));
  if (missingAdapters.length) {
    return apiError('This build cannot be activated because bidder adapters are missing.', 422, {
      missingAdapters,
    });
  }

  try {
    const saved = await readPreviewSnapshot(env.DB.withSession('first-primary'), siteId, {includePrebid:true});
    const config = JSON.parse(saved.config.config_json);
    let configJson = saved.config.config_json;
    if(config.builtinRuntimeSelection) {
      const projected = {...saved,prebidBuilds:[{...row,status:'current'}]};
      const enabled = config.enablePrebid === true;
      const plan = await prepareSiteRuntimeSelection({siteId,snapshot:projected,catalog:runtimeCatalog,
        expectedRevision:await digest(projected),selection:{runtime:config.builtinRuntimeSelection.runtime,
          allowPreview:true,enablePrebid:enabled,prebidBuildId:enabled?buildId:null}},env.BUILDS);
      configJson = plan.configJson;
    }
    await commitSiteConfiguration(env,saved,configJson,getActor(request),{activation:row});
  } catch(error) {
    const failure = error as Error & {status?:number};
    return apiError(failure.message || 'Prebid build could not be activated.',failure.status ?? 422);
  }

  const updated = await fetchBuildRow(env.DB, siteId, buildId);
  return json({
    ok: true,
    build: updated ? await toBuildPayload(env, updated, required) : null,
  });
}

export async function deletePrebidBuild(
  request: Request,
  env: PrebidBuildEnv,
  siteId: string,
  buildId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!env.BUILDS) return storageMissing();

  const row = await fetchBuildRow(env.DB, siteId, buildId);
  if (!row) return apiError('Prebid build not found.', 404);
  if (row.status === 'current') {
    return apiError('The current Prebid build cannot be deleted. Activate another build first.', 409);
  }

  if (request.headers.get('x-confirm-delete') !== buildId) return apiError('Confirm this exact Prebid file before deleting.', 422);

  const actor = getActor(request);
  const now = new Date().toISOString();

  try {
    await env.BUILDS.delete(row.file_key);
    await env.DB.batch([
      env.DB
        .prepare('DELETE FROM prebid_builds WHERE publisher_id = ? AND id = ?')
        .bind(siteId, buildId),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'prebid_build.deleted', ?, 'prebid_build', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          buildId,
          JSON.stringify({ version: row.version, fileKey: row.file_key }),
          now,
        ),
    ]);
  } catch (error) {
    return apiError(
      'Prebid build deletion failed.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  return json({ ok: true, deletedId: buildId });
}

export async function downloadPrebidBuild(
  env: PrebidBuildEnv,
  siteId: string,
  buildId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!env.BUILDS) return storageMissing();

  const row = await fetchBuildRow(env.DB, siteId, buildId);
  if (!row) return apiError('Prebid build not found.', 404);

  const object = await env.BUILDS.get(row.file_key);
  if (!object) return apiError('The build file is missing from R2.', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'private, no-store');
  const originalName = object.customMetadata?.originalName || fileNameFromKey(row.file_key);
  const safeDownloadName = originalName.replace(/["\r\n]/g, '_');
  headers.set('content-disposition', `attachment; filename="${safeDownloadName}"`);
  headers.set('x-content-type-options', 'nosniff');

  return new Response(object.body, { headers });
}
