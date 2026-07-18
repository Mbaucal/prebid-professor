import { apiError, json } from './http';
import {
  generateReleaseForDemandMode,
  validateReleaseForDemandMode,
} from './prebid-mode-release';
import type { ReleaseEnv } from './releases';

type JsonRecord = Record<string, unknown>;

type RuntimeControls = {
  sticky: {
    bottomAdUnitId: string;
    topAdUnitId: string;
    allowClosePortal: boolean;
  };
  floors: {
    enabled: boolean;
    currency: string;
    hardFloor: number;
    bidderFloors: JsonRecord;
    rules: JsonRecord;
  };
  output: {
    cleanComments: boolean;
  };
};

type ConfigState = {
  config: JsonRecord;
  controls: RuntimeControls;
  prebidEnabled: boolean;
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

function numericRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([rawKey, rawValue]) => {
    const key = rawKey.trim();
    const parsed = Number(rawValue);
    return key && Number.isFinite(parsed) && parsed >= 0 ? [[key, parsed]] : [];
  }));
}

function normalizeControls(config: JsonRecord, adUnitCodes: string[]): RuntimeControls {
  const runtime = isRecord(config.runtimeControls) ? config.runtimeControls : {};
  const sticky = isRecord(runtime.sticky) ? runtime.sticky : {};
  const floors = isRecord(runtime.floors) ? runtime.floors : {};
  const output = isRecord(runtime.output) ? runtime.output : {};
  const bottom = typeof sticky.bottomAdUnitId === 'string'
    ? sticky.bottomAdUnitId.trim()
    : adUnitCodes.includes('Sticky') ? 'Sticky' : '';
  const top = typeof sticky.topAdUnitId === 'string' ? sticky.topAdUnitId.trim() : '';
  const currency = String(floors.currency ?? 'EUR').trim().toUpperCase();
  const hardFloor = Number(floors.hardFloor);

  return {
    sticky: {
      bottomAdUnitId: bottom,
      topAdUnitId: top,
      allowClosePortal: sticky.allowClosePortal === true,
    },
    floors: {
      enabled: floors.enabled !== false,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : 'EUR',
      hardFloor: Number.isFinite(hardFloor) && hardFloor >= 0 ? hardFloor : 0.04,
      bidderFloors: numericRecord(floors.bidderFloors),
      rules: numericRecord(floors.rules),
    },
    output: {
      cleanComments: output.cleanComments !== false,
    },
  };
}

