import type {
  Bidder,
  BidderOverride,
  BidderOverrideScope,
  CreateBidderInput,
  CreateBidderOverrideInput,
  DuplicateBidderInput,
  DuplicateBidderOverrideInput,
  JsonObject,
  UpdateBidderInput,
  UpdateBidderOverrideInput,
} from '../src/shared/types';
import { apiError, getActor, json, readJson } from './http';
import type { DatabaseEnv } from './publishers';

type BidderRow = {
  id: string;
  publisher_id: string;
  bidder: string;
  params_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type OverrideRow = {
  id: string;
  publisher_id: string;
  bidder: string;
  scope_type: BidderOverrideScope;
  scope_key: string;
  params_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function parseStoredObject(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

function normalizeObject(value: unknown, field = 'params'): JsonObject {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object, not an array or primitive.`);
  }
  return value as JsonObject;
}

function normalizeBidderName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function validateBidderName(value: string): string[] {
  const errors: string[] = [];
  if (!value) {
    errors.push('bidder is required.');
  } else if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    errors.push('bidder must start with a lowercase letter and use only lowercase letters, numbers, underscore or dash.');
  }
  return errors;
}

function normalizeScopeType(value: unknown): BidderOverrideScope {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'slot' || normalized === 'device' || normalized === 'adunit') {
    return normalized;
  }
  throw new Error('scopeType must be slot, device or adunit.');
}

function normalizeScopeKey(value: unknown): string {
  return String(value ?? '').trim();
}

function toOverride(row: OverrideRow): BidderOverride {
  return {
    id: row.id,
    publisherId: row.publisher_id,
    bidder: row.bidder,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    params: parseStoredObject(row.params_json),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBidder(row: BidderRow, overrides: BidderOverride[] = []): Bidder {
  return {
    id: row.id,
    publisherId: row.publisher_id,
    bidder: row.bidder,
    params: parseStoredObject(row.params_json),
    enabled: Boolean(row.enabled),
    overrides,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function publisherExists(db: D1Database, publisherId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1')
    .bind(publisherId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function adUnitExists(db: D1Database, publisherId: string, code: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM ad_units WHERE publisher_id = ? AND code = ? LIMIT 1')
    .bind(publisherId, code)
    .first<{ id: string }>();
  return Boolean(row);
}

async function validateScopeKey(
  db: D1Database,
  publisherId: string,
  scopeType: BidderOverrideScope,
  scopeKey: string,
): Promise<string[]> {
  const errors: string[] = [];
  if (!scopeKey) errors.push('scopeKey is required.');

  if (scopeType === 'adunit' && scopeKey && !(await adUnitExists(db, publisherId, scopeKey))) {
    errors.push(`Ad unit "${scopeKey}" does not exist for this publisher.`);
  }

  return errors;
}

async function fetchOverridesForBidder(
  db: D1Database,
  publisherId: string,
  bidder: string,
): Promise<BidderOverride[]> {
  const result = await db
    .prepare(
      `SELECT id, publisher_id, bidder, scope_type, scope_key, params_json, enabled,
              created_at, updated_at
       FROM bidder_overrides
       WHERE publisher_id = ? AND bidder = ?
       ORDER BY
         CASE scope_type WHEN 'slot' THEN 0 WHEN 'device' THEN 1 ELSE 2 END,
         scope_key COLLATE NOCASE`,
    )
    .bind(publisherId, bidder)
    .all<OverrideRow>();

  return (result.results ?? []).map(toOverride);
}

async function fetchBidder(
  db: D1Database,
  publisherId: string,
  bidderId: string,
): Promise<Bidder | null> {
  const row = await db
    .prepare(
      `SELECT id, publisher_id, bidder, params_json, enabled, created_at, updated_at
       FROM bidders
       WHERE publisher_id = ? AND id = ?
       LIMIT 1`,
    )
    .bind(publisherId, bidderId)
    .first<BidderRow>();

  if (!row) return null;
  return toBidder(row, await fetchOverridesForBidder(db, publisherId, row.bidder));
}

async function fetchOverride(
  db: D1Database,
  publisherId: string,
  overrideId: string,
): Promise<BidderOverride | null> {
  const row = await db
    .prepare(
      `SELECT id, publisher_id, bidder, scope_type, scope_key, params_json, enabled,
              created_at, updated_at
       FROM bidder_overrides
       WHERE publisher_id = ? AND id = ?
       LIMIT 1`,
    )
    .bind(publisherId, overrideId)
    .first<OverrideRow>();

  return row ? toOverride(row) : null;
}

export async function listBidders(env: DatabaseEnv, publisherId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await publisherExists(env.DB, publisherId))) return apiError('Publisher not found.', 404);

  const bidderResult = await env.DB
    .prepare(
      `SELECT id, publisher_id, bidder, params_json, enabled, created_at, updated_at
       FROM bidders
       WHERE publisher_id = ?
       ORDER BY bidder COLLATE NOCASE`,
    )
    .bind(publisherId)
    .all<BidderRow>();

  const overrideResult = await env.DB
    .prepare(
      `SELECT id, publisher_id, bidder, scope_type, scope_key, params_json, enabled,
              created_at, updated_at
       FROM bidder_overrides
       WHERE publisher_id = ?
       ORDER BY bidder COLLATE NOCASE,
         CASE scope_type WHEN 'slot' THEN 0 WHEN 'device' THEN 1 ELSE 2 END,
         scope_key COLLATE NOCASE`,
    )
    .bind(publisherId)
    .all<OverrideRow>();

  const overridesByBidder = new Map<string, BidderOverride[]>();
  for (const row of overrideResult.results ?? []) {
    const override = toOverride(row);
    const list = overridesByBidder.get(override.bidder) ?? [];
    list.push(override);
    overridesByBidder.set(override.bidder, list);
  }

  return json({
    ok: true,
    bidders: (bidderResult.results ?? []).map((row) =>
      toBidder(row, overridesByBidder.get(row.bidder) ?? []),
    ),
  });
}

export async function createBidder(
  request: Request,
  env: DatabaseEnv,
  publisherId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await publisherExists(env.DB, publisherId))) return apiError('Publisher not found.', 404);

  let input: CreateBidderInput;
  try {
    input = await readJson<CreateBidderInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const bidderName = normalizeBidderName(input.bidder);
  const errors = validateBidderName(bidderName);
  if (errors.length) return apiError('Bidder validation failed.', 422, errors);

  let params: JsonObject;
  try {
    params = normalizeObject(input.params);
  } catch (error) {
    return apiError('Bidder validation failed.', 422, error instanceof Error ? error.message : String(error));
  }

  const id = crypto.randomUUID();
  const enabled = input.enabled === false ? 0 : 1;
  const actor = getActor(request);
  const now = new Date().toISOString();

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO bidders (
             id, publisher_id, bidder, params_json, enabled, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, publisherId, bidderName, JSON.stringify(params), enabled, now, now),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'bidder.created', ?, 'bidder', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          publisherId,
          id,
          JSON.stringify({ bidder: bidderName, enabled: Boolean(enabled) }),
          now,
        ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict ? `Bidder "${bidderName}" already exists for this publisher.` : 'Bidder creation failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  return json({ ok: true, bidder: await fetchBidder(env.DB, publisherId, id) }, { status: 201 });
}

export async function updateBidder(
  request: Request,
  env: DatabaseEnv,
  publisherId: string,
  bidderId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const current = await fetchBidder(env.DB, publisherId, bidderId);
  if (!current) return apiError('Bidder not found.', 404);

  let input: UpdateBidderInput;
  try {
    input = await readJson<UpdateBidderInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const bidderName = input.bidder === undefined ? current.bidder : normalizeBidderName(input.bidder);
  const errors = validateBidderName(bidderName);
  if (errors.length) return apiError('Bidder validation failed.', 422, errors);

  let params = current.params;
  if (input.params !== undefined) {
    try {
      params = normalizeObject(input.params);
    } catch (error) {
      return apiError('Bidder validation failed.', 422, error instanceof Error ? error.message : String(error));
    }
  }

  const enabled = input.enabled === undefined ? current.enabled : Boolean(input.enabled);
  const actor = getActor(request);
  const now = new Date().toISOString();

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE bidders
           SET bidder = ?, params_json = ?, enabled = ?, updated_at = ?
           WHERE publisher_id = ? AND id = ?`,
        )
        .bind(bidderName, JSON.stringify(params), enabled ? 1 : 0, now, publisherId, bidderId),
      env.DB
        .prepare(
          `UPDATE bidder_overrides
           SET bidder = ?, updated_at = ?
           WHERE publisher_id = ? AND bidder = ?`,
        )
        .bind(bidderName, now, publisherId, current.bidder),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'bidder.updated', ?, 'bidder', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          publisherId,
          bidderId,
          JSON.stringify({ previousBidder: current.bidder, bidder: bidderName, enabled }),
          now,
        ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict ? `Bidder "${bidderName}" already exists for this publisher.` : 'Bidder update failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  return json({ ok: true, bidder: await fetchBidder(env.DB, publisherId, bidderId) });
}

export async function duplicateBidder(
  request: Request,
  env: DatabaseEnv,
  publisherId: string,
  sourceBidderId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const source = await fetchBidder(env.DB, publisherId, sourceBidderId);
  if (!source) return apiError('Source bidder not found.', 404);

  let input: DuplicateBidderInput;
  try {
    input = await readJson<DuplicateBidderInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const bidderName = normalizeBidderName(input.bidder);
  const errors = validateBidderName(bidderName);
  if (errors.length) return apiError('Bidder validation failed.', 422, errors);

  const id = crypto.randomUUID();
  const enabled = input.enabled === undefined ? source.enabled : Boolean(input.enabled);
  const actor = getActor(request);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        `INSERT INTO bidders (
           id, publisher_id, bidder, params_json, enabled, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, publisherId, bidderName, JSON.stringify(source.params), enabled ? 1 : 0, now, now),
  ];

  if (input.copyOverrides !== false) {
    for (const override of source.overrides) {
      statements.push(
        env.DB
          .prepare(
            `INSERT INTO bidder_overrides (
               id, publisher_id, bidder, scope_type, scope_key, params_json, enabled,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            publisherId,
            bidderName,
            override.scopeType,
            override.scopeKey,
            JSON.stringify(override.params),
            override.enabled ? 1 : 0,
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
         ) VALUES (?, ?, 'bidder.duplicated', ?, 'bidder', ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        actor,
        publisherId,
        id,
        JSON.stringify({ sourceBidder: source.bidder, bidder: bidderName, copyOverrides: input.copyOverrides !== false }),
        now,
      ),
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict ? `Bidder "${bidderName}" already exists for this publisher.` : 'Bidder duplication failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  return json({ ok: true, bidder: await fetchBidder(env.DB, publisherId, id) }, { status: 201 });
}

export async function deleteBidder(
  request: Request,
  env: DatabaseEnv,
  publisherId: string,
  bidderId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const current = await fetchBidder(env.DB, publisherId, bidderId);
  if (!current) return apiError('Bidder not found.', 404);

  const actor = getActor(request);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB
      .prepare('DELETE FROM bidder_overrides WHERE publisher_id = ? AND bidder = ?')
      .bind(publisherId, current.bidder),
    env.DB.prepare('DELETE FROM bidders WHERE publisher_id = ? AND id = ?').bind(publisherId, bidderId),
    env.DB
      .prepare(
        `INSERT INTO audit_log (
           id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
         ) VALUES (?, ?, 'bidder.deleted', ?, 'bidder', ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        actor,
        publisherId,
        bidderId,
        JSON.stringify({ bidder: current.bidder, overridesDeleted: current.overrides.length }),
        now,
      ),
  ]);

  return json({ ok: true, deletedId: bidderId });
}

export async function createBidderOverride(
  request: Request,
  env: DatabaseEnv,
  publisherId: string,
  bidderId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const bidder = await fetchBidder(env.DB, publisherId, bidderId);
  if (!bidder) return apiError('Bidder not found.', 404);

  let input: CreateBidderOverrideInput;
  try {
    input = await readJson<CreateBidderOverrideInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  let scopeType: BidderOverrideScope;
  let params: JsonObject;
  try {
    scopeType = normalizeScopeType(input.scopeType);
    params = normalizeObject(input.params);
  } catch (error) {
    return apiError('Override validation failed.', 422, error instanceof Error ? error.message : String(error));
  }

  const scopeKey = normalizeScopeKey(input.scopeKey);
  const errors = await validateScopeKey(env.DB, publisherId, scopeType, scopeKey);
  if (errors.length) return apiError('Override validation failed.', 422, errors);

  const id = crypto.randomUUID();
  const enabled = input.enabled === false ? 0 : 1;
  const actor = getActor(request);
  const now = new Date().toISOString();

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO bidder_overrides (
             id, publisher_id, bidder, scope_type, scope_key, params_json, enabled,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          publisherId,
          bidder.bidder,
          scopeType,
          scopeKey,
          JSON.stringify(params),
          enabled,
          now,
          now,
        ),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'bidder_override.created', ?, 'bidder_override', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          publisherId,
          id,
          JSON.stringify({ bidder: bidder.bidder, scopeType, scopeKey }),
          now,
        ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict
        ? `${bidder.bidder} already has a ${scopeType} override for "${scopeKey}".`
        : 'Override creation failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  return json({ ok: true, override: await fetchOverride(env.DB, publisherId, id) }, { status: 201 });
}

export async function updateBidderOverride(
  request: Request,
  env: DatabaseEnv,
  publisherId: string,
  overrideId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const current = await fetchOverride(env.DB, publisherId, overrideId);
  if (!current) return apiError('Bidder override not found.', 404);

  let input: UpdateBidderOverrideInput;
  try {
    input = await readJson<UpdateBidderOverrideInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  let scopeType = current.scopeType;
  let params = current.params;
  try {
    if (input.scopeType !== undefined) scopeType = normalizeScopeType(input.scopeType);
    if (input.params !== undefined) params = normalizeObject(input.params);
  } catch (error) {
    return apiError('Override validation failed.', 422, error instanceof Error ? error.message : String(error));
  }

  const scopeKey = input.scopeKey === undefined ? current.scopeKey : normalizeScopeKey(input.scopeKey);
  const errors = await validateScopeKey(env.DB, publisherId, scopeType, scopeKey);
  if (errors.length) return apiError('Override validation failed.', 422, errors);

  const enabled = input.enabled === undefined ? current.enabled : Boolean(input.enabled);
  const actor = getActor(request);
  const now = new Date().toISOString();

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE bidder_overrides
           SET scope_type = ?, scope_key = ?, params_json = ?, enabled = ?, updated_at = ?
           WHERE publisher_id = ? AND id = ?`,
        )
        .bind(
          scopeType,
          scopeKey,
          JSON.stringify(params),
          enabled ? 1 : 0,
          now,
          publisherId,
          overrideId,
        ),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'bidder_override.updated', ?, 'bidder_override', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          publisherId,
          overrideId,
          JSON.stringify({ bidder: current.bidder, scopeType, scopeKey, enabled }),
          now,
        ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict
        ? `${current.bidder} already has a ${scopeType} override for "${scopeKey}".`
        : 'Override update failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  return json({ ok: true, override: await fetchOverride(env.DB, publisherId, overrideId) });
}

export async function duplicateBidderOverride(
  request: Request,
  env: DatabaseEnv,
  publisherId: string,
  sourceOverrideId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const source = await fetchOverride(env.DB, publisherId, sourceOverrideId);
  if (!source) return apiError('Source bidder override not found.', 404);

  let input: DuplicateBidderOverrideInput;
  try {
    input = await readJson<DuplicateBidderOverrideInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  let scopeType = source.scopeType;
  try {
    if (input.scopeType !== undefined) scopeType = normalizeScopeType(input.scopeType);
  } catch (error) {
    return apiError('Override validation failed.', 422, error instanceof Error ? error.message : String(error));
  }

  const scopeKey = normalizeScopeKey(input.scopeKey);
  const errors = await validateScopeKey(env.DB, publisherId, scopeType, scopeKey);
  if (errors.length) return apiError('Override validation failed.', 422, errors);

  const id = crypto.randomUUID();
  const enabled = input.enabled === undefined ? source.enabled : Boolean(input.enabled);
  const actor = getActor(request);
  const now = new Date().toISOString();

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO bidder_overrides (
             id, publisher_id, bidder, scope_type, scope_key, params_json, enabled,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          publisherId,
          source.bidder,
          scopeType,
          scopeKey,
          JSON.stringify(source.params),
          enabled ? 1 : 0,
          now,
          now,
        ),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'bidder_override.duplicated', ?, 'bidder_override', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          publisherId,
          id,
          JSON.stringify({ sourceOverrideId, bidder: source.bidder, scopeType, scopeKey }),
          now,
        ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict
        ? `${source.bidder} already has a ${scopeType} override for "${scopeKey}".`
        : 'Override duplication failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  return json({ ok: true, override: await fetchOverride(env.DB, publisherId, id) }, { status: 201 });
}

export async function deleteBidderOverride(
  request: Request,
  env: DatabaseEnv,
  publisherId: string,
  overrideId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const current = await fetchOverride(env.DB, publisherId, overrideId);
  if (!current) return apiError('Bidder override not found.', 404);

  const actor = getActor(request);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB
      .prepare('DELETE FROM bidder_overrides WHERE publisher_id = ? AND id = ?')
      .bind(publisherId, overrideId),
    env.DB
      .prepare(
        `INSERT INTO audit_log (
           id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
         ) VALUES (?, ?, 'bidder_override.deleted', ?, 'bidder_override', ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        actor,
        publisherId,
        overrideId,
        JSON.stringify({ bidder: current.bidder, scopeType: current.scopeType, scopeKey: current.scopeKey }),
        now,
      ),
  ]);

  return json({ ok: true, deletedId: overrideId });
}
