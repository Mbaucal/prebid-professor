import { encryptToken } from './gmail-oauth';
import { apiError, getActor, json, readJson } from './http';
import type { DatabaseEnv } from './publishers';

export interface AdsTxtRealConnectorEnv extends DatabaseEnv {
  ADS_TXT_CONNECTOR_ENCRYPTION_KEY?: string;
  GMAIL_TOKEN_ENCRYPTION_KEY?: string;
}

type ConnectorRow = {
  site_id: string;
  endpoint_url: string;
  method: string;
  auth_type: string;
  auth_header: string | null;
  credential_encrypted: string | null;
  enabled: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

type ConnectorInput = {
  endpointUrl?: unknown;
  method?: unknown;
  authType?: unknown;
  authHeader?: unknown;
  credential?: unknown;
  enabled?: unknown;
};

const CONNECTOR_CLAIM_TTL_MS = 2 * 60 * 1000;
let tablesReady: Promise<void> | null = null;

async function ensureTables(db: D1Database): Promise<void> {
  if (!tablesReady) {
    tablesReady = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_real_connectors (
        site_id TEXT PRIMARY KEY,
        endpoint_url TEXT NOT NULL,
        method TEXT NOT NULL CHECK (method IN ('POST', 'PUT')),
        auth_type TEXT NOT NULL CHECK (auth_type IN ('none', 'bearer', 'api_key')),
        auth_header TEXT,
        credential_encrypted TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_real_connector_claims (
        site_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
      )`),
    ]).then(() => undefined).catch((error) => {
      tablesReady = null;
      throw error;
    });
  }
  await tablesReady;
}

function encryptionSecret(env: AdsTxtRealConnectorEnv): string {
  return env.ADS_TXT_CONNECTOR_ENCRYPTION_KEY
    || env.GMAIL_TOKEN_ENCRYPTION_KEY
    || '';
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1')
    .bind(siteId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function connectorRow(db: D1Database, siteId: string): Promise<ConnectorRow | null> {
  return db.prepare(`SELECT site_id, endpoint_url, method, auth_type, auth_header,
      credential_encrypted, enabled, updated_by, created_at, updated_at
    FROM ads_txt_real_connectors WHERE site_id = ? LIMIT 1`)
    .bind(siteId)
    .first<ConnectorRow>();
}

async function acquireConnectorClaim(db: D1Database, siteId: string): Promise<string | null> {
  const token = crypto.randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + CONNECTOR_CLAIM_TTL_MS).toISOString();

  await db.prepare(`INSERT INTO ads_txt_real_connector_claims (
      site_id, token, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(site_id) DO UPDATE SET
      token = excluded.token,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
    WHERE ads_txt_real_connector_claims.expires_at <= excluded.created_at`)
    .bind(siteId, token, expiresAt, nowIso, nowIso)
    .run();

  const row = await db.prepare(
    'SELECT token FROM ads_txt_real_connector_claims WHERE site_id = ? LIMIT 1',
  ).bind(siteId).first<{ token: string }>();
  return row?.token === token ? token : null;
}

async function releaseConnectorClaim(
  db: D1Database,
  siteId: string,
  token: string,
): Promise<void> {
  await db.prepare(
    'DELETE FROM ads_txt_real_connector_claims WHERE site_id = ? AND token = ?',
  ).bind(siteId, token).run();
}

function claimedAuditStatement(
  db: D1Database,
  actor: string,
  action: string,
  siteId: string,
  details: Record<string, unknown>,
  createdAt: string,
  claimToken: string,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO audit_log (
      id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
    )
    SELECT ?, ?, ?, ?, 'ads_txt_connector', ?, ?, ?
    FROM ads_txt_real_connector_claims
    WHERE site_id = ? AND token = ?`)
    .bind(
      crypto.randomUUID(),
      actor,
      action,
      siteId,
      siteId,
      JSON.stringify(details),
      createdAt,
      siteId,
      claimToken,
    );
}

function publicConfig(row: ConnectorRow | null) {
  return row ? {
    configured: true,
    endpointUrl: row.endpoint_url,
    method: row.method,
    authType: row.auth_type,
    authHeader: row.auth_header ?? '',
    credentialSet: Boolean(row.credential_encrypted),
    enabled: row.enabled === 1,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : {
    configured: false,
    endpointUrl: '',
    method: 'PUT',
    authType: 'bearer',
    authHeader: 'Authorization',
    credentialSet: false,
    enabled: false,
    updatedBy: null,
    createdAt: null,
    updatedAt: null,
  };
}

function normalizedEndpoint(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('Endpoint URL is required.');
  if (raw.length > 2_048) throw new Error('Endpoint URL is too long.');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Endpoint URL is not valid.');
  }

  if (url.protocol !== 'https:') throw new Error('Endpoint URL must use HTTPS.');
  if (url.username || url.password) throw new Error('Do not include credentials in the endpoint URL.');
  url.hash = '';
  return url.toString();
}

function normalizedMethod(value: unknown): 'POST' | 'PUT' {
  const method = String(value ?? 'PUT').trim().toUpperCase();
  if (method !== 'POST' && method !== 'PUT') throw new Error('Method must be POST or PUT.');
  return method;
}

function normalizedAuthType(value: unknown): 'none' | 'bearer' | 'api_key' {
  const authType = String(value ?? 'bearer').trim().toLowerCase();
  if (!['none', 'bearer', 'api_key'].includes(authType)) {
    throw new Error('Authorization type is not supported.');
  }
  return authType as 'none' | 'bearer' | 'api_key';
}

function normalizedAuthHeader(authType: string, value: unknown): string {
  if (authType === 'none') return '';
  const fallback = authType === 'bearer' ? 'Authorization' : 'X-API-Key';
  const header = String(value ?? '').trim() || fallback;
  if (header.length > 120 || !/^[A-Za-z0-9-]+$/.test(header)) {
    throw new Error('Authorization header name is not valid.');
  }
  return header;
}

async function ready(env: AdsTxtRealConnectorEnv, siteId: string): Promise<D1Database | Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);
  await ensureTables(env.DB);
  if (!await siteExists(env.DB, siteId)) return apiError('Site not found.', 404);
  return env.DB;
}

export async function getAdsTxtRealConnector(
  env: AdsTxtRealConnectorEnv,
  siteId: string,
): Promise<Response> {
  const db = await ready(env, siteId);
  if (db instanceof Response) return db;
  return json({ ok: true, connection: publicConfig(await connectorRow(db, siteId)) });
}

export async function saveAdsTxtRealConnector(
  request: Request,
  env: AdsTxtRealConnectorEnv,
  siteId: string,
): Promise<Response> {
  const db = await ready(env, siteId);
  if (db instanceof Response) return db;

  let input: ConnectorInput;
  try {
    input = await readJson<ConnectorInput>(request);
  } catch (error) {
    return apiError(
      'Connection settings are not valid JSON.',
      400,
      error instanceof Error ? error.message : String(error),
    );
  }

  let endpointUrl: string;
  let method: 'POST' | 'PUT';
  let authType: 'none' | 'bearer' | 'api_key';
  let authHeader: string;
  try {
    endpointUrl = normalizedEndpoint(input.endpointUrl);
    method = normalizedMethod(input.method);
    authType = normalizedAuthType(input.authType);
    authHeader = normalizedAuthHeader(authType, input.authHeader);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Connection settings are invalid.', 422);
  }

  const credential = String(input.credential ?? '').trim();
  if (credential.length > 8_192) return apiError('Credential is too long.', 422);
  if (authType !== 'none' && !credential) {
    return apiError('Enter the Bearer token or API key every time you save the connection.', 422);
  }

  const claimToken = await acquireConnectorClaim(db, siteId);
  if (!claimToken) {
    return apiError('Another CMS connection change is already in progress for this site.', 409);
  }

  try {
    const existing = await connectorRow(db, siteId);
    let credentialEncrypted: string | null = null;
    if (authType !== 'none') {
      const secret = encryptionSecret(env);
      if (!secret) {
        return apiError('Credential encryption is not configured on the Worker.', 503);
      }
      credentialEncrypted = await encryptToken(secret, credential);
    }

    const now = new Date().toISOString();
    const actor = getActor(request);
    const enabled = input.enabled === false ? 0 : 1;
    const [writeResult] = await db.batch([
      db.prepare(`INSERT INTO ads_txt_real_connectors (
          site_id, endpoint_url, method, auth_type, auth_header, credential_encrypted,
          enabled, updated_by, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM ads_txt_real_connector_claims
        WHERE site_id = ? AND token = ?
        ON CONFLICT(site_id) DO UPDATE SET
          endpoint_url = excluded.endpoint_url,
          method = excluded.method,
          auth_type = excluded.auth_type,
          auth_header = excluded.auth_header,
          credential_encrypted = excluded.credential_encrypted,
          enabled = excluded.enabled,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at`)
        .bind(
          siteId,
          endpointUrl,
          method,
          authType,
          authHeader || null,
          credentialEncrypted,
          enabled,
          actor,
          existing?.created_at ?? now,
          now,
          siteId,
          claimToken,
        ),
      claimedAuditStatement(db, actor, 'ads_txt_connector.connection_saved', siteId, {
        endpointUrl,
        method,
        authType,
        authHeader: authHeader || null,
        credentialChanged: authType !== 'none',
        credentialRequiredOnEverySave: authType !== 'none',
        enabled: enabled === 1,
      }, now, claimToken),
    ]);

    if ((writeResult.meta?.changes ?? 0) < 1) {
      return apiError('The CMS connection change expired before it could be saved. Try again.', 409);
    }

    return json({
      ok: true,
      message: 'CMS connection saved.',
      connection: publicConfig(await connectorRow(db, siteId)),
    });
  } finally {
    await releaseConnectorClaim(db, siteId, claimToken).catch(() => undefined);
  }
}

export async function deleteAdsTxtRealConnector(
  request: Request,
  env: AdsTxtRealConnectorEnv,
  siteId: string,
): Promise<Response> {
  const db = await ready(env, siteId);
  if (db instanceof Response) return db;

  const claimToken = await acquireConnectorClaim(db, siteId);
  if (!claimToken) {
    return apiError('Another CMS connection change is already in progress for this site.', 409);
  }

  try {
    const existing = await connectorRow(db, siteId);
    if (!existing) return json({ ok: true, deleted: false });

    const now = new Date().toISOString();
    const actor = getActor(request);
    const [deleteResult] = await db.batch([
      db.prepare(`DELETE FROM ads_txt_real_connectors
        WHERE site_id = ?
          AND EXISTS (
            SELECT 1 FROM ads_txt_real_connector_claims
            WHERE site_id = ? AND token = ?
          )`)
        .bind(siteId, siteId, claimToken),
      claimedAuditStatement(db, actor, 'ads_txt_connector.connection_deleted', siteId, {
        endpointUrl: existing.endpoint_url,
        method: existing.method,
        authType: existing.auth_type,
      }, now, claimToken),
    ]);

    if ((deleteResult.meta?.changes ?? 0) < 1) {
      return apiError('The CMS connection change expired before it could be removed. Try again.', 409);
    }
    return json({ ok: true, deleted: true });
  } finally {
    await releaseConnectorClaim(db, siteId, claimToken).catch(() => undefined);
  }
}
