import { apiError, getActor, json } from './http';
import type { DatabaseEnv } from './publishers';
import { compileRuntime, type GeneratorEngine } from './runtime-compiler';
import { readRequiredUserIdModules } from './user-id-config';

export interface ReleaseEnv extends DatabaseEnv {
  BUILDS?: R2Bucket;
}

type JsonRecord = Record<string, unknown>;
type ReleaseStatus = 'draft' | 'staging' | 'production' | 'archived' | 'failed';

type SiteRow = {
  id: string;
  name: string;
  domain: string;
  gam_path: string;
  status: string;
  current_release_id: string | null;
  current_version: string;
  last_published_at: string | null;
  ads_txt_url: string | null;
};

type ConfigRow = {
  id: string;
  config_json: string;
};

type AdUnitRow = {
  id: string;
  code: string;
  type: string;
  media_type: string;
  size_map_key: string | null;
  enabled: number;
  sort_order: number;
  notes: string | null;
};

type BidderRow = {
  id: string;
  bidder: string;
  params_json: string;
  enabled: number;
};

type OverrideRow = {
  id: string;
  bidder: string;
  scope_type: 'slot' | 'device' | 'adunit';
  scope_key: string;
  params_json: string;
  enabled: number;
};

type SizeMapRow = {
  id: string;
  name: string;
  map_json: string;
};

type UnitRuleRow = {
  id: string;
  rule_key: string;
  rule_json: string;
};

type PrebidBuildRow = {
  id: string;
  version: string;
  file_key: string;
  modules_json: string;
  status: string;
  uploaded_by: string | null;
  uploaded_at: string;
};

type ReleaseRow = {
  id: string;
  publisher_id: string;
  version: string;
  status: ReleaseStatus;
  config_hash: string | null;
  ads_js_key: string | null;
  ads_min_js_key: string | null;
  prebid_js_key: string | null;
  config_key: string | null;
  manifest_key: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  published_at: string | null;
};

type GeneratorProfileManifest = {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  description: string;
  engine: GeneratorEngine;
  templateKey: string;
  templateFileName: string;
  templateSha256: string;
  sourceKey: string | null;
  sourceSha256: string | null;
  capabilities: JsonRecord;
};

type ValidationIssue = {
  code: string;
  message: string;
  area: string;
};

type SizeMapBreakpoint = {
  minViewPort: [number, number];
  sizes: [number, number][];
};

type ValidationSnapshot = {
  site: SiteRow;
  configRow: ConfigRow;
  config: JsonRecord;
  adUnits: AdUnitRow[];
  bidders: Array<BidderRow & { params: JsonRecord }>;
  overrides: Array<OverrideRow & { params: JsonRecord }>;
  sizeMaps: Array<SizeMapRow & { map: SizeMapBreakpoint[] }>;
  unitRules: Array<UnitRuleRow & { rule: JsonRecord }>;
  advancedRules: Record<string, JsonRecord>;
  profile: GeneratorProfileManifest;
  profileTemplate: string;
  prebidBuild: PrebidBuildRow;
  prebidObject: R2ObjectBody;
  prebidModules: string[];
  requiredBidderModules: string[];
  requiredUserIdModules: string[];
};

type ValidationResult = {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  summary: JsonRecord;
  snapshot?: ValidationSnapshot;
};

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
  smartadserver: 'smartadserverBidAdapter',
  teads: 'teadsBidAdapter',
};

const RELEASE_FILES = [
  'ads.js',
  'ads.min.js',
  'prebid.js',
  'config.json',
  'manifest.json',
  'min-height.css',
  'div-export.csv',
  'implementation.html',
] as const;

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function storageMissing(): Response {
  return apiError('R2 build storage binding is not configured yet.', 503);
}

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

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? Array.from(new Set(parsed.filter((item): item is string => typeof item === 'string'))).sort((a, b) =>
          a.localeCompare(b),
        )
      : [];
  } catch {
    return [];
  }
}

function parseSizeMap(value: string): SizeMapBreakpoint[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is JsonRecord => isRecord(item))
      .map((item) => {
        const viewport = Array.isArray(item.minViewPort) ? item.minViewPort : [];
        const sizes = Array.isArray(item.sizes) ? item.sizes : [];
        return {
          minViewPort: [Number(viewport[0] ?? 0), Number(viewport[1] ?? 0)] as [number, number],
          sizes: sizes
            .filter((size): size is unknown[] => Array.isArray(size) && size.length === 2)
            .map((size) => [Number(size[0]), Number(size[1])] as [number, number])
            .filter((size) => Number.isFinite(size[0]) && Number.isFinite(size[1]) && size[0] > 0 && size[1] > 0),
        };
      })
      .filter((item) => item.sizes.length > 0)
      .sort((a, b) => a.minViewPort[0] - b.minViewPort[0] || a.minViewPort[1] - b.minViewPort[1]);
  } catch {
    return [];
  }
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

function deepMerge(...values: Array<JsonRecord | undefined>): JsonRecord {
  const output: JsonRecord = {};
  for (const value of values) {
    if (!value) continue;
    for (const [key, candidate] of Object.entries(value)) {
      const current = output[key];
      if (isRecord(current) && isRecord(candidate)) output[key] = deepMerge(current, candidate);
      else if (Array.isArray(candidate)) output[key] = candidate.map((item) => (isRecord(item) ? deepMerge(item) : item));
      else output[key] = candidate;
    }
  }
  return output;
}

function utcVersion(date = new Date()): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

