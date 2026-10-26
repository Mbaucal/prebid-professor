import type {
  AdUnit,
  AdUnitType,
  CreateAdUnitInput,
  DuplicateAdUnitInput,
  UpdateAdUnitInput,
} from '../src/shared/types';
import { apiError, getActor, json, readJson } from './http';
import type { DatabaseEnv } from './publishers';
import { keepUnitRuleIntervals } from './refresh-inheritance';
import {
  UNIT_RULE_ROWS_UNCHANGED_SQL,
  nextRowVersion,
  readUnitRuleRows,
  unitRuleRowsUnchangedArgs,
} from './unit-rule-rows';
import type { UnitRuleRowState } from './unit-rule-rows';

type AdUnitRow = {
  id: string;
  publisher_id: string;
  code: string;
  type: AdUnitType;
  media_type: string;
  size_map_key: string | null;
  enabled: number;
  sort_order: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

async function positionGuard(db:D1Database,siteId:string,code:string){
  const row=await db.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id=? LIMIT 1').bind(siteId).first<{config_json:string}>();
  const config=JSON.parse(row?.config_json??'{}');
  const outstream=config.runtimeControls?.outstream?.units?.[code];
  const dealScope=config.runtimeControls?.deals?.entries?.some((entry:{positions?:unknown[]})=>entry.positions?.includes(code));
  return { configJson: row?.config_json ?? null, revenueReferenced: Boolean((outstream&&outstream.format!=='banner')||dealScope), configured: Boolean(config.runtimeControls?.adPositions?.[code])
    || config.runtimeControls?.sticky?.bottomAdUnitId === code
    || config.advancedUnitRules?.[code]?.lazy != null };
}

type JsonRecord = Record<string, unknown>;
const RULE_OWNED_FIELDS = ['timeout', 'cmpTimeout', 'refresh'];

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseRule(value: string): JsonRecord {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** JSON with object keys sorted, so a different key order alone is not a change. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// An ad-unit edit that changes its code, its ATF/BTF group (type set) or both, or a copy.
type RuleCarry =
  | { kind: 'edit'; from: string; to: string; type?: string }
  | { kind: 'copy'; from: string; to: string; type: string; copyRule: boolean };

/** `map` with the entry `replaced` (or, when absent, a new last entry) set to `key: value`; any other `key` entry goes. */
function withEntry(map: JsonRecord, replaced: string, key: string, value: unknown): JsonRecord {
  const entries = Object.entries(map).filter(([name]) => name === replaced || name !== key)
    .map(([name, item]): [string, unknown] => (name === replaced ? [key, value] : [name, item]));
  return Object.fromEntries(Object.hasOwn(map, replaced) ? entries : [...entries, [key, value]]);
}

/**
 * The generated script reads a position's Unit rules settings by its code from the
 * unit_rules row and its Refresh schedules record (timeout, cmpTimeout, refresh) in
 * config.advancedUnitRules; config.unitRules mirrors the rows. A rename moves the row,
 * its mirror entry and its record, and a copy with "Copy exact unit rule" copies them, as
 * Unit rules "Copy to" does; only the entries of the carried codes change. In the
 * target's ATF/BTF group an inherited schedule must not replace the saved interval, so a
 * copy or a group change runs the same keepUnitRuleIntervals step as a Unit rules save.
 * A record an earlier ad-unit delete left under the new code is re-used exactly as
 * before (cleanup on delete is a separate task): the carry does not replace, move into
 * or remove it, so the generated CMP timeout (the longest of every record) stays as it
 * was. Returns the config_json to write (null when nothing changes); callers write it in
 * the same batch as the rows, guarded by the config compare-and-swap and the unit_rules
 * row guard.
 */
function carriedRuleConfig(
  configJson: string | null,
  rows: UnitRuleRowState[],
  carry: RuleCarry,
): { configJson: string | null; kept: string[] } {
  if (configJson === null) return { configJson: null, kept: [] };
  const config = JSON.parse(configJson) as JsonRecord;
  const saved = isRecord(config.advancedUnitRules) ? config.advancedUnitRules : {};
  const basic = Object.fromEntries(rows.map((row) => [row.rule_key, parseRule(row.rule_json)]));
  const sourceRow = rows.find((row) => row.rule_key === carry.from);
  const carriedRow = carry.kind === 'copy' && !carry.copyRule ? undefined : sourceRow;
  const leftover = carry.to !== carry.from && Object.hasOwn(saved, carry.to);
  let changed = false;
  // The rows as they will be after the batch.
  const unitRules: JsonRecord = {};
  for (const row of rows) {
    unitRules[carry.kind === 'edit' && row.rule_key === carry.from ? carry.to : row.rule_key] = parseRule(row.rule_json);
  }
  if (carry.kind === 'copy' && carriedRow) unitRules[carry.to] = parseRule(carriedRow.rule_json);
  // The stored mirror follows the carried row; with no row to carry it stays as stored.
  const mirror = config.unitRules;
  if (carriedRow && isRecord(mirror)) {
    const next = withEntry(mirror, carry.kind === 'edit' ? carry.from : carry.to, carry.to, parseRule(carriedRow.rule_json));
    if (stableJson(next) !== stableJson(mirror)) {
      config.unitRules = next;
      changed = true;
    }
  }
  let advanced: JsonRecord = { ...saved };
  if (!leftover && carry.kind === 'edit' && carry.from !== carry.to && Object.hasOwn(saved, carry.from)) {
    // The whole record moves under the new code.
    advanced = withEntry(saved, carry.from, carry.to, saved[carry.from]);
    changed = true;
  } else if (!leftover && carry.kind === 'copy' && carriedRow && isRecord(saved[carry.from])) {
    const source = saved[carry.from] as JsonRecord;
    const copied: JsonRecord = {};
    for (const field of RULE_OWNED_FIELDS) if (Object.hasOwn(source, field)) copied[field] = structuredClone(source[field]);
    if (Object.keys(copied).length) {
      advanced[carry.to] = copied;
      changed = true;
    }
  }
  // Only the target's own interval can change: its code is the only exact key here.
  const kept = carry.type === undefined || leftover ? [] : keepUnitRuleIntervals(advanced, unitRules, { [carry.to]: carry.type }, carry.to, {
    savedRule: true,
    before: { advanced: saved, basic },
  });
  if (!changed && !kept.length) return { configJson: null, kept };
  if (isRecord(config.advancedUnitRules) || Object.keys(advanced).length) config.advancedUnitRules = advanced;
  return { configJson: JSON.stringify(config), kept };
}

function carriedConfigStatement(
  db: D1Database, siteId: string, previous: string | null, next: string | null, now: string, auditId: string,
): D1PreparedStatement[] {
  if (next === null) return [];
  return [db.prepare(
    `UPDATE publisher_configs SET config_json = ?, config_hash = NULL, updated_at = ?
     WHERE publisher_id = ? AND config_json = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`,
  ).bind(next, now, siteId, previous, auditId)];
}

function toAdUnit(row: AdUnitRow): AdUnit {
  return {
    id: row.id,
    publisherId: row.publisher_id,
    code: row.code,
    type: row.type,
    mediaType: row.media_type,
    sizeMapKey: row.size_map_key,
    enabled: Boolean(row.enabled),
    sortOrder: Number(row.sort_order ?? 0),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeType(value: unknown): AdUnitType {
  const normalized = String(value ?? 'BTF').trim().toUpperCase();
  if (normalized === 'ATF' || normalized === 'BTF' || normalized === 'DRAFT') {
    return normalized;
  }
  return 'BTF';
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeCode(value: unknown): string {
  return String(value ?? '').trim();
}

function validateCode(code: string): string[] {
  const errors: string[] = [];

  if (!code) {
    errors.push('code is required.');
  } else if (!/^[A-Za-z][A-Za-z0-9_:\-]{0,127}$/.test(code)) {
    errors.push('code must start with a letter and use only letters, numbers, underscore, dash or colon.');
  }

  return errors;
}

async function publisherExists(db: D1Database, publisherId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1')
    .bind(publisherId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function fetchAdUnit(
  db: D1Database,
  publisherId: string,
  adUnitId: string,
): Promise<AdUnit | null> {
  const row = await db
    .prepare(
      `SELECT id, publisher_id, code, type, media_type, size_map_key, enabled, sort_order,
              notes, created_at, updated_at
       FROM ad_units
       WHERE publisher_id = ? AND id = ?
       LIMIT 1`,
    )
    .bind(publisherId, adUnitId)
    .first<AdUnitRow>();

  return row ? toAdUnit(row) : null;
}

export async function listAdUnits(env: DatabaseEnv, publisherId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await publisherExists(env.DB, publisherId))) return apiError('Publisher not found.', 404);

  const result = await env.DB
    .prepare(
      `SELECT id, publisher_id, code, type, media_type, size_map_key, enabled, sort_order,
              notes, created_at, updated_at
       FROM ad_units
       WHERE publisher_id = ?
       ORDER BY
         CASE type WHEN 'ATF' THEN 0 WHEN 'BTF' THEN 1 ELSE 2 END,
         sort_order,
         code COLLATE NOCASE`,
    )
    .bind(publisherId)
    .all<AdUnitRow>();

  return json({
    ok: true,
    adUnits: (result.results ?? []).map(toAdUnit),
  });
}

export async function createAdUnit(
  request: Request,
  env: DatabaseEnv,
  publisherId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await publisherExists(env.DB, publisherId))) return apiError('Publisher not found.', 404);

  let input: CreateAdUnitInput;
  try {
    input = await readJson<CreateAdUnitInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const code = normalizeCode(input.code);
  const errors = validateCode(code);
  if (errors.length) return apiError('Ad unit validation failed.', 422, errors);

  const id = crypto.randomUUID();
  const type = normalizeType(input.type);
  const mediaType = String(input.mediaType ?? 'banner').trim() || 'banner';
  const sizeMapKey = normalizeNullableString(input.sizeMapKey);
  const enabled = input.enabled === false ? 0 : 1;
  const sortOrder = Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : 0;
  const notes = normalizeNullableString(input.notes);
  const actor = getActor(request);
  const now = new Date().toISOString();

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO ad_units (
             id, publisher_id, code, type, media_type, size_map_key, enabled, sort_order,
             notes, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          publisherId,
          code,
          type,
          mediaType,
          sizeMapKey,
          enabled,
          sortOrder,
          notes,
          now,
          now,
        ),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'ad_unit.created', ?, 'ad_unit', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          publisherId,
          id,
          JSON.stringify({ code, type, mediaType, sizeMapKey }),
          now,
        ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict ? `Ad unit code "${code}" already exists for this publisher.` : 'Ad unit creation failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  const adUnit = await fetchAdUnit(env.DB, publisherId, id);
  return json({ ok: true, adUnit }, { status: 201 });
}

export async function updateAdUnit(
  request: Request,
  env: DatabaseEnv,
  publisherId: string,
  adUnitId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();

  const current = await fetchAdUnit(env.DB, publisherId, adUnitId);
  if (!current) return apiError('Ad unit not found.', 404);

  let input: UpdateAdUnitInput;
  try {
    input = await readJson<UpdateAdUnitInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const code = input.code === undefined ? current.code : normalizeCode(input.code);
  const errors = validateCode(code);
  if (errors.length) return apiError('Ad unit validation failed.', 422, errors);

  const type = input.type === undefined ? current.type : normalizeType(input.type);
  const mediaType =
    input.mediaType === undefined
      ? current.mediaType
      : String(input.mediaType).trim() || 'banner';
  const sizeMapKey =
    input.sizeMapKey === undefined ? current.sizeMapKey : normalizeNullableString(input.sizeMapKey);
  const enabled = input.enabled === undefined ? current.enabled : Boolean(input.enabled);
  const sortOrder =
    input.sortOrder === undefined || !Number.isFinite(Number(input.sortOrder))
      ? current.sortOrder
      : Number(input.sortOrder);
  const notes = input.notes === undefined ? current.notes : normalizeNullableString(input.notes);
  const guard = await positionGuard(env.DB,publisherId,current.code);
  if((code!==current.code||type==='DRAFT'||mediaType!=='banner'||!enabled)&&guard.revenueReferenced)return apiError('Remove this position from Deals and set its format to Banner before renaming, disabling or changing its media/group.',409);
  if((code!==current.code||type==='DRAFT'||mediaType!=='banner'||!enabled)&&guard.configured)return apiError('Set this position to Standard and group loading before renaming, disabling or changing its media/group.',409);
  const actor = getActor(request);
  const now = new Date().toISOString();
  const auditId = crypto.randomUUID();
  // A rename or ATF/BTF group change carries the rule row, its mirror and its Refresh
  // schedules record in this batch, guarded like a Unit rules save. Other edits write no
  // site settings and leave the rule row as it is.
  const regrouped = type !== current.type;
  const carries = code !== current.code || regrouped;
  const rows = carries ? await readUnitRuleRows(env.DB, publisherId) : [];
  const carried = carries
    ? carriedRuleConfig(guard.configJson, rows, { kind: 'edit', from: current.code, to: code, ...(regrouped ? { type } : {}) })
    : { configJson: null, kept: [] };
  // The re-keyed (or re-grouped) row is a new version of the row this request read, so a
  // Unit rules or Refresh schedules save built from the older row is refused.
  const ruleRow = rows.find((row) => row.rule_key === current.code);

  try {
    const result = await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) SELECT ?, ?, 'ad_unit.updated', ?, 'ad_unit', ?, ?, ?
           WHERE (SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1) IS ?
             AND EXISTS (SELECT 1 FROM ad_units WHERE publisher_id = ? AND id = ? AND code = ? AND updated_at IS ?)
             ${carries ? `AND ${UNIT_RULE_ROWS_UNCHANGED_SQL}` : ''}`,
        )
        .bind(
          auditId,
          actor,
          publisherId,
          adUnitId,
          JSON.stringify({ previousCode: current.code, code, type, mediaType, sizeMapKey, ...(carried.kept.length ? { keptUnitRuleIntervals: carried.kept } : {}) }),
          now, publisherId, guard.configJson, publisherId, adUnitId, current.code, current.updatedAt,
          ...(carries ? unitRuleRowsUnchangedArgs(publisherId, rows) : []),
        ),
      ...carriedConfigStatement(env.DB, publisherId, guard.configJson, carried.configJson, now, auditId),

      env.DB
        .prepare(
          `UPDATE ad_units
           SET code = ?, type = ?, media_type = ?, size_map_key = ?, enabled = ?,
               sort_order = ?, notes = ?, updated_at = ?
           WHERE publisher_id = ? AND id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`,
        )
        .bind(
          code,
          type,
          mediaType,
          sizeMapKey,
          enabled ? 1 : 0,
          sortOrder,
          notes,
          now,
          publisherId,
          adUnitId, auditId,
        ),
      env.DB
        .prepare(
          `UPDATE bidder_overrides
           SET scope_key = ?, updated_at = ?
           WHERE publisher_id = ? AND scope_type = 'adunit' AND scope_key = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`,
        )
        .bind(code, now, publisherId, current.code, auditId),
      ...(ruleRow
        ? [env.DB
            .prepare(
              `UPDATE unit_rules
               SET rule_key = ?, updated_at = ?
               WHERE publisher_id = ? AND rule_key = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`,
            )
            .bind(code, nextRowVersion(ruleRow.updated_at, now), publisherId, current.code, auditId)]
        : []),
    ]);
    if (result[0].meta.changes !== 1) return apiError("Site settings changed. Reload before editing this ad unit.",409);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict ? `Ad unit code "${code}" already exists for this publisher.` : 'Ad unit update failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  const adUnit = await fetchAdUnit(env.DB, publisherId, adUnitId);
  return json({ ok: true, adUnit, keptUnitRuleIntervals: carried.kept });
}

export async function duplicateAdUnit(
  request: Request,
  env: DatabaseEnv,
  publisherId: string,
  sourceAdUnitId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();

  const source = await fetchAdUnit(env.DB, publisherId, sourceAdUnitId);
  if (!source) return apiError('Source ad unit not found.', 404);

  let input: DuplicateAdUnitInput;
  try {
    input = await readJson<DuplicateAdUnitInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const code = normalizeCode(input.code);
  const errors = validateCode(code);
  if (errors.length) return apiError('Ad unit validation failed.', 422, errors);

  const id = crypto.randomUUID();
  const type = input.type === undefined ? source.type : normalizeType(input.type);
  const mediaType = input.mediaType?.trim() || source.mediaType;
  const enabled = input.enabled === undefined ? source.enabled : Boolean(input.enabled);
  const sortOrder =
    input.sortOrder === undefined || !Number.isFinite(Number(input.sortOrder))
      ? source.sortOrder + 1
      : Number(input.sortOrder);
  const notes = input.notes === undefined ? source.notes : normalizeNullableString(input.notes);
  const sizeMapKey = input.copySizeMapReference === false ? null : source.sizeMapKey;
  const actor = getActor(request);
  const now = new Date().toISOString();

  const auditId = crypto.randomUUID();
  const copyUnitRule = input.copyUnitRule !== false;
  // The copied rule row, its mirror and its Refresh schedules record are written together,
  // only while config_json and every unit_rules row are still what this copy was built from.
  const [configRow, rows] = await Promise.all([
    env.DB.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
      .bind(publisherId).first<{ config_json: string }>(),
    readUnitRuleRows(env.DB, publisherId),
  ]);
  const configJson = configRow?.config_json ?? null;
  const carried = carriedRuleConfig(configJson, rows, {
    kind: 'copy', from: source.code, to: code, type, copyRule: copyUnitRule,
  });

  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        `INSERT INTO audit_log (
           id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
         ) SELECT ?, ?, 'ad_unit.duplicated', ?, 'ad_unit', ?, ?, ?
         WHERE (SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1) IS ?
           AND ${UNIT_RULE_ROWS_UNCHANGED_SQL}`,
      )
      .bind(
        auditId,
        actor,
        publisherId,
        id,
        JSON.stringify({
          sourceAdUnitId,
          sourceCode: source.code,
          code,
          copySizeMapReference: input.copySizeMapReference !== false,
          copyUnitRule,
          copyBidderAdUnitOverrides: input.copyBidderAdUnitOverrides !== false,
          ...(carried.kept.length ? { keptUnitRuleIntervals: carried.kept } : {}),
        }),
        now, publisherId, configJson, ...unitRuleRowsUnchangedArgs(publisherId, rows),
      ),
    ...carriedConfigStatement(env.DB, publisherId, configJson, carried.configJson, now, auditId),
    env.DB
      .prepare(
        `INSERT INTO ad_units (
           id, publisher_id, code, type, media_type, size_map_key, enabled, sort_order,
           notes, created_at, updated_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`,
      )
      .bind(
        id,
        publisherId,
        code,
        type,
        mediaType,
        sizeMapKey,
        enabled ? 1 : 0,
        sortOrder,
        notes,
        now,
        now,
        auditId,
      ),
  ];

  if (copyUnitRule) {
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO unit_rules (id, publisher_id, rule_key, rule_json, created_at, updated_at)
           SELECT ?, publisher_id, ?, rule_json, ?, ?
           FROM unit_rules
           WHERE publisher_id = ? AND rule_key = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`,
        )
        .bind(crypto.randomUUID(), code, now, now, publisherId, source.code, auditId),
    );
  }

  if (input.copyBidderAdUnitOverrides !== false) {
    const overrides = await env.DB
      .prepare(
        `SELECT bidder, params_json, enabled
         FROM bidder_overrides
         WHERE publisher_id = ? AND scope_type = 'adunit' AND scope_key = ?`,
      )
      .bind(publisherId, source.code)
      .all<{ bidder: string; params_json: string; enabled: number }>();

    for (const override of overrides.results ?? []) {
      statements.push(
        env.DB
          .prepare(
            `INSERT INTO bidder_overrides (
               id, publisher_id, bidder, scope_type, scope_key, params_json, enabled,
               created_at, updated_at
             ) SELECT ?, ?, ?, 'adunit', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`,
          )
          .bind(
            crypto.randomUUID(),
            publisherId,
            override.bidder,
            code,
            override.params_json,
            override.enabled,
            now,
            now,
            auditId,
          ),
      );
    }
  }

  try {
    const result = await env.DB.batch(statements);
    if (result[0].meta.changes !== 1) return apiError('Site settings changed. Reload before copying this ad unit.', 409);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict ? `Ad unit code "${code}" already exists for this publisher.` : 'Ad unit duplication failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  const adUnit = await fetchAdUnit(env.DB, publisherId, id);
  return json({ ok: true, adUnit, keptUnitRuleIntervals: carried.kept }, { status: 201 });
}

export async function deleteAdUnit(
  request: Request,
  env: DatabaseEnv,
  publisherId: string,
  adUnitId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();

  const current = await fetchAdUnit(env.DB, publisherId, adUnitId);
  if (!current) return apiError('Ad unit not found.', 404);
  const guard = await positionGuard(env.DB,publisherId,current.code);
  if(guard.revenueReferenced)return apiError('Remove this position from Deals and set its format to Banner before deleting it.',409);
  if(guard.configured)return apiError('Set this position to Standard and group loading before deleting it.',409);

  const actor = getActor(request);
  const now = new Date().toISOString();
  const auditId = crypto.randomUUID();

  const result = await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO audit_log (
           id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
         ) SELECT ?, ?, 'ad_unit.deleted', ?, 'ad_unit', ?, ?, ?
           WHERE (SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1) IS ?
             AND EXISTS (SELECT 1 FROM ad_units WHERE publisher_id = ? AND id = ? AND code = ? AND updated_at IS ?)`,
      )
      .bind(
        auditId,
        actor,
        publisherId,
        adUnitId,
        JSON.stringify({ code: current.code }),
        now, publisherId, guard.configJson, publisherId, adUnitId, current.code, current.updatedAt,
      ),

    env.DB
      .prepare(
        `DELETE FROM bidder_overrides
         WHERE publisher_id = ? AND scope_type = 'adunit' AND scope_key = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`,
      )
      .bind(publisherId, current.code, auditId),
    env.DB
      .prepare('DELETE FROM unit_rules WHERE publisher_id = ? AND rule_key = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)')
      .bind(publisherId, current.code, auditId),
    env.DB
      .prepare('DELETE FROM ad_units WHERE publisher_id = ? AND id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)')
      .bind(publisherId, adUnitId, auditId),
    ]);
    if (result[0].meta.changes !== 1) return apiError("Site settings changed. Reload before editing this ad unit.",409);

  return json({ ok: true, deletedId: adUnitId });
}
