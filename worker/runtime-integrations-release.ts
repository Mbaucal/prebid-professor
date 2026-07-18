import { apiError, json } from './http';
import {
  publishReleaseToProduction,
  type ReleaseEnv,
} from './releases';
import {
  generateReleaseWithRuntimeControls,
  validateReleaseWithRuntimeControls,
} from './runtime-controls-release';

type JsonRecord = Record<string, unknown>;

type IntegrationState = {
  schain: {
    configured: boolean;
    enabled: boolean;
    version: string;
    complete: 0 | 1;
    nodes: JsonRecord[];
  };
  consent: {
    mode: 'cmp' | 'contextual-test';
  };
};

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

function normalizeNodes(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((node): node is JsonRecord => isRecord(node)).map((node) => {
    const output: JsonRecord = {
      asi: String(node.asi ?? '').trim().toLowerCase(),
      sid: String(node.sid ?? '').trim(),
      hp: Number(node.hp) === 0 ? 0 : 1,
    };
    for (const key of ['rid', 'name', 'domain'] as const) {
      const candidate = String(node[key] ?? '').trim();
      if (candidate) output[key] = key === 'domain' ? candidate.toLowerCase() : candidate;
    }
    return output;
  }).filter((node) => Boolean(node.asi) && Boolean(node.sid));
}

