import { apiError, getActor, json } from './http';
import type { DatabaseEnv } from './publishers';
import { compileRuntime, type GeneratorEngine } from './runtime-compiler';
import { readRequiredUserIdModules } from './user-id-config';

export interface ReleaseEnv extends DatabaseEnv {
  BUILDS?: R2Bucket;
}

type JsonRecord = Record<string, unknown>;
type ReleaseStatus = 'draft' | 'staging' | 'production' | 'archived' | 'failed';
type Channel = 'current' | 'staging';

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

type ConfigRow = { id: string; config_json: string };
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
type BidderRow = { id: string; bidder: string; params_json: string; enabled: number };
type OverrideRow = {
  id: string;
  bidder: string;
  scope_type: 'slot' | 'device' | 'adunit';
  scope_key: string;
  params_json: string;
  enabled: number;
};
type SizeMapRow = { id: string; name: string; map_json: string };
type UnitRuleRow = { id: string; rule_key: string; rule_json: string };
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
type GeneratorProfile = {
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
type ValidationIssue = { code: string; message: string; area: string };
type SizeMapBreakpoint = {
  minViewPort: [number, number];
  sizes: [number, number][];
};
type LoadedBidder = BidderRow & { params: JsonRecord };
type LoadedOverride = OverrideRow & { params: JsonRecord };
type LoadedMap = SizeMapRow & { map: SizeMapBreakpoint[] };
type LoadedRule = UnitRuleRow & { rule: JsonRecord };
type Snapshot = {
  site: SiteRow;
  configRow: ConfigRow;
  config: JsonRecord;
  adUnits: AdUnitRow[];
  bidders: LoadedBidder[];
  overrides: LoadedOverride[];
  sizeMaps: LoadedMap[];
  unitRules: LoadedRule[];
  advancedRules: Record<string, JsonRecord>;
  profile: GeneratorProfile;
  profileTemplate: string;
  prebidBuild: PrebidBuildRow;
  prebidBytes: ArrayBuffer;
  prebidModules: string[];
  requiredBidderModules: string[];
  requiredUserIdModules: string[];
};
type ValidationResult = {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  summary: JsonRecord;
  snapshot?: Snapshot;
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

const BIDDER_MODULES: Record<string, string> = {
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
      ? uniqueSorted(parsed.filter((item): item is string => typeof item === 'string'))
      : [];
  } catch {
    return [];
  }
}
function parseMap(value: string): SizeMapBreakpoint[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const output: SizeMapBreakpoint[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry) || !Array.isArray(entry.minViewPort) || !Array.isArray(entry.sizes)) continue;
      const minWidth = Number(entry.minViewPort[0] ?? 0);
      const minHeight = Number(entry.minViewPort[1] ?? 0);
      const sizes = entry.sizes
        .filter((size): size is unknown[] => Array.isArray(size) && size.length === 2)
        .map((size) => [Number(size[0]), Number(size[1])] as [number, number])
        .filter((size) => Number.isInteger(size[0]) && Number.isInteger(size[1]) && size[0] > 0 && size[1] > 0);
      if (sizes.length) output.push({ minViewPort: [minWidth, minHeight], sizes });
    }
    return output.sort((a, b) => a.minViewPort[0] - b.minViewPort[0] || a.minViewPort[1] - b.minViewPort[1]);
  } catch {
    return [];
  }
}
function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}
function adapterFor(bidder: string): string {
  const normalized = bidder.trim().toLowerCase();
  return BIDDER_MODULES[normalized] ?? `${normalized}BidAdapter`;
}
function issue(code: string, message: string, area: string): ValidationIssue {
  return { code, message, area };
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
function profileManifestKey(id: string): string {
  return `generator-profiles/${id}/manifest.json`;
}
function releasePrefix(siteId: string, version: string): string {
  return `publishers/${siteId}/releases/${version}/`;
}
function releaseKey(siteId: string, version: string, fileName: string): string {
  return `${releasePrefix(siteId, version)}${fileName}`;
}
function channelKey(siteId: string, channel: Channel, fileName: string): string {
  return `publishers/${siteId}/${channel}/${fileName}`;
}
function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..');
}
function absoluteUrl(request: Request, path: string): string {
  return new URL(path, new URL(request.url).origin).toString();
}
function contentType(fileName: string): string {
  if (fileName.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (fileName.endsWith('.json')) return 'application/json; charset=utf-8';
  if (fileName.endsWith('.css')) return 'text/css; charset=utf-8';
  if (fileName.endsWith('.csv')) return 'text/csv; charset=utf-8';
  if (fileName.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}
function versionStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}
async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  const input = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function readProfile(bucket: R2Bucket, id: string): Promise<GeneratorProfile | null> {
  const object = await bucket.get(profileManifestKey(id));
  if (!object) return null;
  try {
    const parsed = JSON.parse(await object.text()) as unknown;
    return isRecord(parsed) ? (parsed as unknown as GeneratorProfile) : null;
  } catch {
    return null;
  }
}
async function uniqueVersion(db: D1Database, siteId: string): Promise<string> {
  const base = versionStamp();
  for (let index = 0; index < 100; index += 1) {
    const version = index === 0 ? base : `${base}_${String(index + 1).padStart(2, '0')}`;
    const found = await db.prepare('SELECT id FROM releases WHERE publisher_id = ? AND version = ? LIMIT 1')
      .bind(siteId, version).first<{ id: string }>();
    if (!found) return version;
  }
  throw new Error('A unique release version could not be allocated.');
}

async function loadSnapshot(env: ReleaseEnv, siteId: string): Promise<ValidationResult> {
  if (!env.DB) return { ok: false, errors: [issue('database_missing', 'D1 is not configured.', 'platform')], warnings: [], summary: {} };
  if (!env.BUILDS) return { ok: false, errors: [issue('storage_missing', 'R2 is not configured.', 'platform')], warnings: [], summary: {} };

  const [site, configRow, unitsResult, biddersResult, overridesResult, mapsResult, rulesResult, prebidBuild] = await Promise.all([
    env.DB.prepare(`SELECT id, name, domain, gam_path, status, current_release_id, current_version,
                           last_published_at, ads_txt_url FROM publishers WHERE id = ? LIMIT 1`)
      .bind(siteId).first<SiteRow>(),
    env.DB.prepare('SELECT id, config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
      .bind(siteId).first<ConfigRow>(),
    env.DB.prepare(`SELECT id, code, type, media_type, size_map_key, enabled, sort_order, notes
                    FROM ad_units WHERE publisher_id = ? ORDER BY sort_order, code COLLATE NOCASE`)
      .bind(siteId).all<AdUnitRow>(),
    env.DB.prepare('SELECT id, bidder, params_json, enabled FROM bidders WHERE publisher_id = ? ORDER BY bidder COLLATE NOCASE')
      .bind(siteId).all<BidderRow>(),
    env.DB.prepare(`SELECT id, bidder, scope_type, scope_key, params_json, enabled
                    FROM bidder_overrides WHERE publisher_id = ? ORDER BY bidder, scope_type, scope_key`)
      .bind(siteId).all<OverrideRow>(),
    env.DB.prepare('SELECT id, name, map_json FROM size_maps WHERE publisher_id = ? ORDER BY name COLLATE NOCASE')
      .bind(siteId).all<SizeMapRow>(),
    env.DB.prepare('SELECT id, rule_key, rule_json FROM unit_rules WHERE publisher_id = ? ORDER BY rule_key COLLATE NOCASE')
      .bind(siteId).all<UnitRuleRow>(),
    env.DB.prepare(`SELECT id, version, file_key, modules_json, status, uploaded_by, uploaded_at
                    FROM prebid_builds WHERE publisher_id = ? AND status = 'current'
                    ORDER BY uploaded_at DESC LIMIT 1`)
      .bind(siteId).first<PrebidBuildRow>(),
  ]);

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  if (!site) errors.push(issue('site_missing', 'Site does not exist.', 'site'));
  if (!configRow) errors.push(issue('config_missing', 'Site configuration does not exist.', 'config'));
  if (!site || !configRow) return { ok: false, errors, warnings, summary: { siteId } };

  const config = parseRecord(configRow.config_json);
  const adUnits = unitsResult.results ?? [];
  const activeUnits = adUnits.filter((unit) => unit.enabled === 1 && unit.type !== 'DRAFT');
  const sizeMaps: LoadedMap[] = (mapsResult.results ?? []).map((row) => ({ ...row, map: parseMap(row.map_json) }));
  const mapByName = new Map(sizeMaps.map((row) => [row.name, row]));

  if (!site.gam_path || site.gam_path === '//') errors.push(issue('gam_path_missing', 'GAM path is required.', 'site'));
  if (!activeUnits.length) errors.push(issue('ad_units_missing', 'At least one enabled ATF or BTF ad unit is required.', 'ad_units'));
  for (const unit of activeUnits) {
    if (!unit.size_map_key) errors.push(issue('size_map_reference_missing', `${unit.code} has no size map.`, 'ad_units'));
    else if (!mapByName.has(unit.size_map_key)) errors.push(issue('size_map_missing', `${unit.code} references missing map ${unit.size_map_key}.`, 'size_maps'));
    else if (!mapByName.get(unit.size_map_key)!.map.length) errors.push(issue('size_map_empty', `${unit.size_map_key} has no valid breakpoints.`, 'size_maps'));
  }

  const bidders: LoadedBidder[] = [];
  for (const row of biddersResult.results ?? []) {
    const params = parseRecord(row.params_json);
    if (row.params_json.trim() !== '{}' && !Object.keys(params).length) {
      errors.push(issue('bidder_params_invalid', `${row.bidder} params are not a JSON object.`, 'bidders'));
    }
    bidders.push({ ...row, params });
  }
  const enabledBidders = bidders.filter((row) => row.enabled === 1);
  if (!enabledBidders.length) warnings.push(issue('bidders_empty', 'No enabled bidders are configured.', 'bidders'));

  const unitCodes = new Set(adUnits.map((unit) => unit.code));
  const overrides: LoadedOverride[] = [];
  for (const row of overridesResult.results ?? []) {
    const params = parseRecord(row.params_json);
    if (row.params_json.trim() !== '{}' && !Object.keys(params).length) {
      errors.push(issue('override_params_invalid', `${row.bidder} ${row.scope_type}/${row.scope_key} params are invalid.`, 'bidders'));
    }
    if (row.scope_type === 'adunit' && !unitCodes.has(row.scope_key)) {
      errors.push(issue('override_adunit_missing', `${row.bidder} override points to missing ${row.scope_key}.`, 'bidders'));
    }
    overrides.push({ ...row, params });
  }

  const unitRules: LoadedRule[] = (rulesResult.results ?? []).map((row) => ({ ...row, rule: parseRecord(row.rule_json) }));
  const ruleKeys = new Set(unitRules.map((row) => row.rule_key));
  for (const key of ['__DEFAULT__', '__ATF__', '__BTF__']) {
    if (!ruleKeys.has(key)) warnings.push(issue('base_rule_missing', `${key} is not configured.`, 'unit_rules'));
  }
  const advancedRules = isRecord(config.advancedUnitRules)
    ? Object.fromEntries(Object.entries(config.advancedUnitRules).filter((entry): entry is [string, JsonRecord] => isRecord(entry[1])))
    : {};

  const profileId = typeof config.generatorProfileId === 'string' ? config.generatorProfileId.trim() : '';
  let profile: GeneratorProfile | null = null;
  let profileTemplate = '';
  if (!profileId) errors.push(issue('generator_profile_missing', 'Choose a generator profile.', 'generator_profile'));
  else {
    profile = await readProfile(env.BUILDS, profileId);
    if (!profile) errors.push(issue('generator_profile_missing', `Generator profile ${profileId} was not found.`, 'generator_profile'));
    else {
      const object = await env.BUILDS.get(profile.templateKey);
      if (!object) errors.push(issue('generator_template_missing', 'Generator template is missing from R2.', 'generator_profile'));
      else profileTemplate = await object.text();
    }
  }

  let prebidBytes: ArrayBuffer | null = null;
  const prebidModules = prebidBuild ? parseStringArray(prebidBuild.modules_json) : [];
  if (!prebidBuild) errors.push(issue('prebid_build_missing', 'A current Prebid.js build is required.', 'prebid'));
  else {
    const object = await env.BUILDS.get(prebidBuild.file_key);
    if (!object) errors.push(issue('prebid_file_missing', 'The current Prebid.js file is missing from R2.', 'prebid'));
    else prebidBytes = await object.arrayBuffer();
  }

  const requiredBidderModules = uniqueSorted(enabledBidders.map((row) => adapterFor(row.bidder)));
  const requiredUserIdModules = await readRequiredUserIdModules(env.DB, siteId);
  const installed = new Set(prebidModules);
  for (const module of [...requiredBidderModules, ...requiredUserIdModules]) {
    if (!installed.has(module)) errors.push(issue('prebid_module_missing', `Current Prebid.js is missing ${module}.`, 'prebid'));
  }

  if (profile?.engine === 'legacy-frozen-v1' && Object.keys(advancedRules).length) {
    warnings.push(issue('advanced_inactive', 'Advanced schedules are saved but inactive under the frozen profile.', 'generator_profile'));
  }
  if (!isRecord(config.userSync)) warnings.push(issue('user_sync_empty', 'No saved User ID config exists; an empty safe userSync will be generated.', 'user_id'));

  const summary: JsonRecord = {
    siteId,
    siteName: site.name,
    domain: site.domain,
    activeAdUnits: activeUnits.length,
    enabledBidders: enabledBidders.length,
    sizeMaps: sizeMaps.length,
    unitRules: unitRules.length,
    advancedRules: Object.keys(advancedRules).length,
    generatorProfileId: profile ? profile.id : (profileId || null),
    generatorEngine: profile?.engine ?? null,
    prebidBuildId: prebidBuild?.id ?? null,
    prebidVersion: prebidBuild?.version ?? null,
    requiredBidderModules,
    requiredUserIdModules,
  };

  const ok = errors.length === 0 && Boolean(profile && prebidBuild && prebidBytes);
  return {
    ok,
    errors,
    warnings,
    summary,
    snapshot: ok && profile && prebidBuild && prebidBytes
      ? { site, configRow, config, adUnits, bidders, overrides, sizeMaps, unitRules, advancedRules,
          profile, profileTemplate, prebidBuild, prebidBytes, prebidModules,
          requiredBidderModules, requiredUserIdModules }
      : undefined,
  };
}

function sizeUnion(map: SizeMapBreakpoint[]): [number, number][] {
  const values = new Map<string, [number, number]>();
  for (const breakpoint of map) for (const size of breakpoint.sizes) values.set(`${size[0]}x${size[1]}`, size);
  return Array.from(values.values()).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
}

function runtimeData(snapshot: Snapshot) {
  const activeUnits = snapshot.adUnits.filter((unit) => unit.enabled === 1 && unit.type !== 'DRAFT');
  const mapByName = new Map(snapshot.sizeMaps.map((row) => [row.name, row.map]));
  const explicitUnits = activeUnits.map((unit) => {
    const map = unit.size_map_key ? (mapByName.get(unit.size_map_key) ?? []) : [];
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
    sizeMapsRaw[row.name] = row.map.map((breakpoint) => ({ viewport: breakpoint.minViewPort, sizes: breakpoint.sizes }));
  }

  const bidderSlotParams: JsonRecord = {};
  const bidderDeviceParams: JsonRecord = {};
  const bidderAdUnitParams: JsonRecord = {};
  for (const row of snapshot.overrides.filter((entry) => entry.enabled === 1)) {
    const target = row.scope_type === 'device' ? bidderDeviceParams : row.scope_type === 'adunit' ? bidderAdUnitParams : bidderSlotParams;
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
  const defaultRule = isRecord(adUnitRules.__DEFAULT__) ? adUnitRules.__DEFAULT__ as JsonRecord : {};
  const atfRule = isRecord(adUnitRules.__ATF__) ? adUnitRules.__ATF__ as JsonRecord : {};
  const btfRule = isRecord(adUnitRules.__BTF__) ? adUnitRules.__BTF__ as JsonRecord : {};
  const stickyRule = isRecord(adUnitRules.Sticky) ? adUnitRules.Sticky as JsonRecord : {};
  const timeout = (rule: JsonRecord, fallback: number) => {
    const value = Number(rule.timeout);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  let maxCmpTimeout = 1500;
  for (const rule of Object.values(adUnitRules)) {
    if (!isRecord(rule)) continue;
    const value = Number(rule.cmpTimeout);
    if (Number.isFinite(value) && value > maxCmpTimeout) maxCmpTimeout = value;
  }
  const userSync = isRecord(snapshot.config.userSync)
    ? snapshot.config.userSync
    : { syncEnabled: true, aliasSyncEnabled: true, syncsPerBidder: 5, syncDelay: 3000,
        auctionDelay: 150, filterSettings: { all: { bidders: '*', filter: 'include' } }, userIds: [] };

  return {
    bidders: snapshot.bidders.filter((row) => row.enabled === 1).map((row) => ({ bidder: row.bidder, params: row.params })),
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
    globalRefresh: isRecord(defaultRule.refresh) ? defaultRule.refresh as JsonRecord
      : isRecord(atfRule.refresh) ? atfRule.refresh as JsonRecord : {},
    maxCmpTimeout,
  };
}

function cssEscape(value: string): string {
  return value.replace(/([^A-Za-z0-9_-])/g, '\\$1');
}
function activeBreakpoint(map: SizeMapBreakpoint[], width: number): SizeMapBreakpoint | null {
  let selected: SizeMapBreakpoint | null = null;
  for (const breakpoint of map) if (breakpoint.minViewPort[0] <= width) selected = breakpoint;
  return selected ?? map[0] ?? null;
}
function minHeightCss(snapshot: Snapshot): string {
  const units = snapshot.adUnits.filter((unit) => unit.enabled === 1 && unit.type !== 'DRAFT' && unit.size_map_key);
  const maps = new Map(snapshot.sizeMaps.map((row) => [row.name, row.map]));
  const widths = new Set<number>([0]);
  for (const unit of units) for (const breakpoint of maps.get(unit.size_map_key!) ?? []) widths.add(breakpoint.minViewPort[0]);
  const output = ['/* Generated by Prebid Professor. */'];
  for (const width of Array.from(widths).sort((a, b) => a - b)) {
    const groups = new Map<number, string[]>();
    for (const unit of units) {
      const breakpoint = activeBreakpoint(maps.get(unit.size_map_key!) ?? [], width);
      const height = breakpoint ? Math.max(...breakpoint.sizes.map((size) => size[1])) : 0;
      if (!height) continue;
      groups.set(height, [...(groups.get(height) ?? []), `#${cssEscape(unit.code)}`]);
    }
    const rules = Array.from(groups.entries()).map(([height, ids]) => `${ids.join(', ')} { min-height: ${height}px; }`);
    if (!rules.length) continue;
    if (width === 0) output.push('', '/* 0px and above */', ...rules);
    else output.push('', `/* >= ${width}px */`, `@media (min-width: ${width}px) {`, ...rules.map((rule) => `  ${rule}`), '}');
  }
  return `${output.join('\n').trim()}\n`;
}
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
function divCsv(snapshot: Snapshot): string {
  const rows = [['Ad unit name', 'Div', 'class']];
  for (const unit of snapshot.adUnits.filter((row) => row.enabled === 1 && row.type !== 'DRAFT')) {
    const className = unit.type === 'BTF' ? 'wrapperAd lazyAd' : 'wrapperAd';
    rows.push([unit.code, `<div id="${unit.code}" class="${className}"></div>`, className]);
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}
function implementationHtml(snapshot: Snapshot, origin: string): string {
  const divs = snapshot.adUnits.filter((unit) => unit.enabled === 1 && unit.type !== 'DRAFT').map((unit) => {
    const className = unit.type === 'BTF' ? 'wrapperAd lazyAd' : 'wrapperAd';
    return `<!-- ${unit.code} -->\n<div id="${unit.code}" class="${className}"></div>`;
  }).join('\n\n');
  return `<!-- Prebid Professor implementation for ${snapshot.site.name} -->\n<link rel="stylesheet" href="${origin}/cdn/${snapshot.site.id}/current/min-height.css">\n<script src="${origin}/cdn/${snapshot.site.id}/current/prebid.js"></script>\n<script src="${origin}/cdn/${snapshot.site.id}/current/ads.min.js"></script>\n\n${divs}\n`;
}

async function putArtifact(bucket: R2Bucket, key: string, body: string | ArrayBuffer, fileName: string, metadata: Record<string, string>) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body).buffer : body;
  const hash = await sha256Hex(bytes);
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: contentType(fileName), cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { ...metadata, fileName, sha256: hash },
  });
  return { key, size: bytes.byteLength, sha256: hash, contentType: contentType(fileName) };
}
async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
async function manifestFor(bucket: R2Bucket, key: string | null): Promise<JsonRecord | null> {
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
function releasePayload(request: Request, row: ReleaseRow, manifest: JsonRecord | null) {
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
      adsJs: absoluteUrl(request, `${base}/ads.js`), adsMinJs: absoluteUrl(request, `${base}/ads.min.js`),
      prebidJs: absoluteUrl(request, `${base}/prebid.js`), config: absoluteUrl(request, `${base}/config.json`),
      manifest: absoluteUrl(request, `${base}/manifest.json`), css: absoluteUrl(request, `${base}/min-height.css`),
      divCsv: absoluteUrl(request, `${base}/div-export.csv`), implementation: absoluteUrl(request, `${base}/implementation.html`),
    },
  };
}

export async function validateRelease(env: ReleaseEnv, siteId: string): Promise<Response> {
  const result = await loadSnapshot(env, siteId);
  return json({ ok: result.ok, errors: result.errors, warnings: result.warnings, summary: result.summary }, { status: result.ok ? 200 : 422 });
}

export async function generateRelease(request: Request, env: ReleaseEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!env.BUILDS) return storageMissing();
  const validation = await loadSnapshot(env, siteId);
  if (!validation.ok || !validation.snapshot) {
    return apiError('Release validation failed.', 422, { errors: validation.errors, warnings: validation.warnings, summary: validation.summary });
  }

  let notes = '';
  if ((request.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      const body = await request.json() as JsonRecord;
      notes = String(body.notes ?? '').trim();
    } catch {
      return apiError('Release notes JSON could not be read.');
    }
  }

  const snapshot = validation.snapshot;
  const version = await uniqueVersion(env.DB, siteId);
  const data = runtimeData(snapshot);
  let compiled;
  try {
    compiled = compileRuntime({
      template: snapshot.profileTemplate,
      engine: snapshot.profile.engine,
      buildVersion: version,
      siteId,
      generatorProfileId: snapshot.profile.id,
      gamPath: snapshot.site.gam_path,
      bidders: data.bidders,
      bidderSlotParams: data.bidderSlotParams,
      bidderDeviceParams: data.bidderDeviceParams,
      bidderAdUnitParams: data.bidderAdUnitParams,
      adUnitRules: data.adUnitRules,
      explicitUnits: data.explicitUnits,
      sizeMapsRaw: data.sizeMapsRaw,
      prebidSizeConfigsRaw: {},
      userSync: data.userSync,
      defaultTimeout: data.defaultTimeout,
      atfTimeout: data.atfTimeout,
      btfTimeout: data.btfTimeout,
      stickyTimeout: data.stickyTimeout,
      globalRefresh: data.globalRefresh,
      maxCmpTimeout: data.maxCmpTimeout,
    });
  } catch (error) {
    return apiError('Runtime compilation failed.', 422, error instanceof Error ? error.message : String(error));
  }

  const actor = getActor(request);
  const createdAt = new Date().toISOString();
  const releaseId = crypto.randomUUID();
  const origin = new URL(request.url).origin;
  const configSnapshot = {
    schemaVersion: 1,
    version,
    generatedAt: createdAt,
    site: snapshot.site,
    generatorProfile: snapshot.profile,
    prebidBuild: { id: snapshot.prebidBuild.id, version: snapshot.prebidBuild.version, modules: snapshot.prebidModules },
    adUnits: snapshot.adUnits,
    bidders: snapshot.bidders.map((row) => ({ bidder: row.bidder, params: row.params, enabled: row.enabled === 1 })),
    bidderOverrides: snapshot.overrides.map((row) => ({ bidder: row.bidder, scopeType: row.scope_type, scopeKey: row.scope_key, params: row.params, enabled: row.enabled === 1 })),
    sizeMaps: snapshot.sizeMaps.map((row) => ({ name: row.name, map: row.map })),
    unitRules: data.adUnitRules,
    userIdConfig: snapshot.config.userIdConfig ?? null,
    userSync: data.userSync,
    compiler: { engine: snapshot.profile.engine, patches: compiled.patches, warnings: compiled.warnings, minifier: compiled.minifier },
  };
  const configText = `${JSON.stringify(configSnapshot, null, 2)}\n`;
  const configHash = await sha256Hex(configText);
  const prefix = releasePrefix(siteId, version);

  try {
    const files: Record<string, unknown> = {};
    const add = async (fileName: string, body: string | ArrayBuffer) => {
      files[fileName] = await putArtifact(env.BUILDS!, releaseKey(siteId, version, fileName), body, fileName, {
        siteId, releaseId, version, generatorProfileId: snapshot.profile.id, createdBy: actor,
      });
    };
    await Promise.all([
      add('ads.js', compiled.adsJs), add('ads.min.js', compiled.adsMinJs), add('prebid.js', snapshot.prebidBytes),
      add('config.json', configText), add('min-height.css', minHeightCss(snapshot)), add('div-export.csv', divCsv(snapshot)),
      add('implementation.html', implementationHtml(snapshot, origin)),
    ]);
    const manifest = {
      schemaVersion: 1, releaseId, siteId, version, status: 'draft', generatedAt: createdAt, generatedBy: actor, configHash,
      generatorProfile: { id: snapshot.profile.id, name: snapshot.profile.name, version: snapshot.profile.version,
        engine: snapshot.profile.engine, templateSha256: snapshot.profile.templateSha256, sourceSha256: snapshot.profile.sourceSha256 },
      prebidBuild: { id: snapshot.prebidBuild.id, version: snapshot.prebidBuild.version, modules: snapshot.prebidModules },
      compiler: { patches: compiled.patches, warnings: [...compiled.warnings, ...validation.warnings.map((item) => item.message)], minifier: compiled.minifier },
      files,
      publicBaseUrl: `${origin}/cdn/${siteId}/releases/${version}`,
    };
    await add('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

    await env.DB.batch([
      env.DB.prepare(`INSERT INTO releases (
        id, publisher_id, version, status, config_hash, ads_js_key, ads_min_js_key, prebid_js_key,
        config_key, manifest_key, notes, created_by, created_at
      ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(releaseId, siteId, version, configHash, releaseKey(siteId, version, 'ads.js'), releaseKey(siteId, version, 'ads.min.js'),
          releaseKey(siteId, version, 'prebid.js'), releaseKey(siteId, version, 'config.json'), releaseKey(siteId, version, 'manifest.json'),
          notes || null, actor, createdAt),
      env.DB.prepare('UPDATE publisher_configs SET config_hash = ?, updated_at = ? WHERE publisher_id = ?')
        .bind(configHash, createdAt, siteId),
      env.DB.prepare(`INSERT INTO audit_log (
        id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
      ) VALUES (?, ?, 'release.generated', ?, 'release', ?, ?, ?)`)
        .bind(crypto.randomUUID(), actor, siteId, releaseId,
          JSON.stringify({ version, configHash, generatorProfileId: snapshot.profile.id, files: RELEASE_FILES }), createdAt),
    ]);

    const row = await fetchRelease(env.DB, siteId, releaseId);
    return json({ ok: true, release: row ? releasePayload(request, row, manifest) : null }, { status: 201 });
  } catch (error) {
    await deletePrefix(env.BUILDS, prefix).catch(() => undefined);
    return apiError('Release generation failed.', 500, error instanceof Error ? error.message : String(error));
  }
}

export async function listReleases(request: Request, env: ReleaseEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!env.BUILDS) return storageMissing();
  const result = await env.DB.prepare(`SELECT id, publisher_id, version, status, config_hash, ads_js_key, ads_min_js_key,
      prebid_js_key, config_key, manifest_key, notes, created_by, created_at, published_at
      FROM releases WHERE publisher_id = ? ORDER BY created_at DESC`).bind(siteId).all<ReleaseRow>();
  const releases = await Promise.all((result.results ?? []).map(async (row) => releasePayload(request, row, await manifestFor(env.BUILDS!, row.manifest_key))));
  return json({
    ok: true,
    releases,
    channels: {
      current: Object.fromEntries(RELEASE_FILES.map((name) => [name, absoluteUrl(request, `/cdn/${siteId}/current/${name}`)])),
      staging: Object.fromEntries(RELEASE_FILES.map((name) => [name, absoluteUrl(request, `/cdn/${siteId}/staging/${name}`)])),
    },
  });
}

async function fetchRelease(db: D1Database, siteId: string, releaseId: string): Promise<ReleaseRow | null> {
  return db.prepare(`SELECT id, publisher_id, version, status, config_hash, ads_js_key, ads_min_js_key,
      prebid_js_key, config_key, manifest_key, notes, created_by, created_at, published_at
      FROM releases WHERE publisher_id = ? AND id = ? LIMIT 1`).bind(siteId, releaseId).first<ReleaseRow>();
}

async function copyToChannel(bucket: R2Bucket, siteId: string, version: string, channel: Channel): Promise<void> {
  for (const fileName of RELEASE_FILES) {
    const source = await bucket.get(releaseKey(siteId, version, fileName));
    if (!source) throw new Error(`${fileName} is missing from release ${version}.`);
    const bytes = await source.arrayBuffer();
    const headers = new Headers();
    source.writeHttpMetadata(headers);
    await bucket.put(channelKey(siteId, channel, fileName), bytes, {
      httpMetadata: { contentType: headers.get('content-type') ?? contentType(fileName),
        cacheControl: channel === 'staging' ? 'no-store' : 'public, max-age=60, stale-while-revalidate=300' },
      customMetadata: { ...(source.customMetadata ?? {}), channel, sourceVersion: version, promotedAt: new Date().toISOString() },
    });
  }
}

async function promote(request: Request, env: ReleaseEnv, siteId: string, releaseId: string, channel: 'staging' | 'production', rollback: boolean): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!env.BUILDS) return storageMissing();
  const release = await fetchRelease(env.DB, siteId, releaseId);
  if (!release) return apiError('Release not found.', 404);
  if (release.status === 'failed') return apiError('Failed releases cannot be promoted.', 409);
  if (channel === 'staging' && release.status === 'production') return apiError('The current production release does not need staging promotion.', 409);
  try {
    await copyToChannel(env.BUILDS, siteId, release.version, channel === 'production' ? 'current' : 'staging');
  } catch (error) {
    return apiError('Release artifacts could not be promoted.', 409, error instanceof Error ? error.message : String(error));
  }

  const actor = getActor(request);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (channel === 'production') {
    statements.push(
      env.DB.prepare(`UPDATE releases SET status = 'archived' WHERE publisher_id = ? AND status = 'production' AND id <> ?`).bind(siteId, releaseId),
      env.DB.prepare(`UPDATE releases SET status = 'production', published_at = ? WHERE publisher_id = ? AND id = ?`).bind(now, siteId, releaseId),
      env.DB.prepare(`UPDATE publishers SET current_release_id = ?, current_version = ?, last_published_at = ?, status = 'live', updated_at = ? WHERE id = ?`)
        .bind(releaseId, release.version, now, now, siteId),
    );
  } else {
    statements.push(
      env.DB.prepare(`UPDATE releases SET status = 'archived' WHERE publisher_id = ? AND status = 'staging' AND id <> ?`).bind(siteId, releaseId),
      env.DB.prepare(`UPDATE releases SET status = 'staging', published_at = ? WHERE publisher_id = ? AND id = ?`).bind(now, siteId, releaseId),
    );
  }
  statements.push(env.DB.prepare(`INSERT INTO audit_log (
    id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
  ) VALUES (?, ?, ?, ?, 'release', ?, ?, ?)`)
    .bind(crypto.randomUUID(), actor,
      rollback ? 'release.rolled_back' : channel === 'production' ? 'release.production_published' : 'release.staging_published',
      siteId, releaseId, JSON.stringify({ version: release.version, channel }), now));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    return apiError('Release metadata could not be updated.', 500, error instanceof Error ? error.message : String(error));
  }
  const updated = await fetchRelease(env.DB, siteId, releaseId);
  return json({ ok: true, release: updated ? releasePayload(request, updated, await manifestFor(env.BUILDS, updated.manifest_key)) : null });
}

export function publishReleaseToStaging(request: Request, env: ReleaseEnv, siteId: string, releaseId: string) {
  return promote(request, env, siteId, releaseId, 'staging', false);
}
export function publishReleaseToProduction(request: Request, env: ReleaseEnv, siteId: string, releaseId: string) {
  return promote(request, env, siteId, releaseId, 'production', false);
}
export function rollbackRelease(request: Request, env: ReleaseEnv, siteId: string, releaseId: string) {
  return promote(request, env, siteId, releaseId, 'production', true);
}

export async function serveReleaseCdn(request: Request, env: ReleaseEnv): Promise<Response | null> {
  if (!env.BUILDS || !['GET', 'HEAD'].includes(request.method)) return null;
  const pathname = new URL(request.url).pathname;
  let key: string;
  let immutable = false;
  const channelMatch = pathname.match(/^\/cdn\/([^/]+)\/(current|staging)\/([^/]+)$/);
  if (channelMatch) {
    const siteId = decodeURIComponent(channelMatch[1]);
    const channel = channelMatch[2] as Channel;
    const fileName = decodeURIComponent(channelMatch[3]);
    if (!safeSegment(siteId) || !safeSegment(fileName)) return apiError('Invalid CDN path.', 400);
    key = channelKey(siteId, channel, fileName);
  } else {
    const releaseMatch = pathname.match(/^\/cdn\/([^/]+)\/releases\/([^/]+)\/([^/]+)$/);
    if (!releaseMatch) return null;
    const siteId = decodeURIComponent(releaseMatch[1]);
    const version = decodeURIComponent(releaseMatch[2]);
    const fileName = decodeURIComponent(releaseMatch[3]);
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
  headers.set('cache-control', immutable ? 'public, max-age=31536000, immutable' : pathname.includes('/staging/') ? 'no-store' : 'public, max-age=60, stale-while-revalidate=300');
  headers.set('etag', object.httpEtag);
  const body = request.method === 'HEAD' ? null : (object as R2ObjectBody).body;
  return new Response(body, { headers });
}
