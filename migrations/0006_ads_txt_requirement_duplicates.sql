PRAGMA foreign_keys = OFF;

CREATE TABLE ads_txt_requirements_duplicate_ready (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  source_label TEXT,
  entry TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

INSERT INTO ads_txt_requirements_duplicate_ready (
  id, publisher_id, source_label, entry, required, created_at, updated_at
)
SELECT
  id, publisher_id, source_label, entry, required, created_at, updated_at
FROM ads_txt_requirements;

DROP TABLE ads_txt_requirements;
ALTER TABLE ads_txt_requirements_duplicate_ready RENAME TO ads_txt_requirements;
CREATE INDEX IF NOT EXISTS idx_ads_txt_publisher ON ads_txt_requirements(publisher_id);

PRAGMA foreign_keys = ON;
