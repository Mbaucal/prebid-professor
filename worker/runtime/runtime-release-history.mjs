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
  assertRuntimeReleaseSource(descriptor.codeSha256);
  if (descriptor.id !== currentRuntimeRelease.id || descriptor.version !== currentRuntimeRelease.version) {
    throw new Error('Runtime release notes do not match the bundled version.');
  }
  return runtimeReleaseHistory.map(release => ({
    ...release,
    available: release.id === descriptor.id && release.version === descriptor.version && release.codeSha256 === descriptor.codeSha256,
    saved: release.id === savedPin?.runtimeId && release.version === savedPin?.runtimeVersion && release.codeSha256 === savedPin?.runtimeSha256
  }));
}
