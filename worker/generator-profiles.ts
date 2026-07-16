import { apiError, getActor, json } from './http';
import type { DatabaseEnv } from './publishers';

export type GeneratorEngine = 'legacy-frozen-v1' | 'legacy-advanced-refresh-v1';

export interface GeneratorProfileEnv extends DatabaseEnv {
  BUILDS?: R2Bucket;
}

type GeneratorProfileManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  engine: GeneratorEngine;
  createdAt: string;
  createdBy: string;
  templateKey: string;
  templateFileName: string;
  templateSize: number;
  templateSha256: string;
  sourceKey: string | null;
  sourceFileName: string | null;
  sourceSize: number | null;
  sourceSha256: string | null;
  baseProfileId: string | null;
  immutableTemplate: boolean;
  capabilities: {
    perSlotPrebidTimeout: boolean;
    perSlotCmpWait: boolean;
    fixedRefresh: boolean;
    firstThenFixedRefresh: boolean;
    percentageRefresh: boolean;
    sequenceRefresh: boolean;
    accumulatedViewTime: boolean;
  };
};

type JsonRecord = Record<string, unknown>;

const PROFILE_PREFIX = 'generator-profiles/';
const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const ENGINES = new Set<GeneratorEngine>(['legacy-frozen-v1', 'legacy-advanced-refresh-v1']);

function storageMissing(): Response {
  return apiError('R2 build storage binding is not configured yet.', 503);
}

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeProfileId(value: unknown): string {
  const id = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/.test(id)) {
    throw new Error('Profile ID must use lowercase letters, numbers, dot, underscore or dash.');
  }
  return id;
}

function safeFileName(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function manifestKey(id: string): string {
  return `${PROFILE_PREFIX}${id}/manifest.json`;
}

function templateKey(id: string, name: string): string {
  return `${PROFILE_PREFIX}${id}/template/${encodeURIComponent(safeFileName(name, 'ads.js'))}`;
}

function sourceKey(id: string, name: string): string {
  return `${PROFILE_PREFIX}${id}/source/${encodeURIComponent(safeFileName(name, 'source.zip'))}`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function capabilitiesForEngine(engine: GeneratorEngine): GeneratorProfileManifest['capabilities'] {
  const advanced = engine === 'legacy-advanced-refresh-v1';
  return {
    perSlotPrebidTimeout: true,
    perSlotCmpWait: advanced,
    fixedRefresh: true,
    firstThenFixedRefresh: advanced,
    percentageRefresh: advanced,
    sequenceRefresh: advanced,
    accumulatedViewTime: true,
  };
}

async function readManifest(bucket: R2Bucket, id: string): Promise<GeneratorProfileManifest | null> {
  const object = await bucket.get(manifestKey(id));
  if (!object) return null;
  try {
    const value = JSON.parse(await object.text()) as unknown;
    return isRecord(value) ? (value as GeneratorProfileManifest) : null;
  } catch {
    return null;
  }
}

async function listManifests(bucket: R2Bucket): Promise<GeneratorProfileManifest[]> {
  const manifests: GeneratorProfileManifest[] = [];
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ prefix: PROFILE_PREFIX, cursor });
    const keys = page.objects
      .map((object) => object.key)
      .filter((key) => key.endsWith('/manifest.json'));

    for (const key of keys) {
      const object = await bucket.get(key);
      if (!object) continue;
      try {
        const parsed = JSON.parse(await object.text()) as unknown;
        if (isRecord(parsed)) manifests.push(parsed as GeneratorProfileManifest);
      } catch {
        // A corrupt manifest is ignored and can be removed manually from R2.
      }
    }

    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1').bind(siteId).first<{ id: string }>();
  return Boolean(row);
}

