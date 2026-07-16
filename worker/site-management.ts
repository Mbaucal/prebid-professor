import type { PublisherStatus, UpdateSiteInput } from '../src/shared/types';
import { apiError, getActor, json, readJson } from './http';
import { fetchSite, type DatabaseEnv } from './publishers';

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
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

async function accountExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM publisher_accounts WHERE id = ? LIMIT 1')
    .bind(id)
    .first<{ id: string }>();
  return Boolean(row);
}

async function readConfig(db: D1Database, siteId: string): Promise<Record<string, unknown>> {
  const row = await db
    .prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
    .bind(siteId)
    .first<{ config_json: string }>();

  if (!row?.config_json) return {};
  try {
    const parsed = JSON.parse(row.config_json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function updateSite(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();

  const current = await fetchSite(env.DB, siteId);
  if (!current) return apiError('Site not found.', 404);

  let input: UpdateSiteInput;
  try {
    input = await readJson<UpdateSiteInput>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const publisherAccountId = String(
    input.publisherAccountId === undefined
      ? current.publisherAccountId ?? ''
      : input.publisherAccountId ?? '',
  ).trim();
  const name = input.name === undefined ? current.name : String(input.name).trim();
  const domain = input.domain === undefined ? current.domain : normalizeDomain(input.domain);
  const gamPath = input.gamPath === undefined ? current.gamPath : normalizeGamPath(input.gamPath);
  const status = (input.status ?? current.status) as PublisherStatus;
  const adsTxtUrl =
    input.adsTxtUrl === undefined
      ? current.adsTxtUrl
      : String(input.adsTxtUrl ?? '').trim() || `https://${domain}/ads.txt`;

  const errors: string[] = [];
  if (!publisherAccountId || !(await accountExists(env.DB, publisherAccountId))) {
    errors.push('publisherAccountId must reference an existing publisher.');
  }
  if (!name) errors.push('name is required.');
  if (!domain || !domain.includes('.')) errors.push('domain must be a valid hostname.');
  if (!gamPath || gamPath === '//') errors.push('gamPath is required.');
  if (!['live', 'staging', 'draft', 'archived'].includes(status)) {
    errors.push('status is invalid.');
  }
  if (errors.length) return apiError('Site validation failed.', 422, errors);

  const actor = getActor(request);
  const now = new Date().toISOString();
  const config = await readConfig(env.DB, siteId);
  config.publisherId = siteId;
  config.siteId = siteId;
  config.publisherAccountId = publisherAccountId;
  config.domain = domain;
  config.gamPath = gamPath;

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE publishers
           SET publisher_account_id = ?, name = ?, domain = ?, gam_path = ?, status = ?,
               ads_txt_url = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          publisherAccountId,
          name,
          domain,
          gamPath,
          status,
          adsTxtUrl,
          now,
          siteId,
        ),
      env.DB
        .prepare(
          `UPDATE publisher_configs
           SET config_json = ?, updated_at = ?
           WHERE publisher_id = ?`,
        )
        .bind(JSON.stringify(config), now, siteId),
      env.DB
        .prepare(
          `UPDATE publisher_accounts
           SET updated_at = ?
           WHERE id IN (?, ?)`,
        )
        .bind(now, current.publisherAccountId ?? publisherAccountId, publisherAccountId),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'site.updated', ?, 'site', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          siteId,
          JSON.stringify({
            previousPublisherAccountId: current.publisherAccountId,
            publisherAccountId,
            previousDomain: current.domain,
            domain,
            previousGamPath: current.gamPath,
            gamPath,
            name,
            status,
          }),
          now,
        ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(
      conflict ? 'Another site already uses this domain.' : 'Site update failed.',
      conflict ? 409 : 500,
      message,
    );
  }

  return json({ ok: true, site: await fetchSite(env.DB, siteId) });
}

export async function moveSite(
  request: Request,
  env: DatabaseEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();

  let input: { publisherAccountId: string };
  try {
    input = await readJson<{ publisherAccountId: string }>(request);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Invalid JSON body.');
  }

  const syntheticRequest = new Request(request.url, {
    method: 'PATCH',
    headers: request.headers,
    body: JSON.stringify({ publisherAccountId: input.publisherAccountId }),
  });
  return updateSite(syntheticRequest, env, siteId);
}
