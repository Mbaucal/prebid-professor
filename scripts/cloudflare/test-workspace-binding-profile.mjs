/** MBA-19 / MBA-53: exact profile from the reviewed isolated workspace config.
 * Only compare public configuration values. Never read a secret value or export
 * raw bindings, unexpected names or their contents. TEST_ is a detection signal,
 * NOT a wildcard allowlist. This module has no I/O and grants no write permission.
 */
export const WORKSPACE_IDENTITY = Object.freeze({
  accountId: 'b5e5e6f70b811e8f97af71df1af46308',
  worker: 'prebid-professor-test',
  databaseId: 'd27843e4-a53c-403a-baed-04a193f6d5c6',
  bucket: 'prebid-professor-test-builds',
});
const variables = Object.freeze({
  TEST_WORKSPACE_ENABLED: 'true',
  TEST_PUBLIC_ORIGIN: 'https://prebid-professor-test.mbaucal.workers.dev',
  TEST_WORKER_NAME: WORKSPACE_IDENTITY.worker,
  TEST_DATABASE_ID: WORKSPACE_IDENTITY.databaseId,
  TEST_BUCKET_NAME: WORKSPACE_IDENTITY.bucket,
});
const secrets = new Set(['TEST_ADMIN_EMAIL', 'TEST_ADMIN_PASSWORD', 'TEST_SESSION_SECRET']);

// Called only after inspectVersion has validated shape and unique binding names.
export function inspectWorkspaceBindings(bindings) {
  if (!bindings.some((binding) => binding.name.startsWith('TEST_'))) return null;
  const variableMatches = new Set(); const secretMatches = new Set();
  let databaseMatches = false; let bucketMatches = false;
  let unexpectedBindingCount = 0; let invalidBindingCount = 0;
  for (const binding of bindings) {
    if (binding.name === 'DB') {
      databaseMatches = binding.type === 'd1' &&
        (binding.database_id ?? binding.id)?.toLowerCase() === WORKSPACE_IDENTITY.databaseId;
      if (!databaseMatches) invalidBindingCount++;
    } else if (binding.name === 'BUILDS') {
      bucketMatches = binding.type === 'r2_bucket' && binding.bucket_name === WORKSPACE_IDENTITY.bucket;
      if (!bucketMatches) invalidBindingCount++;
    } else if (secrets.has(binding.name)) {
      // Deliberately never access text/json/value, even if the API includes it.
      if (binding.type === 'secret_text') secretMatches.add(binding.name);
      else invalidBindingCount++;
    } else if (Object.hasOwn(variables, binding.name)) {
      if (binding.type === 'plain_text' && binding.text === variables[binding.name]) variableMatches.add(binding.name);
      else invalidBindingCount++;
    } else {
      // Also rejects legacy auth names, TEST_CMS_TOKEN and extra resource bindings.
      unexpectedBindingCount++;
    }
  }
  const requiredSecretsPresent = secretMatches.size === secrets.size;
  const publicConfigurationMatches = variableMatches.size === Object.keys(variables).length;
  const expectedStorageMatches = databaseMatches && bucketMatches;
  const issues = [];
  if (unexpectedBindingCount) issues.push('test_integration_binding_needs_review');
  if (invalidBindingCount) issues.push('test_workspace_binding_mismatch');
  if (!requiredSecretsPresent || !publicConfigurationMatches || !expectedStorageMatches) issues.push('test_workspace_profile_incomplete');
  return {
    issues,
    summary: {
      profile: 'isolated_workspace_v1',
      requiredSecretsPresent, publicConfigurationMatches, expectedStorageMatches,
      unexpectedBindingCount, invalidBindingCount,
      secretValuesInspected: false,
    },
  };
}