async function audit(
  db: D1Database | undefined,
  actor: string,
  action: string,
  entityId: string,
  details: JsonRecord,
  siteId: string | null = null,
): Promise<void> {
  if (!db) return;
  await db
    .prepare(
      `INSERT INTO audit_log (
         id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
       ) VALUES (?, ?, ?, ?, 'generator_profile', ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      actor,
      action,
      siteId,
      entityId,
      JSON.stringify(details),
      new Date().toISOString(),
    )
    .run();
}

async function updateSiteSelection(db: D1Database, siteId: string, profileId: string | null): Promise<void> {
  const row = await db
    .prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
    .bind(siteId)
    .first<{ config_json: string }>();

  if (!row) throw new Error('Publisher config was not found.');

  let config: JsonRecord = {};
  try {
    const parsed = JSON.parse(row.config_json) as unknown;
    if (isRecord(parsed)) config = parsed;
  } catch {
    config = {};
  }

  if (profileId) config.generatorProfileId = profileId;
  else delete config.generatorProfileId;

  await db
    .prepare('UPDATE publisher_configs SET config_json = ?, updated_at = ? WHERE publisher_id = ?')
    .bind(JSON.stringify(config), new Date().toISOString(), siteId)
    .run();
}

export async function listGeneratorProfiles(env: GeneratorProfileEnv): Promise<Response> {
  if (!env.BUILDS) return storageMissing();
  return json({ ok: true, profiles: await listManifests(env.BUILDS) });
}

export async function createGeneratorProfile(request: Request, env: GeneratorProfileEnv): Promise<Response> {
  if (!env.BUILDS) return storageMissing();

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return apiError('Content-Type must be multipart/form-data.');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return apiError('Profile upload form could not be read.');
  }

  let id: string;
  try {
    id = safeProfileId(form.get('id'));
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Profile ID is invalid.', 422);
  }

  if (await env.BUILDS.head(manifestKey(id))) {
    return apiError(`Generator profile "${id}" already exists.`, 409);
  }

  const name = String(form.get('name') ?? '').trim();
  const version = String(form.get('version') ?? '').trim();
  const description = String(form.get('description') ?? '').trim();
  const engine = String(form.get('engine') ?? 'legacy-frozen-v1') as GeneratorEngine;
  const template = form.get('template');
  const source = form.get('source');

  if (!name) return apiError('Profile name is required.', 422);
  if (!version) return apiError('Profile version is required.', 422);
  if (!ENGINES.has(engine)) return apiError('Generator engine is invalid.', 422);
  if (!(template instanceof File)) return apiError('An ads.js template file is required.', 422);
  if (template.size <= 0 || template.size > MAX_TEMPLATE_BYTES) {
    return apiError('Template must be between 1 byte and 5 MB.', 422);
  }
  if (source instanceof File && source.size > MAX_SOURCE_BYTES) {
    return apiError('Source archive cannot be larger than 25 MB.', 422);
  }

  const templateBytes = await template.arrayBuffer();
  const sourceBytes = source instanceof File && source.size > 0 ? await source.arrayBuffer() : null;
  const actor = getActor(request);
  const createdAt = new Date().toISOString();
  const storedTemplateKey = templateKey(id, template.name);
  const storedSourceKey = sourceBytes && source instanceof File ? sourceKey(id, source.name) : null;

  const manifest: GeneratorProfileManifest = {
    schemaVersion: 1,
    id,
    name,
    version,
    description,
    engine,
    createdAt,
    createdBy: actor,
    templateKey: storedTemplateKey,
    templateFileName: template.name,
    templateSize: template.size,
    templateSha256: await sha256Hex(templateBytes),
    sourceKey: storedSourceKey,
    sourceFileName: source instanceof File && sourceBytes ? source.name : null,
    sourceSize: source instanceof File && sourceBytes ? source.size : null,
    sourceSha256: sourceBytes ? await sha256Hex(sourceBytes) : null,
    baseProfileId: null,
    immutableTemplate: true,
    capabilities: capabilitiesForEngine(engine),
  };

  try {
    await env.BUILDS.put(storedTemplateKey, templateBytes, {
      httpMetadata: { contentType: 'application/javascript; charset=utf-8', cacheControl: 'private, no-store' },
      customMetadata: { profileId: id, sha256: manifest.templateSha256, originalName: template.name },
    });

    if (storedSourceKey && sourceBytes && source instanceof File) {
      await env.BUILDS.put(storedSourceKey, sourceBytes, {
        httpMetadata: { contentType: source.type || 'application/octet-stream', cacheControl: 'private, no-store' },
        customMetadata: { profileId: id, sha256: manifest.sourceSha256 ?? '', originalName: source.name },
      });
    }

    await env.BUILDS.put(manifestKey(id), JSON.stringify(manifest, null, 2), {
      httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'private, no-store' },
    });

    await audit(env.DB, actor, 'generator_profile.created', id, {
      name,
      version,
      engine,
      templateSha256: manifest.templateSha256,
      sourceSha256: manifest.sourceSha256,
    });
  } catch (error) {
    await env.BUILDS.delete(storedTemplateKey).catch(() => undefined);
    if (storedSourceKey) await env.BUILDS.delete(storedSourceKey).catch(() => undefined);
    await env.BUILDS.delete(manifestKey(id)).catch(() => undefined);
    return apiError('Generator profile upload failed.', 500, error instanceof Error ? error.message : String(error));
  }

  return json({ ok: true, profile: manifest }, { status: 201 });
}

export async function duplicateGeneratorProfile(
  request: Request,
  env: GeneratorProfileEnv,
  sourceId: string,
): Promise<Response> {
  if (!env.BUILDS) return storageMissing();

  let input: JsonRecord;
  try {
    input = (await request.json()) as JsonRecord;
  } catch {
    return apiError('JSON body could not be read.');
  }

  const sourceManifest = await readManifest(env.BUILDS, sourceId);
  if (!sourceManifest) return apiError('Source generator profile was not found.', 404);

  let id: string;
  try {
    id = safeProfileId(input.id);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Profile ID is invalid.', 422);
  }

  if (await env.BUILDS.head(manifestKey(id))) {
    return apiError(`Generator profile "${id}" already exists.`, 409);
  }

  const name = String(input.name ?? '').trim();
  const version = String(input.version ?? sourceManifest.version).trim();
  const description = String(input.description ?? '').trim();
  const engine = String(input.engine ?? sourceManifest.engine) as GeneratorEngine;

  if (!name) return apiError('Profile name is required.', 422);
  if (!ENGINES.has(engine)) return apiError('Generator engine is invalid.', 422);

  const templateObject = await env.BUILDS.get(sourceManifest.templateKey);
  if (!templateObject) return apiError('Source template file is missing from R2.', 409);
  const templateBytes = await templateObject.arrayBuffer();

  let sourceBytes: ArrayBuffer | null = null;
  if (sourceManifest.sourceKey) {
    const sourceObject = await env.BUILDS.get(sourceManifest.sourceKey);
    if (sourceObject) sourceBytes = await sourceObject.arrayBuffer();
  }

  const newTemplateKey = templateKey(id, sourceManifest.templateFileName);
  const newSourceKey = sourceBytes && sourceManifest.sourceFileName
    ? sourceKey(id, sourceManifest.sourceFileName)
    : null;
  const actor = getActor(request);
  const createdAt = new Date().toISOString();

  const manifest: GeneratorProfileManifest = {
    ...sourceManifest,
    id,
    name,
    version,
    description,
    engine,
    createdAt,
    createdBy: actor,
    templateKey: newTemplateKey,
    sourceKey: newSourceKey,
    baseProfileId: sourceManifest.id,
    immutableTemplate: true,
    capabilities: capabilitiesForEngine(engine),
  };

  try {
    await env.BUILDS.put(newTemplateKey, templateBytes, {
      httpMetadata: { contentType: 'application/javascript; charset=utf-8', cacheControl: 'private, no-store' },
      customMetadata: {
        profileId: id,
        baseProfileId: sourceManifest.id,
        sha256: sourceManifest.templateSha256,
        originalName: sourceManifest.templateFileName,
      },
    });

    if (newSourceKey && sourceBytes && sourceManifest.sourceFileName) {
      await env.BUILDS.put(newSourceKey, sourceBytes, {
        httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, no-store' },
        customMetadata: {
          profileId: id,
          baseProfileId: sourceManifest.id,
          sha256: sourceManifest.sourceSha256 ?? '',
          originalName: sourceManifest.sourceFileName,
        },
      });
    }

    await env.BUILDS.put(manifestKey(id), JSON.stringify(manifest, null, 2), {
      httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'private, no-store' },
    });

    await audit(env.DB, actor, 'generator_profile.duplicated', id, {
      sourceProfileId: sourceManifest.id,
      engine,
      templateSha256: sourceManifest.templateSha256,
    });
  } catch (error) {
    await env.BUILDS.delete(newTemplateKey).catch(() => undefined);
    if (newSourceKey) await env.BUILDS.delete(newSourceKey).catch(() => undefined);
    await env.BUILDS.delete(manifestKey(id)).catch(() => undefined);
    return apiError('Generator profile duplication failed.', 500, error instanceof Error ? error.message : String(error));
  }

  return json({ ok: true, profile: manifest }, { status: 201 });
}

export async function deleteGeneratorProfile(
  request: Request,
  env: GeneratorProfileEnv,
  profileId: string,
): Promise<Response> {
  if (!env.BUILDS) return storageMissing();

  const manifest = await readManifest(env.BUILDS, profileId);
  if (!manifest) return apiError('Generator profile was not found.', 404);

  if (env.DB) {
    const configs = await env.DB
      .prepare('SELECT publisher_id, config_json FROM publisher_configs')
      .all<{ publisher_id: string; config_json: string }>();

    const selectedBy: string[] = [];
    for (const row of configs.results ?? []) {
      try {
        const config = JSON.parse(row.config_json) as unknown;
        if (isRecord(config) && config.generatorProfileId === profileId) selectedBy.push(row.publisher_id);
      } catch {
        // Ignore malformed config rows here; validation handles those separately.
      }
    }

    if (selectedBy.length) {
      return apiError('Profile is selected by one or more sites and cannot be deleted.', 409, { selectedBy });
    }
  }

  let cursor: string | undefined;
  do {
    const page = await env.BUILDS.list({ prefix: `${PROFILE_PREFIX}${profileId}/`, cursor });
    if (page.objects.length) await env.BUILDS.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  await audit(env.DB, getActor(request), 'generator_profile.deleted', profileId, {
    name: manifest.name,
    version: manifest.version,
  });

  return json({ ok: true, deletedId: profileId });
}

export async function downloadGeneratorProfileFile(
  env: GeneratorProfileEnv,
  profileId: string,
  kind: 'template' | 'source',
): Promise<Response> {
  if (!env.BUILDS) return storageMissing();
  const manifest = await readManifest(env.BUILDS, profileId);
  if (!manifest) return apiError('Generator profile was not found.', 404);

  const key = kind === 'template' ? manifest.templateKey : manifest.sourceKey;
  const fileName = kind === 'template' ? manifest.templateFileName : manifest.sourceFileName;
  if (!key || !fileName) return apiError(`This profile has no ${kind} file.`, 404);

  const object = await env.BUILDS.get(key);
  if (!object) return apiError('Profile file is missing from R2.', 409);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('cache-control', 'private, no-store');
  headers.set('content-disposition', `attachment; filename="${safeFileName(fileName, kind === 'template' ? 'ads.js' : 'source.zip')}"`);
  if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
  return new Response(object.body, { headers });
}

export async function getGeneratorSelection(
  env: GeneratorProfileEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  const row = await env.DB
    .prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
    .bind(siteId)
    .first<{ config_json: string }>();

  let profileId: string | null = null;
  try {
    const config = row?.config_json ? (JSON.parse(row.config_json) as unknown) : null;
    if (isRecord(config) && typeof config.generatorProfileId === 'string') {
      profileId = config.generatorProfileId;
    }
  } catch {
    profileId = null;
  }

  return json({ ok: true, profileId });
}

export async function setGeneratorSelection(
  request: Request,
  env: GeneratorProfileEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!env.BUILDS) return storageMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  let input: JsonRecord;
  try {
    input = (await request.json()) as JsonRecord;
  } catch {
    return apiError('JSON body could not be read.');
  }

  const rawProfileId = input.profileId;
  const profileId = rawProfileId === null || rawProfileId === '' ? null : safeProfileId(rawProfileId);
  if (profileId && !(await readManifest(env.BUILDS, profileId))) {
    return apiError('Generator profile was not found.', 404);
  }

  await updateSiteSelection(env.DB, siteId, profileId);
  await audit(env.DB, getActor(request), 'generator_profile.selected', profileId ?? 'none', { profileId }, siteId);
  return json({ ok: true, profileId });
}
