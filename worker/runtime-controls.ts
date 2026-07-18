import { apiError, getActor, json } from './http';
import type { DatabaseEnv } from './publishers';

type JsonRecord = Record<string, unknown>;

type RuntimeControls = {
  sticky: {
    bottomAdUnitId: string | null;
    topAdUnitId: string | null;
    allowClosePortal: boolean;
  };
  floors: {
    configured: boolean;
    enabled: boolean;
    currency: string;
    hardFloor: number;
    bidderFloors: Record<string, number>;
    rules: Record<string, number>;
  };
  output: {
    cleanComments: boolean;
  };
};

type ConfigRow = {
  config_json: string;
};

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseConfig(value: string): JsonRecord {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function finiteNonNegative(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeNumberMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const output: Record<string, number> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    const parsed = Number(rawValue);
    if (!key || !Number.isFinite(parsed) || parsed < 0) continue;
    output[key] = parsed;
  }
  return output;
}

function nullableString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function controlsFromConfig(config: JsonRecord, adUnitCodes: string[]): RuntimeControls {
  const runtime = isRecord(config.runtimeControls) ? config.runtimeControls : {};
  const sticky = isRecord(runtime.sticky) ? runtime.sticky : {};
  const floorsConfigured = isRecord(runtime.floors);
  const floors = floorsConfigured ? runtime.floors as JsonRecord : {};
  const output = isRecord(runtime.output) ? runtime.output : {};
  const defaultBottom = adUnitCodes.includes('Sticky') ? 'Sticky' : null;

  return {
    sticky: {
      bottomAdUnitId: nullableString(sticky.bottomAdUnitId) ?? defaultBottom,
      topAdUnitId: nullableString(sticky.topAdUnitId),
      allowClosePortal: sticky.allowClosePortal === true,
    },
    floors: {
      configured: floorsConfigured,
      // Existing legacy templates already enforce 0.04 EUR. Until the admin
      // saves this panel, expose that legacy value without making validation
      // depend on the optional priceFloors module.
      enabled: floorsConfigured ? floors.enabled !== false : true,
      currency: /^[A-Z]{3}$/.test(String(floors.currency ?? '').toUpperCase())
        ? String(floors.currency).toUpperCase()
        : 'EUR',
      hardFloor: finiteNonNegative(floors.hardFloor, 0.04),
      bidderFloors: normalizeNumberMap(floors.bidderFloors),
      rules: normalizeNumberMap(floors.rules),
    },
    output: {
      cleanComments: output.cleanComments !== false,
    },
  };
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1')
    .bind(siteId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function readConfig(db: D1Database, siteId: string): Promise<ConfigRow | null> {
  return db
    .prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
    .bind(siteId)
    .first<ConfigRow>();
}

async function loadReferenceData(db: D1Database, siteId: string) {
  const [units, bidders] = await Promise.all([
    db
      .prepare(`SELECT code, type, enabled FROM ad_units
                WHERE publisher_id = ? ORDER BY sort_order, code COLLATE NOCASE`)
      .bind(siteId)
      .all<{ code: string; type: string; enabled: number }>(),
    db
      .prepare(`SELECT bidder, enabled FROM bidders
                WHERE publisher_id = ? ORDER BY bidder COLLATE NOCASE`)
      .bind(siteId)
      .all<{ bidder: string; enabled: number }>(),
  ]);

  return {
    adUnits: (units.results ?? []).map((row) => ({
      code: row.code,
      type: row.type,
      enabled: row.enabled === 1,
    })),
    bidders: (bidders.results ?? []).map((row) => ({
      bidder: row.bidder,
      enabled: row.enabled === 1,
    })),
  };
}

function validateControls(body: JsonRecord, adUnitCodes: Set<string>): RuntimeControls | Response {
  const stickyInput = isRecord(body.sticky) ? body.sticky : {};
  const floorsInput = isRecord(body.floors) ? body.floors : {};
  const outputInput = isRecord(body.output) ? body.output : {};

  const bottomAdUnitId = nullableString(stickyInput.bottomAdUnitId);
  const topAdUnitId = nullableString(stickyInput.topAdUnitId);
  if (bottomAdUnitId && !adUnitCodes.has(bottomAdUnitId)) {
    return apiError(`Bottom sticky ad unit "${bottomAdUnitId}" does not exist.`, 422);
  }
  if (topAdUnitId && !adUnitCodes.has(topAdUnitId)) {
    return apiError(`Top sticky ad unit "${topAdUnitId}" does not exist.`, 422);
  }
  if (bottomAdUnitId && topAdUnitId && bottomAdUnitId === topAdUnitId) {
    return apiError('Bottom and top sticky must use different ad units.', 422);
  }

  const currency = String(floorsInput.currency ?? 'EUR').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return apiError('Floor currency must be a three-letter ISO currency code.', 422);
  }

  const hardFloor = Number(floorsInput.hardFloor ?? 0);
  if (!Number.isFinite(hardFloor) || hardFloor < 0 || hardFloor > 1000) {
    return apiError('Global floor must be a number between 0 and 1000.', 422);
  }

  const bidderFloors = normalizeNumberMap(floorsInput.bidderFloors);
  const rules = normalizeNumberMap(floorsInput.rules);

  return {
    sticky: {
      bottomAdUnitId,
      topAdUnitId,
      allowClosePortal: stickyInput.allowClosePortal === true,
    },
    floors: {
      configured: true,
      enabled: floorsInput.enabled !== false,
      currency,
      hardFloor,
      bidderFloors,
      rules,
    },
    output: {
      cleanComments: outputInput.cleanComments !== false,
    },
  };
}

async function buildPayload(db: D1Database, siteId: string, config: JsonRecord) {
  const references = await loadReferenceData(db, siteId);
  return {
    ok: true,
    controls: controlsFromConfig(config, references.adUnits.map((unit) => unit.code)),
    ...references,
    floorRuleSchema: {
      delimiter: '|',
      fields: ['mediaType', 'size', 'deviceType', 'dayType', 'timeOfDay'],
      examples: [
        'banner|320x50|mobile|*|*',
        'banner|970x250|desktop|weekday|morning',
        '*|*|*|*|*',
      ],
    },
  };
}

export async function getRuntimeControls(env: DatabaseEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);
  const row = await readConfig(env.DB, siteId);
  if (!row) return apiError('Publisher config was not found.', 404);
  return json(await buildPayload(env.DB, siteId, parseConfig(row.config_json)));
}

