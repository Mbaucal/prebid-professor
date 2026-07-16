import { apiError, getActor, json } from './http';
import type { DatabaseEnv } from './publishers';

type JsonRecord = Record<string, unknown>;
type StorageType = 'cookie' | 'html5' | 'cookie&html5';
type FilterMode = 'include' | 'exclude';

type UserIdModuleConfig = {
  id: string;
  name: string;
  moduleCode: string;
  enabled: boolean;
  params: JsonRecord;
  storage: JsonRecord | null;
  bidders: string[];
  value: JsonRecord | null;
  notes: string | null;
};

type UserIdConfig = {
  enabled: boolean;
  syncEnabled: boolean;
  aliasSyncEnabled: boolean;
  syncsPerBidder: number;
  syncDelay: number;
  auctionDelay: number;
  filterSettings: {
    all: {
      bidders: '*' | string[];
      filter: FilterMode;
    };
  };
  ppid: string | null;
  autoRefresh: boolean;
  retainConfig: boolean;
  enforceStorageType: boolean;
  idPriority: JsonRecord;
  modules: UserIdModuleConfig[];
};

type CatalogItem = {
  name: string;
  moduleCode: string;
  label: string;
  description: string;
  registration: string;
  defaultParams: JsonRecord;
  defaultStorage: JsonRecord | null;
};

const USER_ID_CATALOG: CatalogItem[] = [
  {
    name: 'sharedId',
    moduleCode: 'sharedIdSystem',
    label: 'SharedID',
    description: 'Publisher first-party identifier stored in cookie or HTML5 storage.',
    registration: 'No vendor registration required; privacy disclosure and opt-out handling are still required.',
    defaultParams: {},
    defaultStorage: { type: 'cookie', name: '_sharedid', expires: 365 },
  },
  {
    name: 'id5Id',
    moduleCode: 'id5IdSystem',
    label: 'ID5 ID',
    description: 'ID5 identity module with partner-specific configuration and recommended two-hour refresh.',
    registration: 'Requires an ID5 Partner Number.',
    defaultParams: {
      partner: 0,
      externalModuleUrl: 'https://cdn.id5-sync.com/api/1.0/id5PrebidModule.js',
      canCookieSync: true,
      gamTargetingPrefix: 'id5',
    },
    defaultStorage: { type: 'html5', name: 'id5id', expires: 90, refreshInSeconds: 7200 },
  },
  {
    name: 'teadsId',
    moduleCode: 'teadsIdSystem',
    label: 'Teads ID',
    description: 'First-party Teads identifier configured with the publisher Teads ID.',
    registration: 'Requires a Teads Publisher ID.',
    defaultParams: { pubId: 0 },
    defaultStorage: null,
  },
  {
    name: 'criteo',
    moduleCode: 'criteoIdSystem',
    label: 'Criteo ID for Exchanges',
    description: 'Criteo identity module; its own caching should normally be used.',
    registration: 'No module parameters are required.',
    defaultParams: {},
    defaultStorage: null,
  },
  {
    name: 'lotamePanoramaId',
    moduleCode: 'lotamePanoramaIdSystem',
    label: 'Lotame Panorama ID',
    description: 'Lotame Panorama identity module configured with a registered client ID.',
    registration: 'Requires a Lotame Panorama Client ID.',
    defaultParams: { clientId: '' },
    defaultStorage: null,
  },
];

const DEFAULT_CONFIG: UserIdConfig = {
  enabled: true,
  syncEnabled: true,
  aliasSyncEnabled: true,
  syncsPerBidder: 5,
  syncDelay: 3000,
  auctionDelay: 150,
  filterSettings: { all: { bidders: '*', filter: 'include' } },
  ppid: null,
  autoRefresh: false,
  retainConfig: true,
  enforceStorageType: false,
  idPriority: {},
  modules: [],
};

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneDefault(): UserIdConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as UserIdConfig;
}

function integerInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  }
  return candidate;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error('Boolean fields must be true or false.');
  return value;
}

function nullableString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeStringList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? '')
        .split(/[;,\n]+/)
        .map((item) => item.trim());
  return Array.from(
    new Set(raw.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)),
  );
}

function normalizeObject(value: unknown, field: string, nullable = false): JsonRecord | null {
  if ((value === null || value === undefined || value === '') && nullable) return null;
  if (!isRecord(value)) throw new Error(`${field} must be a JSON object${nullable ? ' or null' : ''}.`);
  return value;
}

function normalizeStorage(value: unknown, moduleName: string): JsonRecord | null {
  if (value === null || value === undefined || value === '') return null;
  if (!isRecord(value)) throw new Error(`${moduleName}.storage must be a JSON object or null.`);

  const type = String(value.type ?? '').trim() as StorageType;
  if (!['cookie', 'html5', 'cookie&html5'].includes(type)) {
    throw new Error(`${moduleName}.storage.type must be cookie, html5 or cookie&html5.`);
  }

  const name = String(value.name ?? '').trim();
  if (!name) throw new Error(`${moduleName}.storage.name is required.`);

  const expires = integerInRange(value.expires, `${moduleName}.storage.expires`, 1, 3650, 365);
  const storage: JsonRecord = { ...value, type, name, expires };

  if (value.refreshInSeconds !== undefined && value.refreshInSeconds !== null && value.refreshInSeconds !== '') {
    storage.refreshInSeconds = integerInRange(
      value.refreshInSeconds,
      `${moduleName}.storage.refreshInSeconds`,
      1,
      31_536_000,
      7200,
    );
  } else {
    delete storage.refreshInSeconds;
  }

  return storage;
}

function validateKnownModule(module: UserIdModuleConfig, warnings: string[]): void {
  if (!module.enabled) return;

  if (module.name === 'sharedId' && !module.storage) {
    throw new Error('sharedId requires a storage object.');
  }

  if (module.name === 'id5Id') {
    const partner = Number(module.params.partner);
    if (!Number.isInteger(partner) || partner <= 0) {
      throw new Error('id5Id.params.partner must be a positive ID5 Partner Number.');
    }
    const refresh = Number(module.storage?.refreshInSeconds ?? 0);
    if (module.storage && (!Number.isFinite(refresh) || refresh <= 0 || refresh > 7200)) {
      warnings.push('ID5 recommends storage.refreshInSeconds of 7200 seconds or less.');
    }
  }

  if (module.name === 'teadsId') {
    const pubId = Number(module.params.pubId);
    if (!Number.isInteger(pubId) || pubId <= 0) {
      throw new Error('teadsId.params.pubId must be a positive Teads Publisher ID.');
    }
  }

  if (module.name === 'lotamePanoramaId' && !String(module.params.clientId ?? '').trim()) {
    throw new Error('lotamePanoramaId.params.clientId is required.');
  }

  if (module.name === 'criteo' && module.storage) {
    warnings.push('Criteo recommends using its own caching and normally omitting storage from the Criteo ID config.');
  }
}

function normalizeModule(value: unknown, index: number, warnings: string[]): UserIdModuleConfig {
  if (!isRecord(value)) throw new Error(`modules[${index}] must be an object.`);

  const name = String(value.name ?? '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(name)) {
    throw new Error(`modules[${index}].name is invalid.`);
  }

  const moduleCode = String(value.moduleCode ?? '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,119}$/.test(moduleCode)) {
    throw new Error(`modules[${index}].moduleCode is invalid.`);
  }

  const module: UserIdModuleConfig = {
    id: String(value.id ?? '').trim() || crypto.randomUUID(),
    name,
    moduleCode,
    enabled: booleanValue(value.enabled, true),
    params: normalizeObject(value.params ?? {}, `${name}.params`) as JsonRecord,
    storage: normalizeStorage(value.storage, name),
    bidders: normalizeStringList(value.bidders),
    value: normalizeObject(value.value, `${name}.value`, true),
    notes: nullableString(value.notes),
  };

  validateKnownModule(module, warnings);
  return module;
}

