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

UPDATE ads_txt_requirement_sources
SET
  source_label = CASE
    WHEN TRIM(source_label) = '' OR INSTR(source_label, '=') > 0
      THEN UPPER(TRIM(SUBSTR(monitor_entry, 1, INSTR(monitor_entry, '=') - 1)))
    ELSE source_label
  END,
  canonical_entry = 'variable:'
    || LOWER(TRIM(SUBSTR(monitor_entry, 1, INSTR(monitor_entry, '=') - 1)))
    || '='
    || TRIM(SUBSTR(monitor_entry, INSTR(monitor_entry, '=') + 1))
WHERE INSTR(monitor_entry, '=') > 0
  AND (
    INSTR(monitor_entry, ',') = 0
    OR INSTR(monitor_entry, '=') < INSTR(monitor_entry, ',')
  );

WITH seller_rows AS (
  SELECT
    id,
    monitor_entry,
    INSTR(monitor_entry, ',') AS first_comma
  FROM ads_txt_requirement_sources
  WHERE INSTR(monitor_entry, ',') > 0
    AND NOT (
      INSTR(monitor_entry, '=') > 0
      AND INSTR(monitor_entry, '=') < INSTR(monitor_entry, ',')
    )
),
second_parts AS (
  SELECT
    id,
    monitor_entry,
    first_comma,
    INSTR(SUBSTR(monitor_entry, first_comma + 1), ',') AS second_comma_relative
  FROM seller_rows
),
parsed AS (
  SELECT
    id,
    monitor_entry,
    first_comma,
    first_comma + second_comma_relative AS second_comma,
    INSTR(
      SUBSTR(monitor_entry, first_comma + second_comma_relative + 1),
      ','
    ) AS third_comma_relative
  FROM second_parts
  WHERE second_comma_relative > 0
)
UPDATE ads_txt_requirement_sources
SET canonical_entry = (
  SELECT
    LOWER(TRIM(SUBSTR(parsed.monitor_entry, 1, parsed.first_comma - 1)))
    || ','
    || LOWER(TRIM(SUBSTR(
      parsed.monitor_entry,
      parsed.first_comma + 1,
      parsed.second_comma - parsed.first_comma - 1
    )))
    || ','
    || LOWER(TRIM(
      CASE
        WHEN parsed.third_comma_relative > 0
          THEN SUBSTR(
            parsed.monitor_entry,
            parsed.second_comma + 1,
            parsed.third_comma_relative - 1
          )
        ELSE SUBSTR(parsed.monitor_entry, parsed.second_comma + 1)
      END
    ))
    || CASE
      WHEN parsed.third_comma_relative > 0
        THEN ',' || LOWER(TRIM(SUBSTR(
          parsed.monitor_entry,
          parsed.second_comma + parsed.third_comma_relative + 1
        )))
      ELSE ''
    END
  FROM parsed
  WHERE parsed.id = ads_txt_requirement_sources.id
)
WHERE id IN (SELECT id FROM parsed);
