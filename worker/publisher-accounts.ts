import type {
  CreatePublisherAccountInput,
  PublisherAccount,
  PublisherAccountStatus,
  Site,
  UpdatePublisherAccountInput,
} from '../src/shared/types';
import { apiError, getActor, json, readJson } from './http';
import { fetchSite, type DatabaseEnv } from './publishers';

type PublisherAccountRow = {
  id: string;
  name: string;
  status: PublisherAccountStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type SiteRow = {
  id: string;
  publisher_account_id: string | null;
  name: string;
  domain: string;
  gam_path: string;
  status: Site['status'];
  current_release_id: string | null;
  current_version: string;
  last_published_at: string | null;
  ads_txt_url: string | null;
  created_at: string;
  updated_at: string;
  ad_units_count: number | string | null;
  bidders_count: number | string | null;
  releases_count: number | string | null;
};

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function migrationMissing(): Response {
  return apiError(
    'Publisher hierarchy migration is not applied yet.',
    503,
    'Run migrations/0002_publisher_accounts.sql in the D1 console.',
  );
}

function isValidId(id: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,96}[a-z0-9])?$/.test(id);
}

function toSite(row: SiteRow): Site {
  return {
    id: row.id,
    publisherAccountId: row.publisher_account_id,
    name: row.name,
    domain: row.domain,
    gamPath: row.gam_path,
    status: row.status,
    currentReleaseId: row.current_release_id,
    currentVersion: row.current_version,
    lastPublishedAt: row.last_published_at,
    adsTxtUrl: row.ads_txt_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    adUnitsCount: Number(row.ad_units_count ?? 0),
    biddersCount: Number(row.bidders_count ?? 0),
    releasesCount: Number(row.releases_count ?? 0),
  };
}

function toPublisherAccount(row: PublisherAccountRow, sites: Site[]): PublisherAccount {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    notes: row.notes,
    sites,
    sitesCount: sites.length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function hierarchyAvailable(db: D1Database): Promise<boolean> {
  try {
    await db.prepare('SELECT id FROM publisher_accounts LIMIT 1').first();
    return true;
  } catch {
    return false;
  }
}

async function fetchSites(db: D1Database, accountId?: string): Promise<Site[]> {
  const where = accountId ? 'WHERE p.publisher_account_id = ?' : '';
  const statement = db.prepare(
    `SELECT
       p.id,
       p.publisher_account_id,
       p.name,
       p.domain,
       p.gam_path,
       p.status,
       p.current_release_id,
       p.current_version,
       p.last_published_at,
       p.ads_txt_url,
       p.created_at,
       p.updated_at,
       (SELECT COUNT(*) FROM ad_units au WHERE au.publisher_id = p.id) AS ad_units_count,
       (SELECT COUNT(*) FROM bidders b WHERE b.publisher_id = p.id) AS bidders_count,
       (SELECT COUNT(*) FROM releases r WHERE r.publisher_id = p.id) AS releases_count
     FROM publishers p
     ${where}
     ORDER BY p.name COLLATE NOCASE`,
  );
  const result = accountId
    ? await statement.bind(accountId).all<SiteRow>()
    : await statement.all<SiteRow>();
  return (result.results ?? []).map(toSite);
}

async function fetchAccount(db: D1Database, id: string): Promise<PublisherAccount | null> {
  const row = await db
    .prepare(
      `SELECT id, name, status, notes, created_at, updated_at
       FROM publisher_accounts
       WHERE id = ? LIMIT 1`,
    )
    .bind(id)
    .first<PublisherAccountRow>();
  if (!row) return null;
  return toPublisherAccount(row, await fetchSites(db, id));
}

export async function listPublisherAccounts(env: DatabaseEnv): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await hierarchyAvailable(env.DB))) return migrationMissing();

  const [accountsResult, sites] = await Promise.all([
    env.DB
      .prepare(
        `SELECT id, name, status, notes, created_at, updated_at
         FROM publisher_accounts
         ORDER BY name COLLATE NOCASE`,
      )
      .all<PublisherAccountRow>(),
    fetchSites(env.DB),
  ]);

  const grouped = new Map<string, Site[]>();
  sites.forEach((site) => {
    const key = site.publisherAccountId ?? '';
    grouped.set(key, [...(grouped.get(key) ?? []), site]);
  });

  return json({
    ok: true,
    publishers: (accountsResult.results ?? []).map((row) =>
      toPublisherAccount(row, grouped.get(row.id) ?? []),
    ),
  });
}