function normalizeConfig(value: unknown): { config: UserIdConfig; warnings: string[] } {
  if (!isRecord(value)) throw new Error('userIdConfig must be an object.');
  const warnings: string[] = [];

  const filterInput = isRecord(value.filterSettings) && isRecord(value.filterSettings.all)
    ? value.filterSettings.all
    : {};
  const filter = String(filterInput.filter ?? 'include') as FilterMode;
  if (!['include', 'exclude'].includes(filter)) throw new Error('filterSettings.all.filter is invalid.');

  const rawFilterBidders = filterInput.bidders;
  const filterBidders = rawFilterBidders === '*'
    ? '*'
    : normalizeStringList(rawFilterBidders);

  const rawModules = value.modules ?? [];
  if (!Array.isArray(rawModules)) throw new Error('modules must be an array.');
  if (rawModules.length > 50) throw new Error('No more than 50 User ID modules can be configured.');

  const modules = rawModules.map((module, index) => normalizeModule(module, index, warnings));
  const names = new Set<string>();
  const moduleCodes = new Set<string>();
  for (const module of modules) {
    const normalizedName = module.name.toLowerCase();
    const normalizedCode = module.moduleCode.toLowerCase();
    if (names.has(normalizedName)) throw new Error(`User ID module name "${module.name}" is duplicated.`);
    if (moduleCodes.has(normalizedCode)) throw new Error(`Prebid module code "${module.moduleCode}" is duplicated.`);
    names.add(normalizedName);
    moduleCodes.add(normalizedCode);
  }

  const idPriority = normalizeObject(value.idPriority ?? {}, 'idPriority') as JsonRecord;

  const config: UserIdConfig = {
    enabled: booleanValue(value.enabled, true),
    syncEnabled: booleanValue(value.syncEnabled, true),
    aliasSyncEnabled: booleanValue(value.aliasSyncEnabled, true),
    syncsPerBidder: integerInRange(value.syncsPerBidder, 'syncsPerBidder', 0, 50, 5),
    syncDelay: integerInRange(value.syncDelay, 'syncDelay', 0, 120_000, 3000),
    auctionDelay: integerInRange(value.auctionDelay, 'auctionDelay', 0, 10_000, 150),
    filterSettings: { all: { bidders: filterBidders, filter } },
    ppid: nullableString(value.ppid),
    autoRefresh: booleanValue(value.autoRefresh, false),
    retainConfig: booleanValue(value.retainConfig, true),
    enforceStorageType: booleanValue(value.enforceStorageType, false),
    idPriority,
    modules,
  };

  if (config.enabled && !modules.some((module) => module.enabled)) {
    warnings.push('User ID is enabled, but no User ID submodule is active.');
  }
  if (filterBidders !== '*' && filterBidders.length === 0) {
    warnings.push('The global user-sync filter has an empty bidder list.');
  }

  return { config, warnings: Array.from(new Set(warnings)) };
}

