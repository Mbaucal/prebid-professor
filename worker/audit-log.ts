import { apiError, json } from './http';
import type { DatabaseEnv } from './publishers';

type AuditRow = {
  id: string;
  actor: string | null;
  action: string;
  publisher_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  details_json: string;
  created_at: string;
  site_name: string | null;
  site_domain: string | null;
  publisher_account_id: string | null;
  publisher_account_name: string | null;
};

function parseDetails(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function boundedLimit(value: string | null): number {
  const parsed = Number(value ?? 250);
  if (!Number.isFinite(parsed)) return 250;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}

export async function listAuditLog(request: Request, env: DatabaseEnv): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured yet.', 503);

  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId')?.trim() ?? '';
  const publisherAccountId = url.searchParams.get('publisherAccountId')?.trim() ?? '';
  const action = url.searchParams.get('action')?.trim() ?? '';
  const actor = url.searchParams.get('actor')?.trim() ?? '';
  const entityType = url.searchParams.get('entityType')?.trim() ?? '';
  const limit = boundedLimit(url.searchParams.get('limit'));

  const where: string[] = [];
  const bindings: Array<string | number> = [];

  if (siteId) {
    where.push('a.publisher_id = ?');
    bindings.push(siteId);
  }
  if (publisherAccountId) {
    where.push('p.publisher_account_id = ?');
    bindings.push(publisherAccountId);
  }
  if (action) {
    where.push('a.action = ?');
    bindings.push(action);
  }
  if (actor) {
    where.push('a.actor = ?');
    bindings.push(actor);
  }
  if (entityType) {
    where.push('a.entity_type = ?');
    bindings.push(entityType);
  }

  const query = `
    SELECT
      a.id,
      a.actor,
      a.action,
      a.publisher_id,
      a.entity_type,
      a.entity_id,
      a.details_json,
      a.created_at,
      p.name AS site_name,
      p.domain AS site_domain,
      p.publisher_account_id,
      pa.name AS publisher_account_name
    FROM audit_log a
    LEFT JOIN publishers p ON p.id = a.publisher_id
    LEFT JOIN publisher_accounts pa ON pa.id = p.publisher_account_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.created_at DESC
    LIMIT ?
  `;
  bindings.push(limit);

  try {
    const result = await env.DB.prepare(query).bind(...bindings).all<AuditRow>();
    const entries = (result.results ?? []).map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      siteId: row.publisher_id,
      siteName: row.site_name,
      siteDomain: row.site_domain,
      publisherAccountId: row.publisher_account_id,
      publisherAccountName: row.publisher_account_name,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: parseDetails(row.details_json),
      createdAt: row.created_at,
    }));

    return json({ ok: true, entries, limit });
  } catch (error) {
    return apiError('Audit log could not be loaded.', 500, error instanceof Error ? error.message : String(error));
  }
}
