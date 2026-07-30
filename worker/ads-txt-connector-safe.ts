import {
  enableMockAdsTxtConnector,
  ensureAdsTxtConnectorTables,
  getAdsTxtConnectorStatus,
  getMockCmsAdsTxt,
  prepareMockAdsTxtVersion as prepareMockAdsTxtVersionBase,
  publishMockAdsTxtVersion as publishMockAdsTxtVersionBase,
  rollbackMockAdsTxtVersion as rollbackMockAdsTxtVersionBase,
  testMockAdsTxtConnector,
  type AdsTxtConnectorEnv,
} from './ads-txt-connector';
import { apiError, getActor, json } from './http';

export type { AdsTxtConnectorEnv } from './ads-txt-connector';
export {
  enableMockAdsTxtConnector,
  getAdsTxtConnectorStatus,
  getMockCmsAdsTxt,
  testMockAdsTxtConnector,
};

type ConnectorStateRow = {
  current_version_id: string | null;
  previous_version_id: string | null;
};

type ConnectorVersionRow = {
  id: string;
  version_number: number;
  checksum: string;
  status: string;
};

type ConnectorSettingsRow = {
  mode: string;
};

type PublishInput = {
  versionId?: unknown;
};

const CLAIM_TTL_MS = 2 * 60 * 1000;

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured.', 503);
}

async function ensureClaimTable(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_connector_claims (
    site_id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    action TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
  )`).run();
}

async function acquireClaim(db: D1Database, siteId: string, action: string): Promise<string | null> {
  await ensureClaimTable(db);
  const token = crypto.randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + CLAIM_TTL_MS).toISOString();

  await db.prepare(`INSERT INTO ads_txt_connector_claims (
      site_id, token, action, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_id) DO UPDATE SET
      token = excluded.token,
      action = excluded.action,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
    WHERE ads_txt_connector_claims.expires_at <= excluded.created_at`)
    .bind(siteId, token, action, expiresAt, nowIso, nowIso)
    .run();

  const row = await db.prepare(
    'SELECT token FROM ads_txt_connector_claims WHERE site_id = ? LIMIT 1',
  ).bind(siteId).first<{ token: string }>();
  return row?.token === token ? token : null;
}

async function releaseClaim(db: D1Database, siteId: string, token: string): Promise<void> {
  await db.prepare(
    'DELETE FROM ads_txt_connector_claims WHERE site_id = ? AND token = ?',
  ).bind(siteId, token).run();
}

async function withSiteClaim(
  env: AdsTxtConnectorEnv,
  siteId: string,
  action: string,
  operation: (db: D1Database) => Promise<Response>,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  await ensureAdsTxtConnectorTables(env.DB);
  const token = await acquireClaim(env.DB, siteId, action);
  if (!token) {
    return apiError('Another ads.txt connector action is already running for this site. Wait a moment and try again.', 409);
  }

  try {
    return await operation(env.DB);
  } finally {
    await releaseClaim(env.DB, siteId, token).catch(() => undefined);
  }
}

async function connectorState(db: D1Database, siteId: string): Promise<ConnectorStateRow | null> {
  return db.prepare(`SELECT current_version_id, previous_version_id
    FROM ads_txt_mock_cms_state WHERE site_id = ? LIMIT 1`)
    .bind(siteId)
    .first<ConnectorStateRow>();
}

async function connectorVersion(
  db: D1Database,
  siteId: string,
  versionId: string,
): Promise<ConnectorVersionRow | null> {
  return db.prepare(`SELECT id, version_number, checksum, status
    FROM ads_txt_connector_versions WHERE site_id = ? AND id = ? LIMIT 1`)
    .bind(siteId, versionId)
    .first<ConnectorVersionRow>();
}

async function latestPreparedVersion(db: D1Database, siteId: string): Promise<ConnectorVersionRow | null> {
  return db.prepare(`SELECT id, version_number, checksum, status
    FROM ads_txt_connector_versions
    WHERE site_id = ? AND status = 'prepared'
    ORDER BY version_number DESC LIMIT 1`)
    .bind(siteId)
    .first<ConnectorVersionRow>();
}

async function connectorSettings(db: D1Database, siteId: string): Promise<ConnectorSettingsRow | null> {
  return db.prepare('SELECT mode FROM ads_txt_connector_settings WHERE site_id = ? LIMIT 1')
    .bind(siteId)
    .first<ConnectorSettingsRow>();
}

function auditStatement(
  db: D1Database,
  actor: string,
  action: string,
  siteId: string,
  entityId: string,
  details: Record<string, unknown>,
  createdAt: string,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO audit_log (
    id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
  ) VALUES (?, ?, ?, ?, 'ads_txt_connector', ?, ?, ?)`)
    .bind(crypto.randomUUID(), actor, action, siteId, entityId, JSON.stringify(details), createdAt);
}

async function statusObject(request: Request, env: AdsTxtConnectorEnv, siteId: string): Promise<unknown> {
  const statusRequest = new Request(request.url, { headers: request.headers });
  const response = await getAdsTxtConnectorStatus(statusRequest, env, siteId);
  return response.json();
}

async function requestedVersionId(request: Request): Promise<string> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return '';
  try {
    const body = await request.clone().json() as PublishInput;
    return String(body.versionId ?? '').trim();
  } catch {
    return '';
  }
}

async function retireOtherPreparedVersions(
  db: D1Database,
  siteId: string,
  publishedVersionId: string,
): Promise<void> {
  await db.prepare(`UPDATE ads_txt_connector_versions
    SET status = 'superseded'
    WHERE site_id = ? AND status = 'prepared' AND id <> ?`)
    .bind(siteId, publishedVersionId)
    .run();
}