async function readIntegrationState(env: ReleaseEnv, siteId: string): Promise<IntegrationState> {
  if (!env.DB) throw new Error('D1 is not configured.');
  const row = await env.DB
    .prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
    .bind(siteId)
    .first<{ config_json: string }>();
  if (!row) throw new Error('Publisher config was not found.');

  const config = parseRecord(row.config_json);
  const runtime = isRecord(config.runtimeControls) ? config.runtimeControls : {};
  const schainConfigured = isRecord(runtime.schain);
  const schain = schainConfigured ? runtime.schain as JsonRecord : {};
  const consent = isRecord(runtime.consent) ? runtime.consent : {};
  const version = String(schain.version ?? '1.0').trim();

  return {
    schain: {
      configured: schainConfigured,
      enabled: schainConfigured ? schain.enabled !== false : false,
      version: /^\d+\.\d+$/.test(version) ? version : '1.0',
      complete: Number(schain.complete) === 0 ? 0 : 1,
      nodes: normalizeNodes(schain.nodes),
    },
    consent: {
      mode: consent.mode === 'contextual-test' ? 'contextual-test' : 'cmp',
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function jsonLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function replaceVar(source: string, name: string, value: unknown, required: boolean): string {
  const pattern = new RegExp(
    `^(\\s*(?:var|let|const)\\s+${escapeRegExp(name)}\\s*=\\s*).*?(;\\s*(?://[^\\r\\n]*)?[\\t ]*)$`,
    'm',
  );
  if (!pattern.test(source)) {
    if (required) throw new Error(`Generated runtime does not contain variable ${name}.`);
    return source;
  }
  return source.replace(pattern, (_match, prefix: string, suffix: string) => `${prefix}${jsonLiteral(value)}${suffix}`);
}

function patchRuntime(source: string, state: IntegrationState): string {
  if (state.schain.configured) {
    const value = state.schain.enabled
      ? {
          ver: state.schain.version,
          complete: state.schain.complete,
          nodes: state.schain.nodes,
        }
      : null;
    source = replaceVar(source, 'SCHAIN_CONFIG', value, true);
  }
  source = replaceVar(source, 'CMP_MODE', state.consent.mode, state.consent.mode === 'contextual-test');
  return source;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function contentType(fileName: string): string {
  if (fileName.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (fileName.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function releaseKey(siteId: string, version: string, fileName: string): string {
  return `publishers/${siteId}/releases/${version}/${fileName}`;
}

async function readText(bucket: R2Bucket, key: string): Promise<string> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`${key} is missing from R2.`);
  return object.text();
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
    httpMetadata: {
      contentType: contentType(fileName),
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: { ...metadata, fileName, sha256 },
  });
  return { key, size: bytes.byteLength, sha256, contentType: contentType(fileName) };
}

function addCompilerPatch(manifest: JsonRecord, patch: string): void {
  const compiler = isRecord(manifest.compiler) ? manifest.compiler : {};
  const patches = Array.isArray(compiler.patches) ? compiler.patches.map(String) : [];
  compiler.patches = Array.from(new Set([...patches, patch]));
  manifest.compiler = compiler;
}

export async function validateReleaseWithIntegrations(
  env: ReleaseEnv,
  siteId: string,
): Promise<Response> {
  let state: IntegrationState;
  try {
    state = await readIntegrationState(env, siteId);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Integration settings could not be read.', 422);
  }

  const base = await validateReleaseWithRuntimeControls(env, siteId);
  let payload: JsonRecord;
  try {
    payload = JSON.parse(await base.text()) as JsonRecord;
  } catch {
    return base;
  }

  const warnings = Array.isArray(payload.warnings) ? [...payload.warnings] : [];
  if (state.consent.mode === 'contextual-test') {
    warnings.push({
      code: 'contextual_test_mode',
      area: 'consent',
      message: 'Contextual no-CMP test mode is enabled. This release is staging-only and cannot be published to production.',
    });
  }

  const summary = isRecord(payload.summary) ? payload.summary : {};
  summary.schain = state.schain.configured
    ? state.schain.enabled ? `${state.schain.nodes.length} node(s)` : 'disabled'
    : 'template default';
  summary.consentMode = state.consent.mode;
  payload.summary = summary;
  payload.warnings = warnings;
  return json(payload, { status: base.status });
}

export async function generateReleaseWithIntegrations(
  request: Request,
  env: ReleaseEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB || !env.BUILDS) return apiError('D1 or R2 is not configured.', 503);

  let state: IntegrationState;
  try {
    state = await readIntegrationState(env, siteId);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Integration settings could not be read.', 422);
  }

  const base = await generateReleaseWithRuntimeControls(request.clone(), env, siteId);
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
    const [adsSource, adsMinSource, configSource, manifestSource] = await Promise.all([
      readText(env.BUILDS, releaseKey(siteId, version, 'ads.js')),
      readText(env.BUILDS, releaseKey(siteId, version, 'ads.min.js')),
      readText(env.BUILDS, releaseKey(siteId, version, 'config.json')),
      readText(env.BUILDS, releaseKey(siteId, version, 'manifest.json')),
    ]);

    const patchedAds = patchRuntime(adsSource, state);
    const patchedAdsMin = patchRuntime(adsMinSource, state);
    const config = parseRecord(configSource);
    config.runtimeIntegrations = state;
    const configText = `${JSON.stringify(config, null, 2)}\n`;
    const configHash = await sha256Hex(configText);

    const manifest = parseRecord(manifestSource);
    manifest.runtimeIntegrations = state;
    manifest.configHash = configHash;
    if (state.schain.configured) addCompilerPatch(manifest, 'site-level OpenRTB SupplyChain');
    addCompilerPatch(manifest, `consent mode: ${state.consent.mode}`);

    const files = isRecord(manifest.files) ? manifest.files : {};
    const metadata = { siteId, releaseId, version, runtimeIntegrations: 'v1' };
    files['ads.js'] = await putText(env.BUILDS, releaseKey(siteId, version, 'ads.js'), patchedAds, 'ads.js', metadata);
    files['ads.min.js'] = await putText(env.BUILDS, releaseKey(siteId, version, 'ads.min.js'), patchedAdsMin, 'ads.min.js', metadata);
    files['config.json'] = await putText(env.BUILDS, releaseKey(siteId, version, 'config.json'), configText, 'config.json', metadata);
    manifest.files = files;
    await putText(
      env.BUILDS,
      releaseKey(siteId, version, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'manifest.json',
      metadata,
    );

    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB
        .prepare('UPDATE releases SET config_hash = ? WHERE publisher_id = ? AND id = ?')
        .bind(configHash, siteId, releaseId),
      env.DB
        .prepare('UPDATE publisher_configs SET config_hash = ?, updated_at = ? WHERE publisher_id = ?')
        .bind(configHash, now, siteId),
      env.DB.prepare(`INSERT INTO audit_log (
        id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
      ) VALUES (?, ?, 'release.runtime_integrations_compiled', ?, 'release', ?, ?, ?)`) 
        .bind(
          crypto.randomUUID(),
          request.headers.get('x-user-email') ?? 'system',
          siteId,
          releaseId,
          JSON.stringify({ version, runtimeIntegrations: state }),
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
      'Release was generated, but SChain/consent post-processing failed.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function publishProductionWithConsentGuard(
  request: Request,
  env: ReleaseEnv,
  siteId: string,
  releaseId: string,
): Promise<Response> {
  if (!env.DB || !env.BUILDS) return apiError('D1 or R2 is not configured.', 503);
  const row = await env.DB
    .prepare('SELECT version, status, manifest_key FROM releases WHERE publisher_id = ? AND id = ? LIMIT 1')
    .bind(siteId, releaseId)
    .first<{ version: string; status: string; manifest_key: string | null }>();
  if (!row) return apiError('Release not found.', 404);
  if (row.status !== 'staging') return apiError('A release must be published to staging before production.', 409);

  if (row.manifest_key) {
    const object = await env.BUILDS.get(row.manifest_key);
    if (object) {
      const manifest = parseRecord(await object.text());
      const integrations = isRecord(manifest.runtimeIntegrations) ? manifest.runtimeIntegrations : {};
      const consent = isRecord(integrations.consent) ? integrations.consent : {};
      if (consent.mode === 'contextual-test') {
        return apiError(
          'Contextual no-CMP test releases are staging-only. Switch back to Standard CMP and generate a new release.',
          409,
        );
      }
    }
  }

  return publishReleaseToProduction(request, env, siteId, releaseId);
}
