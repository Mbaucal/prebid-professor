from pathlib import Path

path = Path('worker/ads-txt-requirement-sources.ts')
source = path.read_text()

public_marker = """function toPublicSource(row: SourceRow) {
  return {
    id: row.id,
    publisherId: row.publisher_id,
    sourceLabel: row.source_label,
    entry: row.entry,
    required: row.required === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

"""
stored_helper = public_marker + """function storedSource(row: SourceRow): NormalizedSource {
  return {
    sourceLabel: row.source_label,
    entry: row.entry,
    monitorEntry: row.monitor_entry,
    canonicalEntry: row.canonical_entry,
    required: row.required === 1,
  };
}

"""
if public_marker not in source:
    raise SystemExit('toPublicSource marker not found')
source = source.replace(public_marker, stored_helper, 1)

ensure_start = source.index('async function ensureTables(db: D1Database): Promise<void> {')
site_exists_start = source.index('async function siteExists(', ensure_start)
new_ensure = """async function ensureTables(db: D1Database): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_requirement_sources (
          id TEXT PRIMARY KEY,
          publisher_id TEXT NOT NULL,
          source_label TEXT NOT NULL,
          entry TEXT NOT NULL,
          monitor_entry TEXT NOT NULL,
          canonical_entry TEXT NOT NULL,
          required INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_requirement_source_claims (
          publisher_id TEXT PRIMARY KEY,
          token TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_requirement_source_assertions (
          id TEXT PRIMARY KEY,
          valid INTEGER NOT NULL CHECK (valid = 1)
        )`),
      ]);

      await db.batch([
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_ads_txt_sources_publisher
          ON ads_txt_requirement_sources(publisher_id, sort_order, created_at, id)`),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_ads_txt_sources_canonical
          ON ads_txt_requirement_sources(publisher_id, canonical_entry)`),
        db.prepare(`INSERT OR IGNORE INTO ads_txt_requirement_sources (
            id, publisher_id, source_label, entry, monitor_entry, canonical_entry,
            required, sort_order, created_at, updated_at
          )
          SELECT
            id,
            publisher_id,
            COALESCE(NULLIF(TRIM(source_label), ''),
              TRIM(SUBSTR(entry, 1, INSTR(entry || ',', ',') - 1))),
            TRIM(entry),
            TRIM(CASE
              WHEN INSTR(entry, '#') > 0 THEN SUBSTR(entry, 1, INSTR(entry, '#') - 1)
              ELSE entry
            END),
            LOWER(REPLACE(TRIM(CASE
              WHEN INSTR(entry, '#') > 0 THEN SUBSTR(entry, 1, INSTR(entry, '#') - 1)
              ELSE entry
            END), ' ', '')),
            required,
            ROW_NUMBER() OVER (
              PARTITION BY publisher_id
              ORDER BY required DESC, source_label COLLATE NOCASE, entry COLLATE NOCASE, id
            ) - 1,
            created_at,
            updated_at
          FROM ads_txt_requirements`),
      ]);
    })().catch((error) => {
      tablesReady = null;
      throw error;
    });
  }
  await tablesReady;
}

"""
source = source[:ensure_start] + new_ensure + source[site_exists_start:]

old_map = """source.map((row) => normalizeInput({
      sourceLabel: row.source_label,
      entry: row.entry,
      required: row.required === 1,
    }))"""
map_count = source.count(old_map)
if map_count != 2:
    raise SystemExit(f'Expected 2 stored-source normalization maps, found {map_count}')
source = source.replace(old_map, 'source.map(storedSource)')

path.write_text(source)
