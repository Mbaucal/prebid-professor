// An ad unit's size map key names a size_maps row of the same site; Generate looks it up
// by that exact name (case-sensitive, as saved) and refuses the package when it is gone.
// Every ad-unit write that stores a key therefore proves, inside its own D1 batch, that
// each named map is still saved: the same json_each count check as the Unit rules save
// (ADM-5). A map renamed or deleted in another tab after the request read it, or before
// an old open form or CSV preview is saved, then refuses the whole write. Saved keys are
// already trimmed; an empty key (no size map) needs no map.

export const SIZE_MAPS_SAVED_SQL =
  '(SELECT count(*) FROM size_maps WHERE publisher_id = ? AND name IN (SELECT value FROM json_each(?))) = ?';

/** The distinct non-empty keys a write stores. */
export function sizeMapNames(keys: Iterable<unknown>): string[] {
  const names = new Set<string>();
  for (const key of keys) if (typeof key === 'string' && key) names.add(key);
  return [...names];
}

export function sizeMapsSavedArgs(siteId: string, names: string[]): [string, string, number] {
  return [siteId, JSON.stringify(names), names.length];
}

/** The names that are not saved for this site now, in the order given. */
export async function missingSizeMaps(db: D1Database, siteId: string, names: string[]): Promise<string[]> {
  if (!names.length) return [];
  const result = await db
    .prepare('SELECT name FROM size_maps WHERE publisher_id = ? AND name IN (SELECT value FROM json_each(?))')
    .bind(siteId, JSON.stringify(names))
    .all<{ name: string }>();
  const saved = new Set((result.results ?? []).map((row) => row.name));
  return names.filter((name) => !saved.has(name));
}

/** 'Size map "P" does not exist' or 'Size maps "P", "Q" do not exist'. */
export function sizeMapsMissing(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`).join(', ');
  return names.length === 1 ? `Size map ${quoted} does not exist` : `Size maps ${quoted} do not exist`;
}
