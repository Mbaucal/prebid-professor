/** MBA-19: GET-only metadata audit. No SQL, object reads, provisioning or deployment.
 * Reports only whitelisted resource identities. Never serialize raw API bindings.
 * Different resource IDs are necessary, not permission to enable remote writes.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const API = 'https://api.cloudflare.com/client/v4';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[0-9a-f]{32}$/i;
const WORKER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const MAX_JSON_BYTES = 512 * 1024;
const unique = (values) => [...new Set(values)].sort();
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const PRODUCTION = Object.freeze({
  worker: 'prebid-professor',
  databaseId: '7ef68f78-0fd8-4937-a774-d2fd1d5353e6',
  databaseName: 'prebid-professor-db',
  bucket: 'prebid-professor-builds',
});
class AuditError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new AuditError(code); };

export function validateInput(input) {
  if (!object(input) || !ACCOUNT.test(input.accountId ?? '')) fail('invalid_account_id');
  if (!WORKER.test(input.testWorker ?? '')) fail('invalid_test_worker');
  if (!UUID.test(input.testVersionId ?? '')) fail('exact_test_version_required');
  // Token is read from the caller environment, never a command-line argument or a URL.
  if (typeof input.token !== 'string' || input.token.length < 16 || input.token.length > 8192 || /\s/.test(input.token)) fail('read_only_token_required');
  return { accountId: input.accountId.toLowerCase(), testWorker: input.testWorker,
    testVersionId: input.testVersionId.toLowerCase(), token: input.token };
}

/** Cloudflare lists the actively serving deployment first. All traffic versions count. */
export function activeDeployment(result) {
  const deployment = result?.deployments?.[0];
  if (!UUID.test(deployment?.id ?? '') || !Array.isArray(deployment.versions) || !deployment.versions.length || deployment.versions.length > 16) fail('unreadable_active_deployment');
  const versions = deployment.versions.map((row) => {
    if (!UUID.test(row?.version_id ?? '') || typeof row.percentage !== 'number' || !Number.isFinite(row.percentage) || row.percentage <= 0 || row.percentage > 100) fail('unreadable_traffic_split');
    return { versionId: row.version_id.toLowerCase(), percentage: row.percentage };
  }).sort((a, b) => a.versionId.localeCompare(b.versionId));
  if (new Set(versions.map((v) => v.versionId)).size !== versions.length || Math.abs(versions.reduce((sum, row) => sum + row.percentage, 0) - 100) > 0.001) fail('unreadable_traffic_split');
  return { id: deployment.id.toLowerCase(), versions };
}

export function inspectVersion(result, expectedId, role) {
  if (!UUID.test(expectedId) || result?.id?.toLowerCase() !== expectedId.toLowerCase()) fail('version_identity_mismatch');
  const bindings = result?.resources?.bindings;
  if (!Array.isArray(bindings) || bindings.length > 1000) fail('bindings_not_available');
  const names = new Set();
  const databases = []; const buckets = []; const issues = [];
  let externalBindingCount = 0;
  for (const binding of bindings) {
    if (!object(binding) || typeof binding.name !== 'string' || typeof binding.type !== 'string') fail('unreadable_binding');
    if (names.has(binding.name)) fail('duplicate_binding_name');
    names.add(binding.name);
    if (binding.type === 'd1') {
      const value = binding.database_id ?? binding.id;
      if (!UUID.test(value ?? '') || (binding.id && binding.database_id && binding.id.toLowerCase() !== binding.database_id.toLowerCase())) fail('unreadable_d1_identity');
      databases.push({ binding: binding.name, id: value.toLowerCase() });
    } else if (binding.type === 'r2_bucket') {
      if (!BUCKET.test(binding.bucket_name ?? '')) fail('unreadable_r2_identity');
      buckets.push({ binding: binding.name, bucket: binding.bucket_name });
    } else if (binding.type === 'assets') {
      // Assets contain no mutable D1/R2 identity for this comparison.
    } else if (['plain_text', 'secret_text', 'json'].includes(binding.type)) {
      // Even if the API includes `text`/`json`, the value never leaves this function.
      if (role === 'test' && !['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SESSION_SECRET'].includes(binding.name)) externalBindingCount++;
    } else {
      // Includes unresolved `inherit`, services, queues, KV, DO, workflows, etc.
      issues.push('additional_or_unresolved_resource_binding');
    }
  }
  if (databases.filter((r) => r.binding === 'DB').length !== 1 || buckets.filter((r) => r.binding === 'BUILDS').length !== 1) issues.push('required_resource_binding_missing');
  if (role === 'test' && (databases.length !== 1 || buckets.length !== 1)) issues.push('unexpected_test_storage_binding');
  if (externalBindingCount) issues.push('test_integration_binding_needs_review');
  // Do not emit arbitrary binding names: only resource IDs and expected-binding flags.
  return { versionId: expectedId.toLowerCase(), databaseIds: unique(databases.map((r) => r.id)),
    bucketNames: unique(buckets.map((r) => r.bucket)), issues: unique(issues),
    expectedBindingsPresent: databases.some((r) => r.binding === 'DB') && buckets.some((r) => r.binding === 'BUILDS') };
}

