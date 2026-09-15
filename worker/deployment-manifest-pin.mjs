import { sha256 } from './runtime/prebid-artifact-check.mjs';

/** Pin the private source manifest before creating/dispatching a deployment.
 * This grants no permission to publish a stored built-in draft.
 */
export async function deploymentManifestPin(bucket, siteId, release) {
  const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
  if (typeof siteId !== 'string' || typeof release?.version !== 'string' || typeof release?.id !== 'string'
    || !segment.test(siteId) || !segment.test(release.version) || !segment.test(release.id)
    || siteId.includes('..') || release.version.includes('..')
    || release.id.startsWith('builtin-draft-') || release.version.startsWith('builtin-draft-')) throw Error('Release cannot use this deployment path.');
  const expectedKey = `publishers/${siteId}/releases/${release.version}/manifest.json`;
  if (!bucket || release.manifest_key !== expectedKey) throw Error('The stored release manifest is unavailable.');
  const object = await bucket.get(expectedKey);
  if (!object || !Number.isSafeInteger(object.size) || object.size < 1 || object.size > 256 * 1024) throw Error('The stored release manifest has an invalid size.');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== object.size) throw Error('The stored release manifest length differs.');
  const hash = await sha256(bytes);
  if (object.customMetadata?.sha256 !== hash) throw Error('The stored release manifest checksum differs.');
  const manifest = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
  if (manifest.schemaVersion !== 1 || manifest.siteId !== siteId || manifest.releaseId !== release.id || manifest.version !== release.version
    || manifest.configHash !== release.config_hash || manifest.kind === 'builtin-runtime-candidate') throw Error('The stored release manifest belongs to another release.');
  return hash;
}
