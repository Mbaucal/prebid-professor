import { apiError, json } from './http';
import {
  generateRelease as generateBaseRelease,
  validateRelease as validateBaseRelease,
  type ReleaseEnv,
} from './releases';

type JsonRecord = Record<string, unknown>;
type FixedSize = [number, number];
type FlexibleSize = FixedSize | 'fluid';
type FlexibleBreakpoint = { minViewPort: [number, number]; sizes: FlexibleSize[] };
type RawMap = { id: string; name: string; map: FlexibleBreakpoint[] };
type AdUnitRow = {
  code: string;
  type: string;
  media_type: string;
  size_map_key: string | null;
  enabled: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sizeKey(size: FlexibleSize): string {
  return size === 'fluid' ? 'fluid' : `${size[0]}x${size[1]}`;
}

function parseFlexibleMap(value: string): FlexibleBreakpoint[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const output: FlexibleBreakpoint[] = [];
    for (const raw of parsed) {
      if (!isRecord(raw) || !Array.isArray(raw.minViewPort) || !Array.isArray(raw.sizes)) continue;
      const width = Number(raw.minViewPort[0] ?? 0);
      const height = Number(raw.minViewPort[1] ?? 0);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) continue;
      const sizes: FlexibleSize[] = [];
      for (const rawSize of raw.sizes) {
        if (typeof rawSize === 'string' && rawSize.trim().toLowerCase() === 'fluid') {
          sizes.push('fluid');
          continue;
        }
        if (!Array.isArray(rawSize) || rawSize.length !== 2) continue;
        const sizeWidth = Number(rawSize[0]);
        const sizeHeight = Number(rawSize[1]);
        if (!Number.isInteger(sizeWidth) || !Number.isInteger(sizeHeight) || sizeWidth <= 0 || sizeHeight <= 0) continue;
        sizes.push([sizeWidth, sizeHeight]);
      }
      const unique = Array.from(new Map(sizes.map((size) => [sizeKey(size), size])).values());
      output.push({ minViewPort: [width, height], sizes: unique });
    }
    return output.sort((a, b) => a.minViewPort[0] - b.minViewPort[0] || a.minViewPort[1] - b.minViewPort[1]);
  } catch {
    return [];
  }
}

async function loadMapsAndUnits(env: ReleaseEnv, siteId: string): Promise<{ maps: RawMap[]; units: AdUnitRow[] }> {
  if (!env.DB) throw new Error('D1 is not configured.');
  const [mapResult, unitResult] = await Promise.all([
    env.DB.prepare('SELECT id, name, map_json FROM size_maps WHERE publisher_id = ? ORDER BY name COLLATE NOCASE')
      .bind(siteId)
      .all<{ id: string; name: string; map_json: string }>(),
    env.DB.prepare(`SELECT code, type, media_type, size_map_key, enabled
                    FROM ad_units WHERE publisher_id = ? ORDER BY sort_order, code COLLATE NOCASE`)
      .bind(siteId)
      .all<AdUnitRow>(),
  ]);
  return {
    maps: (mapResult.results ?? []).map((row) => ({ id: row.id, name: row.name, map: parseFlexibleMap(row.map_json) })),
    units: unitResult.results ?? [],
  };
}

function mapUsesSpecialSizes(map: FlexibleBreakpoint[]): boolean {
  return map.some((breakpoint) => breakpoint.sizes.length === 0 || breakpoint.sizes.some((size) => size === 'fluid'));
}

function unionSizes(map: FlexibleBreakpoint[]): FlexibleSize[] {
  const fixed = new Map<string, FixedSize>();
  let fluid = false;
  for (const breakpoint of map) {
    for (const size of breakpoint.sizes) {
      if (size === 'fluid') fluid = true;
      else fixed.set(sizeKey(size), size);
    }
  }
  const result: FlexibleSize[] = Array.from(fixed.values()).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  if (fluid) result.push('fluid');
  return result;
}

function buildRuntimeMapData(maps: RawMap[], units: AdUnitRow[]): { sizeMapsRaw: JsonRecord; explicitUnits: JsonRecord[] } {
  const mapByName = new Map(maps.map((entry) => [entry.name, entry.map]));
  const sizeMapsRaw: JsonRecord = {};
  for (const entry of maps) {
    sizeMapsRaw[entry.name] = entry.map.map((breakpoint) => ({
      viewport: breakpoint.minViewPort,
      sizes: breakpoint.sizes,
    }));
  }

  const explicitUnits = units
    .filter((unit) => unit.enabled === 1 && unit.type !== 'DRAFT')
    .map((unit) => {
      const map = unit.size_map_key ? mapByName.get(unit.size_map_key) ?? [] : [];
      return {
        id: unit.code,
        type: unit.type,
        formats: [unit.media_type || 'banner'],
        sizes: unionSizes(map),
        video: null,
        native: null,
        sizeMapName: unit.size_map_key,
        prebidSizeConfigName: unit.size_map_key,
        properties: [],
      };
    });

  return { sizeMapsRaw, explicitUnits };
}

function jsonLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function replaceVar(source: string, name: string, value: unknown): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^(\\s*var\\s+${escaped}\\s*=\\s*).*?(;\\s*(?://[^\\r\\n]*)?[\\t ]*)$`, 'm');
  if (!pattern.test(source)) throw new Error(`Generated runtime does not contain variable ${name}.`);
  return source.replace(pattern, (_match, prefix: string, suffix: string) => `${prefix}${jsonLiteral(value)}${suffix}`);
}

function activeBreakpoint(map: FlexibleBreakpoint[], width: number): FlexibleBreakpoint | null {
  let selected: FlexibleBreakpoint | null = null;
  for (const breakpoint of map) {
    if (breakpoint.minViewPort[0] <= width) selected = breakpoint;
  }
  return selected ?? map[0] ?? null;
}

function cssEscape(value: string): string {
  return value.replace(/([^A-Za-z0-9_-])/g, '\\$1');
}

function generateMinHeightCss(maps: RawMap[], units: AdUnitRow[]): string {
  const enabledUnits = units.filter((unit) => unit.enabled === 1 && unit.type !== 'DRAFT' && unit.size_map_key);
  const mapByName = new Map(maps.map((entry) => [entry.name, entry.map]));
  const widths = new Set<number>([0]);
  for (const unit of enabledUnits) {
    for (const breakpoint of mapByName.get(unit.size_map_key!) ?? []) widths.add(breakpoint.minViewPort[0]);
  }

  const output = [
    '/* Generated by Prebid Professor. */',
    '/* fluid has no deterministic fixed height; empty breakpoint arrays disable the slot at that viewport. */',
  ];
  for (const width of Array.from(widths).sort((a, b) => a - b)) {
    const groups = new Map<number, string[]>();
    for (const unit of enabledUnits) {
      const breakpoint = activeBreakpoint(mapByName.get(unit.size_map_key!) ?? [], width);
      const fixedSizes = (breakpoint?.sizes ?? []).filter((size): size is FixedSize => Array.isArray(size));
      const height = fixedSizes.reduce((max, size) => Math.max(max, size[1]), 0);
      if (!height) continue;
      groups.set(height, [...(groups.get(height) ?? []), `#${cssEscape(unit.code)}`]);
    }
    const rules = Array.from(groups.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([height, selectors]) => `${selectors.join(', ')} { min-height: ${height}px; }`);
    if (!rules.length) continue;
    if (width === 0) output.push('', '/* 0px and above */', ...rules);
    else output.push('', `/* >= ${width}px */`, `@media (min-width: ${width}px) {`, ...rules.map((rule) => `  ${rule}`), '}');
  }
  return `${output.join('\n').trim()}\n`;
}

function contentType(fileName: string): string {
  if (fileName.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (fileName.endsWith('.json')) return 'application/json; charset=utf-8';
  if (fileName.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function putText(
  bucket: R2Bucket,
  key: string,
  body: string,
  fileName: string,
  metadata: Record<string, string>,
): Promise<JsonRecord> {
  const sha256 = await sha256Hex(body);
  const bytes = new TextEncoder().encode(body);
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: contentType(fileName), cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { ...metadata, fileName, sha256 },
  });
  return { key, size: bytes.byteLength, sha256, contentType: contentType(fileName) };
}

function releaseKey(siteId: string, version: string, fileName: string): string {
  return `publishers/${siteId}/releases/${version}/${fileName}`;
}

async function readText(bucket: R2Bucket, key: string): Promise<string> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`${key} is missing from R2.`);
  return object.text();
}