async function checksumHex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function prepareMockAdsTxtVersion(
  request: Request,
  env: AdsTxtConnectorEnv,
  siteId: string,
): Promise<Response> {
  return withSiteClaim(env, siteId, 'prepare', async () =>
    prepareMockAdsTxtVersionBase(request, env, siteId));
}

export async function publishMockAdsTxtVersion(
  request: Request,
  env: AdsTxtConnectorEnv,
  siteId: string,
): Promise<Response> {
  const baseRequest = request.clone();
  return withSiteClaim(env, siteId, 'publish', async (db) => {
    const explicitVersionId = await requestedVersionId(request);
    const version = explicitVersionId
      ? await connectorVersion(db, siteId, explicitVersionId)
      : await latestPreparedVersion(db, siteId);
    if (!version) return apiError('Prepare an ads.txt version before publishing.', 409);

    const state = await connectorState(db, siteId);
    if (state?.current_version_id === version.id) {
      await retireOtherPreparedVersions(db, siteId, version.id);
      const now = new Date().toISOString();
      await db.batch([
        auditStatement(db, getActor(request), 'ads_txt_connector.publish_idempotent', siteId, version.id, {
          versionNumber: version.version_number,
          checksum: version.checksum,
          preservedPreviousVersionId: state.previous_version_id,
        }, now),
      ]);
      return json({
        ok: true,
        action: {
          kind: 'publish',
          message: `Version ${version.version_number} is already published. The existing rollback target was preserved.`,
          versionId: version.id,
          alreadyApplied: true,
        },
        status: await statusObject(request, env, siteId),
      });
    }

    if (version.status !== 'prepared') {
      return apiError('Only a prepared ads.txt version can be published.', 409, {
        versionId: version.id,
        status: version.status,
      });
    }

    const response = await publishMockAdsTxtVersionBase(baseRequest, env, siteId);
    if (!response.ok) return response;

    const payload = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
    const nextState = await connectorState(db, siteId);
    if (nextState?.current_version_id) {
      await retireOtherPreparedVersions(db, siteId, nextState.current_version_id);
    }

    return json({
      ...(payload ?? { ok: true }),
      status: await statusObject(request, env, siteId),
    }, { status: response.status });
  });
}

export async function verifyMockAdsTxtVersion(
  request: Request,
  env: AdsTxtConnectorEnv,
  siteId: string,
): Promise<Response> {
  return withSiteClaim(env, siteId, 'verify', async (db) => {
    const settings = await connectorSettings(db, siteId);
    if (settings?.mode !== 'mock') return apiError('Enable the sandbox connector first.', 409);

    const state = await connectorState(db, siteId);
    if (!state?.current_version_id) return apiError('Publish a sandbox version before verification.', 409);
    const version = await connectorVersion(db, siteId, state.current_version_id);
    if (!version) return apiError('The current sandbox version could not be found.', 500);

    const endpoint = new URL(
      `/api/mock-cms/sites/${encodeURIComponent(siteId)}/ads.txt`,
      request.url,
    ).toString();

    let endpointResponse: Response | null = null;
    let publishedBody = '';
    let fetchError: string | null = null;
    try {
      endpointResponse = await fetch(endpoint, {
        method: 'GET',
        headers: { accept: 'text/plain' },
        cache: 'no-store',
      });
      publishedBody = await endpointResponse.text();
    } catch (error) {
      fetchError = error instanceof Error ? error.message : String(error);
    }

    const actualChecksum = endpointResponse?.ok ? await checksumHex(publishedBody) : null;
    const endpointVersionId = endpointResponse?.headers.get('x-tessera-version-id') ?? null;
    const verified = Boolean(
      endpointResponse?.ok
      && actualChecksum === version.checksum
      && endpointVersionId === version.id,
    );
    const actor = getActor(request);
    const now = new Date().toISOString();

    await db.batch([
      db.prepare(`UPDATE ads_txt_connector_settings
        SET last_verified_at = ?,
            last_verification_status = ?,
            last_verified_version_id = ?,
            updated_by = ?,
            updated_at = ?
        WHERE site_id = ?`)
        .bind(now, verified ? 'ok' : 'failed', version.id, actor, now, siteId),
      auditStatement(db, actor, 'ads_txt_connector.mock_verified_public_endpoint', siteId, version.id, {
        verified,
        endpoint,
        httpStatus: endpointResponse?.status ?? null,
        expectedChecksum: version.checksum,
        actualChecksum,
        expectedVersionId: version.id,
        endpointVersionId,
        fetchError,
      }, now),
    ]);

    return json({
      ok: verified,
      action: {
        kind: 'verify',
        message: verified
          ? `Verification passed for version ${version.version_number}. The public sandbox endpoint serves the expected file.`
          : `Verification failed for version ${version.version_number}.`,
        endpoint,
        httpStatus: endpointResponse?.status ?? null,
        expectedChecksum: version.checksum,
        actualChecksum,
        expectedVersionId: version.id,
        endpointVersionId,
        fetchError,
      },
      status: await statusObject(request, env, siteId),
    }, verified ? {} : { status: 409 });
  });
}

export async function rollbackMockAdsTxtVersion(
  request: Request,
  env: AdsTxtConnectorEnv,
  siteId: string,
): Promise<Response> {
  return withSiteClaim(env, siteId, 'rollback', async (db) => {
    const state = await connectorState(db, siteId);
    if (state?.current_version_id && state.current_version_id === state.previous_version_id) {
      return apiError('Rollback was blocked because current and previous publication IDs are identical.', 409);
    }
    return rollbackMockAdsTxtVersionBase(request, env, siteId);
  });
}
