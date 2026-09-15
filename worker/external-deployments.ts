import { isStoredBuiltinDraft, STORED_DRAFT_BLOCK } from './runtime/stored-draft-safety.mjs';
import { deploymentManifestPin } from './deployment-manifest-pin.mjs';
import { apiError, getActor, json } from './http';
import type { DatabaseEnv } from './publishers';

export interface ExternalDeployEnv extends DatabaseEnv {
  BUILDS?: R2Bucket;
  GITHUB_ACTIONS_TOKEN?: string;
  GITHUB_DEPLOY_REPOSITORY?: string;
  GITHUB_DEPLOY_REF?: string;
  DEPLOY_CALLBACK_SECRET?: string;
}

type JsonRecord = Record<string, unknown>;
type DeploymentChannel = 'staging' | 'production';
type DeploymentStatus = 'queued' | 'running' | 'success' | 'failed';

type DeploymentTargetRow = {
  id: string;
  publisher_id: string;
  name: string;
  provider: 'cloudflare-pages';
  account_id: string;
  project_name: string;
  github_environment: string;
  production_branch: string;
  preview_branch: string;
  public_base_url: string | null;
  enabled: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type ExternalDeploymentRow = {
  id: string;
  publisher_id: string;
  target_id: string;
  target_name?: string | null;
  project_name?: string | null;
  release_id: string;
  release_version: string;
  channel: DeploymentChannel;
  status: DeploymentStatus;
  correlation_id: string;
  github_run_id: string | null;
  github_run_url: string | null;
  provider_deployment_url: string | null;
  provider_alias_url: string | null;
  message: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type ReleaseRow = {
  id: string;
  publisher_id: string;
  version: string;
  status: string;
  manifest_key: string | null;
  config_hash: string;
};

const DEFAULT_REPOSITORY = 'Mbaucal/prebid-professor';
const DEFAULT_REF = 'main';
const WORKFLOW_FILE = 'deploy-pages-release.yml';

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function migrationMissing(error: unknown): Response | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/no such table:\s*(deployment_targets|external_deployments)/i.test(message)) {
    return apiError(
      'External deployment migration is not applied yet.',
      503,
      'Run migrations/0003_external_deployments.sql against prebid-professor-db.',
    );
  }
  return null;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeOptionalUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('publicBaseUrl must use http or https.');
  return parsed.toString().replace(/\/$/, '');
}

function validateTargetInput(value: unknown): {
  name: string;
  accountId: string;
  projectName: string;
  githubEnvironment: string;
  productionBranch: string;
  previewBranch: string;
  publicBaseUrl: string | null;
  enabled: boolean;
} {
  if (!isRecord(value)) throw new Error('Deployment target body must be a JSON object.');

  const name = text(value.name);
  const accountId = text(value.accountId);
  const projectName = text(value.projectName).toLowerCase();
  const githubEnvironment = text(value.githubEnvironment);
  const productionBranch = text(value.productionBranch) || 'main';
  const previewBranch = text(value.previewBranch) || 'staging';
  const publicBaseUrl = normalizeOptionalUrl(value.publicBaseUrl);
  const enabled = booleanValue(value.enabled, true);

  if (!name || name.length > 100) throw new Error('Target name is required and cannot exceed 100 characters.');
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('Cloudflare Account ID must contain 32 hexadecimal characters.');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(projectName)) {
    throw new Error('Pages project name must use lowercase letters, numbers and dashes.');
  }
  if (!githubEnvironment || githubEnvironment.length > 255) {
    throw new Error('GitHub Environment name is required.');
  }
  if (!/^[A-Za-z0-9._/-]{1,255}$/.test(productionBranch)) {
    throw new Error('Production branch contains unsupported characters.');
  }
  if (!/^[A-Za-z0-9._/-]{1,255}$/.test(previewBranch)) {
    throw new Error('Preview branch contains unsupported characters.');
  }

  return {
    name,
    accountId,
    projectName,
    githubEnvironment,
    productionBranch,
    previewBranch,
    publicBaseUrl,
    enabled,
  };
}

