import type {
  CreateUnitRuleInput,
  DuplicateUnitRuleInput,
  UnitRule,
  UnitRuleCondition,
  UnitRuleConditionalMapping,
  UnitRuleConfig,
  UnitRuleConditionOperator,
  UnitRuleSlotAction,
  UpdateUnitRuleInput,
} from '../src/shared/types';
import { apiError, getActor, json, readJson } from './http';
import type { DatabaseEnv } from './publishers';
import { keepUnitRuleIntervals } from './refresh-inheritance';
import {
  UNIT_RULE_ROWS_UNCHANGED_SQL,
  everyStatementChangedOneRow,
  nextRowVersion,
  readUnitRuleRows,
  unitRuleRowsUnchangedArgs,
} from './unit-rule-rows';
import type { UnitRuleRowState } from './unit-rule-rows';

type UnitRuleRow = {
  id: string;
  publisher_id: string;
  rule_key: string;
  rule_json: string;
  created_at: string;
  updated_at: string;
};

type JsonRecord = Record<string, unknown>;

const RESERVED_RULE_KEYS = new Set(['__DEFAULT__', '__ATF__', '__BTF__']);
const CONDITION_OPERATORS = new Set<UnitRuleConditionOperator>([
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'exists',
  'notExists',
]);
const SLOT_ACTIONS = new Set<UnitRuleSlotAction>(['inherit', 'enable', 'disable']);

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseStoredRule(value: string): UnitRuleConfig {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? (parsed as UnitRuleConfig) : {};
  } catch {
    return {};
  }
}

