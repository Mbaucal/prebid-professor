import { apiError, json } from './http';
import {
  generateReleaseWithFluidPreflight,
  validateReleaseWithFluidPreflight,
} from './release-size-map-preflight';
import type { ReleaseEnv } from './releases';

type JsonRecord = Record<string, unknown>;

type ModeState = {
  enabled: boolean;
  config: JsonRecord;
  savedBidders: number;
  savedOverrides: number;
};

const SYNTHETIC_PREBID_KEY = '__prebid-professor__/adx-only/prebid.js';
const SYNTHETIC_PREBID_SOURCE = '/* Prebid disabled for this release. Google Ad Manager / AdX only. */\n';

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseRecord(value: string | null | undefined): JsonRecord {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function releaseKey(siteId: string, version: string, fileName: string): string {
  return `publishers/${siteId}/releases/${version}/${fileName}`;
}

async function readMode(env: ReleaseEnv, siteId: string): Promise<ModeState> {
  if (!env.DB) throw new Error('D1 is not configured.');
  const [configRow, bidderCount, overrideCount] = await Promise.all([
    env.DB
      .prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
      .bind(siteId)
      .first<{ config_json: string }>(),
    env.DB
      .prepare('SELECT COUNT(*) AS total FROM bidders WHERE publisher_id = ?')
      .bind(siteId)
      .first<{ total: number | string | null }>(),
    env.DB
      .prepare('SELECT COUNT(*) AS total FROM bidder_overrides WHERE publisher_id = ?')
      .bind(siteId)
      .first<{ total: number | string | null }>(),
  ]);
  if (!configRow) throw new Error('Publisher config was not found.');
  const config = parseRecord(configRow.config_json);
  return {
    enabled: config.enablePrebid !== false,
    config,
    savedBidders: Number(bidderCount?.total ?? 0),
    savedOverrides: Number(overrideCount?.total ?? 0),
  };
}

function adxOnlyConfigJson(raw: string): string {
  const config = parseRecord(raw);
  config.enablePrebid = false;
  config.userSync = {
    syncEnabled: false,
    aliasSyncEnabled: false,
    syncsPerBidder: 0,
    syncDelay: 0,
    auctionDelay: 0,
    filterSettings: { all: { bidders: '*', filter: 'include' } },
    userIds: [],
  };
  const existingUserId = isRecord(config.userIdConfig) ? config.userIdConfig : {};
  config.userIdConfig = { ...existingUserId, enabled: false, modules: Array.isArray(existingUserId.modules) ? existingUserId.modules : [] };
  return JSON.stringify(config);
}

function normalizedQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().toLowerCase();
}

function syntheticBuildRow(): JsonRecord {
  return {
    id: '__adx-only__',
    version: 'disabled',
    file_key: SYNTHETIC_PREBID_KEY,
    modules_json: '[]',
    status: 'current',
    uploaded_by: 'prebid-professor',
    uploaded_at: new Date(0).toISOString(),
  };
}