function uniqueWarnings(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = typeof value === 'string' ? value : JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function validateReleaseWithFlexibleSizes(
  env: ReleaseEnv,
  siteId: string,
): Promise<Response> {
  const base = await validateBaseRelease(env, siteId);
  let payload: JsonRecord;
  try {
    payload = JSON.parse(await base.text()) as JsonRecord;
  } catch {
    return base;
  }
  if (!env.DB) return json(payload, { status: base.status });

  const { maps } = await loadMapsAndUnits(env, siteId);
  const validMapNames = new Set(maps.filter((entry) => entry.map.length && entry.map.some((bp) => bp.sizes.length)).map((entry) => entry.name));
  const rawErrors = Array.isArray(payload.errors) ? payload.errors : [];
  const filteredErrors = rawErrors.filter((value) => {
    if (!isRecord(value) || value.code !== 'size_map_empty') return true;
    const message = String(value.message ?? '');
    return !Array.from(validMapNames).some((name) => message.includes(name));
  });

  const warnings = Array.isArray(payload.warnings) ? [...payload.warnings] : [];
  for (const entry of maps) {
    if (entry.map.some((breakpoint) => breakpoint.sizes.some((size) => size === 'fluid'))) {
      warnings.push({
        code: 'fluid_gpt_only',
        area: 'size_maps',
        message: `${entry.name} contains fluid. GPT can request fluid/native; fluid is intentionally excluded from Prebid banner sizes.`,
      });
    }
    if (entry.map.some((breakpoint) => breakpoint.sizes.length === 0)) {
      warnings.push({
        code: 'disabled_breakpoint',
        area: 'size_maps',
        message: `${entry.name} contains an empty breakpoint. The slot is disabled when that viewport rule is active.`,
      });
    }
  }

  payload.errors = filteredErrors;
  payload.warnings = uniqueWarnings(warnings);
  payload.ok = filteredErrors.length === 0;
  return json(payload, { status: filteredErrors.length ? 422 : 200 });
}

export async function generateReleaseWithFlexibleSizes(
  request: Request,
  env: ReleaseEnv,
  siteId: string,
): Promise<Response> {
  const baseResponse = await generateBaseRelease(request.clone(), env, siteId);
  const responseText = await baseResponse.text();
  let payload: JsonRecord;
  try {
    payload = JSON.parse(responseText) as JsonRecord;
  } catch {
    return new Response(responseText, { status: baseResponse.status, headers: baseResponse.headers });
  }
  if (!baseResponse.ok || !env.DB || !env.BUILDS || !isRecord(payload.release)) {
    return json(payload, { status: baseResponse.status });
  }

  const release = payload.release;
  const releaseId = String(release.id ?? '');
  const version = String(release.version ?? '');
  if (!releaseId || !version) return json(payload, { status: baseResponse.status });

  try {
    const { maps, units } = await loadMapsAndUnits(env, siteId);
    if (!maps.some((entry) => mapUsesSpecialSizes(entry.map))) {
      return json(payload, { status: baseResponse.status });
    }

    const runtime = buildRuntimeMapData(maps, units);
    const [adsSource, adsMinSource, configSource, manifestSource] = await Promise.all([
      readText(env.BUILDS, releaseKey(siteId, version, 'ads.js')),
      readText(env.BUILDS, releaseKey(siteId, version, 'ads.min.js')),
      readText(env.BUILDS, releaseKey(siteId, version, 'config.json')),
      readText(env.BUILDS, releaseKey(siteId, version, 'manifest.json')),
    ]);

    const patchedAds = replaceVar(replaceVar(adsSource, 'EXPLICIT_UNITS', runtime.explicitUnits), 'SIZE_MAPS_RAW', runtime.sizeMapsRaw);
    const patchedAdsMin = replaceVar(replaceVar(adsMinSource, 'EXPLICIT_UNITS', runtime.explicitUnits), 'SIZE_MAPS_RAW', runtime.sizeMapsRaw);
    const css = generateMinHeightCss(maps, units);

    const config = JSON.parse(configSource) as JsonRecord;
    config.sizeMaps = maps.map((entry) => ({ name: entry.name, map: entry.map }));
    const compiler = isRecord(config.compiler) ? config.compiler : {};
    const compilerPatches = Array.isArray(compiler.patches) ? compiler.patches : [];
    compiler.patches = Array.from(new Set([...compilerPatches.map(String), 'fluid and disabled size-map breakpoints']));
    config.compiler = compiler;
    const configText = `${JSON.stringify(config, null, 2)}\n`;
    const configHash = await sha256Hex(configText);

    const manifest = JSON.parse(manifestSource) as JsonRecord;
    const files = isRecord(manifest.files) ? manifest.files : {};
    const metadata = { siteId, releaseId, version, compatibility: 'fluid-empty-size-map-v1' };
    files['ads.js'] = await putText(env.BUILDS, releaseKey(siteId, version, 'ads.js'), patchedAds, 'ads.js', metadata);
    files['ads.min.js'] = await putText(env.BUILDS, releaseKey(siteId, version, 'ads.min.js'), patchedAdsMin, 'ads.min.js', metadata);
    files['config.json'] = await putText(env.BUILDS, releaseKey(siteId, version, 'config.json'), configText, 'config.json', metadata);
    files['min-height.css'] = await putText(env.BUILDS, releaseKey(siteId, version, 'min-height.css'), css, 'min-height.css', metadata);
    manifest.files = files;
    manifest.configHash = configHash;
    const manifestCompiler = isRecord(manifest.compiler) ? manifest.compiler : {};
    const manifestPatches = Array.isArray(manifestCompiler.patches) ? manifestCompiler.patches : [];
    manifestCompiler.patches = Array.from(new Set([...manifestPatches.map(String), 'fluid and disabled size-map breakpoints']));
    manifest.compiler = manifestCompiler;
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await putText(env.BUILDS, releaseKey(siteId, version, 'manifest.json'), manifestText, 'manifest.json', metadata);

    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare('UPDATE releases SET config_hash = ? WHERE publisher_id = ? AND id = ?')
        .bind(configHash, siteId, releaseId),
      env.DB.prepare('UPDATE publisher_configs SET config_hash = ?, updated_at = ? WHERE publisher_id = ?')
        .bind(configHash, now, siteId),
    ]);

    release.configHash = configHash;
    release.manifest = manifest;
    return json(payload, { status: baseResponse.status });
  } catch (error) {
    await env.DB.prepare(`UPDATE releases SET status = 'failed' WHERE publisher_id = ? AND id = ?`)
      .bind(siteId, releaseId)
      .run()
      .catch(() => undefined);
    return apiError(
      'Release was generated, but fluid/disabled size-map compatibility patching failed.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}