function targetPayload(row: DeploymentTargetRow): JsonRecord {
  return {
    id: row.id,
    publisherId: row.publisher_id,
    name: row.name,
    provider: row.provider,
    accountId: row.account_id,
    projectName: row.project_name,
    githubEnvironment: row.github_environment,
    productionBranch: row.production_branch,
    previewBranch: row.preview_branch,
    publicBaseUrl: row.public_base_url,
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deploymentPayload(row: ExternalDeploymentRow): JsonRecord {
  return {
    id: row.id,
    publisherId: row.publisher_id,
    targetId: row.target_id,
    targetName: row.target_name ?? null,
    projectName: row.project_name ?? null,
    releaseId: row.release_id,
    releaseVersion: row.release_version,
    channel: row.channel,
    status: row.status,
    correlationId: row.correlation_id,
    githubRunId: row.github_run_id,
    githubRunUrl: row.github_run_url,
    deploymentUrl: row.provider_deployment_url,
    aliasUrl: row.provider_alias_url,
    message: row.message,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1').bind(siteId).first<{ id: string }>();
  return Boolean(row);
}

async function fetchTarget(
  db: D1Database,
  siteId: string,
  targetId: string,
): Promise<DeploymentTargetRow | null> {
  return db
    .prepare(
      `SELECT id, publisher_id, name, provider, account_id, project_name, github_environment,
              production_branch, preview_branch, public_base_url, enabled, created_by,
              created_at, updated_at
       FROM deployment_targets
       WHERE publisher_id = ? AND id = ?
       LIMIT 1`,
    )
    .bind(siteId, targetId)
    .first<DeploymentTargetRow>();
}

async function fetchDeploymentByCorrelation(
  db: D1Database,
  correlationId: string,
): Promise<ExternalDeploymentRow | null> {
  return db
    .prepare(
      `SELECT d.*, t.name AS target_name, t.project_name AS project_name
       FROM external_deployments d
       LEFT JOIN deployment_targets t ON t.id = d.target_id
       WHERE d.correlation_id = ?
       LIMIT 1`,
    )
    .bind(correlationId)
    .first<ExternalDeploymentRow>();
}

function repositoryParts(env: ExternalDeployEnv): { owner: string; repo: string; full: string } {
  const full = text(env.GITHUB_DEPLOY_REPOSITORY) || DEFAULT_REPOSITORY;
  const parts = full.split('/').map((item) => item.trim()).filter(Boolean);
  if (parts.length !== 2) throw new Error('GITHUB_DEPLOY_REPOSITORY must use owner/repository format.');
  return { owner: parts[0], repo: parts[1], full };
}

function safeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

export async function listDeploymentTargets(env: ExternalDeployEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  try {
    const [targetsResult, deploymentsResult] = await Promise.all([
      env.DB
        .prepare(
          `SELECT id, publisher_id, name, provider, account_id, project_name, github_environment,
                  production_branch, preview_branch, public_base_url, enabled, created_by,
                  created_at, updated_at
           FROM deployment_targets
           WHERE publisher_id = ?
           ORDER BY enabled DESC, name COLLATE NOCASE`,
        )
        .bind(siteId)
        .all<DeploymentTargetRow>(),
      env.DB
        .prepare(
          `SELECT d.*, t.name AS target_name, t.project_name AS project_name
           FROM external_deployments d
           LEFT JOIN deployment_targets t ON t.id = d.target_id
           WHERE d.publisher_id = ?
           ORDER BY d.created_at DESC
           LIMIT 100`,
        )
        .bind(siteId)
        .all<ExternalDeploymentRow>(),
    ]);

    return json({
      ok: true,
      targets: (targetsResult.results ?? []).map(targetPayload),
      deployments: (deploymentsResult.results ?? []).map(deploymentPayload),
      orchestrator: {
        githubConfigured: Boolean(env.GITHUB_ACTIONS_TOKEN),
        callbackConfigured: Boolean(env.DEPLOY_CALLBACK_SECRET),
        repository: text(env.GITHUB_DEPLOY_REPOSITORY) || DEFAULT_REPOSITORY,
        workflow: WORKFLOW_FILE,
      },
    });
  } catch (error) {
    return migrationMissing(error) ?? apiError('Deployment targets could not be loaded.', 500, String(error));
  }
}

export async function createDeploymentTarget(
  request: Request,
  env: ExternalDeployEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  let input;
  try {
    input = validateTargetInput(await request.json());
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Deployment target is invalid.', 422);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const actor = getActor(request);

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO deployment_targets (
             id, publisher_id, name, provider, account_id, project_name, github_environment,
             production_branch, preview_branch, public_base_url, enabled, created_by,
             created_at, updated_at
           ) VALUES (?, ?, ?, 'cloudflare-pages', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          siteId,
          input.name,
          input.accountId,
          input.projectName,
          input.githubEnvironment,
          input.productionBranch,
          input.previewBranch,
          input.publicBaseUrl,
          input.enabled ? 1 : 0,
          actor,
          now,
          now,
        ),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'deployment_target.created', ?, 'deployment_target', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          id,
          JSON.stringify({
            name: input.name,
            provider: 'cloudflare-pages',
            accountId: input.accountId,
            projectName: input.projectName,
            githubEnvironment: input.githubEnvironment,
          }),
          now,
        ),
    ]);
  } catch (error) {
    const migration = migrationMissing(error);
    if (migration) return migration;
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(conflict ? `A deployment target named "${input.name}" already exists.` : 'Target could not be created.', conflict ? 409 : 500, message);
  }

  const row = await fetchTarget(env.DB, siteId, id);
  return json({ ok: true, target: row ? targetPayload(row) : null }, { status: 201 });
}