export async function getPublisherAccount(env: DatabaseEnv, id: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await hierarchyAvailable(env.DB))) return migrationMissing();
  const publisher = await fetchAccount(env.DB, id);
  if (!publisher) return apiError('Publisher not found.', 404);
  return json({ ok: true, publisher });
}

export async function createPublisherAccount(
  request: Request,
  env: DatabaseEnv,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await hierarchyAvailable(env.DB))) return migrationMissing();

  let input: CreatePublisherAccountInput;
  try {
    input = await readJson<CreatePublisherAccountInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const id = String(input.id ?? '').trim();
  const name = String(input.name ?? '').trim();
  const status = input.status ?? 'active';
  const notes = String(input.notes ?? '').trim() || null;
  const errors: string[] = [];
  if (!isValidId(id)) errors.push('id must use lowercase letters, numbers and dashes.');
  if (!name) errors.push('name is required.');
  if (!['active', 'draft', 'archived'].includes(status)) errors.push('status is invalid.');
  if (errors.length) return apiError('Publisher validation failed.', 422, errors);

  const actor = getActor(request);
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO publisher_accounts (id, name, status, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, name, status, notes, now, now),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'publisher_account.created', NULL, 'publisher_account', ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), actor, id, JSON.stringify({ name, status }), now),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(conflict ? 'Publisher ID already exists.' : 'Publisher creation failed.', conflict ? 409 : 500, message);
  }

  const publisher = await fetchAccount(env.DB, id);
  return json({ ok: true, publisher }, { status: 201 });
}

export async function updatePublisherAccount(
  request: Request,
  env: DatabaseEnv,
  id: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await hierarchyAvailable(env.DB))) return migrationMissing();
  const current = await fetchAccount(env.DB, id);
  if (!current) return apiError('Publisher not found.', 404);

  let input: UpdatePublisherAccountInput;
  try {
    input = await readJson<UpdatePublisherAccountInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const name = input.name === undefined ? current.name : String(input.name).trim();
  const status = input.status ?? current.status;
  const notes = input.notes === undefined ? current.notes : String(input.notes ?? '').trim() || null;
  if (!name) return apiError('Publisher name is required.', 422);

  const now = new Date().toISOString();
  await env.DB
    .prepare(
      `UPDATE publisher_accounts
       SET name = ?, status = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(name, status, notes, now, id)
    .run();

  return json({ ok: true, publisher: await fetchAccount(env.DB, id) });
}

export async function deletePublisherAccount(
  request: Request,
  env: DatabaseEnv,
  id: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await hierarchyAvailable(env.DB))) return migrationMissing();
  const publisher = await fetchAccount(env.DB, id);
  if (!publisher) return apiError('Publisher not found.', 404);
  if (publisher.sitesCount > 0) {
    return apiError('Publisher cannot be deleted while it still contains sites.', 409);
  }

  const now = new Date().toISOString();
  const actor = getActor(request);
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO audit_log (
           id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
         ) VALUES (?, ?, 'publisher_account.deleted', NULL, 'publisher_account', ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), actor, id, JSON.stringify({ name: publisher.name }), now),
    env.DB.prepare('DELETE FROM publisher_accounts WHERE id = ?').bind(id),
  ]);

  return json({ ok: true, deletedId: id });
}

export async function moveSiteToPublisher(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await hierarchyAvailable(env.DB))) return migrationMissing();
  const site = await fetchSite(env.DB, siteId);
  if (!site) return apiError('Site not found.', 404);

  let input: { publisherAccountId: string };
  try {
    input = await readJson<{ publisherAccountId: string }>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const targetId = String(input.publisherAccountId ?? '').trim();
  if (!targetId || !(await fetchAccount(env.DB, targetId))) {
    return apiError('Target publisher does not exist.', 404);
  }

  const now = new Date().toISOString();
  await env.DB
    .prepare(
      `UPDATE publishers
       SET publisher_account_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(targetId, now, siteId)
    .run();

  return json({ ok: true, site: await fetchSite(env.DB, siteId) });
}
