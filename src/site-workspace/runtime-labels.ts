// Public labels only. Stored version identities, hashes and release files stay exact.
export function runtimeLabel(version: unknown) {
  if (typeof version !== 'string' || !version.trim()) return 'Invalid saved version';
  const value = version.trim();
  return /^(\d+\.\d+\.\d+)-(?:tessera|revenue)\.preview\.\d+$/.exec(value)?.[1] ?? value;
}

// Offer supported numeric releases without relabeling a development generator.
// A saved earlier build is handled separately by the UI and keeps its exact pin.
export function publicRuntimeChoices<T extends { version: string; channel?: string }>(runtimes: readonly T[]): T[] {
  const releases = new Map<string, T>();
  for (const runtime of runtimes) {
    if (!/^\d+\.\d+\.\d+$/.test(runtime.version)) continue;
    const previous = releases.get(runtime.version);
    if (!previous || (runtime.channel === 'stable' && previous.channel !== 'stable')) {
      releases.set(runtime.version, runtime);
    }
  }
  return [...releases.values()].sort((left, right) => {
    const a = runtimeLabel(left.version).split('.').map(Number);
    const b = runtimeLabel(right.version).split('.').map(Number);
    return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
  });
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