export async function updateDeploymentTarget(
  request: Request,
  env: ExternalDeployEnv,
  siteId: string,
  targetId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();

  let current: DeploymentTargetRow | null;
  try {
    current = await fetchTarget(env.DB, siteId, targetId);
  } catch (error) {
    return migrationMissing(error) ?? apiError('Deployment target could not be loaded.', 500, String(error));
  }
  if (!current) return apiError('Deployment target not found.', 404);

  let raw: JsonRecord;
  try {
    const value = await request.json();
    if (!isRecord(value)) throw new Error('Deployment target body must be a JSON object.');
    raw = value;
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Deployment target JSON is invalid.', 422);
  }

  let input;
  try {
    input = validateTargetInput({
      name: raw.name ?? current.name,
      accountId: raw.accountId ?? current.account_id,
      projectName: raw.projectName ?? current.project_name,
      githubEnvironment: raw.githubEnvironment ?? current.github_environment,
      productionBranch: raw.productionBranch ?? current.production_branch,
      previewBranch: raw.previewBranch ?? current.preview_branch,
      publicBaseUrl: Object.prototype.hasOwnProperty.call(raw, 'publicBaseUrl') ? raw.publicBaseUrl : current.public_base_url,
      enabled: raw.enabled ?? current.enabled === 1,
    });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Deployment target is invalid.', 422);
  }

  const now = new Date().toISOString();
  const actor = getActor(request);
  try {
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE deployment_targets
           SET name = ?, account_id = ?, project_name = ?, github_environment = ?,
               production_branch = ?, preview_branch = ?, public_base_url = ?, enabled = ?,
               updated_at = ?
           WHERE publisher_id = ? AND id = ?`,
        )
        .bind(
          input.name,
          input.accountId,
          input.projectName,
          input.githubEnvironment,
          input.productionBranch,
          input.previewBranch,
          input.publicBaseUrl,
          input.enabled ? 1 : 0,
          now,
          siteId,
          targetId,
        ),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'deployment_target.updated', ?, 'deployment_target', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          targetId,
          JSON.stringify({ name: input.name, projectName: input.projectName, enabled: input.enabled }),
          now,
        ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /unique|constraint/i.test(message);
    return apiError(conflict ? `A deployment target named "${input.name}" already exists.` : 'Target could not be updated.', conflict ? 409 : 500, message);
  }

  const row = await fetchTarget(env.DB, siteId, targetId);
  return json({ ok: true, target: row ? targetPayload(row) : null });
}

export async function deleteDeploymentTarget(
  request: Request,
  env: ExternalDeployEnv,
  siteId: string,
  targetId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  const target = await fetchTarget(env.DB, siteId, targetId);
  if (!target) return apiError('Deployment target not found.', 404);

  const active = await env.DB
    .prepare(
      `SELECT COUNT(*) AS count
       FROM external_deployments
       WHERE target_id = ? AND status IN ('queued', 'running')`,
    )
    .bind(targetId)
    .first<{ count: number | string }>();
  if (Number(active?.count ?? 0) > 0) {
    return apiError('This target has a queued or running deployment and cannot be deleted.', 409);
  }

  const actor = getActor(request);
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM deployment_targets WHERE publisher_id = ? AND id = ?').bind(siteId, targetId),
      env.DB
        .prepare(
          `INSERT INTO audit_log (
             id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
           ) VALUES (?, ?, 'deployment_target.deleted', ?, 'deployment_target', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          targetId,
          JSON.stringify({ name: target.name, projectName: target.project_name }),
          now,
        ),
    ]);
  } catch (error) {
    return apiError('Deployment target could not be deleted.', 500, error instanceof Error ? error.message : String(error));
  }

  return json({ ok: true, deletedId: targetId });
}

