// Display only. Stored version identities, hashes and release files stay exact.
export const runtimeLabel = (version: unknown) => typeof version === 'string' && version.trim()
  ? version.replace(/-tessera\.preview\.\d+$/, '')
  : 'Invalid saved version';
