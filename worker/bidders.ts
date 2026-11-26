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
import { normalizeBidderAccount, normalizeBidderAccounts } from '../shared/bidder-accounts/settings.mjs';
import { assertCompilerStrings } from './compiler-input-compatibility.mjs';
import { savedNoticedScriptApplies, savedScriptVersionLabels } from './site-runtime/script-version-guidance.mjs';

type BidderRow = {
  id: string;
  publisher_id: string;
  bidder: string;
  params_json: string;
  account_json?: string;
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
  assertCompilerStrings(value, field);
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
    ...normalizeBidderAccount(JSON.parse(row.account_json ?? '{}'), { bidder: row.bidder }),
    params: parseStoredObject(row.params_json),
    enabled: Boolean(row.enabled),
    overrides,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function validateAccountSet(db: D1Database, publisherId: string, account: ReturnType<typeof normalizeBidderAccount>, replacedId?: string): Promise<string | null> {
  const stored = await db.prepare('SELECT id, bidder, account_json FROM bidders WHERE publisher_id = ?').bind(publisherId).all<{id: string; bidder: string; account_json: string}>();
  const accounts = (stored.results ?? []).filter(row => row.id !== replacedId).map(row => normalizeBidderAccount(JSON.parse(row.account_json ?? '{}'), {bidder: row.bidder}));
  try {
    normalizeBidderAccounts([...accounts, account]);
  } catch (error) { return error instanceof Error ? error.message : String(error); }
  return null;
}

async function referencedSettings(db: D1Database, publisherId: string, bidder: string): Promise<string[]> {
  const row = await db.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1').bind(publisherId).first<{config_json: string}>();
  if (!row) return [];
  const config = JSON.parse(row.config_json) as Record<string, unknown>;
  const matches: string[] = [];
  const visit = (value: unknown, path: string) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((child, index) => { if (child === bidder) matches.push(`${path}[${index}]`); else visit(child, `${path}[${index}]`); }); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key === bidder || (key === 'bidder' && child === bidder)) matches.push(path + '.' + key);
      else visit(child, path + '.' + key);
    }
  };
  for (const key of ['runtimeControls', 'userSync', 'testPrebidPlan']) visit(config[key], key);
  return matches;
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
      `SELECT id, publisher_id, bidder, params_json, account_json, enabled, created_at, updated_at
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
      `SELECT id, publisher_id, bidder, params_json, account_json, enabled, created_at, updated_at
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

  // The script versions the account form names: bidder accounts together with the site's other saved options.
  const config = await env.DB.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1').bind(publisherId).first<{config_json: string}>();
  const saved = {config: {config_json: config?.config_json ?? '{}'}, bidders: bidderResult.results ?? []};
  const accountScriptVersions = savedScriptVersionLabels('bidder-accounts', saved);
  // Whether a version with a runtime notice applies them: it is never named, but stays selectable in Script setup.
  const accountNoticedScriptApplies = savedNoticedScriptApplies('bidder-accounts', saved);

  return json({
    ok: true,
    bidders: (bidderResult.results ?? []).map((row) =>
      toBidder(row, overridesByBidder.get(row.bidder) ?? []),
    ),
    accountScriptVersions,
    accountNoticedScriptApplies,
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
  let account;
  try {
    account = normalizeBidderAccount({ baseAdapter: input.baseAdapter, displayName: input.displayName, schain: input.schain }, { bidder: bidderName });
    params = normalizeObject(input.params);
  } catch (error) {
    return apiError('Bidder validation failed.', 422, error instanceof Error ? error.message : String(error));
  }

  const accountError = await validateAccountSet(env.DB, publisherId, account);
  if (accountError) return apiError('Bidder validation failed.', 422, accountError);
  const id = crypto.randomUUID();
  const enabled = input.enabled === false ? 0 : 1;
  const actor = getActor(request);
  const now = new Date().toISOString();

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO bidders (
             id, publisher_id, bidder, params_json, account_json, enabled, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, publisherId, bidderName, JSON.stringify(params), JSON.stringify(account), enabled, now, now),
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
          JSON.stringify({ bidder: bidderName, enabled: Boolean(enabled), baseAdapter: account.baseAdapter, schainMode: account.schain.mode }),
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

  let account;
  try { account = normalizeBidderAccount({ baseAdapter: input.baseAdapter ?? current.baseAdapter ?? current.bidder, displayName: input.displayName ?? current.displayName ?? '', schain: input.schain ?? current.schain ?? {mode:'inherit'} }, {bidder: bidderName}); }
  catch (error) { return apiError('Bidder validation failed.', 422, error instanceof Error ? error.message : String(error)); }
  const accountError = await validateAccountSet(env.DB, publisherId, account, bidderId);
  if (accountError) return apiError('Bidder validation failed.', 422, accountError);
  if (bidderName !== current.bidder) {
    const references = await referencedSettings(env.DB, publisherId, current.bidder);
    if (references.length) return apiError('Update these references before renaming this bidder.', 409, references);
  }
  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== current.updatedAt) return apiError('This bidder changed in another tab. Reload before saving.', 409);
  const enabled = input.enabled === undefined ? current.enabled : Boolean(input.enabled);
  const actor = getActor(request);
  const now = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString();

  try {
    const result = await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE bidders
           SET bidder = ?, params_json = ?, account_json = ?, enabled = ?, updated_at = ?
           WHERE publisher_id = ? AND id = ? AND updated_at = ?`,
        )
        .bind(bidderName, JSON.stringify(params), JSON.stringify(account), enabled ? 1 : 0, now, publisherId, bidderId, current.updatedAt),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) SELECT ?, ?, 'bidder.updated', ?, 'bidder', ?, ?, ? WHERE changes() = 1`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          publisherId,
          bidderId,
          JSON.stringify({ previousBidder: current.bidder, bidder: bidderName, enabled, baseAdapter: account.baseAdapter, schainMode: account.schain.mode }),
          now,
        ),
      env.DB
        .prepare(
          `UPDATE bidder_overrides
           SET bidder = ?, updated_at = ?
           WHERE publisher_id = ? AND bidder = ? AND changes() = 1`,
        )
        .bind(bidderName, now, publisherId, current.bidder),
    ]);
    if (result[0]?.meta?.changes !== 1) return apiError('This bidder changed in another tab. Reload before saving.', 409);
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

  let account;
  try { account = normalizeBidderAccount({ baseAdapter: input.baseAdapter ?? source.baseAdapter ?? source.bidder, displayName: input.displayName ?? source.displayName ?? '', schain: input.schain ?? source.schain ?? {mode:'inherit'} }, {bidder: bidderName}); }
  catch (error) { return apiError('Bidder validation failed.', 422, error instanceof Error ? error.message : String(error)); }
  const accountError = await validateAccountSet(env.DB, publisherId, account);
  if (accountError) return apiError('Bidder validation failed.', 422, accountError);
  const id = crypto.randomUUID();
  const enabled = input.enabled === undefined ? source.enabled : Boolean(input.enabled);
  const actor = getActor(request);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        `INSERT INTO bidders (
           id, publisher_id, bidder, params_json, account_json, enabled, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, publisherId, bidderName, JSON.stringify(source.params), JSON.stringify(account), enabled ? 1 : 0, now, now),
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
        JSON.stringify({ sourceBidder: source.bidder, bidder: bidderName, baseAdapter: account.baseAdapter, schainMode: account.schain.mode, copyOverrides: input.copyOverrides !== false }),
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
  const references = await referencedSettings(env.DB, publisherId, current.bidder);
  if (references.length) return apiError('Remove this bidder from these settings before deleting it.', 409, references);

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