export async function dispatchExternalDeployment(
  request: Request,
  env: ExternalDeployEnv,
  siteId: string,
  targetId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!env.GITHUB_ACTIONS_TOKEN) {
    return apiError('GITHUB_ACTIONS_TOKEN is not configured on the Worker.', 503);
  }
  if (!env.DEPLOY_CALLBACK_SECRET) {
    return apiError('DEPLOY_CALLBACK_SECRET is not configured on the Worker.', 503);
  }

  let input: JsonRecord;
  try {
    const value = await request.json();
    if (!isRecord(value)) throw new Error('Deployment body must be a JSON object.');
    input = value;
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Deployment JSON is invalid.', 422);
  }

  const releaseId = text(input.releaseId);
  const channel = text(input.channel) as DeploymentChannel;
  if (!releaseId) return apiError('releaseId is required.', 422);
  if (!['staging', 'production'].includes(channel)) return apiError('channel must be staging or production.', 422);

  const target = await fetchTarget(env.DB, siteId, targetId);
  if (!target) return apiError('Deployment target not found.', 404);
  if (target.enabled !== 1) return apiError('Deployment target is disabled.', 409);

  const release = await env.DB
    .prepare('SELECT id, publisher_id, version, status, manifest_key, config_hash FROM releases WHERE publisher_id = ? AND id = ? LIMIT 1')
    .bind(siteId, releaseId)
    .first<ReleaseRow>();
  if (!release) return apiError('Release not found.', 404);
  if (isStoredBuiltinDraft(release)) return apiError(STORED_DRAFT_BLOCK, 409);
  if (release.status === 'failed') return apiError('A failed release cannot be deployed.', 409);
  if (channel === 'production' && release.status !== 'production') {
    return apiError('External production deploy requires an internally published production release.', 409);
  }
  let manifestSha256: string;
  try { manifestSha256 = await deploymentManifestPin(env.BUILDS, siteId, release); }
  catch { return apiError('The exact stored release manifest could not be verified. Nothing was dispatched.', 409); }

  let repository;
  try {
    repository = repositoryParts(env);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'GitHub repository configuration is invalid.', 503);
  }

  const correlationId = crypto.randomUUID();
  const deploymentId = crypto.randomUUID();
  const now = new Date().toISOString();
  const actor = getActor(request);
  const branch = channel === 'production' ? target.production_branch : target.preview_branch;
  const origin = new URL(request.url).origin;
  const releaseBaseUrl = new URL(
    `/cdn/${encodeURIComponent(siteId)}/releases/${encodeURIComponent(release.version)}`,
    origin,
  ).toString().replace(/\/$/, '');
  const callbackUrl = new URL('/api/deployments/callback', origin).toString();

  try {
    await env.DB
      .prepare(
        `INSERT INTO external_deployments (
           id, publisher_id, target_id, release_id, release_version, channel, status,
           correlation_id, message, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      )
      .bind(
        deploymentId,
        siteId,
        targetId,
        release.id,
        release.version,
        channel,
        correlationId,
        'Waiting for GitHub Actions runner.',
        actor,
        now,
        now,
      )
      .run();
  } catch (error) {
    return migrationMissing(error) ?? apiError('Deployment record could not be created.', 500, String(error));
  }

  const githubResponse = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/actions/workflows/${encodeURIComponent(WORKFLOW_FILE)}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'prebid-professor-deployer',
      },
      body: JSON.stringify({
        ref: text(env.GITHUB_DEPLOY_REF) || DEFAULT_REF,
        inputs: {
          correlation_id: correlationId,
          callback_url: callbackUrl,
          site_id: siteId,
          release_id: release.id,
          release_version: release.version,
          release_base_url: releaseBaseUrl,
          manifest_sha256: manifestSha256,
          github_environment: target.github_environment,
          account_id: target.account_id,
          project_name: target.project_name,
          branch,
          channel,
        },
      }),
    },
  );

  if (!githubResponse.ok) {
    const details = await githubResponse.text();
    const message = `GitHub workflow dispatch failed with ${githubResponse.status}.`;
    await env.DB
      .prepare(
        `UPDATE external_deployments
         SET status = 'failed', message = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .bind(message, now, now, deploymentId)
      .run();
    return apiError(message, 502, details.slice(0, 2000));
  }

  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE external_deployments
         SET status = 'running', message = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind('GitHub Actions workflow dispatched.', new Date().toISOString(), deploymentId),
    env.DB
      .prepare(
        `INSERT INTO audit_log (
           id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
         ) VALUES (?, ?, 'external_deployment.dispatched', ?, 'external_deployment', ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        actor,
        siteId,
        deploymentId,
        JSON.stringify({
          targetId,
          targetName: target.name,
          releaseId: release.id,
          releaseVersion: release.version,
          channel,
          branch,
          repository: repository.full,
          githubEnvironment: target.github_environment,
        }),
        new Date().toISOString(),
      ),
  ]);

  const row = await fetchDeploymentByCorrelation(env.DB, correlationId);
  return json(
    {
      ok: true,
      deployment: row ? deploymentPayload(row) : null,
      actionsUrl: `https://github.com/${repository.full}/actions/workflows/${WORKFLOW_FILE}`,
    },
    { status: 202 },
  );
}

