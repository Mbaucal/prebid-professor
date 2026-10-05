import { prebidRequirements, inspectPrebidArtifact } from './prebid-artifact-check.mjs';
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: HEADERS });

/** The authenticated route supplies the real snapshot reader and generator adapter.
 * Dependencies are explicit so tests can forbid every write and network side effect.
 */
export async function handlePrebidPreflight(request, env, siteId, { readSnapshot, normalizeInput, digest, runtime }) {
  if (request.method !== 'GET') return reply({ error: 'Method not allowed.' }, 405);
  if (!/^[a-z0-9][a-z0-9-]{0,97}$/.test(siteId)) return reply({ error: 'Invalid site ID.' }, 400);
  const url = new URL(request.url);
  const expected = url.searchParams.get('reviewHash');
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) return reply({ error: 'Refresh settings before checking Prebid.js.' }, 409);
  if (url.searchParams.get('runtimeSha256') !== runtime.codeSha256) return reply({ error: 'Runtime changed. Refresh settings before checking Prebid.js.' }, 409);
  try {
    const snapshot = await readSnapshot(env.DB, siteId, { includePrebid: true });
    const { prebidBuilds = [], ...configuration } = snapshot;
    if (configuration.site?.id !== siteId) return reply({ error: 'Site mismatch. No build was checked.' }, 409);
    if (await digest(configuration) !== expected) return reply({ error: 'Site configuration changed after review. Refresh settings and check again.' }, 409);
    const originalHash = await digest(snapshot);
    const input = normalizeInput(configuration, runtime, 'preflight');
    const config = JSON.parse(configuration.config.config_json);
    const requirements = prebidRequirements(input, config);
    // No R2 binding is accessed for the explicit GPT-only mode.
    const report = await inspectPrebidArtifact({ siteId, builds: prebidBuilds, requirements }, requirements.required ? env.BUILDS : undefined);
    const latest = await readSnapshot(env.DB, siteId, { includePrebid: true });
    if (await digest(latest) !== originalHash) return reply({ error: 'Site settings or the current Prebid build changed during the check. Refresh settings and check again.' }, 409);
    return reply({ ok: true, report: { ...report, reviewHash: expected, runtimeSha256: runtime.codeSha256, checkedAt: new Date().toISOString() } });
  } catch {
    // Do not leak database errors, storage keys or any saved bidder credentials.
    return reply({ error: 'Prebid file check could not be completed. Refresh settings, verify the selected Prebid build and try again.' }, 422);
  }
}