function parseStoredConfig(configJson: string): JsonRecord {
  try {
    const parsed = JSON.parse(configJson) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function storedUserIdConfig(config: JsonRecord): UserIdConfig {
  const raw = config.userIdConfig;
  if (!isRecord(raw)) return cloneDefault();
  try {
    return normalizeConfig(raw).config;
  } catch {
    return cloneDefault();
  }
}

export function compileUserSync(config: UserIdConfig): JsonRecord {
  const userIds = config.enabled
    ? config.modules
        .filter((module) => module.enabled)
        .map((module) => {
          const entry: JsonRecord = { name: module.name };
          if (Object.keys(module.params).length) entry.params = module.params;
          if (module.storage) entry.storage = module.storage;
          if (module.bidders.length) entry.bidders = module.bidders;
          if (module.value) entry.value = module.value;
          return entry;
        })
    : [];

  const userSync: JsonRecord = {
    syncEnabled: config.syncEnabled,
    aliasSyncEnabled: config.aliasSyncEnabled,
    syncsPerBidder: config.syncsPerBidder,
    syncDelay: config.syncDelay,
    auctionDelay: config.auctionDelay,
    filterSettings: config.filterSettings,
    autoRefresh: config.autoRefresh,
    retainConfig: config.retainConfig,
    enforceStorageType: config.enforceStorageType,
    userIds,
  };

  if (config.ppid) userSync.ppid = config.ppid;
  if (Object.keys(config.idPriority).length) userSync.idPriority = config.idPriority;
  return userSync;
}

function requiredModules(config: UserIdConfig): string[] {
  if (!config.enabled) return [];
  const enabled = config.modules.filter((module) => module.enabled);
  if (!enabled.length) return [];
  return Array.from(new Set(['userId', ...enabled.map((module) => module.moduleCode)])).sort((a, b) =>
    a.localeCompare(b),
  );
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1').bind(siteId).first<{ id: string }>();
  return Boolean(row);
}

async function readPublisherConfig(db: D1Database, siteId: string): Promise<{ id: string; config: JsonRecord } | null> {
  const row = await db
    .prepare('SELECT id, config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
    .bind(siteId)
    .first<{ id: string; config_json: string }>();
  return row ? { id: row.id, config: parseStoredConfig(row.config_json) } : null;
}

export async function readRequiredUserIdModules(db: D1Database, siteId: string): Promise<string[]> {
  const row = await readPublisherConfig(db, siteId);
  if (!row) return [];
  return requiredModules(storedUserIdConfig(row.config));
}

export async function getUserIdConfig(env: DatabaseEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  const row = await readPublisherConfig(env.DB, siteId);
  if (!row) return apiError('Publisher config was not found.', 404);
  const config = storedUserIdConfig(row.config);

  return json({
    ok: true,
    userIdConfig: config,
    userSyncPreview: compileUserSync(config),
    requiredModules: requiredModules(config),
    catalog: USER_ID_CATALOG,
    warnings: normalizeConfig(config).warnings,
  });
}

export async function updateUserIdConfig(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return apiError('JSON body could not be read.');
  }

  let normalized: { config: UserIdConfig; warnings: string[] };
  try {
    normalized = normalizeConfig(input);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'User ID configuration is invalid.', 422);
  }

  const row = await readPublisherConfig(env.DB, siteId);
  if (!row) return apiError('Publisher config was not found.', 404);

  const configJson = row.config;
  configJson.userIdConfig = normalized.config;
  // Keep a compiled native Prebid userSync object for the frozen generator and
  // for release validation. userIdConfig remains the editable source of truth.
  configJson.userSync = compileUserSync(normalized.config);

  const actor = getActor(request);
  const now = new Date().toISOString();

  try {
    await env.DB.batch([
      env.DB
        .prepare('UPDATE publisher_configs SET config_json = ?, updated_at = ? WHERE publisher_id = ?')
        .bind(JSON.stringify(configJson), now, siteId),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'user_id_config.updated', ?, 'user_id_config', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          siteId,
          JSON.stringify({
            enabled: normalized.config.enabled,
            activeModules: normalized.config.modules
              .filter((module) => module.enabled)
              .map((module) => ({ name: module.name, moduleCode: module.moduleCode })),
            requiredModules: requiredModules(normalized.config),
            warnings: normalized.warnings,
          }),
          now,
        ),
    ]);
  } catch (error) {
    return apiError(
      'User ID configuration could not be saved.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  return json({
    ok: true,
    userIdConfig: normalized.config,
    userSyncPreview: compileUserSync(normalized.config),
    requiredModules: requiredModules(normalized.config),
    catalog: USER_ID_CATALOG,
    warnings: normalized.warnings,
  });
}
