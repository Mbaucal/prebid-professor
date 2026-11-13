import type { SizeMapPageTypeConfirmation, SizeMapReference } from '../src/shared/types';
import { compactCodes, describePageTypeChange, pageTypeChanges, pageTypeRenames, pageTypeUse } from '../shared/size-maps/page-type.mjs';

type RuleRow = { id: string; rule_key: string; rule_json: string; updated_at: string };
type UnitRow = { id: string; code: string; size_map_key: string | null; sort_order: number | null; updated_at: string };
type ConfigRow = { config_json: string };
type MapRow = { id: string; name: string; map_json: string; updated_at: string };
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** Saved references that block a delete until the operator reassigns them. */
const EXPLICIT = new Set<SizeMapReference['source']>(['ad-unit', 'rule', 'advanced-rule']);
const MAX_NAME_LENGTH = 128;
function parsed(value: string, label: string): RecordValue {
  let result: unknown;
  try { result = JSON.parse(value); } catch { throw new Error(`${label} contains invalid saved JSON. Review it before changing size maps.`); }
  if (!record(result)) throw new Error(`${label} contains invalid saved settings. Review it before changing size maps.`);
  return result;
}
function mappings(rule: unknown): RecordValue[] {
  if (!record(rule) || rule.conditionalMappings == null) return [];
  if (!Array.isArray(rule.conditionalMappings) || rule.conditionalMappings.some(item => !record(item))) {
    throw new Error('Saved conditional mappings are invalid. Review unit rules before changing size maps.');
  }
  return rule.conditionalMappings as RecordValue[];
}
function savedRuleGroups(config: RecordValue | null, key: string): RecordValue {
  const value = config?.[key];
  if (value == null) return {};
  if (!record(value) || Object.values(value).some(rule => !record(rule))) throw new Error('Saved rule groups are invalid. Review site configuration before changing size maps.');
  return value;
}
function scopeLabel(scope: string): string {
  const labels: Record<string, string> = { __DEFAULT__: 'Default', __ATF__: 'ATF group', __BTF__: 'BTF group', __INTERSTITIAL__: 'Interstitial fallback' };
  return Object.hasOwn(labels, scope) ? labels[scope] : scope;
}
/** TakeOver positions return their overlay unit before baseUnitConfigById, so page types never apply. */
function takeOverCodes(config: RecordValue | null): Set<string> {
  const runtime = config?.runtimeControls;
  const positions = record(runtime) ? runtime.adPositions : null;
  return new Set(record(positions) ? Object.keys(positions) : []);
}
/** Responsive Outstream choices are keyed "<map name>@<width>x<height>" (shared/outstream/settings-v3.mjs). */
function outstreamUnits(config: RecordValue | null): Array<[string, RecordValue]> {
  const runtime = config?.runtimeControls;
  const outstream = record(runtime) ? runtime.outstream : null;
  const units = record(outstream) ? outstream.units : null;
  if (!record(units)) return [];
  return Object.entries(units).filter((entry): entry is [string, RecordValue] =>
    record(entry[1]) && entry[1].playerSizing === 'size-map' && record(entry[1].playerSizes));
}
function keyMap(key: string): string | null {
  const at = key.lastIndexOf('@');
  return at > 0 ? key.slice(0, at) : null;
}
/** Same family rule as playerSizeMaps(): the assigned map and every saved name ending in _<map>. */
const outstreamFamily = (name: string, base: string) => name === base || name.endsWith('_' + base);
/** Rows as the generators compare them (viewport + sizes, ascending viewport). */
function comparableRows(json: string): string {
  let rows: unknown;
  try { rows = JSON.parse(json); } catch { return json; }
  if (!Array.isArray(rows)) return json;
  return JSON.stringify(rows.map(row => {
    const value = record(row) ? row : {};
    return { viewport: value.minViewPort ?? value.viewport, sizes: value.sizes };
  }).sort((a, b) => {
    const left = Array.isArray(a.viewport) ? a.viewport : [], right = Array.isArray(b.viewport) ? b.viewport : [];
    return (Number(left[0]) - Number(right[0]) || Number(left[1]) - Number(right[1])) || 0;
  }));
}
const TAKEOVER_PAGE_TYPES = 'This script version does not support TakeOver maps by page type. Your maps are kept; this requires a future script version, or an explicit change to Standard display.';