function toUnitRule(row: UnitRuleRow): UnitRule {
  return {
    id: row.id,
    publisherId: row.publisher_id,
    ruleKey: row.rule_key,
    rule: parseStoredRule(row.rule_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function integerInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate! < min || candidate! > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  }
  return candidate!;
}

function booleanValue(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${field} must be true or false.`);
  return value;
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1')
    .bind(siteId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function exactAdUnitExists(db: D1Database, siteId: string, ruleKey: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT code FROM ad_units WHERE publisher_id = ? AND code = ? LIMIT 1')
    .bind(siteId, ruleKey)
    .first<{ code: string }>();
  return Boolean(row);
}

async function sizeMapExists(db: D1Database, siteId: string, name: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT name FROM size_maps WHERE publisher_id = ? AND name = ? LIMIT 1')
    .bind(siteId, name)
    .first<{ name: string }>();
  return Boolean(row);
}

async function normalizeRuleKey(db: D1Database, siteId: string, value: unknown): Promise<string> {
  const ruleKey = String(value ?? '').trim();
  if (!ruleKey) throw new Error('ruleKey is required.');
  if (RESERVED_RULE_KEYS.has(ruleKey)) return ruleKey;
  if (!(await exactAdUnitExists(db, siteId, ruleKey))) {
    throw new Error(`Exact rule target "${ruleKey}" is not an ad unit on this site.`);
  }
  return ruleKey;
}

function normalizeCondition(value: unknown, mappingIndex: number, conditionIndex: number): UnitRuleCondition {
  if (!isRecord(value)) {
    throw new Error(`Mapping ${mappingIndex + 1}, condition ${conditionIndex + 1} must be an object.`);
  }

  const key = String(value.key ?? '').trim();
  const operator = String(value.operator ?? 'equals') as UnitRuleConditionOperator;
  const conditionValue = String(value.value ?? '').trim();

  if (!key) throw new Error(`Mapping ${mappingIndex + 1}, condition ${conditionIndex + 1}: key is required.`);
  if (!CONDITION_OPERATORS.has(operator)) {
    throw new Error(`Mapping ${mappingIndex + 1}, condition ${conditionIndex + 1}: operator is invalid.`);
  }
  if (!['exists', 'notExists'].includes(operator) && !conditionValue) {
    throw new Error(`Mapping ${mappingIndex + 1}, condition ${conditionIndex + 1}: value is required.`);
  }

  return {
    id: String(value.id ?? '').trim() || crypto.randomUUID(),
    key,
    operator,
    value: ['exists', 'notExists'].includes(operator) ? '' : conditionValue,
  };
}

async function normalizeConditionalMapping(
  db: D1Database,
  siteId: string,
  value: unknown,
  index: number,
): Promise<UnitRuleConditionalMapping> {
  if (!isRecord(value)) throw new Error(`Conditional mapping ${index + 1} must be an object.`);

  const rawConditions = value.conditions;
  if (!Array.isArray(rawConditions) || rawConditions.length === 0) {
    throw new Error(`Conditional mapping ${index + 1} must contain at least one condition.`);
  }
  if (rawConditions.length > 12) {
    throw new Error(`Conditional mapping ${index + 1} cannot contain more than 12 conditions.`);
  }

  const match = value.match === 'any' ? 'any' : 'all';
  const slotAction = String(value.slotAction ?? 'inherit') as UnitRuleSlotAction;
  if (!SLOT_ACTIONS.has(slotAction)) {
    throw new Error(`Conditional mapping ${index + 1}: slotAction is invalid.`);
  }

  const sizeMapKey = String(value.sizeMapKey ?? '').trim() || null;
  if (sizeMapKey && !(await sizeMapExists(db, siteId, sizeMapKey))) {
    throw new Error(`Conditional mapping ${index + 1}: size map "${sizeMapKey}" does not exist.`);
  }
  if (!sizeMapKey && slotAction === 'inherit') {
    throw new Error(
      `Conditional mapping ${index + 1} must select a size map or enable/disable the slot.`,
    );
  }

  return {
    id: String(value.id ?? '').trim() || crypto.randomUUID(),
    name: String(value.name ?? '').trim() || `Mapping ${index + 1}`,
    enabled: booleanValue(value.enabled, `conditionalMappings[${index}].enabled`, true),
    priority: integerInRange(value.priority, `conditionalMappings[${index}].priority`, 0, 10000, 100),
    match,
    conditions: rawConditions.map((condition, conditionIndex) =>
      normalizeCondition(condition, index, conditionIndex),
    ),
    sizeMapKey,
    slotAction,
  };
}

async function normalizeRuleConfig(
  db: D1Database,
  siteId: string,
  value: unknown,
): Promise<UnitRuleConfig> {
  if (!isRecord(value)) throw new Error('rule must be an object.');

  const normalized: UnitRuleConfig = {};

  if (Object.prototype.hasOwnProperty.call(value, 'timeout') && value.timeout !== null) {
    normalized.timeout = integerInRange(value.timeout, 'timeout', 100, 30000);
  }

  if (Object.prototype.hasOwnProperty.call(value, 'lazy') && value.lazy !== null) {
    if (!isRecord(value.lazy)) throw new Error('lazy must be an object or null.');
    normalized.lazy = {
      enabled: booleanValue(value.lazy.enabled, 'lazy.enabled', true),
      fetchMarginPx: integerInRange(value.lazy.fetchMarginPx, 'lazy.fetchMarginPx', 0, 20000, 500),
      renderMarginPx: integerInRange(value.lazy.renderMarginPx, 'lazy.renderMarginPx', 0, 20000, 200),
    };
  }

  if (Object.prototype.hasOwnProperty.call(value, 'refresh') && value.refresh !== null) {
    if (!isRecord(value.refresh)) throw new Error('refresh must be an object or null.');
    normalized.refresh = {
      enabled: booleanValue(value.refresh.enabled, 'refresh.enabled', true),
      minSeconds: integerInRange(value.refresh.minSeconds, 'refresh.minSeconds', 5, 3600, 30),
      minViewPct: integerInRange(value.refresh.minViewPct, 'refresh.minViewPct', 0, 100, 50),
      requirePreviousViewable: booleanValue(
        value.refresh.requirePreviousViewable,
        'refresh.requirePreviousViewable',
        false,
      ),
      checkEveryMs: integerInRange(value.refresh.checkEveryMs, 'refresh.checkEveryMs', 250, 60000, 5000),
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(value, 'conditionalMappings') &&
    value.conditionalMappings !== null
  ) {
    if (!Array.isArray(value.conditionalMappings)) {
      throw new Error('conditionalMappings must be an array or null.');
    }
    if (value.conditionalMappings.length > 100) {
      throw new Error('conditionalMappings cannot contain more than 100 entries.');
    }

    const mappings: UnitRuleConditionalMapping[] = [];
    for (let index = 0; index < value.conditionalMappings.length; index += 1) {
      mappings.push(
        await normalizeConditionalMapping(db, siteId, value.conditionalMappings[index], index),
      );
    }
    normalized.conditionalMappings = mappings.sort((a, b) => b.priority - a.priority);
  }

  return normalized;
}

async function fetchUnitRule(
  db: D1Database,
  siteId: string,
  unitRuleId: string,
): Promise<UnitRule | null> {
  const row = await db
    .prepare(
      `SELECT id, publisher_id, rule_key, rule_json, created_at, updated_at
       FROM unit_rules
       WHERE publisher_id = ? AND id = ?
       LIMIT 1`,
    )
    .bind(siteId, unitRuleId)
    .first<UnitRuleRow>();
  return row ? toUnitRule(row) : null;
}

// The committed row, returned without a second read that a later write could race.
function writtenRule(
  id: string, siteId: string, ruleKey: string, rule: UnitRuleConfig, createdAt: string, updatedAt: string,
): UnitRule {
  return toUnitRule({
    id, publisher_id: siteId, rule_key: ruleKey, rule_json: JSON.stringify(rule),
    created_at: createdAt, updated_at: updatedAt,
  });
}

class RuleConflict extends Error {}
class RuleGone extends Error {}

const CHANGED_ELSEWHERE = 'Unit rules changed in another tab. Reload before saving.';
const UPDATE_TARGET_GONE = 'This unit rule no longer exists; it may have been deleted in another tab. Your changes were not saved.';
const DELETE_TARGET_GONE = 'This unit rule no longer exists; it may have been deleted in another tab.';
const DUPLICATE_SOURCE_GONE = 'The source rule no longer exists; it may have been deleted in another tab. Nothing was copied.';

// What must still be true when the batch commits; checked on the read snapshot and,
// through the row guard, again inside the batch that writes config_json.
type RowExpectation = {
  // The row this request was built from: same id, rule key, version (updated_at) and content.
  present?: { rule: UnitRule; goneMessage: string };
  // A rule key that must not exist yet (create or duplicate target).
  absentKey?: string;
};

function checkExpectation(rows: UnitRuleRowState[], expectation: RowExpectation): void {
  const { present, absentKey } = expectation;
  if (present) {
    const row = rows.find((item) => item.id === present.rule.id);
    if (!row) throw new RuleGone(present.goneMessage);
    if (row.rule_key !== present.rule.ruleKey || row.updated_at !== present.rule.updatedAt
      || JSON.stringify(parseStoredRule(row.rule_json)) !== JSON.stringify(present.rule.rule)) {
      throw new RuleConflict(CHANGED_ELSEWHERE);
    }
  }
  if (absentKey !== undefined && rows.some((item) => item.rule_key === absentKey)) {
    throw new RuleConflict(`Rule "${absentKey}" already exists on this site.`);
  }
}

function ruleErrorResponse(error: unknown): Response | null {
  if (error instanceof RuleGone) return apiError(error.message, 404);
  if (error instanceof RuleConflict) return apiError(error.message, 409);
  return null;
}

async function prepareConfigUpdate(
  db: D1Database, siteId: string, ruleKey: string, rule: UnitRuleConfig | null,
  now: string, sourceRuleKey: string | undefined, expectation: RowExpectation,
  followInheritedSchedule = false,
): Promise<{ statement: D1PreparedStatement; kept: string[] }> {
  const [row, rows, units] = await Promise.all([
    db.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1').bind(siteId).first<{config_json: string}>(),
    readUnitRuleRows(db, siteId),
    db.prepare('SELECT code, type FROM ad_units WHERE publisher_id = ?').bind(siteId).all<{code: string; type: string}>(),
  ]);
  if (!row) throw new Error('Publisher config was not found.');
  checkExpectation(rows, expectation);
  const config = JSON.parse(row.config_json) as JsonRecord;
  const savedRules: Record<string, UnitRuleConfig> = {};
  for (const item of rows) savedRules[item.rule_key] = parseStoredRule(item.rule_json);
  const unitRules: Record<string, UnitRuleConfig> = { ...savedRules };
  const previous = unitRules[ruleKey];
  if (rule) unitRules[ruleKey] = rule; else delete unitRules[ruleKey];
  config.unitRules = unitRules;
  const advanced = isRecord(config.advancedUnitRules) ? config.advancedUnitRules : {};
  const current = isRecord(advanced[ruleKey]) ? { ...advanced[ruleKey] } : null;
  if (!rule && current) {
    // Display/loading owns lazy, so deleting refresh must retain that setting.
    for (const field of ['timeout', 'cmpTimeout', 'refresh']) delete current[field];
  } else if (sourceRuleKey && isRecord(advanced[sourceRuleKey])) {
    const source = advanced[sourceRuleKey];
    const target = current ?? {};
    for (const field of ['timeout', 'cmpTimeout', 'refresh']) {
      if (Object.hasOwn(source, field)) target[field] = structuredClone(source[field]);
      else delete target[field];
    }
    advanced[ruleKey] = target;
  } else if (rule && current) {
    if (rule.timeout === undefined) delete current.timeout; else current.timeout = rule.timeout;
    const refresh = isRecord(current.refresh) ? current.refresh : {};
    const schedule = isRecord(refresh.schedule) ? refresh.schedule : null;
    const nonFixed = schedule && schedule.mode !== 'fixed';
    if (nonFixed && JSON.stringify(previous?.refresh) !== JSON.stringify(rule.refresh)) {
      throw new RuleConflict('This rule uses a sequence or percentage refresh schedule. Open Refresh schedules to change its refresh settings.');
    }
    if (!nonFixed) {
      if (!rule.refresh) delete current.refresh;
      else current.refresh = {
        ...refresh, ...rule.refresh,
        ...(schedule ? {schedule: {...schedule, fixedSeconds: rule.refresh.minSeconds, firstSeconds: rule.refresh.minSeconds, nextSeconds: rule.refresh.minSeconds}} : {}),
      };
    }
  }
  if (current) {
    if (Object.keys(current).length) advanced[ruleKey] = current; else delete advanced[ruleKey];
  }
  // An inherited Refresh schedule would otherwise replace this rule's (or a
  // child rule's) chosen Unit rules interval in every generated script.
  const saved = JSON.parse(row.config_json) as JsonRecord;
  const kept = keepUnitRuleIntervals(advanced, unitRules, Object.fromEntries((units.results ?? []).map((unit) => [unit.code, unit.type])), ruleKey, {
    savedRule: Boolean(rule),
    followInherited: followInheritedSchedule,
    before: { advanced: isRecord(saved.advancedUnitRules) ? saved.advancedUnitRules : {}, basic: savedRules },
  });
  if (isRecord(config.advancedUnitRules) || Object.keys(advanced).length) config.advancedUnitRules = advanced;
  // config_json is derived from this config snapshot and these rows, so it may only be
  // written while both are unchanged; the row statements that follow are gated on changes().
  // The kept intervals are part of this same guarded config write. They also depend on the
  // saved position's ATF/BTF group, which an ad-unit edit can change without touching any
  // row when the position has none yet, so its code and group must still be as read.
  const unitType = (units.results ?? []).find((unit) => unit.code === ruleKey)?.type ?? null;
  // A create or copy for a position that was renamed or deleted after its target was checked
  // would otherwise pass the guard (NULL IS NULL) and write under a code that no longer
  // exists. (An existing row is covered by the row guard: a rename moves it, a delete removes it.)
  if (rule && expectation.absentKey !== undefined && !RESERVED_RULE_KEYS.has(ruleKey) && unitType === null) {
    throw new RuleConflict(`${ruleKey} was renamed or deleted in Ad units while this rule was being saved, so nothing was saved. Reload and choose the ad unit again.`);
  }
  const statement = db.prepare(
    `UPDATE publisher_configs SET config_json = ?, config_hash = NULL, updated_at = ?
     WHERE publisher_id = ? AND config_json = ? AND ${UNIT_RULE_ROWS_UNCHANGED_SQL}
       AND (SELECT type FROM ad_units WHERE publisher_id = ? AND code = ? LIMIT 1) IS ?`,
  ).bind(JSON.stringify(config), now, siteId, row.config_json, ...unitRuleRowsUnchangedArgs(siteId, rows), siteId, ruleKey, unitType);
  return { statement, kept };
}

/** Audit detail for rules given their own fixed schedule by this save. */
function keptDetails(kept: string[]): { keptUnitRuleIntervals?: string[] } {
  return kept.length ? { keptUnitRuleIntervals: kept } : {};
}

// Runs the guarded config write plus its dependent row and audit statements in one batch.
// Returns null when every statement applied, otherwise the 404/409 response to send.
async function applyRuleSave(
  db: D1Database,
  siteId: string,
  statements: D1PreparedStatement[],
  expectation: RowExpectation,
): Promise<Response | null> {
  const results = await db.batch(statements);
  if (results[0]?.meta.changes !== 1) {
    // Nothing was written: the guarded config statement matched no row, and every
    // following statement requires changes() = 1. Explain why from the current rows.
    try {
      checkExpectation(await readUnitRuleRows(db, siteId), expectation);
    } catch (error) {
      const response = ruleErrorResponse(error);
      if (response) return response;
      throw error;
    }
    return apiError(CHANGED_ELSEWHERE, 409);
  }
  if (!everyStatementChangedOneRow(results, statements.length)) {
    return apiError('Unit rule save was not fully applied. Reload unit rules before saving again.', 500);
  }
  return null;
}

export async function listUnitRules(env: DatabaseEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  const result = await env.DB
    .prepare(
      `SELECT id, publisher_id, rule_key, rule_json, created_at, updated_at
       FROM unit_rules
       WHERE publisher_id = ?
       ORDER BY
         CASE rule_key
           WHEN '__DEFAULT__' THEN 0
           WHEN '__ATF__' THEN 1
           WHEN '__BTF__' THEN 2
           ELSE 3
         END,
         rule_key COLLATE NOCASE`,
    )
    .bind(siteId)
    .all<UnitRuleRow>();

  return json({ ok: true, unitRules: (result.results ?? []).map(toUnitRule) });
}

export async function createUnitRule(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  let input: CreateUnitRuleInput;
  try {
    input = await readJson<CreateUnitRuleInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  let ruleKey: string;
  let rule: UnitRuleConfig;
  try {
    ruleKey = await normalizeRuleKey(env.DB, siteId, input.ruleKey);
    rule = await normalizeRuleConfig(env.DB, siteId, input.rule ?? {});
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Unit rule validation failed.', 422);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const actor = getActor(request);

  const expectation: RowExpectation = { absentKey: ruleKey };
  let kept: string[] = [];

  try {
    const prepared = await prepareConfigUpdate(env.DB, siteId, ruleKey, rule, now, undefined, expectation, input.followInheritedSchedule === true);
    const configUpdate = prepared.statement;
    kept = prepared.kept;
    const refused = await applyRuleSave(env.DB, siteId, [
      configUpdate,
      env.DB
        .prepare(
          `INSERT INTO unit_rules (id, publisher_id, rule_key, rule_json, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
        )
        .bind(id, siteId, ruleKey, JSON.stringify(rule), now, now),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) SELECT ?, ?, 'unit_rule.created', ?, 'unit_rule', ?, ?, ? WHERE changes() = 1`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          id,
          JSON.stringify({ ruleKey, sections: Object.keys(rule), ...keptDetails(kept) }),
          now,
        ),
    ], expectation);
    if (refused) return refused;
  } catch (error) {
    const ruleError = ruleErrorResponse(error);
    if (ruleError) return ruleError;
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict ? `Rule "${ruleKey}" already exists on this site.` : 'Unit rule creation failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  return json({ ok: true, unitRule: writtenRule(id, siteId, ruleKey, rule, now, now), keptUnitRuleIntervals: kept }, { status: 201 });
}

export async function updateUnitRule(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
  unitRuleId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const current = await fetchUnitRule(env.DB, siteId, unitRuleId);
  if (!current) return apiError(UPDATE_TARGET_GONE, 404);

  let input: UpdateUnitRuleInput;
  try {
    input = await readJson<UpdateUnitRuleInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }
  // The editor's own read: a tab opened before another tab saved this rule would put
  // back values it never changed. `current` (same version) is the batch's expectation,
  // so the row guard enforces this version again when the batch commits.
  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== current.updatedAt) {
    return apiError(CHANGED_ELSEWHERE, 409);
  }

  let rule: UnitRuleConfig;
  try {
    rule = await normalizeRuleConfig(env.DB, siteId, input.rule ?? current.rule);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Unit rule validation failed.', 422);
  }

  const now = new Date().toISOString();
  const actor = getActor(request);

  const version = nextRowVersion(current.updatedAt, now);
  const expectation: RowExpectation = {
    present: { rule: current, goneMessage: UPDATE_TARGET_GONE },
  };
  let kept: string[] = [];

  try {
    const prepared = await prepareConfigUpdate(env.DB, siteId, current.ruleKey, rule, now, undefined, expectation);
    const configUpdate = prepared.statement;
    kept = prepared.kept;
    const refused = await applyRuleSave(env.DB, siteId, [
      configUpdate,
      env.DB
        .prepare(
          `UPDATE unit_rules
           SET rule_json = ?, updated_at = ?
           WHERE publisher_id = ? AND id = ? AND rule_key = ? AND updated_at = ? AND changes() = 1`,
        )
        .bind(JSON.stringify(rule), version, siteId, unitRuleId, current.ruleKey, current.updatedAt),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) SELECT ?, ?, 'unit_rule.updated', ?, 'unit_rule', ?, ?, ? WHERE changes() = 1`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          unitRuleId,
          JSON.stringify({ ruleKey: current.ruleKey, sections: Object.keys(rule), ...keptDetails(kept) }),
          now,
        ),
    ], expectation);
    if (refused) return refused;
  } catch (error) {
    const ruleError = ruleErrorResponse(error);
    if (ruleError) return ruleError;
    return apiError(
      'Unit rule update failed.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  return json({ ok: true, unitRule: writtenRule(current.id, siteId, current.ruleKey, rule, current.createdAt, version), keptUnitRuleIntervals: kept });
}

export async function duplicateUnitRule(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
  sourceUnitRuleId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const source = await fetchUnitRule(env.DB, siteId, sourceUnitRuleId);
  if (!source) return apiError(DUPLICATE_SOURCE_GONE, 404);

  let input: DuplicateUnitRuleInput;
  try {
    input = await readJson<DuplicateUnitRuleInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  let ruleKey: string;
  try {
    ruleKey = await normalizeRuleKey(env.DB, siteId, input.ruleKey);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Unit rule validation failed.', 422);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const actor = getActor(request);

  const expectation: RowExpectation = {
    present: { rule: source, goneMessage: DUPLICATE_SOURCE_GONE },
    absentKey: ruleKey,
  };
  let kept: string[] = [];

  try {
    const prepared = await prepareConfigUpdate(env.DB, siteId, ruleKey, source.rule, now, source.ruleKey, expectation);
    const configUpdate = prepared.statement;
    kept = prepared.kept;
    const refused = await applyRuleSave(env.DB, siteId, [
      configUpdate,
      env.DB
        .prepare(
          `INSERT INTO unit_rules (id, publisher_id, rule_key, rule_json, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
        )
        .bind(id, siteId, ruleKey, JSON.stringify(source.rule), now, now),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) SELECT ?, ?, 'unit_rule.duplicated', ?, 'unit_rule', ?, ?, ? WHERE changes() = 1`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          id,
          JSON.stringify({ sourceRuleId: source.id, sourceRuleKey: source.ruleKey, ruleKey, ...keptDetails(kept) }),
          now,
        ),
    ], expectation);
    if (refused) return refused;
  } catch (error) {
    const ruleError = ruleErrorResponse(error);
    if (ruleError) return ruleError;
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict ? `Rule "${ruleKey}" already exists on this site.` : 'Unit rule duplication failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  return json({ ok: true, unitRule: writtenRule(id, siteId, ruleKey, source.rule, now, now), keptUnitRuleIntervals: kept }, { status: 201 });
}

export async function deleteUnitRule(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
  unitRuleId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const current = await fetchUnitRule(env.DB, siteId, unitRuleId);
  if (!current) return apiError(DELETE_TARGET_GONE, 404);

  const actor = getActor(request);
  const now = new Date().toISOString();

  const expectation: RowExpectation = {
    present: { rule: current, goneMessage: DELETE_TARGET_GONE },
  };
  let kept: string[] = [];

  try {
    const prepared = await prepareConfigUpdate(env.DB, siteId, current.ruleKey, null, now, undefined, expectation);
    const configUpdate = prepared.statement;
    kept = prepared.kept;
    const refused = await applyRuleSave(env.DB, siteId, [
      configUpdate,
      env.DB
        .prepare('DELETE FROM unit_rules WHERE publisher_id = ? AND id = ? AND rule_key = ? AND updated_at = ? AND changes() = 1')
        .bind(siteId, unitRuleId, current.ruleKey, current.updatedAt),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) SELECT ?, ?, 'unit_rule.deleted', ?, 'unit_rule', ?, ?, ? WHERE changes() = 1`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          unitRuleId,
          JSON.stringify({ ruleKey: current.ruleKey, ...keptDetails(kept) }),
          now,
        ),
    ], expectation);
    if (refused) return refused;
  } catch (error) {
    const ruleError = ruleErrorResponse(error);
    if (ruleError) return ruleError;
    return apiError(
      'Unit rule could not be deleted.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  return json({ ok: true, deletedId: unitRuleId, keptUnitRuleIntervals: kept });
}
