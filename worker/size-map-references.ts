import type { SizeMapReference } from '../src/shared/types';

type RuleRow = { id: string; rule_key: string; rule_json: string; updated_at: string };
type UnitRow = { id: string; code: string; size_map_key: string | null; updated_at: string };
type ConfigRow = { config_json: string };
type MapRow = { id: string; name: string; map_json: string; updated_at: string };
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
export async function readSizeMapReferences(db: D1Database, siteId: string) {
  const [rules, units, config] = await Promise.all([
    db.prepare('SELECT id, rule_key, rule_json, updated_at FROM unit_rules WHERE publisher_id = ? ORDER BY id').bind(siteId).all<RuleRow>(),
    db.prepare('SELECT id, code, size_map_key, updated_at FROM ad_units WHERE publisher_id = ? ORDER BY id').bind(siteId).all<UnitRow>(),
    db.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1').bind(siteId).first<ConfigRow>(),
  ]);
  if (!rules.success || !units.success) throw new Error('Saved size-map references could not be read.');
  const ruleRows = rules.results ?? [], unitRows = units.results ?? [];
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
  return { ruleRows, unitRows, config, configValue, ruleValues, byMap };
}

/** Snapshot guarded transaction. The audit row is the gate for every write,
 * so a concurrent config/rule/unit/map edit causes no mutation and no audit. */
export async function mutateSizeMap(db: D1Database, siteId: string, expected: { id: string; name: string; updatedAt: string }, actor: string, change: { name: string; map: unknown[] } | null) {
  const state = await readSizeMapReferences(db, siteId);
  const current = await db.prepare('SELECT id, name, map_json, updated_at FROM size_maps WHERE publisher_id = ? AND id = ? LIMIT 1').bind(siteId, expected.id).first<MapRow>();
  if (!current || current.name !== expected.name || current.updated_at !== expected.updatedAt) return { status: 409, error: 'Size map changed in another tab. Reload before saving.' };
  const references = state.byMap.get(current.name) ?? [];
  if (!change && references.length) return { status: 409, error: `Size map "${current.name}" is still used by ${references.map(reference => reference.label).join(', ')}. Reassign these references before deleting it.`, references };
  const now = new Date().toISOString(), auditId = crypto.randomUUID();
  const gate = 'EXISTS (SELECT 1 FROM audit_log WHERE id = ?)';
  const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO audit_log (id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at)
    SELECT ?, ?, ?, ?, 'size_map', ?, ?, ? WHERE
    EXISTS (SELECT 1 FROM size_maps WHERE publisher_id = ? AND id = ? AND name = ? AND map_json = ? AND updated_at = ?)
    AND (SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1) IS ?
    AND (SELECT json_group_array(json_array(id,rule_key,rule_json,updated_at)) FROM (SELECT id,rule_key,rule_json,updated_at FROM unit_rules WHERE publisher_id = ? ORDER BY id)) = ?
    AND (SELECT json_group_array(json_array(id,code,size_map_key,updated_at)) FROM (SELECT id,code,size_map_key,updated_at FROM ad_units WHERE publisher_id = ? ORDER BY id)) = ?`)
    .bind(auditId, actor, change ? 'size_map.updated' : 'size_map.deleted', siteId, current.id,
      JSON.stringify(change ? { previousName: current.name, name: change.name, breakpoints: change.map.length } : { name: current.name }), now,
      siteId, current.id, current.name, current.map_json, current.updated_at, siteId, state.config?.config_json ?? null,
      siteId, JSON.stringify(state.ruleRows.map(row => [row.id, row.rule_key, row.rule_json, row.updated_at])),
      siteId, JSON.stringify(state.unitRows.map(row => [row.id, row.code, row.size_map_key, row.updated_at])))];
  if (change) {
    statements.push(db.prepare(`UPDATE size_maps SET name = ?, map_json = ?, updated_at = ? WHERE publisher_id = ? AND id = ? AND ${gate}`).bind(change.name, JSON.stringify(change.map), now, siteId, current.id, auditId));
    if (change.name !== current.name) {
      statements.push(db.prepare(`UPDATE ad_units SET size_map_key = ?, updated_at = ? WHERE publisher_id = ? AND size_map_key = ? AND ${gate}`).bind(change.name, now, siteId, current.name, auditId));
      function rename(rule: unknown): boolean { let changed = false; for (const mapping of mappings(rule)) if (mapping.sizeMapKey === current!.name) { mapping.sizeMapKey = change!.name; changed = true; } return changed; }
      for (const { row, value } of state.ruleValues) if (rename(value)) statements.push(db.prepare(`UPDATE unit_rules SET rule_json = ?, updated_at = ? WHERE publisher_id = ? AND id = ? AND ${gate}`).bind(JSON.stringify(value), now, siteId, row.id, auditId));
      let configChanged = false;
      for (const key of ['unitRules', 'advancedUnitRules']) for (const rule of Object.values(savedRuleGroups(state.configValue, key))) configChanged = rename(rule) || configChanged;
      if (configChanged) statements.push(db.prepare(`UPDATE publisher_configs SET config_json = ?, config_hash = NULL, updated_at = ? WHERE publisher_id = ? AND ${gate}`).bind(JSON.stringify(state.configValue), now, siteId, auditId));
    }
  } else statements.push(db.prepare(`DELETE FROM size_maps WHERE publisher_id = ? AND id = ? AND ${gate}`).bind(siteId, current.id, auditId));
  const result = await db.batch(statements);
  if (result.some(item => !item.success)) return { status: 503, error: 'The save result is unconfirmed. Reload size maps before trying again.' };
  if (result[0]?.meta?.changes !== 1) return { status: 409, error: 'Site settings changed in another tab. Reload size maps before saving.' };
  return null;
}
