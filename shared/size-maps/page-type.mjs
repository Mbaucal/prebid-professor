/**
 * Page-type size maps, exactly as every Tessera generator selects them.
 *
 * Reference 3.9.1 baseUnitConfigById (built-in 3.16.0 to 3.21.2 and every
 * operator template built from it) builds each prefix from
 * window.adsKeywords[PAGE_TYPE_KEYS[i]] as String(value).toLowerCase() with
 * whitespace runs replaced by "_", joins several keys with "_", and then uses
 * SIZE_MAPS_RAW[prefix + "_" + sizeMapName] when that exact saved name exists.
 * Map selection is fixed at page load and never reads rules or ad-unit settings.
 *
 * The prefixes that rule can produce are exactly the non-empty strings that are
 * already lower case and contain no whitespace. Diacritics, dots and leading
 * digits are allowed: the size-map CSV import stores such names (for example
 * "članak_P"), and a page type "Članak" selects them.
 * Pure functions: used by the Worker and by the admin UI preview.
 */

/** The page type that selects `name` instead of `base`, or null. */
export function pageTypeOf(name, base) {
  if (typeof name !== 'string' || typeof base !== 'string' || !base) return null;
  if (name.length <= base.length + 1 || !name.endsWith('_' + base)) return null;
  const prefix = name.slice(0, name.length - base.length - 1);
  // String#toLowerCase is idempotent and whitespace is folded to "_", so these are
  // exactly the values computePageTypePrefixes() can produce.
  return prefix && prefix === prefix.toLowerCase() && !/\s/.test(prefix) ? prefix : null;
}

/**
 * Renaming `from` to `to` renames the page-type maps of `from` (<page type>_<from>)
 * the same way. `unitBases` holds every ad unit's saved size map. The rename never
 * carries a map that is itself an ad unit's size map or a page-type map of another
 * base in use, and carries nothing when `from` is itself a page-type map of a base
 * in use. Those selections change instead, and the caller asks for confirmation.
 */
export function pageTypeRenames(names, from, to, unitBases = new Set()) {
  const renames = new Map();
  if (from === to) return renames;
  renames.set(from, to);
  const bases = [...unitBases].filter(base => typeof base === 'string' && base && base !== from);
  const variantOfOther = name => bases.some(base => pageTypeOf(name, base) !== null);
  if (variantOfOther(from)) return renames;
  for (const name of names) {
    const pageType = pageTypeOf(name, from);
    if (pageType === null || unitBases.has(name) || variantOfOther(name)) continue;
    renames.set(name, `${pageType}_${to}`);
  }
  return renames;
}

/** Codes in saved order; three or more consecutive numbered codes become P1–P8. */
export function compactCodes(codes) {
  const parts = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) parts.push(`${run[0].code}–${run[run.length - 1].code}`);
    else parts.push(...run.map(item => item.code));
    run = [];
  };
  for (const code of codes) {
    const match = /^(.*?)(\d+)$/.exec(code);
    const item = match ? { code, stem: match[1], number: Number(match[2]) } : { code, stem: null, number: NaN };
    const last = run[run.length - 1];
    if (last && item.stem !== null && item.stem === last.stem && item.number === last.number + 1) run.push(item);
    else { flush(); run = [item]; }
  }
  flush();
  return parts.join(', ');
}

/**
 * For every base map that in-page ad units use: which saved map each page type selects.
 * units: [{code, base}] in saved order (TakeOver positions excluded by the caller,
 * because their configuration bypasses baseUnitConfigById).
 */
export function pageTypeUse(names, units) {
  const byBase = new Map();
  for (const unit of units) if (unit.base) byBase.set(unit.base, [...(byBase.get(unit.base) ?? []), unit.code]);
  const result = [];
  for (const [base, codes] of byBase) {
    for (const name of names) {
      const pageType = pageTypeOf(name, base);
      if (pageType !== null) result.push({ base, pageType, map: name, codes });
    }
  }
  return result;
}

/**
 * Page-type selections that a rename or delete changes, after following renames.
 * A rename that carries a base together with its page-type maps returns [].
 */
export function pageTypeChanges({ names, units, renames = new Map(), deleted = new Set() }) {
  const rename = name => renames.get(name) ?? name;
  const namesAfter = names.filter(name => !deleted.has(name)).map(rename);
  const unitsAfter = units.map(unit => ({ code: unit.code, base: unit.base ? rename(unit.base) : unit.base }));
  const before = pageTypeUse(names, units), after = pageTypeUse(namesAfter, unitsAfter);
  const key = (base, pageType) => `${base}\u0000${pageType}`;
  const selected = new Map(), changes = new Map();
  for (const use of after) selected.set(key(use.base, use.pageType), use);
  for (const use of before) {
    const base = rename(use.base), next = selected.get(key(base, use.pageType));
    const previous = deleted.has(use.map) ? null : rename(use.map);
    if (next?.map === previous) { selected.delete(key(base, use.pageType)); continue; }
    changes.set(key(base, use.pageType), { pageType: use.pageType, base, codes: use.codes, from: use.map, to: next?.map ?? null });
    selected.delete(key(base, use.pageType));
  }
  for (const use of selected.values()) {
    changes.set(key(use.base, use.pageType), { pageType: use.pageType, base: use.base, codes: use.codes, from: null, to: use.map });
  }
  return [...changes.values()].sort((a, b) => compare(a.base, b.base) || compare(a.pageType, b.pageType));
}

/** Locale-independent order, so the Worker and every browser list changes identically. */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort order of page-type changes; the UI uses it to build the same list from the listing. */
export function comparePageTypeChanges(a, b) {
  return compare(a.base, b.base) || compare(a.pageType, b.pageType);
}

/** One plain English line per change, in the existing admin wording style. */
export function describePageTypeChange(change) {
  const codes = compactCodes(change.codes);
  if (change.from && !change.to) return `Page type ${change.pageType}: ${codes} will use ${change.base} instead of ${change.from}.`;
  if (!change.from && change.to) return `Page type ${change.pageType}: ${codes} will use ${change.to} instead of ${change.base}.`;
  return `Page type ${change.pageType}: ${codes} will use ${change.to} instead of ${change.from}.`;
}
