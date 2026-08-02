PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ads_txt_source_documents (
  site_id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  base_content TEXT NOT NULL DEFAULT '',
  draft_content TEXT NOT NULL DEFAULT '',
  base_hash TEXT NOT NULL DEFAULT '',
  draft_hash TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ads_txt_source_versions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  change_type TEXT NOT NULL,
  summary TEXT,
  content TEXT NOT NULL,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (site_id, revision),
  FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ads_txt_source_versions_site
  ON ads_txt_source_versions(site_id, revision DESC);