async function sha256Hex(value: ArrayBuffer | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((item) => item.toString(16).padStart(2, '0'))
    .join('');
}

function releasePrefix(siteId: string, version: string): string {
  return `publishers/${siteId}/releases/${version}/`;
}

function releaseKey(siteId: string, version: string, fileName: string): string {
  return `${releasePrefix(siteId, version)}${fileName}`;
}

function channelKey(siteId: string, channel: 'current' | 'staging', fileName: string): string {
  return `publishers/${siteId}/${channel}/${fileName}`;
}

function publicUrl(request: Request, path: string): string {
  return new URL(path, new URL(request.url).origin).toString();
}

function profileManifestKey(id: string): string {
  return `generator-profiles/${id}/manifest.json`;
}

function issue(code: string, message: string, area: string): ValidationIssue {
  return { code, message, area };
}

async function readProfile(bucket: R2Bucket, id: string): Promise<GeneratorProfileManifest | null> {
  const object = await bucket.get(profileManifestKey(id));
  if (!object) return null;
  try {
    const parsed = JSON.parse(await object.text()) as unknown;
    return isRecord(parsed) ? (parsed as unknown as GeneratorProfileManifest) : null;
  } catch {
    return null;
  }
}

async function loadValidationSnapshot(env: ReleaseEnv, siteId: string): Promise<ValidationResult> {
  if (!env.DB) {
    return { ok: false, errors: [issue('database_missing', 'D1 database is not configured.', 'platform')], warnings: [], summary: {} };
  }
  if (!env.BUILDS) {
    return { ok: false, errors: [issue('storage_missing', 'R2 build storage is not configured.', 'platform')], warnings: [], summary: {} };
  }

  const [site, configRow, adUnitsResult, biddersResult, overridesResult, mapsResult, rulesResult, prebidBuild] =
    await Promise.all([
      env.DB
        .prepare(
          `SELECT id, name, domain, gam_path, status, current_release_id, current_version,
                  last_published_at, ads_txt_url
           FROM publishers WHERE id = ? LIMIT 1`,
        )
        .bind(siteId)
        .first<SiteRow>(),
      env.DB
        .prepare('SELECT id, config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
        .bind(siteId)
        .first<ConfigRow>(),
      env.DB
        .prepare(
          `SELECT id, code, type, media_type, size_map_key, enabled, sort_order, notes
           FROM ad_units WHERE publisher_id = ? ORDER BY sort_order, code COLLATE NOCASE`,
        )
        .bind(siteId)
        .all<AdUnitRow>(),
      env.DB
        .prepare(
          `SELECT id, bidder, params_json, enabled
           FROM bidders WHERE publisher_id = ? ORDER BY bidder COLLATE NOCASE`,
        )
        .bind(siteId)
        .all<BidderRow>(),
      env.DB
        .prepare(
          `SELECT id, bidder, scope_type, scope_key, params_json, enabled
           FROM bidder_overrides WHERE publisher_id = ? ORDER BY bidder, scope_type, scope_key`,
        )
        .bind(siteId)
        .all<OverrideRow>(),
      env.DB
        .prepare('SELECT id, name, map_json FROM size_maps WHERE publisher_id = ? ORDER BY name COLLATE NOCASE')
        .bind(siteId)
        .all<SizeMapRow>(),
      env.DB
        .prepare('SELECT id, rule_key, rule_json FROM unit_rules WHERE publisher_id = ? ORDER BY rule_key COLLATE NOCASE')
        .bind(siteId)
        .all<UnitRuleRow>(),
      env.DB
        .prepare(
          `SELECT id, version, file_key, modules_json, status, uploaded_by, uploaded_at
           FROM prebid_builds
           WHERE publisher_id = ? AND status = 'current'
           ORDER BY uploaded_at DESC LIMIT 1`,
        )
        .bind(siteId)
        .first<PrebidBuildRow>(),
    ]);

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  if (!site) errors.push(issue('site_missing', 'Site was not found.', 'site'));
  if (!configRow) errors.push(issue('config_missing', 'Site configuration was not found.', 'config'));
  if (!site || !configRow) return { ok: false, errors, warnings, summary: { siteId } };

  const config = parseRecord(configRow.config_json);
  const adUnits = adUnitsResult.results ?? [];
  const activeAdUnits = adUnits.filter((row) => row.enabled === 1 && row.type !== 'DRAFT');
  const maps = (mapsResult.results ?? []).map((row) => ({ ...row, map: parseSizeMap(row.map_json) }));
  const mapByName = new Map(maps.map((row) => [row.name, row]));

  if (!site.gam_path || site.gam_path === '//') {
    errors.push(issue('gam_path_missing', 'GAM path is missing.', 'site'));
  }
  if (!activeAdUnits.length) {
    errors.push(issue('ad_units_missing', 'At least one enabled ATF or BTF ad unit is required.', 'ad_units'));
  }
  for (const unit of activeAdUnits) {
    if (!unit.size_map_key) {
      errors.push(issue('size_map_reference_missing', `${unit.code} has no size-map reference.`, 'ad_units'));
      continue;
    }
    const map = mapByName.get(unit.size_map_key);
    if (!map) errors.push(issue('size_map_missing', `${unit.code} references missing size map ${unit.size_map_key}.`, 'size_maps'));
    else if (!map.map.length) errors.push(issue('size_map_empty', `Size map ${map.name} has no valid breakpoints.`, 'size_maps'));
  }

  const bidders: Array<BidderRow & { params: JsonRecord }> = [];
  for (const row of biddersResult.results ?? []) {
    const params = parseRecord(row.params_json);
    if (row.params_json.trim() && Object.keys(params).length === 0 && row.params_json.trim() !== '{}') {
      errors.push(issue('bidder_params_invalid', `${row.bidder} params are not a valid JSON object.`, 'bidders'));
    }
    bidders.push({ ...row, params });
  }
  const enabledBidders = bidders.filter((row) => row.enabled === 1);
  if (!enabledBidders.length) warnings.push(issue('bidders_empty', 'No enabled bidders are configured; only GAM demand can fill.', 'bidders'));

  const adUnitCodes = new Set(adUnits.map((row) => row.code));
  const overrides: Array<OverrideRow & { params: JsonRecord }> = [];
  for (const row of overridesResult.results ?? []) {
    const params = parseRecord(row.params_json);
    if (row.params_json.trim() && Object.keys(params).length === 0 && row.params_json.trim() !== '{}') {
      errors.push(issue('override_params_invalid', `${row.bidder} ${row.scope_type}/${row.scope_key} params are invalid.`, 'bidders'));
    }
    if (row.scope_type === 'adunit' && !adUnitCodes.has(row.scope_key)) {
      errors.push(issue('override_adunit_missing', `${row.bidder} override references missing ad unit ${row.scope_key}.`, 'bidders'));
    }
    overrides.push({ ...row, params });
  }

  const unitRules = (rulesResult.results ?? []).map((row) => ({ ...row, rule: parseRecord(row.rule_json) }));
  const ruleKeys = new Set(unitRules.map((row) => row.rule_key));
  for (const key of ['__DEFAULT__', '__ATF__', '__BTF__']) {
    if (!ruleKeys.has(key)) warnings.push(issue('base_rule_missing', `${key} is not configured; template defaults will be used.`, 'unit_rules'));
  }

  const advancedRules = isRecord(config.advancedUnitRules)
    ? Object.fromEntries(Object.entries(config.advancedUnitRules).filter((entry): entry is [string, JsonRecord] => isRecord(entry[1])))
    : {};

  const profileId = typeof config.generatorProfileId === 'string' ? config.generatorProfileId.trim() : '';
  let profile: GeneratorProfileManifest | null = null;
  let profileTemplate = '';
  if (!profileId) {
    errors.push(issue('generator_profile_missing', 'Select a generator profile for this site.', 'generator_profile'));
  } else {
    profile = await readProfile(env.BUILDS, profileId);
    if (!profile) errors.push(issue('generator_profile_not_found', `Generator profile ${profileId} was not found in R2.`, 'generator_profile'));
    else {
      const templateObject = await env.BUILDS.get(profile.templateKey);
      if (!templateObject) errors.push(issue('generator_template_missing', 'The selected generator template is missing from R2.', 'generator_profile'));
      else profileTemplate = await templateObject.text();
    }
  }

  let prebidObject: R2ObjectBody | null = null;
  const prebidModules = prebidBuild ? parseStringArray(prebidBuild.modules_json) : [];
  if (!prebidBuild) {
    errors.push(issue('prebid_build_missing', 'A current valid Prebid.js build is required.', 'prebid'));
  } else {
    prebidObject = await env.BUILDS.get(prebidBuild.file_key);
    if (!prebidObject) errors.push(issue('prebid_file_missing', 'The current Prebid.js file is missing from R2.', 'prebid'));
  }

  const requiredBidderModules = uniqueSorted(enabledBidders.map((row) => adapterModuleForBidder(row.bidder)));
  const requiredUserIdModules = await readRequiredUserIdModules(env.DB, siteId);
  const moduleSet = new Set(prebidModules);
  for (const module of [...requiredBidderModules, ...requiredUserIdModules]) {
    if (!moduleSet.has(module)) {
      errors.push(issue('prebid_module_missing', `Current Prebid.js build is missing ${module}.`, 'prebid'));
    }
  }

  if (profile?.engine === 'legacy-frozen-v1' && Object.keys(advancedRules).length) {
    warnings.push(issue('advanced_rules_inactive', 'Advanced schedules exist but the selected frozen profile only applies basic values.', 'generator_profile'));
  }
  if (profile?.engine === 'legacy-advanced-refresh-v1' && !Object.keys(advancedRules).length) {
    warnings.push(issue('advanced_rules_empty', 'Advanced generator is selected, but no advanced schedules are configured.', 'unit_rules'));
  }
  if (!isRecord(config.userSync)) {
    warnings.push(issue('user_sync_default', 'No saved User ID userSync config exists; the template User ID setup will be replaced with an empty safe config.', 'user_id'));
  }

  const summary = {
    siteId,
    siteName: site.name,
    domain: site.domain,
    activeAdUnits: activeAdUnits.length,
    enabledBidders: enabledBidders.length,
    sizeMaps: maps.length,
    unitRules: unitRules.length,
    advancedRules: Object.keys(advancedRules).length,
    generatorProfileId: profile?.id ?? profileId || null,
    generatorEngine: profile?.engine ?? null,
    prebidBuildId: prebidBuild?.id ?? null,
    prebidVersion: prebidBuild?.version ?? null,
    requiredBidderModules,
    requiredUserIdModules,
  };

  const ok = errors.length === 0 && Boolean(profile && prebidBuild && prebidObject);
  return {
    ok,
    errors,
    warnings,
    summary,
    snapshot: ok && profile && prebidBuild && prebidObject
      ? {
          site,
          configRow,
          config,
          adUnits,
          bidders,
          overrides,
          sizeMaps: maps,
          unitRules,
          advancedRules,
          profile,
          profileTemplate,
          prebidBuild,
          prebidObject,
          prebidModules,
          requiredBidderModules,
          requiredUserIdModules,
        }
      : undefined,
  };
}

function sizeUnion(map: SizeMapBreakpoint[]): [number, number][] {
  const values = new Map<string, [number, number]>();
  for (const breakpoint of map) {
    for (const size of breakpoint.sizes) values.set(`${size[0]}x${size[1]}`, size);
  }
  return Array.from(values.values()).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
}

function buildRuntimeData(snapshot: ValidationSnapshot): {
  bidders: JsonRecord[];
  bidderSlotParams: JsonRecord;
  bidderDeviceParams: JsonRecord;
  bidderAdUnitParams: JsonRecord;
  adUnitRules: JsonRecord;
  explicitUnits: JsonRecord[];
  sizeMapsRaw: JsonRecord;
  userSync: JsonRecord;
  defaultTimeout: number;
  atfTimeout: number;
  btfTimeout: number;
  stickyTimeout: number;
  globalRefresh: JsonRecord;
  maxCmpTimeout: number;
} {
  const activeUnits = snapshot.adUnits.filter((row) => row.enabled === 1 && row.type !== 'DRAFT');
  const mapByName = new Map(snapshot.sizeMaps.map((row) => [row.name, row.map]));

  const explicitUnits = activeUnits.map((unit) => {
    const map = unit.size_map_key ? mapByName.get(unit.size_map_key) ?? [] : [];
    return {
      id: unit.code,
      type: unit.type,
      formats: [unit.media_type || 'banner'],
      sizes: sizeUnion(map),
      video: null,
      native: null,
      sizeMapName: unit.size_map_key,
      prebidSizeConfigName: unit.size_map_key,
      properties: [],
    };
  });

  const sizeMapsRaw: JsonRecord = {};
  for (const row of snapshot.sizeMaps) {
    sizeMapsRaw[row.name] = row.map.map((breakpoint) => ({
      viewport: breakpoint.minViewPort,
      sizes: breakpoint.sizes,
    }));
  }

  const bidderSlotParams: JsonRecord = {};
  const bidderDeviceParams: JsonRecord = {};
  const bidderAdUnitParams: JsonRecord = {};
  for (const row of snapshot.overrides.filter((item) => item.enabled === 1)) {
    const target = row.scope_type === 'device'
      ? bidderDeviceParams
      : row.scope_type === 'adunit'
        ? bidderAdUnitParams
        : bidderSlotParams;
    if (!isRecord(target[row.bidder])) target[row.bidder] = {};
    (target[row.bidder] as JsonRecord)[row.scope_key] = row.params;
  }

  const basicRules: Record<string, JsonRecord> = {};
  for (const row of snapshot.unitRules) basicRules[row.rule_key] = row.rule;
  const adUnitRules: JsonRecord = {};
  const keys = new Set([...Object.keys(basicRules), ...Object.keys(snapshot.advancedRules)]);
  for (const key of keys) {
    adUnitRules[key] = snapshot.profile.engine === 'legacy-advanced-refresh-v1'
      ? deepMerge(basicRules[key], snapshot.advancedRules[key])
      : deepMerge(basicRules[key]);
  }

  const defaultRule = isRecord(adUnitRules.__DEFAULT__) ? (adUnitRules.__DEFAULT__ as JsonRecord) : {};
  const atfRule = isRecord(adUnitRules.__ATF__) ? (adUnitRules.__ATF__ as JsonRecord) : {};
  const btfRule = isRecord(adUnitRules.__BTF__) ? (adUnitRules.__BTF__ as JsonRecord) : {};
  const stickyRule = isRecord(adUnitRules.Sticky) ? (adUnitRules.Sticky as JsonRecord) : {};
  const timeout = (rule: JsonRecord, fallback: number) => {
    const value = Number(rule.timeout);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  let maxCmpTimeout = 1500;
  for (const value of Object.values(adUnitRules)) {
    if (!isRecord(value)) continue;
    const cmp = Number(value.cmpTimeout);
    if (Number.isFinite(cmp) && cmp > maxCmpTimeout) maxCmpTimeout = cmp;
  }

  const userSync = isRecord(snapshot.config.userSync)
    ? snapshot.config.userSync
    : {
        syncEnabled: true,
        aliasSyncEnabled: true,
        syncsPerBidder: 5,
        syncDelay: 3000,
        auctionDelay: 150,
        filterSettings: { all: { bidders: '*', filter: 'include' } },
        userIds: [],
      };

  return {
    bidders: snapshot.bidders
      .filter((row) => row.enabled === 1)
      .map((row) => ({ bidder: row.bidder, params: row.params })),
    bidderSlotParams,
    bidderDeviceParams,
    bidderAdUnitParams,
    adUnitRules,
    explicitUnits,
    sizeMapsRaw,
    userSync,
    defaultTimeout: timeout(defaultRule, 2500),
    atfTimeout: timeout(atfRule, timeout(defaultRule, 2200)),
    btfTimeout: timeout(btfRule, timeout(defaultRule, 2500)),
    stickyTimeout: timeout(stickyRule, timeout(atfRule, timeout(defaultRule, 2500))),
    globalRefresh: isRecord(defaultRule.refresh)
      ? (defaultRule.refresh as JsonRecord)
      : isRecord(atfRule.refresh)
        ? (atfRule.refresh as JsonRecord)
        : {},
    maxCmpTimeout,
  };
}

function cssEscape(value: string): string {
  return value.replace(/([^A-Za-z0-9_-])/g, '\\$1');
}

function activeBreakpoint(map: SizeMapBreakpoint[], width: number): SizeMapBreakpoint | null {
  let selected: SizeMapBreakpoint | null = null;
  for (const breakpoint of map) {
    if (breakpoint.minViewPort[0] <= width) selected = breakpoint;
  }
  return selected ?? map[0] ?? null;
}

function generateMinHeightCss(snapshot: ValidationSnapshot): string {
  const units = snapshot.adUnits.filter((row) => row.enabled === 1 && row.type !== 'DRAFT' && row.size_map_key);
  const mapByName = new Map(snapshot.sizeMaps.map((row) => [row.name, row.map]));
  const widths = new Set<number>([0]);
  for (const unit of units) {
    const map = unit.size_map_key ? mapByName.get(unit.size_map_key) ?? [] : [];
    for (const breakpoint of map) widths.add(breakpoint.minViewPort[0]);
  }

  const renderRules = (width: number): string[] => {
    const groups = new Map<number, string[]>();
    for (const unit of units) {
      const map = unit.size_map_key ? mapByName.get(unit.size_map_key) ?? [] : [];
      const breakpoint = activeBreakpoint(map, width);
      const height = breakpoint ? Math.max(...breakpoint.sizes.map((size) => size[1])) : 0;
      if (!height) continue;
      const ids = groups.get(height) ?? [];
      ids.push(`#${cssEscape(unit.code)}`);
      groups.set(height, ids);
    }
    return Array.from(groups.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([height, ids]) => `${ids.join(', ')} { min-height: ${height}px; }`);
  };

  const ordered = Array.from(widths).sort((a, b) => a - b);
  const output = ['/* Generated by Prebid Professor from active size maps. */'];
  for (const width of ordered) {
    const rules = renderRules(width);
    if (!rules.length) continue;
    if (width === 0) {
      output.push('', '/* 0px and above */', ...rules);
    } else {
      output.push('', `/* >= ${width}px */`, `@media (min-width: ${width}px) {`, ...rules.map((rule) => `  ${rule}`), '}');
    }
  }
  return `${output.join('\n').trim()}\n`;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function generateDivCsv(snapshot: ValidationSnapshot): string {
  const rows = [['Ad unit name', 'Div', 'class']];
  for (const unit of snapshot.adUnits.filter((row) => row.enabled === 1 && row.type !== 'DRAFT')) {
    const className = unit.type === 'BTF' ? 'wrapperAd lazyAd' : 'wrapperAd';
    rows.push([unit.code, `<div id="${unit.code}" class="${className}"></div>`, className]);
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function generateImplementationHtml(snapshot: ValidationSnapshot, origin: string): string {
  const siteId = snapshot.site.id;
  const divs = snapshot.adUnits
    .filter((row) => row.enabled === 1 && row.type !== 'DRAFT')
    .map((unit) => {
      const className = unit.type === 'BTF' ? 'wrapperAd lazyAd' : 'wrapperAd';
      return `<!-- ${unit.code} -->\n<div id="${unit.code}" class="${className}"></div>`;
    })
    .join('\n\n');

  return `<!-- Prebid Professor implementation for ${snapshot.site.name} -->
<link rel="stylesheet" href="${origin}/cdn/${siteId}/current/min-height.css">
<script src="${origin}/cdn/${siteId}/current/prebid.js"></script>
<script src="${origin}/cdn/${siteId}/current/ads.min.js"></script>

${divs}
`;
}

async function ensureUniqueVersion(db: D1Database, siteId: string): Promise<string> {
  const base = utcVersion();
  for (let index = 0; index < 100; index += 1) {
    const version = index === 0 ? base : `${base}_${String(index + 1).padStart(2, '0')}`;
    const existing = await db
      .prepare('SELECT id FROM releases WHERE publisher_id = ? AND version = ? LIMIT 1')
      .bind(siteId, version)
      .first<{ id: string }>();
    if (!existing) return version;
  }
  throw new Error('Could not allocate a unique release version.');
}

async function cleanupPrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

function artifactContentType(fileName: string): string {
  if (fileName.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (fileName.endsWith('.json')) return 'application/json; charset=utf-8';
  if (fileName.endsWith('.css')) return 'text/css; charset=utf-8';
  if (fileName.endsWith('.csv')) return 'text/csv; charset=utf-8';
  if (fileName.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

async function putArtifact(
  bucket: R2Bucket,
  key: string,
  body: string | ArrayBuffer,
  fileName: string,
  metadata: Record<string, string>,
): Promise<{ key: string; size: number; sha256: string; contentType: string }> {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body).buffer : body;
  const sha256 = await sha256Hex(bytes);
  const contentType = artifactContentType(fileName);
  await bucket.put(key, bytes, {
    httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { ...metadata, fileName, sha256 },
  });
  return { key, size: bytes.byteLength, sha256, contentType };
}

function releasePayload(request: Request, row: ReleaseRow, manifest: JsonRecord | null): JsonRecord {
  const base = `/cdn/${encodeURIComponent(row.publisher_id)}/releases/${encodeURIComponent(row.version)}`;
  return {
    id: row.id,
    publisherId: row.publisher_id,
    version: row.version,
    status: row.status,
    configHash: row.config_hash,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    manifest,
    urls: {
      adsJs: publicUrl(request, `${base}/ads.js`),
      adsMinJs: publicUrl(request, `${base}/ads.min.js`),
      prebidJs: publicUrl(request, `${base}/prebid.js`),
      config: publicUrl(request, `${base}/config.json`),
      manifest: publicUrl(request, `${base}/manifest.json`),
      css: publicUrl(request, `${base}/min-height.css`),
      divCsv: publicUrl(request, `${base}/div-export.csv`),
      implementation: publicUrl(request, `${base}/implementation.html`),
    },
  };
}

async function readReleaseManifest(bucket: R2Bucket, key: string | null): Promise<JsonRecord | null> {
  if (!key) return null;
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    const parsed = JSON.parse(await object.text()) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function validateRelease(env: ReleaseEnv, siteId: string): Promise<Response> {
  const result = await loadValidationSnapshot(env, siteId);
  return json({
    ok: result.ok,
    errors: result.errors,
    warnings: result.warnings,
    summary: result.summary,
  }, { status: result.ok ? 200 : 422 });
}

export async function generateRelease(request: Request, env: ReleaseEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!env.BUILDS) return storageMissing();

  const validation = await loadValidationSnapshot(env, siteId);
  if (!validation.ok || !validation.snapshot) {
    return apiError('Release validation failed.', 422, {
      errors: validation.errors,
      warnings: validation.warnings,
      summary: validation.summary,
    });
  }

  let notes = '';
  try {
    if ((request.headers.get('content-type') ?? '').includes('application/json')) {
      const body = (await request.json()) as JsonRecord;
      notes = String(body.notes ?? '').trim();
    }
  } catch {
    return apiError('Release notes JSON could not be read.');
  }

  const snapshot = validation.snapshot;
  const version = await ensureUniqueVersion(env.DB, siteId);
  const runtime = buildRuntimeData(snapshot);
  let compiled;
  try {
    compiled = compileRuntime({
      template: snapshot.profileTemplate,
      engine: snapshot.profile.engine,
      buildVersion: version,
      siteId,
      generatorProfileId: snapshot.profile.id,
      gamPath: snapshot.site.gam_path,
      bidders: runtime.bidders,
      bidderSlotParams: runtime.bidderSlotParams,
      bidderDeviceParams: runtime.bidderDeviceParams,
      bidderAdUnitParams: runtime.bidderAdUnitParams,
      adUnitRules: runtime.adUnitRules,
      explicitUnits: runtime.explicitUnits,
      sizeMapsRaw: runtime.sizeMapsRaw,
      prebidSizeConfigsRaw: {},
      userSync: runtime.userSync,
      defaultTimeout: runtime.defaultTimeout,
      atfTimeout: runtime.atfTimeout,
      btfTimeout: runtime.btfTimeout,
      stickyTimeout: runtime.stickyTimeout,
      globalRefresh: runtime.globalRefresh,
      maxCmpTimeout: runtime.maxCmpTimeout,
    });
  } catch (error) {
    return apiError('Runtime compilation failed.', 422, error instanceof Error ? error.message : String(error));
  }

  const prebidBytes = await snapshot.prebidObject.arrayBuffer();
  const origin = new URL(request.url).origin;
  const generatedAt = new Date().toISOString();
  const configSnapshot = {
    schemaVersion: 1,
    generatedAt,
    version,
    site: snapshot.site,
    generatorProfile: snapshot.profile,
    prebidBuild: {
      id: snapshot.prebidBuild.id,
      version: snapshot.prebidBuild.version,
      modules: snapshot.prebidModules,
      uploadedBy: snapshot.prebidBuild.uploaded_by,
      uploadedAt: snapshot.prebidBuild.uploaded_at,
    },
    adUnits: snapshot.adUnits,
    bidders: snapshot.bidders.map((row) => ({ bidder: row.bidder, params: row.params, enabled: row.enabled === 1 })),
    bidderOverrides: snapshot.overrides.map((row) => ({
      bidder: row.bidder,
      scopeType: row.scope_type,
      scopeKey: row.scope_key,
      params: row.params,
      enabled: row.enabled === 1,
    })),
    sizeMaps: snapshot.sizeMaps.map((row) => ({ name: row.name, map: row.map })),
    unitRules: runtime.adUnitRules,
    userIdConfig: snapshot.config.userIdConfig ?? null,
    userSync: runtime.userSync,
    compiler: {
      engine: snapshot.profile.engine,
      patches: compiled.patches,
      warnings: compiled.warnings,
      minifier: compiled.minifier,
    },
  };
  const configText = `${JSON.stringify(configSnapshot, null, 2)}\n`;
  const configHash = await sha256Hex(configText);
  const css = generateMinHeightCss(snapshot);
  const divCsv = generateDivCsv(snapshot);
  const implementation = generateImplementationHtml(snapshot, origin);
  const prefix = releasePrefix(siteId, version);
  const actor = getActor(request);
  const releaseId = crypto.randomUUID();

  try {
    const files: Record<string, JsonRecord> = {};
    const add = async (fileName: string, body: string | ArrayBuffer) => {
      files[fileName] = await putArtifact(env.BUILDS!, releaseKey(siteId, version, fileName), body, fileName, {
        siteId,
        releaseId,
        version,
        generatorProfileId: snapshot.profile.id,
        createdBy: actor,
      });
    };

    await Promise.all([
      add('ads.js', compiled.adsJs),
      add('ads.min.js', compiled.adsMinJs),
      add('prebid.js', prebidBytes),
      add('config.json', configText),
      add('min-height.css', css),
      add('div-export.csv', divCsv),
      add('implementation.html', implementation),
    ]);

    const manifest = {
      schemaVersion: 1,
      releaseId,
      siteId,
      version,
      status: 'draft',
      generatedAt,
      generatedBy: actor,
      configHash,
      generatorProfile: {
        id: snapshot.profile.id,
        name: snapshot.profile.name,
        version: snapshot.profile.version,
        engine: snapshot.profile.engine,
        templateSha256: snapshot.profile.templateSha256,
        sourceSha256: snapshot.profile.sourceSha256,
      },
      prebidBuild: {
        id: snapshot.prebidBuild.id,
        version: snapshot.prebidBuild.version,
        modules: snapshot.prebidModules,
      },
      compiler: {
        patches: compiled.patches,
        warnings: [...compiled.warnings, ...validation.warnings.map((item) => item.message)],
        minifier: compiled.minifier,
      },
      files,
      publicBaseUrl: `${origin}/cdn/${siteId}/releases/${version}`,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    files['manifest.json'] = await putArtifact(
      env.BUILDS,
      releaseKey(siteId, version, 'manifest.json'),
      manifestText,
      'manifest.json',
      { siteId, releaseId, version, generatorProfileId: snapshot.profile.id, createdBy: actor },
    );

    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO releases (
             id, publisher_id, version, status, config_hash, ads_js_key, ads_min_js_key,
             prebid_js_key, config_key, manifest_key, notes, created_by, created_at
           ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          releaseId,
          siteId,
          version,
          configHash,
          releaseKey(siteId, version, 'ads.js'),
          releaseKey(siteId, version, 'ads.min.js'),
          releaseKey(siteId, version, 'prebid.js'),
          releaseKey(siteId, version, 'config.json'),
          releaseKey(siteId, version, 'manifest.json'),
          notes || null,
          actor,
          generatedAt,
        ),
      env.DB
        .prepare('UPDATE publisher_configs SET config_hash = ?, updated_at = ? WHERE publisher_id = ?')
        .bind(configHash, generatedAt, siteId),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'release.generated', ?, 'release', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          releaseId,
          JSON.stringify({ version, configHash, generatorProfileId: snapshot.profile.id, files: Object.keys(files) }),
          generatedAt,
        ),
    ]);

    const row = await env.DB
      .prepare(
        `SELECT id, publisher_id, version, status, config_hash, ads_js_key, ads_min_js_key,
                prebid_js_key, config_key, manifest_key, notes, created_by, created_at, published_at
         FROM releases WHERE id = ? LIMIT 1`,
      )
      .bind(releaseId)
      .first<ReleaseRow>();
    return json({ ok: true, release: row ? releasePayload(request, row, manifest) : null }, { status: 201 });
  } catch (error) {
    await cleanupPrefix(env.BUILDS, prefix).catch(() => undefined);
    return apiError('Release generation failed.', 500, error instanceof Error ? error.message : String(error));
  }
}

export async function listReleases(request: Request, env: ReleaseEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!env.BUILDS) return storageMissing();
  const result = await env.DB
    .prepare(
      `SELECT id, publisher_id, version, status, config_hash, ads_js_key, ads_min_js_key,
              prebid_js_key, config_key, manifest_key, notes, created_by, created_at, published_at
       FROM releases WHERE publisher_id = ? ORDER BY created_at DESC`,
    )
    .bind(siteId)
    .all<ReleaseRow>();
  const releases = await Promise.all(
    (result.results ?? []).map(async (row) => releasePayload(request, row, await readReleaseManifest(env.BUILDS!, row.manifest_key))),
  );
  return json({
    ok: true,
    releases,
    channels: {
      current: {
        adsJs: publicUrl(request, `/cdn/${siteId}/current/ads.js`),
        adsMinJs: publicUrl(request, `/cdn/${siteId}/current/ads.min.js`),
        prebidJs: publicUrl(request, `/cdn/${siteId}/current/prebid.js`),
        manifest: publicUrl(request, `/cdn/${siteId}/current/manifest.json`),
      },
      staging: {
        adsJs: publicUrl(request, `/cdn/${siteId}/staging/ads.js`),
        adsMinJs: publicUrl(request, `/cdn/${siteId}/staging/ads.min.js`),
        prebidJs: publicUrl(request, `/cdn/${siteId}/staging/prebid.js`),
        manifest: publicUrl(request, `/cdn/${siteId}/staging/manifest.json`),
      },
    },
  });
}

async function fetchRelease(db: D1Database, siteId: string, releaseId: string): Promise<ReleaseRow | null> {
  return db
    .prepare(
      `SELECT id, publisher_id, version, status, config_hash, ads_js_key, ads_min_js_key,
              prebid_js_key, config_key, manifest_key, notes, created_by, created_at, published_at
       FROM releases WHERE publisher_id = ? AND id = ? LIMIT 1`,
    )
    .bind(siteId, releaseId)
    .first<ReleaseRow>();
}

async function copyReleaseToChannel(
  bucket: R2Bucket,
  siteId: string,
  version: string,
  channel: 'current' | 'staging',
): Promise<void> {
  for (const fileName of RELEASE_FILES) {
    const source = await bucket.get(releaseKey(siteId, version, fileName));
    if (!source) throw new Error(`Release artifact ${fileName} is missing.`);
    const bytes = await source.arrayBuffer();
    const headers = new Headers();
    source.writeHttpMetadata(headers);
    await bucket.put(channelKey(siteId, channel, fileName), bytes, {
      httpMetadata: {
        contentType: headers.get('content-type') ?? artifactContentType(fileName),
        cacheControl: channel === 'current' ? 'public, max-age=60, stale-while-revalidate=300' : 'no-store',
      },
      customMetadata: {
        ...(source.customMetadata ?? {}),
        channel,
        sourceVersion: version,
        promotedAt: new Date().toISOString(),
      },
    });
  }
}

async function promoteRelease(
  request: Request,
  env: ReleaseEnv,
  siteId: string,
  releaseId: string,
  channel: 'staging' | 'production',
  rollback: boolean,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!env.BUILDS) return storageMissing();
  const release = await fetchRelease(env.DB, siteId, releaseId);
  if (!release) return apiError('Release not found.', 404);
  if (release.status === 'failed') return apiError('Failed releases cannot be promoted.', 409);

  const targetChannel = channel === 'production' ? 'current' : 'staging';
  try {
    await copyReleaseToChannel(env.BUILDS, siteId, release.version, targetChannel);
  } catch (error) {
    return apiError('Release artifacts could not be promoted.', 409, error instanceof Error ? error.message : String(error));
  }

  const actor = getActor(request);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (channel === 'production') {
    statements.push(
      env.DB
        .prepare(`UPDATE releases SET status = 'archived' WHERE publisher_id = ? AND status = 'production' AND id <> ?`)
        .bind(siteId, releaseId),
      env.DB
        .prepare(`UPDATE releases SET status = 'production', published_at = ? WHERE publisher_id = ? AND id = ?`)
        .bind(now, siteId, releaseId),
      env.DB
        .prepare(
          `UPDATE publishers
           SET current_release_id = ?, current_version = ?, last_published_at = ?, status = 'live', updated_at = ?
           WHERE id = ?`,
        )
        .bind(releaseId, release.version, now, now, siteId),
    );
  } else {
    statements.push(
      env.DB
        .prepare(`UPDATE releases SET status = 'archived' WHERE publisher_id = ? AND status = 'staging' AND id <> ?`)
        .bind(siteId, releaseId),
      env.DB
        .prepare(`UPDATE releases SET status = 'staging', published_at = ? WHERE publisher_id = ? AND id = ?`)
        .bind(now, siteId, releaseId),
    );
  }
  statements.push(
    env.DB
      .prepare(
        `INSERT INTO audit_log (
           id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
         ) VALUES (?, ?, ?, ?, 'release', ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        actor,
        rollback ? 'release.rolled_back' : channel === 'production' ? 'release.production_published' : 'release.staging_published',
        siteId,
        releaseId,
        JSON.stringify({ version: release.version, channel: targetChannel }),
        now,
      ),
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    return apiError('Release promotion metadata could not be saved.', 500, error instanceof Error ? error.message : String(error));
  }

  const updated = await fetchRelease(env.DB, siteId, releaseId);
  return json({ ok: true, release: updated ? releasePayload(request, updated, await readReleaseManifest(env.BUILDS, updated.manifest_key)) : null });
}

export function publishReleaseToStaging(
  request: Request,
  env: ReleaseEnv,
  siteId: string,
  releaseId: string,
): Promise<Response> {
  return promoteRelease(request, env, siteId, releaseId, 'staging', false);
}

export function publishReleaseToProduction(
  request: Request,
  env: ReleaseEnv,
  siteId: string,
  releaseId: string,
): Promise<Response> {
  return promoteRelease(request, env, siteId, releaseId, 'production', false);
}

export function rollbackRelease(
  request: Request,
  env: ReleaseEnv,
  siteId: string,
  releaseId: string,
): Promise<Response> {
  return promoteRelease(request, env, siteId, releaseId, 'production', true);
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..');
}

export async function serveReleaseCdn(request: Request, env: ReleaseEnv): Promise<Response | null> {
  if (!env.BUILDS) return null;
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  const path = new URL(request.url).pathname;

  let key: string | null = null;
  let immutable = false;
  let match = path.match(/^\/cdn\/([^/]+)\/(current|staging)\/([^/]+)$/);
  if (match) {
    const [, siteId, channel, fileName] = match.map((value) => decodeURIComponent(value));
    if (!safeSegment(siteId) || !safeSegment(fileName)) return apiError('Invalid CDN path.', 400);
    key = channelKey(siteId, channel as 'current' | 'staging', fileName);
  } else {
    match = path.match(/^\/cdn\/([^/]+)\/releases\/([^/]+)\/([^/]+)$/);
    if (!match) return null;
    const [, siteId, version, fileName] = match.map((value) => decodeURIComponent(value));
    if (!safeSegment(siteId) || !safeSegment(version) || !safeSegment(fileName)) return apiError('Invalid CDN path.', 400);
    key = releaseKey(siteId, version, fileName);
    immutable = true;
  }

  const object = request.method === 'HEAD' ? await env.BUILDS.head(key) : await env.BUILDS.get(key);
  if (!object) return new Response('Not found.', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('cache-control', immutable ? 'public, max-age=31536000, immutable' : path.includes('/staging/') ? 'no-store' : 'public, max-age=60, stale-while-revalidate=300');
  if ('httpEtag' in object && object.httpEtag) headers.set('etag', object.httpEtag);
  return new Response(request.method === 'HEAD' ? null : (object as R2ObjectBody).body, { headers });
}
