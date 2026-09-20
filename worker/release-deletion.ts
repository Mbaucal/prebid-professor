import { isStoredBuiltinDraft, STORED_DRAFT_BLOCK } from './runtime/stored-draft-safety.mjs';
import { apiError, getActor, json } from './http';
import type { ReleaseEnv } from './releases';

type ReleaseRow = {
  id: string;
  publisher_id: string;
  version: string;
  status: string;
};

type SiteReference = {
  current_release_id: string | null;
  current_version: string | null;
};

const DELETABLE_STATUSES = new Set(['draft', 'failed', 'archived']);

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function storageMissing(): Response {
  return apiError('R2 build storage binding is not configured yet.', 503);
}

async function tableExists(db: D1Database, tableName: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .bind(tableName)
    .first<{ name: string }>();
  return Boolean(row);
}

async function collectReleaseObjects(
  bucket: R2Bucket,
  prefix: string,
): Promise<{ keys: string[]; bytes: number }> {
  const keys: string[] = [];
  let bytes = 0;
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ prefix, cursor });
    for (const object of page.objects) {
      keys.push(object.key);
      bytes += Number(object.size || 0);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return { keys, bytes };
}

async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  const chunkSize = 1000;
  for (let index = 0; index < keys.length; index += chunkSize) {
    await bucket.delete(keys.slice(index, index + chunkSize));
  }
}

export async function deleteRelease(
  request: Request,
  env: ReleaseEnv,
  siteId: string,
  releaseId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!env.BUILDS) return storageMissing();

  const release = await env.DB
    .prepare(`SELECT id, publisher_id, version, status
              FROM releases
              WHERE publisher_id = ? AND id = ?
              LIMIT 1`)
    .bind(siteId, releaseId)
    .first<ReleaseRow>();

  if (!release) return apiError('Release not found.', 404);
  if (isStoredBuiltinDraft(release)) return apiError(STORED_DRAFT_BLOCK, 409);
  if (!DELETABLE_STATUSES.has(release.status)) {
    return apiError(
      `A ${release.status} release cannot be deleted. Only draft, failed and archived releases may be removed.`,
      409,
    );
  }

  const siteReference = await env.DB
    .prepare(`SELECT current_release_id, current_version
              FROM publishers
              WHERE id = ?
              LIMIT 1`)
    .bind(siteId)
    .first<SiteReference>();

  if (siteReference?.current_release_id === release.id || siteReference?.current_version === release.version) {
    return apiError('The release is still referenced as the current site release and cannot be deleted.', 409);
  }

  const hasExternalDeployments = await tableExists(env.DB, 'external_deployments');
  let externalDeploymentCount = 0;
  if (hasExternalDeployments) {
    const activeDeployment = await env.DB
      .prepare(`SELECT id FROM external_deployments
                WHERE publisher_id = ? AND release_id = ?
                  AND status IN ('queued', 'running')
                LIMIT 1`)
      .bind(siteId, releaseId)
      .first<{ id: string }>();
    if (activeDeployment) {
      return apiError('This release still has a queued or running external deployment.', 409);
    }

    const count = await env.DB
      .prepare(`SELECT COUNT(*) AS total
                FROM external_deployments
                WHERE publisher_id = ? AND release_id = ?`)
      .bind(siteId, releaseId)
      .first<{ total: number | string | null }>();
    externalDeploymentCount = Number(count?.total ?? 0);
  }

  if (request.headers.get('x-confirm-delete') !== releaseId) return apiError('Confirm this exact release before deleting.', 422);

  const prefix = `publishers/${siteId}/releases/${release.version}/`;
  let objects: { keys: string[]; bytes: number };
  try {
    objects = await collectReleaseObjects(env.BUILDS, prefix);
    if (objects.keys.length) await deleteKeys(env.BUILDS, objects.keys);
  } catch (error) {
    return apiError(
      'Release files could not be removed from R2.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  const actor = getActor(request);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  if (hasExternalDeployments) {
    statements.push(
      env.DB
        .prepare('DELETE FROM external_deployments WHERE publisher_id = ? AND release_id = ?')
        .bind(siteId, releaseId),
    );
  }

  statements.push(
    env.DB
      .prepare('DELETE FROM releases WHERE publisher_id = ? AND id = ?')
      .bind(siteId, releaseId),
    env.DB
      .prepare(`INSERT INTO audit_log (
        id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
      ) VALUES (?, ?, 'release.deleted', ?, 'release', ?, ?, ?)`) 
      .bind(
        crypto.randomUUID(),
        actor,
        siteId,
        releaseId,
        JSON.stringify({
          version: release.version,
          status: release.status,
          r2Prefix: prefix,
          objectsDeleted: objects.keys.length,
          bytesFreed: objects.bytes,
          externalDeploymentsDeleted: externalDeploymentCount,
        }),
        now,
      ),
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    return apiError(
      'Release files were removed, but D1 metadata cleanup failed. Retry the delete action.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  return json({
    ok: true,
    deleted: {
      id: release.id,
      version: release.version,
      status: release.status,
      objectsDeleted: objects.keys.length,
      bytesFreed: objects.bytes,
      externalDeploymentsDeleted: externalDeploymentCount,
    },
  });
}
