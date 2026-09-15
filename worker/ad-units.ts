import type {
  AdUnit,
  AdUnitType,
  CreateAdUnitInput,
  DuplicateAdUnitInput,
  UpdateAdUnitInput,
} from '../src/shared/types';
import { apiError, getActor, json, readJson } from './http';
import type { DatabaseEnv } from './publishers';

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

async function hasVersionedPosition(db:D1Database,siteId:string,code:string):Promise<boolean>{
  const row=await db.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id=? LIMIT 1').bind(siteId).first<{config_json:string}>();
  const config=JSON.parse(row?.config_json??'{}');
  return Boolean(config.runtimeControls?.adPositions?.[code])||config.advancedUnitRules?.[code]?.lazy!=null;
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
  if((code!==current.code||type==='DRAFT'||mediaType!=='banner')&&await hasVersionedPosition(env.DB,publisherId,current.code))return apiError('Set this position to Standard and group loading before renaming it or changing its media/group.',409);
  const actor = getActor(request);
  const now = new Date().toISOString();

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE ad_units
           SET code = ?, type = ?, media_type = ?, size_map_key = ?, enabled = ?,
               sort_order = ?, notes = ?, updated_at = ?
           WHERE publisher_id = ? AND id = ?`,
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
          adUnitId,
        ),
      env.DB
        .prepare(
          `UPDATE bidder_overrides
           SET scope_key = ?, updated_at = ?
           WHERE publisher_id = ? AND scope_type = 'adunit' AND scope_key = ?`,
        )
        .bind(code, now, publisherId, current.code),
      env.DB
        .prepare(
          `UPDATE unit_rules
           SET rule_key = ?, updated_at = ?
           WHERE publisher_id = ? AND rule_key = ?`,
        )
        .bind(code, now, publisherId, current.code),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'ad_unit.updated', ?, 'ad_unit', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          publisherId,
          adUnitId,
          JSON.stringify({ previousCode: current.code, code, type, mediaType, sizeMapKey }),
          now,
        ),
    ]);
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
  return json({ ok: true, adUnit });
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

  const statements: D1PreparedStatement[] = [
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
        enabled ? 1 : 0,
        sortOrder,
        notes,
        now,
        now,
      ),
  ];

  if (input.copyUnitRule !== false) {
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO unit_rules (id, publisher_id, rule_key, rule_json, created_at, updated_at)
           SELECT ?, publisher_id, ?, rule_json, ?, ?
           FROM unit_rules
           WHERE publisher_id = ? AND rule_key = ?`,
        )
        .bind(crypto.randomUUID(), code, now, now, publisherId, source.code),
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
             ) VALUES (?, ?, ?, 'adunit', ?, ?, ?, ?, ?)`,
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
          ),
      );
    }
  }

  statements.push(
    env.DB
      .prepare(
        `INSERT INTO audit_log (
           id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
         ) VALUES (?, ?, 'ad_unit.duplicated', ?, 'ad_unit', ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        actor,
        publisherId,
        id,
        JSON.stringify({
          sourceAdUnitId,
          sourceCode: source.code,
          code,
          copySizeMapReference: input.copySizeMapReference !== false,
          copyUnitRule: input.copyUnitRule !== false,
          copyBidderAdUnitOverrides: input.copyBidderAdUnitOverrides !== false,
        }),
        now,
      ),
  );

  try {
    await env.DB.batch(statements);
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
  return json({ ok: true, adUnit }, { status: 201 });
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
  if(await hasVersionedPosition(env.DB,publisherId,current.code))return apiError('Set this position to Standard and group loading before deleting it.',409);

  const actor = getActor(request);
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB
      .prepare(
        `DELETE FROM bidder_overrides
         WHERE publisher_id = ? AND scope_type = 'adunit' AND scope_key = ?`,
      )
      .bind(publisherId, current.code),
    env.DB
      .prepare('DELETE FROM unit_rules WHERE publisher_id = ? AND rule_key = ?')
      .bind(publisherId, current.code),
    env.DB
      .prepare('DELETE FROM ad_units WHERE publisher_id = ? AND id = ?')
      .bind(publisherId, adUnitId),
    env.DB
      .prepare(
        `INSERT INTO audit_log (
           id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
         ) VALUES (?, ?, 'ad_unit.deleted', ?, 'ad_unit', ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        actor,
        publisherId,
        adUnitId,
        JSON.stringify({ code: current.code }),
        now,
      ),
  ]);

  return json({ ok: true, deletedId: adUnitId });
}
