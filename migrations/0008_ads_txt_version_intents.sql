-- Intentionally no CASCADE: these keys survive a failed save or site deletion.
CREATE TABLE IF NOT EXISTS ads_txt_version_intents (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('writing', 'cleanup')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ads_txt_intents_site ON ads_txt_version_intents(site_id);
