import { apiError, getActor, json } from './http';
import type { DatabaseEnv } from './publishers';
import { inheritedRefresh, keepUnitRuleIntervals, scheduleSource } from './refresh-inheritance';
import {
  UNIT_RULE_ROWS_UNCHANGED_SQL,
  everyStatementChangedOneRow,
  nextRowVersion,
  readUnitRuleRows,
  unitRuleRowsUnchangedArgs,
} from './unit-rule-rows';

type JsonRecord = Record<string, unknown>;
type RefreshMode = 'fixed' | 'firstThenFixed' | 'percentage' | 'sequence';

const RESERVED_RULE_KEYS = new Set(['__DEFAULT__', '__ATF__', '__BTF__']);
const REFRESH_MODES = new Set<RefreshMode>(['fixed', 'firstThenFixed', 'percentage', 'sequence']);
const REFRESH_CHANGED_ELSEWHERE = 'Unit rules or refresh settings changed in another tab. Reload before saving.';
const targetChangedElsewhere = (ruleKey: string) =>
  `${ruleKey} was renamed or deleted in Ad units while this was being saved, so nothing was saved. Reload and choose the ad unit again.`;

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

/** Equal as JSON values, whatever the key order. */
function sameJson(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
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

  const legacyCurrentSeconds = Number(current.minSeconds ?? 30);
  const fixedSeconds = integerInRange(
    scheduleInput.fixedSeconds,
    'refresh.schedule.fixedSeconds',
    5,
    3600,
    Number.isFinite(legacyCurrentSeconds) ? legacyCurrentSeconds : 30,
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

async function readConfig(
  db: D1Database,
  siteId: string,
): Promise<{ raw: JsonRecord; rowId: string; configJson: string } | null> {
  const row = await db
    .prepare('SELECT id, config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
    .bind(siteId)
    .first<{ id: string; config_json: string }>();
  if (!row) return null;
  return { raw: parseRecord(row.config_json), rowId: row.id, configJson: row.config_json };
}

function advancedMap(config: JsonRecord): Record<string, JsonRecord> {
  const value = config.advancedUnitRules;
  if (!isRecord(value)) return {};
  const result: Record<string, JsonRecord> = {};
  for (const [key, rule] of Object.entries(value)) {
    if (isRecord(rule)) result[key] = rule;
  }
  return result;
}

/**
 * The Unit rules row a Refresh schedules save keeps in step (legacy mirror of the editable
 * fields), from the row read in the snapshot. Only the sections this save sends are mirrored:
 * a section left out (unchanged, or inherited) keeps the row's own value, or its absence, as
 * it was (no `refresh: {}` that Unit rules would show as an override).
 */
function mirroredLegacyRule(saved: JsonRecord, advanced: JsonRecord, input: JsonRecord): JsonRecord {
  const rule = { ...saved };
  if (Object.hasOwn(input, 'timeout')) rule.timeout = advanced.timeout;
  if (Object.hasOwn(input, 'refresh') && isRecord(advanced.refresh)) {
    const currentRefresh = isRecord(rule.refresh) ? rule.refresh : {};
    rule.refresh = {
      ...currentRefresh,
      enabled: advanced.refresh.enabled,
      minSeconds: advanced.refresh.minSeconds,
      minViewPct: advanced.refresh.minViewPct,
      requirePreviousViewable: advanced.refresh.requirePreviousViewable,
      checkEveryMs: advanced.refresh.checkEveryMs,
    };
  }
  return rule;
}

/** A Unit rules row as the Refresh tab saves against it: the row id and version go back with the save. */
type MirroredRow = { id: string; ruleKey: string; updatedAt: string; rule: JsonRecord };

function mirroredRow(row: { id: string; rule_key: string; rule_json: string; updated_at: string }): MirroredRow {
  return { id: row.id, ruleKey: row.rule_key, updatedAt: row.updated_at, rule: parseRecord(row.rule_json) };
}

export async function listAdvancedRules(env: DatabaseEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);
  // config_json, the unit_rules rows and each position's ATF/BTF group are read in one batch
  // (one D1 transaction), so a form built from this response, the parents it inherits from and
  // the row version it is saved against always describe the same saved state; a save in
  // between cannot pair one with the other.
  const [configResult, rowResult, unitResult] = await env.DB.batch([
    env.DB.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1').bind(siteId),
    env.DB
      .prepare('SELECT id, rule_key, rule_json, updated_at FROM unit_rules WHERE publisher_id = ? ORDER BY rule_key COLLATE NOCASE')
      .bind(siteId),
    env.DB.prepare('SELECT code, type FROM ad_units WHERE publisher_id = ?').bind(siteId),
  ]);
  const config = (configResult?.results?.[0] as { config_json: string } | undefined)?.config_json;
  const rows = (rowResult?.results ?? []) as Array<{ id: string; rule_key: string; rule_json: string; updated_at: string }>;
  const units = (unitResult?.results ?? []) as Array<{ code: string; type: string }>;
  return json({
    ok: true,
    advancedRules: config === undefined ? {} : advancedMap(parseRecord(config)),
    unitRuleRows: Object.fromEntries(rows.map((row) => [row.rule_key, mirroredRow(row)])),
    unitTypes: Object.fromEntries(units.map((unit) => [unit.code, unit.type])),
  });
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

  const configRow = await readConfig(env.DB, siteId);
  if (!configRow) return apiError('Publisher config was not found.', 404);
  const config = configRow.raw;
  const allAdvanced = advancedMap(config);
  const current = allAdvanced[ruleKey] ?? {};
  const advanced: JsonRecord = { ...current };

  try {
    if (Object.prototype.hasOwnProperty.call(input, 'timeout')) {
      advanced.timeout = integerInRange(input.timeout, 'timeout', 100, 30000, Number(current.timeout ?? 2500));
    }
    if (Object.prototype.hasOwnProperty.call(input, 'cmpTimeout')) {
      advanced.cmpTimeout = integerInRange(
        input.cmpTimeout,
        'cmpTimeout',
        100,
        30000,
        Number(current.cmpTimeout ?? 1500),
      );
    }
    if (Object.prototype.hasOwnProperty.call(input, 'refresh')) {
      advanced.refresh = normalizeRefresh(input.refresh, isRecord(current.refresh) ? current.refresh : {});
    }
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Advanced rule validation failed.', 422);
  }

  const now = new Date().toISOString();
  const actor = getActor(request);
  let kept: string[] = [];
  let appliesTo: string[] = [];
  let written: MirroredRow;

  try {
    // The mirrored row, config.unitRules and the advanced record are written in one
    // batch that applies only while config_json and every unit_rules row still match
    // what was read here, so a concurrent unit-rule save or delete cannot be
    // overwritten or resurrected and cannot leave an advanced override without its row.
    const [rows, unitRows] = await Promise.all([
      readUnitRuleRows(env.DB, siteId),
      env.DB
        .prepare('SELECT code, type, enabled FROM ad_units WHERE publisher_id = ?')
        .bind(siteId)
        .all<{ code: string; type: string; enabled: number }>(),
    ]);
    const existing = rows.find((row) => row.rule_key === ruleKey);
    // An ad-unit rename or delete of a position without a row changes neither config_json
    // nor any unit_rules row, so the guarded write below also requires the position's code
    // and ATF/BTF group to be as read here (reserved scopes have no ad unit: NULL IS NULL).
    const unitType = (unitRows.results ?? []).find((unit) => unit.code === ruleKey)?.type ?? null;
    if (!RESERVED_RULE_KEYS.has(ruleKey) && unitType === null) return apiError(targetChangedElsewhere(ruleKey), 409);
    // The Unit rules row the Refresh tab loaded for this scope: id and version (null: no row).
    // Every Unit rules or Refresh save of the scope moves the version, and a deleted and
    // re-created row has a new id even in the same millisecond, so a stale tab cannot put
    // back an older schedule or re-create a deleted rule; the row guard rechecks it in the batch.
    // Callers that send neither field keep the previous contract.
    if ((Object.hasOwn(input, 'expectedUpdatedAt') && input.expectedUpdatedAt !== (existing?.updated_at ?? null))
      || (Object.hasOwn(input, 'expectedUnitRuleId') && input.expectedUnitRuleId !== (existing?.id ?? null))) {
      return apiError(REFRESH_CHANGED_ELSEWHERE, 409);
    }
    const mirroredId = existing?.id ?? crypto.randomUUID();
    const mirroredVersion = existing ? nextRowVersion(existing.updated_at, now) : now;
    const types = Object.fromEntries((unitRows.results ?? []).map((unit) => [unit.code, unit.type]));
    const basic = Object.fromEntries(rows.map((row) => [row.rule_key, parseRecord(row.rule_json)]));
    // A refresh section sent with values filled from the parent scopes carries the parents'
    // settings it was built from; a Default or group change since then would otherwise be
    // undone silently by those copies, so the save is refused (409) and the tab rebases.
    if (Object.hasOwn(input, 'expectedInheritedRefresh')
      && !sameJson(input.expectedInheritedRefresh, inheritedRefresh({ advanced: allAdvanced, basic }, types, ruleKey))) {
      return apiError(REFRESH_CHANGED_ELSEWHERE, 409);
    }
    const mirroredJson = JSON.stringify(mirroredLegacyRule(parseRecord(existing?.rule_json), advanced, input));
    // Unit rules as the table will hold them after this save, in the table's order
    // (SQLite's own NOCASE sort, as before). Only the order is taken from this read:
    // it must hold exactly the rows of the guarded snapshot above, or another save
    // landed in between and this one is refused before anything is written.
    const nextRows = await env.DB
      .prepare(
        `SELECT rule_key, rule_json FROM unit_rules WHERE publisher_id = ? AND rule_key <> ?
         UNION ALL SELECT ?, ? ORDER BY rule_key COLLATE NOCASE`,
      )
      .bind(siteId, ruleKey, ruleKey, mirroredJson)
      .all<{ rule_key: string; rule_json: string }>();
    const snapshot = new Map(rows.map((row) => [row.rule_key, row.rule_json]));
    snapshot.set(ruleKey, mirroredJson);
    const ordered = nextRows.results ?? [];
    if (ordered.length !== snapshot.size || ordered.some((row) => snapshot.get(row.rule_key) !== row.rule_json)) {
      return apiError(REFRESH_CHANGED_ELSEWHERE, 409);
    }
    const before = { advanced: structuredClone(allAdvanced) as Record<string, unknown>, basic: basic as Record<string, unknown> };
    const unitRules: Record<string, JsonRecord> = {};
    for (const row of ordered) unitRules[row.rule_key] = parseRecord(row.rule_json);
    allAdvanced[ruleKey] = advanced;
    config.advancedUnitRules = allAdvanced;
    config.unitRules = unitRules;
    // A chosen child Unit rules interval in effect before this save stays in
    // effect instead of silently following this schedule; the response names them.
    // The kept schedules are part of the same guarded config write below.
    kept = keepUnitRuleIntervals(allAdvanced, unitRules, types, ruleKey, { savedRule: false, before });
    appliesTo = (unitRows.results ?? [])
      .filter((unit) => unit.enabled === 1 && unit.type !== 'DRAFT'
        && scheduleSource({ advanced: allAdvanced, basic: unitRules }, types, unit.code) === ruleKey)
      .map((unit) => unit.code);

    const statements = [
      env.DB
        .prepare(
          `UPDATE publisher_configs SET config_json = ?, updated_at = ?
           WHERE publisher_id = ? AND config_json = ? AND ${UNIT_RULE_ROWS_UNCHANGED_SQL}
             AND (SELECT type FROM ad_units WHERE publisher_id = ? AND code = ? LIMIT 1) IS ?`,
        )
        .bind(JSON.stringify(config), now, siteId, configRow.configJson, ...unitRuleRowsUnchangedArgs(siteId, rows), siteId, ruleKey, unitType),
      existing
        ? env.DB
            .prepare(
              `UPDATE unit_rules SET rule_json = ?, updated_at = ?
               WHERE publisher_id = ? AND id = ? AND updated_at = ? AND changes() = 1`,
            )
            .bind(mirroredJson, mirroredVersion, siteId, existing.id, existing.updated_at)
        : env.DB
            .prepare(
              `INSERT INTO unit_rules (id, publisher_id, rule_key, rule_json, created_at, updated_at)
               SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
            )
            .bind(mirroredId, siteId, ruleKey, mirroredJson, now, mirroredVersion),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) SELECT ?, ?, 'unit_rule.advanced_updated', ?, 'advanced_unit_rule', ?, ?, ? WHERE changes() = 1`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          ruleKey,
          JSON.stringify({ ruleKey, advanced, mirroredUnitRuleId: mirroredId, ...(kept.length ? { keptUnitRuleIntervals: kept } : {}) }),
          now,
        ),
    ];
    const results = await env.DB.batch(statements);
    if (results[0]?.meta.changes !== 1) {
      return apiError(REFRESH_CHANGED_ELSEWHERE, 409);
    }
    if (!everyStatementChangedOneRow(results, statements.length)) {
      return apiError('Advanced rule update was not fully applied. Reload before saving again.', 500);
    }
    written = mirroredRow({ id: mirroredId, rule_key: ruleKey, rule_json: mirroredJson, updated_at: mirroredVersion });
  } catch (error) {
    return apiError('Advanced rule update failed.', 500, error instanceof Error ? error.message : String(error));
  }

  // The committed row and version, returned without a second read that a later save could
  // race: the tab saves its next change against exactly this version.
  return json({
    ok: true, ruleKey, advancedRule: advanced, unitRule: written, keptUnitRuleIntervals: kept,
    keptAdvancedRules: Object.fromEntries(kept.map((key) => [key, allAdvanced[key]])), appliesToAdUnits: appliesTo,
  });
}
