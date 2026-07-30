import { apiError, getActor, json, readJson } from './http';
import type { DatabaseEnv } from './publishers';

export interface AdsTxtConnectorEnv extends DatabaseEnv {}

type SiteRow = {
  id: string;
  name: string;
  domain: string;
};

type RequirementRow = {
  source_label: string | null;
  entry: string;
  required: number;
};

type SettingsRow = {
  site_id: string;
  mode: string;
  last_tested_at: string | null;
  last_test_status: string | null;
  last_verified_at: string | null;
  last_verification_status: string | null;
  last_verified_version_id: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

type VersionRow = {
  id: string;
  site_id: string;
  version_number: number;
  content: string;
  checksum: string;
  line_count: number;
  entry_count: number;
  status: string;
  created_by: string | null;
  created_at: string;
  published_at: string | null;
};

type MockStateRow = {
  site_id: string;
  current_version_id: string | null;
  previous_version_id: string | null;
  content: string;
  checksum: string | null;
  updated_at: string;
};

type PublishInput = {
  versionId?: unknown;
};

const MAX_GENERATED_BYTES = 2 * 1024 * 1024;
let tablesReady: Promise<void> | null = null;

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured.', 503);
}

async function createTables(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_connector_settings (
      site_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'disabled',
      last_tested_at TEXT,
      last_test_status TEXT,
      last_verified_at TEXT,
      last_verification_status TEXT,
      last_verified_version_id TEXT,
      updated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_connector_versions (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      content TEXT NOT NULL,
      checksum TEXT NOT NULL,
      line_count INTEGER NOT NULL DEFAULT 0,
      entry_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'prepared',
      created_by TEXT,
      created_at TEXT NOT NULL,
      published_at TEXT,
      UNIQUE (site_id, version_number),
      FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_mock_cms_state (
      site_id TEXT PRIMARY KEY,
      current_version_id TEXT,
      previous_version_id TEXT,
      content TEXT NOT NULL DEFAULT '',
      checksum TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
    )`),
  ]);

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_ads_txt_connector_versions_site
    ON ads_txt_connector_versions(site_id, version_number DESC)`).run();
}

export async function ensureAdsTxtConnectorTables(db: D1Database): Promise<void> {
  if (!tablesReady) {
    tablesReady = createTables(db).catch((error) => {
      tablesReady = null;
      throw error;
    });
  }
  await tablesReady;
}

async function siteRow(db: D1Database, siteId: string): Promise<SiteRow | null> {
  return db.prepare('SELECT id, name, domain FROM publishers WHERE id = ? LIMIT 1')
    .bind(siteId)
    .first<SiteRow>();
}

async function requireSite(db: D1Database, siteId: string): Promise<SiteRow> {
  const site = await siteRow(db, siteId);
  if (!site) throw new Error('Site not found.');
  return site;
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

async function checksumHex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function safeLabel(value: string | null | undefined): string {
  return String(value ?? '').trim().replace(/^#+\s*/, '').slice(0, 120) || 'Other';
}

function buildAdsTxt(requirements: RequirementRow[]): string {
  const groups = new Map<string, string[]>();
  for (const requirement of requirements) {
    const entry = requirement.entry.trim();
    if (!entry) continue;
    const label = safeLabel(requirement.source_label);
    groups.set(label, [...(groups.get(label) ?? []), entry]);
  }

  const body = Array.from(groups.entries())
    .map(([label, entries]) => `# ${label}\n${entries.join('\n')}`)
    .join('\n\n');
  return body ? `${body}\n` : '';
}

function lineCount(content: string): number {
  if (!content) return 0;
  return content.replace(/\n$/, '').split(/\r?\n/).length;
}

function toVersion(row: VersionRow | null | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    versionNumber: row.version_number,
    checksum: row.checksum,
    lineCount: row.line_count,
    entryCount: row.entry_count,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

async function settingsRow(db: D1Database, siteId: string): Promise<SettingsRow | null> {
  return db.prepare(`SELECT site_id, mode, last_tested_at, last_test_status,
      last_verified_at, last_verification_status, last_verified_version_id,
      updated_by, created_at, updated_at
    FROM ads_txt_connector_settings WHERE site_id = ? LIMIT 1`)
    .bind(siteId)
    .first<SettingsRow>();
}

async function versionRow(db: D1Database, siteId: string, versionId: string): Promise<VersionRow | null> {
  return db.prepare(`SELECT id, site_id, version_number, content, checksum, line_count,
      entry_count, status, created_by, created_at, published_at
    FROM ads_txt_connector_versions
    WHERE site_id = ? AND id = ? LIMIT 1`)
    .bind(siteId, versionId)
    .first<VersionRow>();
}

async function latestPreparedVersion(db: D1Database, siteId: string): Promise<VersionRow | null> {
  return db.prepare(`SELECT id, site_id, version_number, content, checksum, line_count,
      entry_count, status, created_by, created_at, published_at
    FROM ads_txt_connector_versions
    WHERE site_id = ? AND status = 'prepared'
    ORDER BY version_number DESC LIMIT 1`)
    .bind(siteId)
    .first<VersionRow>();
}

async function mockStateRow(db: D1Database, siteId: string): Promise<MockStateRow | null> {
  return db.prepare(`SELECT site_id, current_version_id, previous_version_id, content, checksum, updated_at
    FROM ads_txt_mock_cms_state WHERE site_id = ? LIMIT 1`)
    .bind(siteId)
    .first<MockStateRow>();
}

async function statusPayload(request: Request, db: D1Database, siteId: string) {
  const site = await requireSite(db, siteId);
  const [settings, state, prepared, versionResult, requirementCountRow] = await Promise.all([
    settingsRow(db, siteId),
    mockStateRow(db, siteId),
    latestPreparedVersion(db, siteId),
    db.prepare(`SELECT id, site_id, version_number, content, checksum, line_count,
        entry_count, status, created_by, created_at, published_at
      FROM ads_txt_connector_versions
      WHERE site_id = ? ORDER BY version_number DESC LIMIT 10`)
      .bind(siteId)
      .all<VersionRow>(),
    db.prepare('SELECT COUNT(*) AS count FROM ads_txt_requirements WHERE publisher_id = ?')
      .bind(siteId)
      .first<{ count: number }>(),
  ]);

  const versions = versionResult.results ?? [];
  const current = state?.current_version_id
    ? versions.find((version) => version.id === state.current_version_id)
      ?? await versionRow(db, siteId, state.current_version_id)
    : null;
  const previous = state?.previous_version_id
    ? versions.find((version) => version.id === state.previous_version_id)
      ?? await versionRow(db, siteId, state.previous_version_id)
    : null;
  const endpoint = `${new URL(request.url).origin}/api/mock-cms/sites/${encodeURIComponent(siteId)}/ads.txt`;

  return {
    ok: true as const,
    site,
    sandbox: {
      mode: settings?.mode ?? 'disabled',
      enabled: settings?.mode === 'mock',
      endpoint,
      lastTestedAt: settings?.last_tested_at ?? null,
      lastTestStatus: settings?.last_test_status ?? null,
      lastVerifiedAt: settings?.last_verified_at ?? null,
      lastVerificationStatus: settings?.last_verification_status ?? null,
      lastVerifiedVersionId: settings?.last_verified_version_id ?? null,
      updatedBy: settings?.updated_by ?? null,
      updatedAt: settings?.updated_at ?? null,
      warning: 'Sandbox only. This endpoint never changes the publisher live ads.txt file.',
    },
    requirements: {
      count: Number(requirementCountRow?.count ?? 0),
    },
    preparedVersion: toVersion(prepared),
    currentPublication: toVersion(current),
    previousPublication: toVersion(previous),
    mockState: state ? {
      currentVersionId: state.current_version_id,
      previousVersionId: state.previous_version_id,
      checksum: state.checksum,
      updatedAt: state.updated_at,
      hasContent: Boolean(state.content),
    } : null,
    versions: versions.map(toVersion),
  };
}

async function requireDatabaseAndSite(
  env: AdsTxtConnectorEnv,
  siteId: string,
): Promise<{ db: D1Database; site: SiteRow } | Response> {
  if (!env.DB) return databaseMissing();
  await ensureAdsTxtConnectorTables(env.DB);
  const site = await siteRow(env.DB, siteId);
  if (!site) return apiError('Site not found.', 404);
  return { db: env.DB, site };
}

export async function getAdsTxtConnectorStatus(
  request: Request,
  env: AdsTxtConnectorEnv,
  siteId: string,
): Promise<Response> {
  const ready = await requireDatabaseAndSite(env, siteId);
  if (ready instanceof Response) return ready;
  return json(await statusPayload(request, ready.db, siteId));
}

export async function enableMockAdsTxtConnector(
  request: Request,
  env: AdsTxtConnectorEnv,
  siteId: string,
): Promise<Response> {
  const ready = await requireDatabaseAndSite(env, siteId);
  if (ready instanceof Response) return ready;
  const actor = getActor(request);
  const now = new Date().toISOString();
  await ready.db.batch([
    ready.db.prepare(`INSERT INTO ads_txt_connector_settings (
        site_id, mode, updated_by, created_at, updated_at
      ) VALUES (?, 'mock', ?, ?, ?)
      ON CONFLICT(site_id) DO UPDATE SET
        mode = 'mock',
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at`)
      .bind(siteId, actor, now, now),
    auditStatement(ready.db, actor, 'ads_txt_connector.mock_enabled', siteId, siteId, {
      mode: 'mock',
    }, now),
  ]);
  return json({
    ok: true,
    action: { kind: 'enable', message: 'The sandbox connector is enabled for this site.' },
    status: await statusPayload(request, ready.db, siteId),
  });
}

export async function testMockAdsTxtConnector(
  request: Request,
  env: AdsTxtConnectorEnv,
  siteId: string,
): Promise<Response> {
  const ready = await requireDatabaseAndSite(env, siteId);
  if (ready instanceof Response) return ready;
  const settings = await settingsRow(ready.db, siteId);
  if (settings?.mode !== 'mock') return apiError('Enable the sandbox connector first.', 409);

  const startedAt = Date.now();
  await ready.db.prepare('SELECT 1 AS ok').first();
  const latencyMs = Math.max(1, Date.now() - startedAt);
  const actor = getActor(request);
  const now = new Date().toISOString();
  await ready.db.batch([
    ready.db.prepare(`UPDATE ads_txt_connector_settings
      SET last_tested_at = ?, last_test_status = 'ok', updated_by = ?, updated_at = ?
      WHERE site_id = ?`)
      .bind(now, actor, now, siteId),
    auditStatement(ready.db, actor, 'ads_txt_connector.connection_tested', siteId, siteId, {
      mode: 'mock', latencyMs, result: 'ok',
    }, now),
  ]);

  return json({
    ok: true,
    action: {
      kind: 'test',
      message: 'Connection successful. The mock CMS endpoint is ready.',
      latencyMs,
    },
    status: await statusPayload(request, ready.db, siteId),
  });
}

export async function prepareMockAdsTxtVersion(
  request: Request,
  env: AdsTxtConnectorEnv,
  siteId: string,
): Promise<Response> {
  const ready = await requireDatabaseAndSite(env, siteId);
  if (ready instanceof Response) return ready;
  const settings = await settingsRow(ready.db, siteId);
  if (settings?.mode !== 'mock') return apiError('Enable the sandbox connector first.', 409);

  const result = await ready.db.prepare(`SELECT source_label, entry, required
    FROM ads_txt_requirements
    WHERE publisher_id = ?
    ORDER BY source_label COLLATE NOCASE, entry COLLATE NOCASE, id`)
    .bind(siteId)
    .all<RequirementRow>();
  const requirements = result.results ?? [];
  if (!requirements.length) return apiError('Add at least one saved ads.txt requirement before preparing a version.', 422);

  const content = buildAdsTxt(requirements);
  if (new TextEncoder().encode(content).byteLength > MAX_GENERATED_BYTES) {
    return apiError('The generated ads.txt version is larger than 2 MB.', 422);
  }
  const checksum = await checksumHex(content);
  const existing = await ready.db.prepare(`SELECT id, site_id, version_number, content, checksum,
      line_count, entry_count, status, created_by, created_at, published_at
    FROM ads_txt_connector_versions
    WHERE site_id = ? AND checksum = ? AND status = 'prepared'
    ORDER BY version_number DESC LIMIT 1`)
    .bind(siteId, checksum)
    .first<VersionRow>();

  if (existing) {
    return json({
      ok: true,
      action: {
        kind: 'prepare',
        message: `Version ${existing.version_number} already contains the current saved requirements.`,
        reused: true,
      },
      status: await statusPayload(request, ready.db, siteId),
    });
  }

  const nextRow = await ready.db.prepare(`SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number
    FROM ads_txt_connector_versions WHERE site_id = ?`)
    .bind(siteId)
    .first<{ next_number: number }>();
  const versionNumber = Number(nextRow?.next_number ?? 1);
  const versionId = `ads-${siteId}-${String(versionNumber).padStart(4, '0')}-${crypto.randomUUID().slice(0, 8)}`;
  const actor = getActor(request);
  const now = new Date().toISOString();
  await ready.db.batch([
    ready.db.prepare(`INSERT INTO ads_txt_connector_versions (
      id, site_id, version_number, content, checksum, line_count, entry_count,
      status, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`)
      .bind(
        versionId,
        siteId,
        versionNumber,
        content,
        checksum,
        lineCount(content),
        requirements.length,
        actor,
        now,
      ),
    auditStatement(ready.db, actor, 'ads_txt_connector.version_prepared', siteId, versionId, {
      versionNumber,
      checksum,
      lineCount: lineCount(content),
      entryCount: requirements.length,
    }, now),
  ]);

  return json({
    ok: true,
    action: {
      kind: 'prepare',
      message: `Prepared version ${versionNumber} from ${requirements.length} saved requirement(s).`,
      versionId,
      checksum,
    },
    status: await statusPayload(request, ready.db, siteId),
  });
}

async function optionalPublishInput(request: Request): Promise<PublishInput> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return {};
  try {
    return await readJson<PublishInput>(request);
  } catch {
    return {};
  }
}

export async function publishMockAdsTxtVersion(
  request: Request,
  env: AdsTxtConnectorEnv,
  siteId: string,
): Promise<Response> {
  const ready = await requireDatabaseAndSite(env, siteId);
  if (ready instanceof Response) return ready;
  const settings = await settingsRow(ready.db, siteId);
  if (settings?.mode !== 'mock') return apiError('Enable the sandbox connector first.', 409);

  const input = await optionalPublishInput(request);
  const requestedVersionId = String(input.versionId ?? '').trim();
  const version = requestedVersionId
    ? await versionRow(ready.db, siteId, requestedVersionId)
    : await latestPreparedVersion(ready.db, siteId);
  if (!version) return apiError('Prepare an ads.txt version before publishing.', 409);

  const state = await mockStateRow(ready.db, siteId);
  const actor = getActor(request);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (state?.current_version_id && state.current_version_id !== version.id) {
    statements.push(ready.db.prepare(`UPDATE ads_txt_connector_versions
      SET status = 'superseded' WHERE site_id = ? AND id = ?`)
      .bind(siteId, state.current_version_id));
  }
  statements.push(
    ready.db.prepare(`UPDATE ads_txt_connector_versions
      SET status = 'published', published_at = ? WHERE site_id = ? AND id = ?`)
      .bind(now, siteId, version.id),
    ready.db.prepare(`INSERT INTO ads_txt_mock_cms_state (
      site_id, current_version_id, previous_version_id, content, checksum, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_id) DO UPDATE SET
      current_version_id = excluded.current_version_id,
      previous_version_id = ads_txt_mock_cms_state.current_version_id,
      content = excluded.content,
      checksum = excluded.checksum,
      updated_at = excluded.updated_at`)
      .bind(siteId, version.id, state?.current_version_id ?? null, version.content, version.checksum, now),
    ready.db.prepare(`UPDATE ads_txt_connector_settings
      SET last_verified_at = NULL,
          last_verification_status = 'pending',
          last_verified_version_id = NULL,
          updated_by = ?,
          updated_at = ?
      WHERE site_id = ?`)
      .bind(actor, now, siteId),
    auditStatement(ready.db, actor, 'ads_txt_connector.mock_published', siteId, version.id, {
      versionNumber: version.version_number,
      checksum: version.checksum,
      previousVersionId: state?.current_version_id ?? null,
    }, now),
  );
  await ready.db.batch(statements);

  return json({
    ok: true,
    action: {
      kind: 'publish',
      message: `Published version ${version.version_number} to the sandbox endpoint. The live publisher site was not changed.`,
      versionId: version.id,
    },
    status: await statusPayload(request, ready.db, siteId),
  });
}

export async function verifyMockAdsTxtVersion(
  request: Request,
  env: AdsTxtConnectorEnv,
  siteId: string,
): Promise<Response> {
  const ready = await requireDatabaseAndSite(env, siteId);
  if (ready instanceof Response) return ready;
  const settings = await settingsRow(ready.db, siteId);
  if (settings?.mode !== 'mock') return apiError('Enable the sandbox connector first.', 409);

  const state = await mockStateRow(ready.db, siteId);
  if (!state?.current_version_id) return apiError('Publish a sandbox version before verification.', 409);
  const version = await versionRow(ready.db, siteId, state.current_version_id);
  if (!version) return apiError('The current sandbox version could not be found.', 500);

  const actualChecksum = await checksumHex(state.content);
  const verified = actualChecksum === version.checksum && state.checksum === version.checksum;
  const actor = getActor(request);
  const now = new Date().toISOString();
  await ready.db.batch([
    ready.db.prepare(`UPDATE ads_txt_connector_settings
      SET last_verified_at = ?,
          last_verification_status = ?,
          last_verified_version_id = ?,
          updated_by = ?,
          updated_at = ?
      WHERE site_id = ?`)
      .bind(now, verified ? 'ok' : 'failed', version.id, actor, now, siteId),
    auditStatement(ready.db, actor, 'ads_txt_connector.mock_verified', siteId, version.id, {
      verified,
      expectedChecksum: version.checksum,
      actualChecksum,
    }, now),
  ]);

  return json({
    ok: verified,
    action: {
      kind: 'verify',
      message: verified
        ? `Verification passed for version ${version.version_number}.`
        : `Verification failed for version ${version.version_number}.`,
      expectedChecksum: version.checksum,
      actualChecksum,
    },
    status: await statusPayload(request, ready.db, siteId),
  }, verified ? {} : { status: 409 });
}

export async function rollbackMockAdsTxtVersion(
  request: Request,
  env: AdsTxtConnectorEnv,
  siteId: string,
): Promise<Response> {
  const ready = await requireDatabaseAndSite(env, siteId);
  if (ready instanceof Response) return ready;
  const settings = await settingsRow(ready.db, siteId);
  if (settings?.mode !== 'mock') return apiError('Enable the sandbox connector first.', 409);

  const state = await mockStateRow(ready.db, siteId);
  if (!state?.current_version_id || !state.previous_version_id) {
    return apiError('There is no previous sandbox publication to restore.', 409);
  }
  const target = await versionRow(ready.db, siteId, state.previous_version_id);
  if (!target) return apiError('The previous sandbox version could not be found.', 500);

  const actor = getActor(request);
  const now = new Date().toISOString();
  await ready.db.batch([
    ready.db.prepare(`UPDATE ads_txt_connector_versions
      SET status = 'rolled_back' WHERE site_id = ? AND id = ?`)
      .bind(siteId, state.current_version_id),
    ready.db.prepare(`UPDATE ads_txt_connector_versions
      SET status = 'published', published_at = COALESCE(published_at, ?)
      WHERE site_id = ? AND id = ?`)
      .bind(now, siteId, target.id),
    ready.db.prepare(`UPDATE ads_txt_mock_cms_state
      SET current_version_id = ?,
          previous_version_id = ?,
          content = ?,
          checksum = ?,
          updated_at = ?
      WHERE site_id = ?`)
      .bind(target.id, state.current_version_id, target.content, target.checksum, now, siteId),
    ready.db.prepare(`UPDATE ads_txt_connector_settings
      SET last_verified_at = NULL,
          last_verification_status = 'pending',
          last_verified_version_id = NULL,
          updated_by = ?,
          updated_at = ?
      WHERE site_id = ?`)
      .bind(actor, now, siteId),
    auditStatement(ready.db, actor, 'ads_txt_connector.mock_rolled_back', siteId, target.id, {
      restoredVersionNumber: target.version_number,
      replacedVersionId: state.current_version_id,
    }, now),
  ]);

  return json({
    ok: true,
    action: {
      kind: 'rollback',
      message: `Restored sandbox version ${target.version_number}. Verify it before continuing.`,
      versionId: target.id,
    },
    status: await statusPayload(request, ready.db, siteId),
  });
}

export async function getMockCmsAdsTxt(
  env: AdsTxtConnectorEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return new Response('D1 database binding is not configured.\n', { status: 503 });
  await ensureAdsTxtConnectorTables(env.DB);
  const site = await siteRow(env.DB, siteId);
  if (!site) return new Response('Mock CMS site not found.\n', { status: 404 });
  const state = await mockStateRow(env.DB, siteId);
  if (!state?.current_version_id || !state.content) {
    return new Response(`# Tessera sandbox endpoint for ${site.domain}\n# No test version has been published yet.\n`, {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-tessera-sandbox': 'true',
      },
    });
  }

  return new Response(state.content, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      etag: `"${state.checksum ?? ''}"`,
      'x-tessera-sandbox': 'true',
      'x-tessera-version-id': state.current_version_id,
    },
  });
}
