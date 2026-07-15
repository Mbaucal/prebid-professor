import type {
  CreatePublisherInput,
  DuplicatePublisherInput,
  Publisher,
  PublisherStatus,
} from '../src/shared/types';
import { apiError, getActor, json, readJson } from './http';

export interface DatabaseEnv {
  DB?: D1Database;
}

type PublisherRow = {
  id: string;
  name: string;
  domain: string;
  gam_path: string;
  status: PublisherStatus;
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

const publisherSelect = `
  SELECT
    p.id,
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
`;

function databaseMissing(): Response {
  return apiError(
    'D1 database binding is not configured yet.',
    503,
    'Create a D1 database, bind it as DB, and apply migrations/0001_initial.sql.',
  );
}

function normalizeDomain(input: string): string {
  const trimmed = String(input ?? '').trim().toLowerCase();

  if (!trimmed) return '';

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return trimmed.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

function normalizeGamPath(input: string): string {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
}

function isValidPublisherId(id: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(id);
}

function toPublisher(row: PublisherRow): Publisher {
  return {
    id: row.id,
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

function validatePublisherInput(input: CreatePublisherInput | DuplicatePublisherInput): string[] {
  const errors: string[] = [];
  const id = String(input.id ?? '').trim();
  const name = String(input.name ?? '').trim();
  const domain = normalizeDomain(input.domain);
  const gamPath = normalizeGamPath(input.gamPath);

  if (!isValidPublisherId(id)) {
    errors.push('id must use lowercase letters, numbers and dashes, with no leading or trailing dash.');
  }

  if (!name) errors.push('name is required.');
  if (!domain || !domain.includes('.')) errors.push('domain must be a valid hostname.');
  if (!gamPath || gamPath === '//') errors.push('gamPath is required.');

  return errors;
}

async function fetchPublisher(db: D1Database, id: string): Promise<Publisher | null> {
  const row = await db
    .prepare(`${publisherSelect} WHERE p.id = ? LIMIT 1`)
    .bind(id)
    .first<PublisherRow>();

  return row ? toPublisher(row) : null;
}

export async function listPublishers(env: DatabaseEnv): Promise<Response> {
  if (!env.DB) return databaseMissing();

  const result = await env.DB.prepare(`${publisherSelect} ORDER BY p.name COLLATE NOCASE`).all<PublisherRow>();

  return json({
    ok: true,
    publishers: (result.results ?? []).map(toPublisher),
  });
}

export async function getPublisher(env: DatabaseEnv, id: string): Promise<Response> {
  if (!env.DB) return databaseMissing();

  const publisher = await fetchPublisher(env.DB, id);
  if (!publisher) return apiError('Publisher not found.', 404);

  return json({ ok: true, publisher });
}

export async function createPublisher(request: Request, env: DatabaseEnv): Promise<Response> {
  if (!env.DB) return databaseMissing();

  let input: CreatePublisherInput;

  try {
    input = await readJson<CreatePublisherInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const errors = validatePublisherInput(input);
  if (errors.length) return apiError('Publisher validation failed.', 422, errors);

  const id = input.id.trim();
  const name = input.name.trim();
  const domain = normalizeDomain(input.domain);
  const gamPath = normalizeGamPath(input.gamPath);
  const status = input.status ?? 'draft';
  const adsTxtUrl = input.adsTxtUrl?.trim() || `https://${domain}/ads.txt`;
  const actor = getActor(request);
  const configId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const configJson = JSON.stringify({
    publisherId: id,
    domain,
    gamPath,
    enablePrebid: true,
    adUnits: [],
    bidders: [],
    bidderOverrides: [],
    sizeMaps: {},
    unitRules: {},
  });

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO publishers (
          id, name, domain, gam_path, status, current_version, ads_txt_url
        ) VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
      ).bind(id, name, domain, gamPath, status, adsTxtUrl),
      env.DB.prepare(
        `INSERT INTO publisher_configs (
          id, publisher_id, config_json, created_by
        ) VALUES (?, ?, ?, ?)`,
      ).bind(configId, id, configJson, actor),
      env.DB.prepare(
        `INSERT INTO audit_log (
          id, actor, action, publisher_id, entity_type, entity_id, details_json
        ) VALUES (?, ?, 'publisher.created', ?, 'publisher', ?, ?)`,
      ).bind(auditId, actor, id, id, JSON.stringify({ name, domain, gamPath })),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(conflict ? 'Publisher id or domain already exists.' : 'Publisher creation failed.', conflict ? 409 : 500, message);
  }

  const publisher = await fetchPublisher(env.DB, id);
  return json({ ok: true, publisher }, { status: 201 });
}

export async function duplicatePublisher(
  request: Request,
  env: DatabaseEnv,
  sourceId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();

  let input: DuplicatePublisherInput;

  try {
    input = await readJson<DuplicatePublisherInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const errors = validatePublisherInput(input);
  if (errors.length) return apiError('Publisher validation failed.', 422, errors);

  const source = await fetchPublisher(env.DB, sourceId);
  if (!source) return apiError('Source publisher not found.', 404);

  const sourceConfig = await env.DB
    .prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
    .bind(sourceId)
    .first<{ config_json: string }>();

  const id = input.id.trim();
  const name = input.name.trim();
  const domain = normalizeDomain(input.domain);
  const gamPath = normalizeGamPath(input.gamPath);
  const status = input.status ?? 'draft';
  const adsTxtUrl = input.adsTxtUrl?.trim() || `https://${domain}/ads.txt`;
  const actor = getActor(request);
  const now = new Date().toISOString();

  let config: Record<string, unknown> = {};

  try {
    config = sourceConfig?.config_json ? (JSON.parse(sourceConfig.config_json) as Record<string, unknown>) : {};
  } catch {
    config = {};
  }

  config.publisherId = id;
  config.domain = domain;
  config.gamPath = gamPath;

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO publishers (
        id, name, domain, gam_path, status, current_version, ads_txt_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).bind(id, name, domain, gamPath, status, adsTxtUrl, now, now),
    env.DB.prepare(
      `INSERT INTO publisher_configs (
        id, publisher_id, config_json, config_hash, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), id, JSON.stringify(config), actor, now, now),
    env.DB.prepare(
      `INSERT INTO ad_units (
        id, publisher_id, code, type, media_type, size_map_key, enabled, sort_order, notes, created_at, updated_at
      )
      SELECT lower(hex(randomblob(16))), ?, code, type, media_type, size_map_key, enabled, sort_order, notes, ?, ?
      FROM ad_units WHERE publisher_id = ?`,
    ).bind(id, now, now, sourceId),
    env.DB.prepare(
      `INSERT INTO bidders (
        id, publisher_id, bidder, params_json, enabled, created_at, updated_at
      )
      SELECT lower(hex(randomblob(16))), ?, bidder, params_json, enabled, ?, ?
      FROM bidders WHERE publisher_id = ?`,
    ).bind(id, now, now, sourceId),
    env.DB.prepare(
      `INSERT INTO bidder_overrides (
        id, publisher_id, bidder, scope_type, scope_key, params_json, enabled, created_at, updated_at
      )
      SELECT lower(hex(randomblob(16))), ?, bidder, scope_type, scope_key, params_json, enabled, ?, ?
      FROM bidder_overrides WHERE publisher_id = ?`,
    ).bind(id, now, now, sourceId),
    env.DB.prepare(
      `INSERT INTO size_maps (
        id, publisher_id, name, map_json, created_at, updated_at
      )
      SELECT lower(hex(randomblob(16))), ?, name, map_json, ?, ?
      FROM size_maps WHERE publisher_id = ?`,
    ).bind(id, now, now, sourceId),
    env.DB.prepare(
      `INSERT INTO unit_rules (
        id, publisher_id, rule_key, rule_json, created_at, updated_at
      )
      SELECT lower(hex(randomblob(16))), ?, rule_key, rule_json, ?, ?
      FROM unit_rules WHERE publisher_id = ?`,
    ).bind(id, now, now, sourceId),
  ];

  if (input.copyAdsTxtRequirements) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO ads_txt_requirements (
          id, publisher_id, source_label, entry, required, created_at, updated_at
        )
        SELECT lower(hex(randomblob(16))), ?, source_label, entry, required, ?, ?
        FROM ads_txt_requirements WHERE publisher_id = ?`,
      ).bind(id, now, now, sourceId),
    );
  }

  if (input.copyPrebidBuild) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO prebid_builds (
          id, publisher_id, version, file_key, file_url, modules_json, status, uploaded_by, uploaded_at
        )
        SELECT lower(hex(randomblob(16))), ?, version, file_key, file_url, modules_json, 'current', ?, ?
        FROM prebid_builds
        WHERE publisher_id = ? AND status = 'current'
        ORDER BY uploaded_at DESC
        LIMIT 1`,
      ).bind(id, actor, now, sourceId),
    );
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_log (
        id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
      ) VALUES (?, ?, 'publisher.duplicated', ?, 'publisher', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      actor,
      id,
      id,
      JSON.stringify({
        sourcePublisherId: sourceId,
        copyPrebidBuild: Boolean(input.copyPrebidBuild),
        copyAdsTxtRequirements: Boolean(input.copyAdsTxtRequirements),
      }),
      now,
    ),
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(conflict ? 'Publisher id or domain already exists.' : 'Publisher duplication failed.', conflict ? 409 : 500, message);
  }

  const publisher = await fetchPublisher(env.DB, id);
  return json({ ok: true, publisher }, { status: 201 });
}