function readSchedules(result) {
  if (!Array.isArray(result?.schedules) || result.schedules.some((row) => typeof row?.cron !== 'string')) fail('schedules_not_available');
  return result.schedules.map((row) => row.cron).sort();
}

export function compareResources(production, test, testWorker, scheduleCount) {
  if (!production.length) fail('production_evidence_required');
  const prodDbs = new Set([PRODUCTION.databaseId, ...production.flatMap((v) => v.databaseIds)]);
  const prodBuckets = new Set([PRODUCTION.bucket, ...production.flatMap((v) => v.bucketNames)]);
  const sharedDatabaseIds = test.databaseIds.filter((id) => prodDbs.has(id));
  // Conservatively treat equal bucket names as shared even if jurisdiction differs.
  const sharedBucketNames = test.bucketNames.filter((name) => prodBuckets.has(name));
  const issues = unique([...production.flatMap((v) => v.issues), ...test.issues,
    ...(sharedDatabaseIds.length ? ['shared_production_d1'] : []),
    ...(sharedBucketNames.length ? ['shared_production_r2'] : []),
    ...(testWorker === PRODUCTION.worker ? ['same_worker_as_production'] : []),
    ...(scheduleCount ? ['test_cron_enabled'] : [])]);
  return { status: issues.length ? 'blocked' : 'resource_separation_observed', issues,
    sharedDatabaseIds, sharedBucketNames, testScheduleCount: scheduleCount,
    remoteWritesAuthorized: false, launchApproved: false,
    remainingChecks: ['verify_test_url_matches_exact_version', 'review_test_only_secrets_and_seed_data',
      'verify_backup_and_migration_plan', 'verify_no_email_cms_or_publish_side_effects',
      'enable_only_reviewed_authenticated_test_routes'] };
}

/** Controlled API client: a fixed origin, GET only, no redirects and bounded responses. */
function metadataClient({ accountId, token }, fetchImpl) {
  return async (worker, suffix) => {
    if (!WORKER.test(worker) || !/^(deployments|schedules|versions\/[0-9a-f-]{36})$/.test(suffix)) fail('forbidden_metadata_path');
    const url = `${API}/accounts/${accountId}/workers/scripts/${worker}/${suffix}`;
    let response;
    try { response = await fetchImpl(url, { method: 'GET', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(20000) }); }
    catch { fail('cloudflare_metadata_request_failed'); }
    if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'cloudflare_read_permission_required' : 'cloudflare_metadata_unavailable');
    if (!response.body) fail('empty_metadata_response');
    const reader = response.body.getReader(); const chunks = []; let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > MAX_JSON_BYTES) { await reader.cancel(); fail('metadata_response_too_large'); }
        chunks.push(value);
      }
    } catch (error) { if (error instanceof AuditError) throw error; fail('metadata_body_read_failed'); }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('invalid_metadata_json'); }
    if (payload?.success !== true || !object(payload.result)) fail('unsuccessful_metadata_response');
    return payload.result;
  };
}

export async function auditIsolation(input, { fetchImpl = globalThis.fetch, now = () => new Date().toISOString() } = {}) {
  try {
    const config = validateInput(input);
    const get = metadataClient(config, fetchImpl);
    const before = activeDeployment(await get(PRODUCTION.worker, 'deployments'));
    const production = [];
    for (const row of before.versions) production.push(inspectVersion(await get(PRODUCTION.worker, `versions/${row.versionId}`), row.versionId, 'production'));
    const test = inspectVersion(await get(config.testWorker, `versions/${config.testVersionId}`), config.testVersionId, 'test');
    const schedulesBefore = readSchedules(await get(config.testWorker, 'schedules'));
    const after = activeDeployment(await get(PRODUCTION.worker, 'deployments'));
    const schedulesAfter = readSchedules(await get(config.testWorker, 'schedules'));
    if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(schedulesBefore) !== JSON.stringify(schedulesAfter)) fail('deployment_or_schedule_changed_during_audit');
    return { schemaVersion: 1, evidence: 'cloudflare_get_metadata', observedAt: now(),
      production: { worker: PRODUCTION.worker, deployment: before, versions: production },
      test: { worker: config.testWorker, ...test },
      ...compareResources(production, test, config.testWorker, schedulesAfter.length),
      notice: 'Metadata-only point-in-time evidence. No database, object content or secret value was exported. This is not authorization to write or publish.' };
  } catch (error) {
    return { schemaVersion: 1, status: 'unverified', remoteWritesAuthorized: false, launchApproved: false,
      error: error instanceof AuditError ? error.code : 'audit_failed',
      notice: 'No isolation conclusion. No changes were requested.' };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await auditIsolation({ accountId: process.env.CF_ACCOUNT_ID,
    testWorker: process.env.CF_TEST_WORKER, testVersionId: process.env.CF_TEST_VERSION_ID,
    token: process.env.CLOUDFLARE_AUDIT_API_TOKEN });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.status === 'resource_separation_observed' ? 0 : 2;
}