function wrapStatement(statement: D1PreparedStatement, query: string): D1PreparedStatement {
  const normalized = normalizedQuery(query);
  return new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') {
        return (...values: D1Value[]) => wrapStatement(target.bind(...values), query);
      }
      if (property === 'first') {
        return async () => {
          if (normalized.includes(' from prebid_builds ') && normalized.includes("status = 'current'")) {
            return syntheticBuildRow();
          }
          const row = await target.first<JsonRecord>();
          if (row && normalized.includes(' from publisher_configs ') && typeof row.config_json === 'string') {
            return { ...row, config_json: adxOnlyConfigJson(row.config_json) };
          }
          return row;
        };
      }
      if (property === 'all') {
        return async () => {
          const result = await target.all<JsonRecord>();
          if (normalized.includes(' from bidders ')) {
            return { ...result, results: (result.results ?? []).map((row) => ({ ...row, enabled: 0 })) };
          }
          if (normalized.includes(' from bidder_overrides ')) {
            return { ...result, results: (result.results ?? []).map((row) => ({ ...row, enabled: 0 })) };
          }
          if (normalized.includes(' from publisher_configs ')) {
            return {
              ...result,
              results: (result.results ?? []).map((row) =>
                typeof row.config_json === 'string' ? { ...row, config_json: adxOnlyConfigJson(row.config_json) } : row,
              ),
            };
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1PreparedStatement;
}

function syntheticPrebidObject(): R2ObjectBody {
  const bytes = new TextEncoder().encode(SYNTHETIC_PREBID_SOURCE);
  return {
    key: SYNTHETIC_PREBID_KEY,
    version: 'adx-only',
    size: bytes.byteLength,
    etag: 'adx-only',
    httpEtag: '"adx-only"',
    uploaded: new Date(0),
    httpMetadata: { contentType: 'application/javascript; charset=utf-8' },
    customMetadata: { prebidEnabled: 'false' },
    range: undefined,
    checksums: {} as R2Checksums,
    storageClass: 'Standard',
    ssecKeyMd5: undefined,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    bodyUsed: false,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => SYNTHETIC_PREBID_SOURCE,
    json: async <T>() => JSON.parse('{}') as T,
    blob: async () => new Blob([bytes], { type: 'application/javascript' }),
    writeHttpMetadata(headers: Headers) {
      headers.set('content-type', 'application/javascript; charset=utf-8');
    },
  } as unknown as R2ObjectBody;
}

function withAdxOnlyEnvironment(env: ReleaseEnv): ReleaseEnv {
  if (!env.DB || !env.BUILDS) return env;
  const originalDb = env.DB;
  const originalBucket = env.BUILDS;

  const db = new Proxy(originalDb, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) => wrapStatement(target.prepare(query), query);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;

  const bucket = new Proxy(originalBucket, {
    get(target, property) {
      if (property === 'get') {
        return async (key: string, options?: R2GetOptions) => {
          if (key === SYNTHETIC_PREBID_KEY) return syntheticPrebidObject();
          return target.get(key, options);
        };
      }
      if (property === 'head') {
        return async (key: string) => {
          if (key === SYNTHETIC_PREBID_KEY) return syntheticPrebidObject();
          return target.head(key);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as R2Bucket;

  return { ...env, DB: db, BUILDS: bucket };
}

async function profileSupportsAdxOnly(env: ReleaseEnv, config: JsonRecord): Promise<boolean> {
  if (!env.BUILDS) return false;
  const profileId = String(config.generatorProfileId ?? '').trim();
  if (!profileId) return false;
  const manifestObject = await env.BUILDS.get(`generator-profiles/${profileId}/manifest.json`);
  if (!manifestObject) return false;
  const manifest = parseRecord(await manifestObject.text());
  const templateKey = String(manifest.templateKey ?? '').trim();
  if (!templateKey) return false;
  const templateObject = await env.BUILDS.get(templateKey);
  if (!templateObject) return false;
  const template = await templateObject.text();
  return /(?:var|let|const)\s+ENABLE_PREBID\s*=|window\.ENABLE_PREBID\s*=/.test(template);
}

function patchPrebidFlag(source: string): string {
  const declaration = /^(\s*(?:var|let|const)\s+ENABLE_PREBID\s*=\s*).*?(;\s*(?:\/\/[^\r\n]*)?[\t ]*)$/m;
  const windowAssignment = /^(\s*window\.ENABLE_PREBID\s*=\s*).*?(;[\t ]*)$/m;
  let output = source;
  if (declaration.test(output)) {
    output = output.replace(declaration, (_match, prefix: string, suffix: string) => `${prefix}false${suffix}`);
  } else if (windowAssignment.test(output)) {
    output = output.replace(windowAssignment, (_match, prefix: string, suffix: string) => `${prefix}false${suffix}`);
  } else {
    throw new Error('The selected generator template does not contain ENABLE_PREBID.');
  }

  if (!output.includes('window.ADOPS_PREBID_ENABLED')) {
    const marker = /(window\.ADOPS_GENERATOR_PROFILE\s*=\s*[^;]+;)/;
    output = marker.test(output)
      ? output.replace(marker, '$1\n      window.ADOPS_PREBID_ENABLED = false;')
      : `window.ADOPS_PREBID_ENABLED = false;\n${output}`;
  }
  return output;
}

function omitPrebidScript(html: string): string {
  return `${html
    .split(/\r?\n/)
    .filter((line) => !/prebid\.js/i.test(line))
    .join('\n')
    .trim()}\n`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function contentType(fileName: string): string {
  if (fileName.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (fileName.endsWith('.json')) return 'application/json; charset=utf-8';
  if (fileName.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

async function putText(
  bucket: R2Bucket,
  key: string,
  value: string,
  fileName: string,
  metadata: Record<string, string>,
): Promise<JsonRecord> {
  const bytes = new TextEncoder().encode(value);
  const sha256 = await sha256Hex(value);
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: contentType(fileName), cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { ...metadata, fileName, sha256 },
  });
  return { key, size: bytes.byteLength, sha256, contentType: contentType(fileName) };
}

async function readText(bucket: R2Bucket, key: string): Promise<string> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`${key} is missing from R2.`);
  return object.text();
}

function addUniquePatch(manifest: JsonRecord, patch: string): void {
  const compiler = isRecord(manifest.compiler) ? manifest.compiler : {};
  const patches = Array.isArray(compiler.patches) ? compiler.patches.map(String) : [];
  compiler.patches = Array.from(new Set([...patches, patch]));
  manifest.compiler = compiler;
}

export async function validateReleaseForDemandMode(env: ReleaseEnv, siteId: string): Promise<Response> {
  let mode: ModeState;
  try {
    mode = await readMode(env, siteId);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Demand mode could not be read.', 422);
  }
  if (mode.enabled) return validateReleaseWithFluidPreflight(env, siteId);

  const base = await validateReleaseWithFluidPreflight(withAdxOnlyEnvironment(env), siteId);
  let payload: JsonRecord;
  try {
    payload = JSON.parse(await base.text()) as JsonRecord;
  } catch {
    return base;
  }

  const errors = Array.isArray(payload.errors) ? [...payload.errors] : [];
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((entry) => !isRecord(entry) || !['bidders_empty', 'user_sync_empty'].includes(String(entry.code ?? '')))
    : [];

  if (!(await profileSupportsAdxOnly(env, mode.config))) {
    errors.push({
      code: 'generator_prebid_toggle_missing',
      area: 'generator_profile',
      message: 'The selected generator template does not contain ENABLE_PREBID and cannot produce an AdX-only release.',
    });
  }
  if (mode.savedBidders || mode.savedOverrides) {
    warnings.push({
      code: 'prebid_configuration_saved_inactive',
      area: 'bidders',
      message: `${mode.savedBidders} bidder(s) and ${mode.savedOverrides} override(s) are saved but inactive in AdX-only mode.`,
    });
  }

  const summary = isRecord(payload.summary) ? payload.summary : {};
  summary.demandMode = 'gam-adx-only';
  summary.prebidEnabled = false;
  summary.prebidBuildId = null;
  summary.prebidVersion = null;
  summary.requiredBidderModules = [];
  summary.requiredUserIdModules = [];
  summary.savedBidders = mode.savedBidders;
  summary.savedOverrides = mode.savedOverrides;

  payload.errors = errors;
  payload.warnings = warnings;
  payload.summary = summary;
  payload.ok = errors.length === 0;
  return json(payload, { status: errors.length ? 422 : 200 });
}

export async function generateReleaseForDemandMode(
  request: Request,
  env: ReleaseEnv,
  siteId: string,
): Promise<Response> {
  let mode: ModeState;
  try {
    mode = await readMode(env, siteId);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Demand mode could not be read.', 422);
  }
  if (mode.enabled) return generateReleaseWithFluidPreflight(request, env, siteId);
  if (!env.DB || !env.BUILDS) return apiError('D1 or R2 is not configured.', 503);
  if (!(await profileSupportsAdxOnly(env, mode.config))) {
    return apiError('The selected generator template does not contain ENABLE_PREBID.', 422);
  }

  const base = await generateReleaseWithFluidPreflight(request.clone(), withAdxOnlyEnvironment(env), siteId);
  const responseText = await base.text();
  let payload: JsonRecord;
  try {
    payload = JSON.parse(responseText) as JsonRecord;
  } catch {
    return new Response(responseText, { status: base.status, headers: base.headers });
  }
  if (!base.ok || !isRecord(payload.release)) return json(payload, { status: base.status });

  const release = payload.release;
  const releaseId = String(release.id ?? '');
  const version = String(release.version ?? '');
  if (!releaseId || !version) return json(payload, { status: base.status });

  try {
    const [adsJs, adsMinJs, configSource, manifestSource, implementationSource] = await Promise.all([
      readText(env.BUILDS, releaseKey(siteId, version, 'ads.js')),
      readText(env.BUILDS, releaseKey(siteId, version, 'ads.min.js')),
      readText(env.BUILDS, releaseKey(siteId, version, 'config.json')),
      readText(env.BUILDS, releaseKey(siteId, version, 'manifest.json')),
      readText(env.BUILDS, releaseKey(siteId, version, 'implementation.html')),
    ]);

    const patchedAdsJs = patchPrebidFlag(adsJs);
    const patchedAdsMinJs = patchPrebidFlag(adsMinJs);
    const implementation = omitPrebidScript(implementationSource);

    const config = parseRecord(configSource);
    config.demandMode = 'gam-adx-only';
    config.enablePrebid = false;
    config.prebidBuild = null;
    config.requiredBidderModules = [];
    config.requiredUserIdModules = [];
    config.savedBidderConfigurationPreserved = true;
    const configText = `${JSON.stringify(config, null, 2)}\n`;
    const configHash = await sha256Hex(configText);

    const manifest = parseRecord(manifestSource);
    manifest.demandMode = 'gam-adx-only';
    manifest.prebidEnabled = false;
    manifest.prebidBuild = null;
    manifest.configHash = configHash;
    addUniquePatch(manifest, 'ENABLE_PREBID=false · GAM/AdX-only release');
    const files = isRecord(manifest.files) ? manifest.files : {};
    const metadata = { siteId, releaseId, version, demandMode: 'gam-adx-only' };
    files['ads.js'] = await putText(env.BUILDS, releaseKey(siteId, version, 'ads.js'), patchedAdsJs, 'ads.js', metadata);
    files['ads.min.js'] = await putText(env.BUILDS, releaseKey(siteId, version, 'ads.min.js'), patchedAdsMinJs, 'ads.min.js', metadata);
    files['config.json'] = await putText(env.BUILDS, releaseKey(siteId, version, 'config.json'), configText, 'config.json', metadata);
    files['implementation.html'] = await putText(
      env.BUILDS,
      releaseKey(siteId, version, 'implementation.html'),
      implementation,
      'implementation.html',
      metadata,
    );
    manifest.files = files;
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await putText(env.BUILDS, releaseKey(siteId, version, 'manifest.json'), manifestText, 'manifest.json', metadata);

    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB
        .prepare('UPDATE releases SET config_hash = ? WHERE publisher_id = ? AND id = ?')
        .bind(configHash, siteId, releaseId),
      env.DB
        .prepare('UPDATE publisher_configs SET config_hash = ?, updated_at = ? WHERE publisher_id = ?')
        .bind(configHash, now, siteId),
      env.DB
        .prepare(`INSERT INTO audit_log (
          id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
        ) VALUES (?, ?, 'release.adx_only_compiled', ?, 'release', ?, ?, ?)`) 
        .bind(
          crypto.randomUUID(),
          request.headers.get('x-user-email') ?? 'system',
          siteId,
          releaseId,
          JSON.stringify({ version, enablePrebid: false, savedBidders: mode.savedBidders, savedOverrides: mode.savedOverrides }),
          now,
        ),
    ]);

    release.configHash = configHash;
    release.manifest = manifest;
    return json(payload, { status: base.status });
  } catch (error) {
    await env.DB
      .prepare("UPDATE releases SET status = 'failed' WHERE publisher_id = ? AND id = ?")
      .bind(siteId, releaseId)
      .run()
      .catch(() => undefined);
    return apiError(
      'AdX-only release was generated, but final demand-mode patching failed.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}