export async function readSizeMapReferences(db: D1Database, siteId: string) {
  const [rules, units, config, maps] = await Promise.all([
    db.prepare('SELECT id, rule_key, rule_json, updated_at FROM unit_rules WHERE publisher_id = ? ORDER BY id').bind(siteId).all<RuleRow>(),
    db.prepare('SELECT id, code, size_map_key, sort_order, updated_at FROM ad_units WHERE publisher_id = ? ORDER BY id').bind(siteId).all<UnitRow>(),
    db.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1').bind(siteId).first<ConfigRow>(),
    db.prepare('SELECT id, name, map_json, updated_at FROM size_maps WHERE publisher_id = ? ORDER BY id').bind(siteId).all<MapRow>(),
  ]);
  if (!rules.success || !units.success || !maps.success) throw new Error('Saved size-map references could not be read.');
  const ruleRows = rules.results ?? [], unitRows = units.results ?? [], mapRows = maps.results ?? [];
  const configValue = config ? parsed(config.config_json, 'Site configuration') : null;
  const ruleValues = ruleRows.map(row => ({ row, value: parsed(row.rule_json, `Rule ${row.rule_key}`) }));
  const byMap = new Map<string, SizeMapReference[]>();
  function add(name: string, reference: SizeMapReference) { byMap.set(name, [...(byMap.get(name) ?? []), reference]); }
  for (const unit of unitRows) if (unit.size_map_key) add(unit.size_map_key, { source: 'ad-unit', scope: unit.code, label: unit.code });
  function addRule(rule: unknown, source: 'rule' | 'advanced-rule', scope: string) {
    mappings(rule).forEach((mapping, index) => {
      if (typeof mapping.sizeMapKey !== 'string' || !mapping.sizeMapKey) return;
      const name = typeof mapping.name === 'string' && mapping.name.trim() ? mapping.name.trim() : `Mapping ${index + 1}`;
      add(mapping.sizeMapKey, { source, scope, label: `${scopeLabel(scope)}: ${name}${source === 'advanced-rule' ? ' (advanced)' : ''}${mapping.enabled === false ? ' (disabled)' : ''}` });
    });
  }
  ruleValues.forEach(({ row, value }) => addRule(value, 'rule', row.rule_key));
  for (const [scope, rule] of Object.entries(savedRuleGroups(configValue, 'unitRules'))) {
    // The config mirror normally duplicates the table. Retain orphaned/stale saved
    // references too, without counting an identical mirror twice in the UI.
    const basic = ruleValues.find(({ row }) => row.rule_key === scope)?.value;
    if (JSON.stringify(mappings(rule)) !== JSON.stringify(mappings(basic))) addRule(rule, 'rule', scope);
  }
  for (const [scope, rule] of Object.entries(savedRuleGroups(configValue, 'advancedUnitRules'))) addRule(rule, 'advanced-rule', scope);
  // Implicit page-type use: the generator selects <page type>_<base> by name for in-page units.
  const takeOver = takeOverCodes(configValue);
  const pageUnits = [...unitRows]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.code.localeCompare(b.code))
    .filter(unit => !takeOver.has(unit.code))
    .map(unit => ({ code: unit.code, base: unit.size_map_key }));
  const mapNames = mapRows.map(row => row.name);
  for (const use of pageTypeUse(mapNames, pageUnits)) {
    add(use.map, { source: 'page-type', scope: use.base, label: `Page type ${use.pageType}: ${compactCodes(use.codes)} (via ${use.base})`, pageType: use.pageType, baseMap: use.base, units: use.codes });
  }
  for (const [code, settings] of outstreamUnits(configValue)) {
    const names = new Set(Object.keys(settings.playerSizes as RecordValue).map(keyMap).filter((name): name is string => Boolean(name)));
    for (const name of names) add(name, { source: 'outstream', scope: code, label: `${code}: Outstream video sizes` });
  }
  return { ruleRows, unitRows, mapRows, config, configValue, ruleValues, byMap, pageUnits };
}

export type SizeMapMutationFailure = {
  status: number;
  error: string;
  references?: SizeMapReference[];
  confirmation?: SizeMapPageTypeConfirmation;
};