export async function deploymentCallback(request: Request, env: ExternalDeployEnv): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!env.DEPLOY_CALLBACK_SECRET) return apiError('Deployment callback is not configured.', 503);
  if (request.method !== 'POST') return apiError('Method not allowed.', 405);

  const authorization = request.headers.get('authorization') ?? '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!provided || !safeEqual(provided, env.DEPLOY_CALLBACK_SECRET)) {
    return apiError('Invalid deployment callback credential.', 401);
  }

  let input: JsonRecord;
  try {
    const value = await request.json();
    if (!isRecord(value)) throw new Error('Callback body must be a JSON object.');
    input = value;
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Callback JSON is invalid.', 422);
  }

  const correlationId = text(input.correlationId);
  const status = text(input.status) as DeploymentStatus;
  if (!correlationId) return apiError('correlationId is required.', 422);
  if (!['running', 'success', 'failed'].includes(status)) return apiError('Callback status is invalid.', 422);

  const current = await fetchDeploymentByCorrelation(env.DB, correlationId);
  if (!current) return apiError('Deployment correlation ID was not found.', 404);

  const now = new Date().toISOString();
  const completedAt = ['success', 'failed'].includes(status) ? now : null;
  await env.DB
    .prepare(
      `UPDATE external_deployments
       SET status = ?, github_run_id = ?, github_run_url = ?, provider_deployment_url = ?,
           provider_alias_url = ?, message = ?, updated_at = ?, completed_at = ?
       WHERE correlation_id = ?`,
    )
    .bind(
      status,
      text(input.githubRunId) || current.github_run_id,
      text(input.githubRunUrl) || current.github_run_url,
      text(input.deploymentUrl) || current.provider_deployment_url,
      text(input.aliasUrl) || current.provider_alias_url,
      text(input.message) || current.message,
      now,
      completedAt,
      correlationId,
    )
    .run();

  const row = await fetchDeploymentByCorrelation(env.DB, correlationId);
  return json({ ok: true, deployment: row ? deploymentPayload(row) : null });
}
