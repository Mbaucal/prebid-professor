// Public labels only. Stored version identities, hashes and release files stay exact.
export function runtimeLabel(version: unknown) {
  if (typeof version !== 'string' || !version.trim()) return 'Invalid saved version';
  const value = version.trim();
  return /^(\d+\.\d+\.\d+)-(?:tessera|revenue)\.preview\.\d+$/.exec(value)?.[1] ?? value;
}

// Keep one public entry per release, preferring its stable notes over earlier builds.
// Return original records without changing the code-owned history or saved pins.
export function publicRuntimeHistory<T extends { version: string }>(history: readonly T[]): T[] {
  const entries: T[] = [];
  const versions = new Map<string, number>();
  for (const entry of history) {
    const label = runtimeLabel(entry.version);
    const previous = /^\d+\.\d+\.\d+$/.test(label) ? versions.get(label) : undefined;
    if (previous === undefined) {
      versions.set(label, entries.length);
      entries.push(entry);
    } else if (entry.version === label && entries[previous].version !== label) {
      entries[previous] = entry;
    }
  }
  return entries;
}
