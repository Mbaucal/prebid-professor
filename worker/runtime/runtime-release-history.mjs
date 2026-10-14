/** Code-owned release notes. Editing notes never changes a saved engine pin.
 * The two existing preview.2 builds predate this register; keep both identities.
 * Future engine changes must append a new version, retaining these records.
 */
import releases from './runtime-releases.json' with { type: 'json' };
export const runtimeReleaseHistory = releases;

export const currentRuntimeRelease = runtimeReleaseHistory[0];

export function assertRuntimeReleaseSource(codeSha256, release = currentRuntimeRelease) {
  if (codeSha256 !== release.codeSha256) {
    throw new Error('Runtime source changed. Register a new exact runtime version with its source checksum and change notes before building. Do not replace an existing release record.');
  }
}

/** History is informational. Only the actually bundled descriptor is selectable. */
export function describeRuntimeReleases(descriptor, savedPin) {
  const catalog=Array.isArray(descriptor)?descriptor:[descriptor];
  for(const entry of catalog){
    const release=runtimeReleaseHistory.find(r=>r.id===entry.id&&r.version===entry.version&&r.codeSha256===entry.codeSha256);
    if(!release)throw Error('Runtime release notes do not match the bundled version.');
  }
  return runtimeReleaseHistory.map(release => ({
    ...release,
    available: catalog.some(entry=>release.id===entry.id&&release.version===entry.version&&release.codeSha256===entry.codeSha256),
    saved: release.id === savedPin?.runtimeId && release.version === savedPin?.runtimeVersion && release.codeSha256 === savedPin?.runtimeSha256
  }));
}
