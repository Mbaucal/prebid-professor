import { zipSync } from 'fflate';
import { runtimeDescriptor, readPreviewSnapshot } from './builtin-preview-service.mjs';
import { previewInput, digest, assertReview } from './preview-snapshot.mjs';
import { pinRuntime } from './version-pin.mjs';
import { prebidRequirements, inspectPrebidArtifact } from './prebid-artifact-check.mjs';
import { buildArtifactCandidate } from './artifact-candidate.mjs';

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
const fail = (error, status) => new Response(JSON.stringify({ error }), { status, headers: HEADERS });
const MAX_PREBID_BYTES = 8 * 1024 * 1024;
async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('JSON body is required.');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 24000) { await reader.cancel(); throw new Error('Candidate request exceeds 24 KB.'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Auth is enforced by app-builtin-runtime-preview before entering this route. */
export async function handleArtifactBundle(request, env, siteId) {
  if (request.method !== 'POST') return fail('Method not allowed.', 405);
  if (!/^[a-z0-9][a-z0-9-]{0,97}$/.test(siteId)) return fail('Invalid site ID.', 400);
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return fail('JSON body is required.', 415);
  let body;
  try { body = await readBody(request); } catch { return fail('A valid JSON request up to 24 KB is required.', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['reviewHash', 'runtimeVersion', 'runtimeSha256', 'allowPreview', 'takeOver'].includes(key))) {
    return fail('Invalid candidate request. Browser source or artifact input is not accepted.', 422);
  }
  if (body.allowPreview !== true) return fail('Explicit candidate review acknowledgement is required.', 422);
  if (body.runtimeVersion !== runtimeDescriptor.version || body.runtimeSha256 !== runtimeDescriptor.codeSha256) return fail('Runtime changed. Refresh settings before generating the candidate.', 409);
  let snapshot, prebidBuilds;
  try {
    const current = await readPreviewSnapshot(env.DB, siteId, { includePrebid: true });
    ({ prebidBuilds, ...snapshot } = current);
    if (snapshot.site.id !== siteId) return fail('Site mismatch. No bundle was generated.', 409);
    await assertReview(snapshot, body.reviewHash);
  } catch (error) {
    return fail(error.message?.includes('changed after review') ? 'Site configuration changed after review. Refresh settings and generate again.' : 'Saved site settings could not be read.', error.message?.includes('changed after review') ? 409 : 422);
  }
  const reviewedHash = await digest({ ...snapshot, prebidBuilds });
  const buildTimestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  let input;
  try { input = previewInput(snapshot, runtimeDescriptor, buildTimestamp, body.takeOver ?? { enabled: false }); }
  catch { return fail('The saved configuration contains an unsupported setting. Refresh settings and resolve the validation message before creating a candidate.', 422); }
  const requirements = prebidRequirements(input, JSON.parse(snapshot.config.config_json));
  let verified = null;
  if (requirements.required) {
    if (!env.BUILDS) return fail('R2 build storage is not configured.', 503);
    let bytes = null;
    // Same bytes are inspected and included; no second R2 download or mutable "latest" URL.
    const readOnlyBucket = { async get(key) {
      const object = await env.BUILDS.get(key);
      if (!object) return null;
      if (object.size > MAX_PREBID_BYTES) throw new Error('Candidate Prebid file exceeds 8 MB.');
      return { size: object.size, customMetadata: object.customMetadata,
        async arrayBuffer() { bytes = await object.arrayBuffer(); return bytes; } };
    } };
    const report = await inspectPrebidArtifact({ siteId, builds: prebidBuilds, requirements }, readOnlyBucket);
    if (report.status !== 'checked' || !bytes) return fail('Prebid artifact verification failed. Use Check Prebid file to inspect the selected build. Candidate downloads support files up to 8 MB.', 422);
    verified = { report, bytes };
  }
  try {
    const candidate = await buildArtifactCandidate({ snapshot, pin: pinRuntime(runtimeDescriptor, { allowPreview: true }),
      takeOver: body.takeOver ?? { enabled: false }, buildTimestamp, prebid: verified });
    const current = await readPreviewSnapshot(env.DB, siteId, { includePrebid: true });
    if (await digest(current) !== reviewedHash) return fail('Site settings or the current Prebid build changed during generation. Refresh settings and generate again.', 409);
    const files = Object.fromEntries(Object.entries(candidate.files).map(([name, data]) => [name, [data, { level: 0, mtime: new Date('1980-01-01T00:00:00Z') }]]));
    const zip = zipSync(files, { level: 0 });
    return new Response(zip, { headers: {
      'content-type': 'application/zip', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="${siteId}-candidate-${buildTimestamp}.zip"`,
      'x-tessera-artifact-kind': 'review-candidate', 'x-tessera-site-id': siteId,
      'x-tessera-runtime-sha256': runtimeDescriptor.codeSha256,
    } });
  } catch {
    return fail('The candidate bundle could not be generated. Check the saved size maps, output options and selected Prebid artifact. No release was saved or published.', 422);
  }
}