export async function updateRuntimeControls(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('JSON body could not be read.');
  }
  if (!isRecord(body)) return apiError('Runtime controls must be a JSON object.', 422);

  const row = await readConfig(env.DB, siteId);
  if (!row) return apiError('Publisher config was not found.', 404);
  const config = parseConfig(row.config_json);
  const references = await loadReferenceData(env.DB, siteId);
  const controls = validateControls(body, new Set(references.adUnits.map((unit) => unit.code)));
  if (controls instanceof Response) return controls;

  const previous = controlsFromConfig(config, references.adUnits.map((unit) => unit.code));
  config.runtimeControls = controls;
  const actor = getActor(request);
  const now = new Date().toISOString();

  try {
    await env.DB.batch([
      env.DB
        .prepare('UPDATE publisher_configs SET config_json = ?, updated_at = ? WHERE publisher_id = ?')
        .bind(JSON.stringify(config), now, siteId),
      env.DB
        .prepare(`INSERT INTO audit_log (
          id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
        ) VALUES (?, ?, 'runtime_controls.updated', ?, 'runtime_controls', ?, ?, ?)`) 
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          siteId,
          JSON.stringify({ previous, next: controls }),
          now,
        ),
    ]);
  } catch (error) {
    return apiError(
      'Runtime controls could not be saved.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  return json(await buildPayload(env.DB, siteId, config));
}
