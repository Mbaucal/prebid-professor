from pathlib import Path

SELLER_CANONICAL_REPAIR_SQL = r'''WITH seller_rows AS (
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
WHERE id IN (SELECT id FROM parsed);'''

worker_path = Path('worker/ads-txt-requirement-sources.ts')
worker = worker_path.read_text()
if 'WITH seller_rows AS (' not in worker:
    marker = """  AND (
    INSTR(monitor_entry, ',') = 0
    OR INSTR(monitor_entry, '=') < INSTR(monitor_entry, ',')
  )`),
      ]);"""
    replacement = """  AND (
    INSTR(monitor_entry, ',') = 0
    OR INSTR(monitor_entry, '=') < INSTR(monitor_entry, ',')
  )`),
        db.prepare(`""" + SELLER_CANONICAL_REPAIR_SQL.rstrip(';') + """`),
      ]);"""
    if marker not in worker:
        raise SystemExit('Worker insertion point was not found')
    worker_path.write_text(worker.replace(marker, replacement, 1))

migration_path = Path('migrations/0006_ads_txt_requirement_sources.sql')
migration = migration_path.read_text()
if 'WITH seller_rows AS (' not in migration:
    migration_path.write_text(migration.rstrip() + '\n\n' + SELLER_CANONICAL_REPAIR_SQL + '\n')