async function readConfigState(env: ReleaseEnv, siteId: string): Promise<ConfigState> {
  if (!env.DB) throw new Error('D1 is not configured.');
  const [configRow, units] = await Promise.all([
    env.DB
      .prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
      .bind(siteId)
      .first<{ config_json: string }>(),
    env.DB
      .prepare('SELECT code FROM ad_units WHERE publisher_id = ? ORDER BY sort_order, code COLLATE NOCASE')
      .bind(siteId)
      .all<{ code: string }>(),
  ]);
  if (!configRow) throw new Error('Publisher config was not found.');
  const config = parseRecord(configRow.config_json);
  return {
    config,
    controls: normalizeControls(config, (units.results ?? []).map((unit) => unit.code)),
    prebidEnabled: config.enablePrebid !== false,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function jsonLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function replaceVar(source: string, name: string, value: unknown, required = true): string {
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

function ensureVarAfter(source: string, anchorName: string, name: string, value: unknown): string {
  const existing = new RegExp(`^\\s*(?:var|let|const)\\s+${escapeRegExp(name)}\\s*=`, 'm');
  if (existing.test(source)) return replaceVar(source, name, value, false);
  const anchor = new RegExp(
    `^(\\s*(?:var|let|const)\\s+${escapeRegExp(anchorName)}\\s*=\\s*.*?;[\\t ]*)$`,
    'm',
  );
  if (!anchor.test(source)) throw new Error(`Generated runtime does not contain variable ${anchorName}.`);
  return source.replace(anchor, `$1\\n  var ${name} = ${jsonLiteral(value)};`);
}

function replaceWindowValue(source: string, name: string, value: unknown): string {
  const pattern = new RegExp(`^(\\s*window\\.${escapeRegExp(name)}\\s*=\\s*).*?(;[\\t ]*)$`, 'm');
  if (!pattern.test(source)) return source;
  return source.replace(pattern, (_match, prefix: string, suffix: string) => `${prefix}${jsonLiteral(value)}${suffix}`);
}

function ensureWindowMetadata(
  source: string,
  profileId: string,
  profileVersion: string,
): string {
  source = replaceWindowValue(source, 'ADOPS_GENERATOR_PROFILE', profileId);
  source = replaceWindowValue(source, 'ADOPS_GENERATOR_PROFILE_ID', profileId);
  source = replaceWindowValue(source, 'ADOPS_GENERATOR_PROFILE_VERSION', profileVersion);

  const marker = /^(\s*window\.ADOPS_GENERATOR_PROFILE\s*=\s*[^;]+;[\t ]*)$/m;
  if (!marker.test(source)) return source;
  const additions: string[] = [];
  if (!/window\.ADOPS_GENERATOR_PROFILE_ID\s*=/.test(source)) {
    additions.push(`      window.ADOPS_GENERATOR_PROFILE_ID = ${jsonLiteral(profileId)};`);
  }
  if (!/window\.ADOPS_GENERATOR_PROFILE_VERSION\s*=/.test(source)) {
    additions.push(`      window.ADOPS_GENERATOR_PROFILE_VERSION = ${jsonLiteral(profileVersion)};`);
  }
  return additions.length ? source.replace(marker, `$1\\n${additions.join('\\n')}`) : source;
}

function patchGenericSticky(source: string): string {
  const start = source.indexOf('  function _q(sel)');
  const end = source.indexOf('/* Fallback:', start >= 0 ? start : 0);
  if (start >= 0 && end > start) {
    const replacement = `  function _q(sel){ try{ return document.querySelector(sel); }catch(_){ return null; } }

  function findStickyHost(id, position){
    if (!id) return null;
    return document.getElementById(id) ||
      _q('[data-ad="'+id+'"], [data-slot="'+id+'"], [data-sticky-position="'+position+'"]');
  }

  function getStickyHost(){ return findStickyHost(STICKY_TARGET_ID, 'bottom'); }
  function getStickyTopHost(){ return findStickyHost(STICKY_TOP_TARGET_ID, 'top'); }
  window.getStickyHost = getStickyHost;
  window.getStickyTopHost = getStickyTopHost;

`;
    source = `${source.slice(0, start)}${replacement}${source.slice(end)}`;
  }
  return source
    .replace(/__cvjTopBound/g, '__ppStickyTopBound')
    .replace(/__cvjBound/g, '__ppStickyBound')
    .replace(/adsx-sticky-top-css/g, 'pp-sticky-top-css')
    .replace(/adsx-sticky-css/g, 'pp-sticky-css')
    .replace(/\.cvj-sticky-top,\s*\.cvj_sticky_top,\s*/g, '')
    .replace(/\.cvj-sticky,\s*\.cvj_sticky,\s*/g, '');
}

function patchFloors(source: string, controls: RuntimeControls): string {
  const enabled = controls.floors.enabled;
  source = replaceVar(source, 'AD_SERVER_CURRENCY', controls.floors.currency, false);
  source = replaceVar(source, 'HARD_FLOOR_EUR', enabled ? controls.floors.hardFloor : 0, true);
  source = replaceVar(source, 'BIDDER_FLOORS', enabled ? controls.floors.bidderFloors : {}, true);
  source = ensureVarAfter(source, 'BIDDER_FLOORS', 'FLOOR_RULES', enabled ? controls.floors.rules : {});

  const enabledPattern = /(floors\s*:\s*\{\s*enabled\s*:\s*)(?:true|false)/;
  if (!enabledPattern.test(source)) throw new Error('Generated runtime floor configuration was not found.');
  source = source.replace(enabledPattern, `$1${enabled ? 'true' : 'false'}`);

  const extraPattern = /var\s+extra\s*=\s*(?:\/\*[\s\S]*?\*\/\s*)?\{\s*\}\s*;/;
  if (extraPattern.test(source)) source = source.replace(extraPattern, 'var extra = FLOOR_RULES;');
  else if (!source.includes('var extra = FLOOR_RULES;')) {
    throw new Error('Generated runtime custom floor-rule insertion point was not found.');
  }
  return source;
}

function stripTrailingLineComment(line: string): string {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < line.length - 1; index += 1) {
    const character = line[index];
    const next = line[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '/' && next === '/') return line.slice(0, index).replace(/[\t ]+$/g, '');
  }
  return line;
}

function stripLegacyComments(source: string): string {
  const output: string[] = [];
  let insideBlock = false;
  let previousBlank = false;
  for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = rawLine.trim();
    if (insideBlock) {
      if (trimmed.includes('*/')) insideBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) insideBlock = true;
      continue;
    }
    if (trimmed.startsWith('//')) continue;

    let line = rawLine.replace(/\s*\/\*.*?\*\/\s*/g, ' ');
    line = stripTrailingLineComment(line).replace(/[\t ]+$/g, '');
    const blank = line.trim() === '';
    if (blank && previousBlank) continue;
    output.push(line);
    previousBlank = blank;
  }
  return output.join('\n').trim();
}

function generatedHeader(
  siteId: string,
  version: string,
  profileId: string,
  profileVersion: string,
): string {
  return `/*!
 * Prebid Professor generated runtime
 * Site: ${siteId}
 * Release: ${version}
 * Generator profile: ${profileId}
 * Runtime version: ${profileVersion}
 * Generated artifact. Do not edit manually.
 */`;
}

function patchRuntime(
  source: string,
  controls: RuntimeControls,
  siteId: string,
  version: string,
  profileId: string,
  profileVersion: string,
): string {
  source = replaceVar(source, 'STICKY_TARGET_ID', controls.sticky.bottomAdUnitId, false);
  source = replaceVar(source, 'STICKY_TOP_TARGET_ID', controls.sticky.topAdUnitId, false);
  source = replaceVar(source, 'ALLOW_CLOSE_PORTAL', controls.sticky.allowClosePortal, false);
  source = patchGenericSticky(source);
  source = patchFloors(source, controls);
  source = ensureWindowMetadata(source, profileId, profileVersion);
  if (controls.output.cleanComments) {
    source = `${generatedHeader(siteId, version, profileId, profileVersion)}\n${stripLegacyComments(source)}\n`;
  }
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
    httpMetadata: { contentType: contentType(fileName), cacheControl: 'public, max-age=31536000, immutable' },
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

async function currentPrebidModules(env: ReleaseEnv, siteId: string): Promise<string[]> {
  if (!env.DB) return [];
  const row = await env.DB
    .prepare(`SELECT modules_json FROM prebid_builds
              WHERE publisher_id = ? AND status = 'current'
              ORDER BY uploaded_at DESC LIMIT 1`)
    .bind(siteId)
    .first<{ modules_json: string }>();
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.modules_json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export async function validateReleaseWithRuntimeControls(
  env: ReleaseEnv,
  siteId: string,
): Promise<Response> {
  let state: ConfigState;
  try {
    state = await readConfigState(env, siteId);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Runtime controls could not be read.', 422);
  }

  const base = await validateReleaseForDemandMode(env, siteId);
  let payload: JsonRecord;
  try {
    payload = JSON.parse(await base.text()) as JsonRecord;
  } catch {
    return base;
  }

  const errors = Array.isArray(payload.errors) ? [...payload.errors] : [];
  if (state.prebidEnabled && state.controls.floors.enabled) {
    const modules = await currentPrebidModules(env, siteId);
    if (!modules.includes('priceFloors')) {
      errors.push({
        code: 'prebid_module_missing',
        area: 'runtime_controls',
        message: 'Current Prebid.js is missing priceFloors while floor enforcement is enabled.',
      });
    }
  }

  const summary = isRecord(payload.summary) ? payload.summary : {};
  summary.runtimeControls = state.controls;
  summary.floorModuleRequired = state.prebidEnabled && state.controls.floors.enabled;
  payload.summary = summary;
  payload.errors = errors;
  payload.ok = errors.length === 0;
  return json(payload, { status: errors.length ? 422 : 200 });
}

export async function generateReleaseWithRuntimeControls(
  request: Request,
  env: ReleaseEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB || !env.BUILDS) return apiError('D1 or R2 is not configured.', 503);

  let state: ConfigState;
  try {
    state = await readConfigState(env, siteId);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Runtime controls could not be read.', 422);
  }

  if (state.prebidEnabled && state.controls.floors.enabled) {
    const modules = await currentPrebidModules(env, siteId);
    if (!modules.includes('priceFloors')) {
      return apiError('Current Prebid.js is missing priceFloors while floor enforcement is enabled.', 422);
    }
  }

  const base = await generateReleaseForDemandMode(request.clone(), env, siteId);
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

    const manifest = parseRecord(manifestSource);
    const profile = isRecord(manifest.generatorProfile) ? manifest.generatorProfile : {};
    const profileId = String(profile.id ?? 'unknown-profile');
    const profileVersion = String(profile.version ?? 'unknown');
    const patchedAds = patchRuntime(adsSource, state.controls, siteId, version, profileId, profileVersion);
    const patchedAdsMin = patchRuntime(adsMinSource, state.controls, siteId, version, profileId, profileVersion);

    const config = parseRecord(configSource);
    config.runtimeControls = state.controls;
    config.requiredRuntimeModules = state.prebidEnabled && state.controls.floors.enabled ? ['priceFloors'] : [];
    const configText = `${JSON.stringify(config, null, 2)}\n`;
    const configHash = await sha256Hex(configText);

    manifest.runtimeControls = state.controls;
    manifest.configHash = configHash;
    addCompilerPatch(manifest, 'clean generated runtime comments and English header');
    addCompilerPatch(manifest, 'generic sticky host selectors');
    addCompilerPatch(manifest, 'runtime floor controls');

    const files = isRecord(manifest.files) ? manifest.files : {};
    const metadata = { siteId, releaseId, version, runtimeControls: 'v1' };
    files['ads.js'] = await putText(env.BUILDS, releaseKey(siteId, version, 'ads.js'), patchedAds, 'ads.js', metadata);
    files['ads.min.js'] = await putText(env.BUILDS, releaseKey(siteId, version, 'ads.min.js'), patchedAdsMin, 'ads.min.js', metadata);
    files['config.json'] = await putText(env.BUILDS, releaseKey(siteId, version, 'config.json'), configText, 'config.json', metadata);
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
        ) VALUES (?, ?, 'release.runtime_controls_compiled', ?, 'release', ?, ?, ?)`) 
        .bind(
          crypto.randomUUID(),
          request.headers.get('x-user-email') ?? 'system',
          siteId,
          releaseId,
          JSON.stringify({ version, runtimeControls: state.controls }),
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
      'Release was generated, but runtime-control post-processing failed.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}