async function changesToken(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Rewrites saved Outstream choices for renamed/deleted maps; returns what changed for the audit,
 * and every saved key that a renamed key would overwrite (the caller refuses those). */
function rewriteOutstream(config: RecordValue | null, unitRows: UnitRow[], renames: Map<string, string>, deleted: Set<string>) {
  const renamed: string[] = [], removed: string[] = [], overwritten: Array<{ code: string; key: string }> = [];
  const baseOf = new Map(unitRows.map(unit => [unit.code, unit.size_map_key]));
  for (const [code, settings] of outstreamUnits(config)) {
    const base = baseOf.get(code) ?? null;
    const baseAfter = base === null ? null : renames.get(base) ?? base;
    const next: RecordValue = {};
    let touched = false;
    for (const [key, value] of Object.entries(settings.playerSizes as RecordValue)) {
      const name = keyMap(key);
      if (name === null) { next[key] = value; continue; }
      if (deleted.has(name)) { removed.push(`${code}: ${key}`); touched = true; continue; }
      const nameAfter = renames.get(name) ?? name;
      // Only a choice that this change moves out of the unit's map family is dropped;
      // older unrelated keys stay for Formats review exactly as saved.
      if ((renames.has(name) || (base !== null && renames.has(base))) && base !== null && baseAfter !== null
        && outstreamFamily(name, base) && !outstreamFamily(nameAfter, baseAfter)) {
        removed.push(`${code}: ${key}`); touched = true; continue;
      }
      const keyAfter = nameAfter + key.slice(name.length);
      if (keyAfter !== key) { renamed.push(`${code}: ${key} -> ${keyAfter}`); touched = true; }
      // Renames are one-to-one and target new names, so a clash is always a renamed key
      // meeting an older saved key for a map that does not exist; never drop either silently.
      if (Object.hasOwn(next, keyAfter)) overwritten.push({ code, key: keyAfter });
      next[keyAfter] = value;
    }
    if (touched) settings.playerSizes = next;
  }
  return { renamed, removed, overwritten };
}

/** The TakeOver Generate guard (worker/test-workspace/runtime-catalog.mjs) refuses any saved
 * map named *_<TakeOver map> whose rows differ from that map. Returns the maps that a rename
 * would newly put into that conflict, so the rename is refused instead of breaking Generate. */
function takeOverConflicts(
  mapRows: MapRow[], configValue: RecordValue | null, unitRows: UnitRow[], renames: Map<string, string>,
  edited: { id: string; map: unknown[] },
): { code: string; base: string; names: string[] } | null {
  const conflicts = (after: boolean) => {
    const maps = mapRows.map(row => ({ id: row.id, name: after ? renames.get(row.name) ?? row.name : row.name,
      rows: comparableRows(after && row.id === edited.id ? JSON.stringify(edited.map) : row.map_json) }));
    const found = new Map<string, { code: string; base: string; ids: Set<string> }>();
    for (const code of takeOverCodes(configValue)) {
      const saved = unitRows.find(unit => unit.code === code)?.size_map_key;
      if (!saved) continue;
      const base = after ? renames.get(saved) ?? saved : saved;
      const baseRows = maps.find(item => item.name === base)?.rows;
      const ids = new Set(maps.filter(item => item.name.endsWith('_' + base) && item.rows !== baseRows).map(item => item.id));
      found.set(code, { code, base, ids });
    }
    return found;
  };
  const before = conflicts(false);
  for (const [code, current] of conflicts(true)) {
    const added = [...current.ids].filter(id => !before.get(code)?.ids.has(id));
    if (!added.length) continue;
    const names = mapRows.filter(row => added.includes(row.id)).map(row => renames.get(row.name) ?? row.name);
    return { code, base: current.base, names };
  }
  return null;
}

/** Snapshot guarded transaction. The audit row is the gate for every write, so a
 * concurrent map/config/rule/unit edit causes no mutation and no audit. A rename
 * carries the map's page-type maps (<page type>_<name>) and every explicit and
 * Outstream reference to any of them; a change that would alter which map a page
 * type selects needs the confirmation token returned by the previous attempt. */
export async function mutateSizeMap(
  db: D1Database, siteId: string, expected: { id: string; name: string; updatedAt: string }, actor: string,
  change: { name: string; map: unknown[] } | null, confirmPageTypeChanges?: unknown,
): Promise<SizeMapMutationFailure | null> {
  const state = await readSizeMapReferences(db, siteId);
  const current = state.mapRows.find(row => row.id === expected.id);
  if (!current || current.name !== expected.name || current.updated_at !== expected.updatedAt) return { status: 409, error: 'Size map changed in another tab. Reload before saving.' };
  const names = state.mapRows.map(row => row.name);
  const references = state.byMap.get(current.name) ?? [];
  const unitBases = new Set(state.unitRows.map(unit => unit.size_map_key).filter((name): name is string => Boolean(name)));
  const renames = change ? pageTypeRenames(names, current.name, change.name, unitBases) : new Map<string, string>();
  const deleted = new Set<string>(change ? [] : [current.name]);
  const renaming = Boolean(change && change.name !== current.name);
  for (const [from, to] of renames) {
    if (to.length > MAX_NAME_LENGTH) return { status: 422, error: `Renaming ${current.name} to ${change!.name} would rename its page-type map ${from} to ${to}, which is longer than ${MAX_NAME_LENGTH} characters. Choose a shorter name.` };
    if (!names.includes(to)) continue;
    return { status: 409, error: from === current.name
      ? `Size map "${to}" already exists on this site.`
      : `Size map "${to}" already exists on this site. Renaming ${current.name} to ${change!.name} also renames its page-type map ${from} to ${to}. Rename or delete ${to} first, or choose another name.` };
  }
  if (!change) {
    const blocking = references.filter(reference => EXPLICIT.has(reference.source));
    if (blocking.length) return { status: 409, error: `Size map "${current.name}" is still used by ${blocking.map(reference => reference.label).join(', ')}. Reassign these references before deleting it.`, references: blocking };
  }
  if (change && renaming) {
    const takeOver = takeOverConflicts(state.mapRows, state.configValue, state.unitRows, renames, { id: current.id, map: change.map });
    if (takeOver) return { status: 409, error: `Renaming ${current.name} to ${change.name} would make ${takeOver.names.join(', ')} a page-type map of TakeOver position ${takeOver.code} (size map ${takeOver.base}) with different sizes. ${TAKEOVER_PAGE_TYPES}` };
  }
  const pageChanges = pageTypeChanges({ names, units: state.pageUnits, renames, deleted });
  const configValue = state.configValue ? structuredClone(state.configValue) : null;
  const outstream = rewriteOutstream(configValue, state.unitRows, renames, deleted);
  if (outstream.overwritten.length) {
    const codes = [...new Set(outstream.overwritten.map(item => item.code))];
    return { status: 409, error: `Renaming ${current.name} to ${change!.name} would replace the saved Outstream video size ${outstream.overwritten.map(item => `${item.key} on ${item.code}`).join(', ')}. Reopen Formats and review the video size choices for ${codes.join(', ')}, or choose another name.` };
  }
  if (pageChanges.length) {
    const token = await changesToken({ pageChanges, outstreamRemoved: outstream.removed });
    if (confirmPageTypeChanges !== token) {
      const action = change ? `Renaming ${current.name} to ${change.name}` : `Deleting ${current.name}`;
      const lines = pageChanges.map(describePageTypeChange);
      const removedFor = [...new Set(outstream.removed.map(item => item.slice(0, item.indexOf(':'))))];
      const video = removedFor.length ? ` Saved Outstream video sizes for this map are removed from ${removedFor.join(', ')}.` : '';
      return { status: 409, error: `${action} changes the size map that page types use. ${lines.join(' ')}${video} Reload size maps to review and confirm this change.`,
        confirmation: { token, changes: pageChanges.map((item, index) => ({ ...item, message: lines[index] })), videoUnits: removedFor } };
    }
  }

  const now = new Date().toISOString(), auditId = crypto.randomUUID();
  const gate = 'EXISTS (SELECT 1 FROM audit_log WHERE id = ?)';
  const pageTypeMaps = [...renames].filter(([from]) => from !== current.name);
  const details = change
    ? { previousName: current.name, name: change.name, breakpoints: change.map.length }
    : { name: current.name };
  const audit = { ...details,
    ...(pageTypeMaps.length ? { pageTypeMaps } : {}),
    ...(pageChanges.length ? { pageTypeChanges: pageChanges.map(describePageTypeChange) } : {}),
    ...(outstream.renamed.length || outstream.removed.length ? { outstreamVideoSizes: { renamed: outstream.renamed, removed: outstream.removed } } : {}) };
  // A rename or delete depends on every map name (cascade targets, page-type selection),
  // so it compares all map rows; a sizes-only edit changes nothing else and compares its own row.
  const mapsGate = renaming || !change
    ? { sql: '(SELECT json_group_array(json_array(id,name,map_json,updated_at)) FROM (SELECT id,name,map_json,updated_at FROM size_maps WHERE publisher_id = ? ORDER BY id)) = ?',
      args: [siteId, JSON.stringify(state.mapRows.map(row => [row.id, row.name, row.map_json, row.updated_at]))] }
    : { sql: 'EXISTS (SELECT 1 FROM size_maps WHERE publisher_id = ? AND id = ? AND name = ? AND map_json = ? AND updated_at = ?)',
      args: [siteId, current.id, current.name, current.map_json, current.updated_at] };
  const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO audit_log (id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at)
    SELECT ?, ?, ?, ?, 'size_map', ?, ?, ? WHERE
    ${mapsGate.sql}
    AND (SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1) IS ?
    AND (SELECT json_group_array(json_array(id,rule_key,rule_json,updated_at)) FROM (SELECT id,rule_key,rule_json,updated_at FROM unit_rules WHERE publisher_id = ? ORDER BY id)) = ?
    AND (SELECT json_group_array(json_array(id,code,size_map_key,updated_at)) FROM (SELECT id,code,size_map_key,updated_at FROM ad_units WHERE publisher_id = ? ORDER BY id)) = ?`)
    .bind(auditId, actor, change ? 'size_map.updated' : 'size_map.deleted', siteId, current.id, JSON.stringify(audit), now,
      ...mapsGate.args,
      siteId, state.config?.config_json ?? null,
      siteId, JSON.stringify(state.ruleRows.map(row => [row.id, row.rule_key, row.rule_json, row.updated_at])),
      siteId, JSON.stringify(state.unitRows.map(row => [row.id, row.code, row.size_map_key, row.updated_at])))];
  if (change) {
    statements.push(db.prepare(`UPDATE size_maps SET name = ?, map_json = ?, updated_at = ? WHERE publisher_id = ? AND id = ? AND ${gate}`).bind(change.name, JSON.stringify(change.map), now, siteId, current.id, auditId));
    for (const [from, to] of pageTypeMaps) {
      const row = state.mapRows.find(item => item.name === from)!;
      statements.push(db.prepare(`UPDATE size_maps SET name = ?, updated_at = ? WHERE publisher_id = ? AND id = ? AND ${gate}`).bind(to, now, siteId, row.id, auditId));
    }
  } else statements.push(db.prepare(`DELETE FROM size_maps WHERE publisher_id = ? AND id = ? AND ${gate}`).bind(siteId, current.id, auditId));
  for (const [from, to] of renames) {
    if (state.unitRows.some(unit => unit.size_map_key === from)) statements.push(db.prepare(`UPDATE ad_units SET size_map_key = ?, updated_at = ? WHERE publisher_id = ? AND size_map_key = ? AND ${gate}`).bind(to, now, siteId, from, auditId));
  }
  function rename(rule: unknown): boolean {
    let changed = false;
    for (const mapping of mappings(rule)) {
      const to = typeof mapping.sizeMapKey === 'string' ? renames.get(mapping.sizeMapKey) : undefined;
      if (to !== undefined) { mapping.sizeMapKey = to; changed = true; }
    }
    return changed;
  }
  for (const { row, value } of state.ruleValues) if (rename(value)) statements.push(db.prepare(`UPDATE unit_rules SET rule_json = ?, updated_at = ? WHERE publisher_id = ? AND id = ? AND ${gate}`).bind(JSON.stringify(value), now, siteId, row.id, auditId));
  let configChanged = outstream.renamed.length > 0 || outstream.removed.length > 0;
  for (const key of ['unitRules', 'advancedUnitRules']) for (const rule of Object.values(savedRuleGroups(configValue, key))) configChanged = rename(rule) || configChanged;
  if (configChanged) statements.push(db.prepare(`UPDATE publisher_configs SET config_json = ?, config_hash = NULL, updated_at = ? WHERE publisher_id = ? AND ${gate}`).bind(JSON.stringify(configValue), now, siteId, auditId));
  const result = await db.batch(statements);
  if (result.some(item => !item.success)) return { status: 503, error: 'The save result is unconfirmed. Reload size maps before trying again.' };
  if (result[0]?.meta?.changes !== 1) return { status: 409, error: 'Site settings changed in another tab. Reload size maps before saving.' };
  return null;
}
