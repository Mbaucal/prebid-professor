import { apiError, getActor, json } from './http';
import type { DatabaseEnv } from './publishers';

type JsonRecord = Record<string, unknown>;
type RefreshMode = 'fixed' | 'firstThenFixed' | 'percentage' | 'sequence';

const RESERVED_RULE_KEYS = new Set(['__DEFAULT__', '__ATF__', '__BTF__']);
const REFRESH_MODES = new Set<RefreshMode>(['fixed', 'firstThenFixed', 'percentage', 'sequence']);

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function integerInRange(value: unknown, field: string, min: number, max: number, fallback: number): number {
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  }
  return candidate;
}

function numberInRange(value: unknown, field: string, min: number, max: number, fallback: number): number {
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(candidate) || candidate < min || candidate > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}.`);
  }
  return candidate;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1').bind(siteId).first<{ id: string }>();
  return Boolean(row);
}

async function ruleTargetExists(db: D1Database, siteId: string, ruleKey: string): Promise<boolean> {
  if (RESERVED_RULE_KEYS.has(ruleKey)) return true;
  const row = await db
    .prepare('SELECT code FROM ad_units WHERE publisher_id = ? AND code = ? LIMIT 1')
    .bind(siteId, ruleKey)
    .first<{ code: string }>();
  return Boolean(row);
}

function parseRule(value: string | null | undefined): JsonRecord {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeSequence(value: unknown): number[] {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? '')
        .split(/[;,\s]+/)
        .filter(Boolean);

  if (!raw.length) return [20, 30];
  if (raw.length > 50) throw new Error('refresh.schedule.sequenceSeconds cannot contain more than 50 values.');

  return raw.map((item, index) =>
    integerInRange(item, `refresh.schedule.sequenceSeconds[${index}]`, 5, 3600, 30),
  );
}

function normalizeRefresh(value: unknown, current: JsonRecord): JsonRecord {
  if (!isRecord(value)) throw new Error('refresh must be an object.');
  const currentSchedule = isRecord(current.schedule) ? current.schedule : {};
  const scheduleInput = isRecord(value.schedule) ? value.schedule : {};
  const mode = String(scheduleInput.mode ?? currentSchedule.mode ?? 'fixed') as RefreshMode;
  if (!REFRESH_MODES.has(mode)) throw new Error('refresh.schedule.mode is invalid.');

  const fixedSeconds = integerInRange(
    scheduleInput.fixedSeconds,
    'refresh.schedule.fixedSeconds',
    5,
    3600,
    integerInRange(current.minSeconds, 'refresh.minSeconds', 5, 3600, 30),
  );
  const firstSeconds = integerInRange(
    scheduleInput.firstSeconds,
    'refresh.schedule.firstSeconds',
    5,
    3600,
    fixedSeconds,
  );
  const nextSeconds = integerInRange(
    scheduleInput.nextSeconds,
    'refresh.schedule.nextSeconds',
    5,
    3600,
    fixedSeconds,
  );
  const growthPercent = numberInRange(
    scheduleInput.growthPercent,
    'refresh.schedule.growthPercent',
    0,
    500,
    20,
  );
  const maxSeconds = integerInRange(
    scheduleInput.maxSeconds,
    'refresh.schedule.maxSeconds',
    5,
    7200,
    Math.max(firstSeconds, nextSeconds, 120),
  );
  const sequenceSeconds = normalizeSequence(scheduleInput.sequenceSeconds ?? currentSchedule.sequenceSeconds);

  const legacyMinSeconds =
    mode === 'fixed'
      ? fixedSeconds
      : mode === 'sequence'
        ? sequenceSeconds[0]
        : firstSeconds;

  return {
    ...current,
    enabled: booleanValue(value.enabled, booleanValue(current.enabled, true)),
    minSeconds: legacyMinSeconds,
    minViewPct: integerInRange(value.minViewPct, 'refresh.minViewPct', 0, 100, Number(current.minViewPct ?? 50)),
    exitViewPct: integerInRange(value.exitViewPct, 'refresh.exitViewPct', 0, 100, Number(current.exitViewPct ?? 10)),
    accumulateViewTime: booleanValue(
      value.accumulateViewTime,
      booleanValue(current.accumulateViewTime, true),
    ),
    minGapSeconds: integerInRange(
      value.minGapSeconds,
      'refresh.minGapSeconds',
      0,
      3600,
      Number(current.minGapSeconds ?? 0),
    ),
    maxRefreshes: integerInRange(
      value.maxRefreshes,
      'refresh.maxRefreshes',
      0,
      1000,
      Number(current.maxRefreshes ?? 20),
    ),
    requirePreviousViewable: booleanValue(
      value.requirePreviousViewable,
      booleanValue(current.requirePreviousViewable, false),
    ),
    checkEveryMs: integerInRange(
      value.checkEveryMs,
      'refresh.checkEveryMs',
      250,
      60000,
      Number(current.checkEveryMs ?? 5000),
    ),
    schedule: {
      mode,
      fixedSeconds,
      firstSeconds,
      nextSeconds,
      growthPercent,
      maxSeconds,
      sequenceSeconds,
      repeatLast: true,
    },
  };
}

async function syncConfigJson(db: D1Database, siteId: string): Promise<void> {
  const [configRow, rulesResult] = await Promise.all([
    db
      .prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
      .bind(siteId)
      .first<{ config_json: string }>(),
    db
      .prepare('SELECT rule_key, rule_json FROM unit_rules WHERE publisher_id = ? ORDER BY rule_key COLLATE NOCASE')
      .bind(siteId)
      .all<{ rule_key: string; rule_json: string }>(),
  ]);

  if (!configRow) return;
  const config = parseRule(configRow.config_json);
  const unitRules: Record<string, JsonRecord> = {};
  for (const row of rulesResult.results ?? []) unitRules[row.rule_key] = parseRule(row.rule_json);
  config.unitRules = unitRules;

  await db
    .prepare('UPDATE publisher_configs SET config_json = ?, updated_at = ? WHERE publisher_id = ?')
    .bind(JSON.stringify(config), new Date().toISOString(), siteId)
    .run();
}

export async function updateAdvancedRule(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
  ruleKey: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);
  if (!(await ruleTargetExists(env.DB, siteId, ruleKey))) {
    return apiError(`Rule target "${ruleKey}" is not an ad unit on this site.`, 404);
  }

  let input: JsonRecord;
  try {
    input = (await request.json()) as JsonRecord;
  } catch {
    return apiError('JSON body could not be read.');
  }

  const existing = await env.DB
    .prepare('SELECT id, rule_json FROM unit_rules WHERE publisher_id = ? AND rule_key = ? LIMIT 1')
    .bind(siteId, ruleKey)
    .first<{ id: string; rule_json: string }>();

  const rule = parseRule(existing?.rule_json);

  try {
    if (Object.prototype.hasOwnProperty.call(input, 'timeout')) {
      rule.timeout = integerInRange(input.timeout, 'timeout', 100, 60000, Number(rule.timeout ?? 2500));
    }
    if (Object.prototype.hasOwnProperty.call(input, 'cmpTimeout')) {
      rule.cmpTimeout = integerInRange(
        input.cmpTimeout,
        'cmpTimeout',
        100,
        30000,
        Number(rule.cmpTimeout ?? 1500),
      );
    }
    if (Object.prototype.hasOwnProperty.call(input, 'refresh')) {
      rule.refresh = normalizeRefresh(input.refresh, isRecord(rule.refresh) ? rule.refresh : {});
    }
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Advanced rule validation failed.', 422);
  }

  const now = new Date().toISOString();
  const id = existing?.id ?? crypto.randomUUID();
  const actor = getActor(request);

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO unit_rules (id, publisher_id, rule_key, rule_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(publisher_id, rule_key)
           DO UPDATE SET rule_json = excluded.rule_json, updated_at = excluded.updated_at`,
        )
        .bind(id, siteId, ruleKey, JSON.stringify(rule), now, now),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'unit_rule.advanced_updated', ?, 'unit_rule', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          id,
          JSON.stringify({ ruleKey, timeout: rule.timeout, cmpTimeout: rule.cmpTimeout, refresh: rule.refresh }),
          now,
        ),
    ]);
    await syncConfigJson(env.DB, siteId);
  } catch (error) {
    return apiError('Advanced rule update failed.', 500, error instanceof Error ? error.message : String(error));
  }

  return json({
    ok: true,
    unitRule: {
      id,
      publisherId: siteId,
      ruleKey,
      rule,
      createdAt: now,
      updatedAt: now,
    },
  });
}
