CREATE TABLE IF NOT EXISTS ads_txt_requirement_sources (
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
);

CREATE INDEX IF NOT EXISTS idx_ads_txt_sources_publisher
  ON ads_txt_requirement_sources(publisher_id, sort_order, created_at, id);

CREATE INDEX IF NOT EXISTS idx_ads_txt_sources_canonical
  ON ads_txt_requirement_sources(publisher_id, canonical_entry);

CREATE TABLE IF NOT EXISTS ads_txt_requirement_source_claims (
  publisher_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ads_txt_requirement_source_assertions (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT OR IGNORE INTO ads_txt_requirement_sources (
  id,
  publisher_id,
  source_label,
  entry,
  monitor_entry,
  canonical_entry,
  required,
  sort_order,
  created_at,
  updated_at
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
FROM ads_txt_requirements;
