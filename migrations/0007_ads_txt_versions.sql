CREATE TABLE IF NOT EXISTS ads_txt_versions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'saved' CHECK (status IN ('saved', 'published', 'superseded')),
  object_key TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  canonical_count INTEGER NOT NULL,
  repeated_row_count INTEGER NOT NULL,
  heading_count INTEGER NOT NULL,
  line_count INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE,
  UNIQUE (site_id, version_number),
  UNIQUE (site_id, checksum)
);

CREATE INDEX IF NOT EXISTS idx_ads_txt_versions_site_created
  ON ads_txt_versions(site_id, version_number DESC, created_at DESC);
