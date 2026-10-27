// publisher_configs.config_json mirrors unit_rules (config.unitRules) and owns the
// advanced timeout/refresh records that the generated runtime merges over each row.
// Every write that derives config_json from unit_rules must therefore prove, inside
// the same D1 batch, that the rows it read are still exactly the rows that exist.
// D1 runs a batch as one transaction, so this guard plus the config_json
// compare-and-swap makes the derived config apply only to the state it was built from.

export type UnitRuleRowState = {
  id: string;
  rule_key: string;
  rule_json: string;
  updated_at: string;
};

export async function readUnitRuleRows(db: D1Database, siteId: string): Promise<UnitRuleRowState[]> {
  const result = await db
    .prepare(
      `SELECT id, rule_key, rule_json, updated_at
       FROM unit_rules
       WHERE publisher_id = ?
       ORDER BY rule_key COLLATE NOCASE`,
    )
    .bind(siteId)
    .all<UnitRuleRowState>();
  return result.results ?? [];
}

// Fixed bind count (JSON payload) so large sites stay under D1's bound-parameter limit.
// The count check rejects added rows; the join rejects removed, re-keyed, edited or
// re-created rows (ids are primary keys, so each expected row matches at most once).
export const UNIT_RULE_ROWS_UNCHANGED_SQL = `(SELECT count(*) FROM unit_rules WHERE publisher_id = ?) = ?
  AND (SELECT count(*)
       FROM unit_rules AS guard_row
       JOIN json_each(?) AS guard_expected
         ON guard_row.id = json_extract(guard_expected.value, '$[0]')
        AND guard_row.rule_key = json_extract(guard_expected.value, '$[1]')
        AND guard_row.updated_at = json_extract(guard_expected.value, '$[2]')
        AND guard_row.rule_json = json_extract(guard_expected.value, '$[3]')
       WHERE guard_row.publisher_id = ?) = ?`;

export function unitRuleRowsUnchangedArgs(siteId: string, rows: UnitRuleRowState[]): unknown[] {
  const expected = JSON.stringify(rows.map((row) => [row.id, row.rule_key, row.updated_at, row.rule_json]));
  return [siteId, rows.length, expected, siteId, rows.length];
}

// updated_at is a row's version. A write must move it forward even when it lands in
// the same millisecond as the version it replaces; otherwise a request that read the
// older content would still match the row and could delete or overwrite the newer one.
export function nextRowVersion(previous: string, now: string): string {
  const before = Date.parse(previous);
  if (!Number.isFinite(before) || Date.parse(now) > before) return now;
  return new Date(before + 1).toISOString();
}

export function everyStatementChangedOneRow(results: D1Result[], expected: number): boolean {
  return results.length === expected && results.every((result) => result.meta.changes === 1);
}
