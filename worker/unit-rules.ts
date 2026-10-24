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

class RuleConflict extends Error {}

async function prepareConfigUpdate(
  db: D1Database, siteId: string, ruleKey: string, rule: UnitRuleConfig | null,
  now: string, sourceRuleKey?: string,
): Promise<D1PreparedStatement> {
  const [row, rows] = await Promise.all([
    db.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1').bind(siteId).first<{config_json: string}>(),
    db.prepare('SELECT rule_key, rule_json FROM unit_rules WHERE publisher_id = ? ORDER BY rule_key COLLATE NOCASE').bind(siteId).all<{rule_key: string; rule_json: string}>(),
  ]);
  if (!row) throw new Error('Publisher config was not found.');
  const config = JSON.parse(row.config_json) as JsonRecord;
  const unitRules: Record<string, UnitRuleConfig> = {};
  for (const item of rows.results ?? []) unitRules[item.rule_key] = parseStoredRule(item.rule_json);
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
  if (isRecord(config.advancedUnitRules) || Object.keys(advanced).length) config.advancedUnitRules = advanced;
  return db.prepare('UPDATE publisher_configs SET config_json = ?, config_hash = NULL, updated_at = ? WHERE publisher_id = ? AND config_json = ?')
    .bind(JSON.stringify(config), now, siteId, row.config_json);
}

function ruleSaveConflict(results: D1Result[]): boolean {
  return results[0]?.meta.changes !== 1;
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

  try {
    const configUpdate = await prepareConfigUpdate(env.DB, siteId, ruleKey, rule, now);
    const results = await env.DB.batch([
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
          JSON.stringify({ ruleKey, sections: Object.keys(rule) }),
          now,
        ),
    ]);
    if (ruleSaveConflict(results)) return apiError('Unit rules changed in another tab. Reload before saving.', 409);
  } catch (error) {
    if (error instanceof RuleConflict) return apiError(error.message, 409);
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict ? `Rule "${ruleKey}" already exists on this site.` : 'Unit rule creation failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  return json({ ok: true, unitRule: await fetchUnitRule(env.DB, siteId, id) }, { status: 201 });
}

export async function updateUnitRule(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
  unitRuleId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const current = await fetchUnitRule(env.DB, siteId, unitRuleId);
  if (!current) return apiError('Unit rule not found.', 404);

  let input: UpdateUnitRuleInput;
  try {
    input = await readJson<UpdateUnitRuleInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  let rule: UnitRuleConfig;
  try {
    rule = await normalizeRuleConfig(env.DB, siteId, input.rule ?? current.rule);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Unit rule validation failed.', 422);
  }

  const now = new Date().toISOString();
  const actor = getActor(request);

  try {
    const configUpdate = await prepareConfigUpdate(env.DB, siteId, current.ruleKey, rule, now);
    const results = await env.DB.batch([
      configUpdate,
      env.DB
        .prepare(
          `UPDATE unit_rules
           SET rule_json = ?, updated_at = ?
           WHERE publisher_id = ? AND id = ? AND changes() = 1`,
        )
        .bind(JSON.stringify(rule), now, siteId, unitRuleId),
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
          JSON.stringify({ ruleKey: current.ruleKey, sections: Object.keys(rule) }),
          now,
        ),
    ]);
    if (ruleSaveConflict(results)) return apiError('Unit rules changed in another tab. Reload before saving.', 409);
  } catch (error) {
    if (error instanceof RuleConflict) return apiError(error.message, 409);
    return apiError(
      'Unit rule update failed.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  return json({ ok: true, unitRule: await fetchUnitRule(env.DB, siteId, unitRuleId) });
}

export async function duplicateUnitRule(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
  sourceUnitRuleId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const source = await fetchUnitRule(env.DB, siteId, sourceUnitRuleId);
  if (!source) return apiError('Source unit rule not found.', 404);

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

  try {
    const configUpdate = await prepareConfigUpdate(env.DB, siteId, ruleKey, source.rule, now, source.ruleKey);
    const results = await env.DB.batch([
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
          JSON.stringify({ sourceRuleId: source.id, sourceRuleKey: source.ruleKey, ruleKey }),
          now,
        ),
    ]);
    if (ruleSaveConflict(results)) return apiError('Unit rules changed in another tab. Reload before saving.', 409);
  } catch (error) {
    if (error instanceof RuleConflict) return apiError(error.message, 409);
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict ? `Rule "${ruleKey}" already exists on this site.` : 'Unit rule duplication failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  return json({ ok: true, unitRule: await fetchUnitRule(env.DB, siteId, id) }, { status: 201 });
}

export async function deleteUnitRule(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
  unitRuleId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const current = await fetchUnitRule(env.DB, siteId, unitRuleId);
  if (!current) return apiError('Unit rule not found.', 404);

  const actor = getActor(request);
  const now = new Date().toISOString();

  try {
    const configUpdate = await prepareConfigUpdate(env.DB, siteId, current.ruleKey, null, now);
    const results = await env.DB.batch([
      configUpdate,
      env.DB.prepare('DELETE FROM unit_rules WHERE publisher_id = ? AND id = ? AND changes() = 1').bind(siteId, unitRuleId),
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
          JSON.stringify({ ruleKey: current.ruleKey }),
          now,
        ),
    ]);
    if (ruleSaveConflict(results)) return apiError('Unit rules changed in another tab. Reload before saving.', 409);
  } catch (error) {
    if (error instanceof RuleConflict) return apiError(error.message, 409);
    return apiError(
      'Unit rule could not be deleted.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  return json({ ok: true, deletedId: unitRuleId });
}
