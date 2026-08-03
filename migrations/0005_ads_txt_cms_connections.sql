CREATE TABLE IF NOT EXISTS ads_txt_real_connectors (
  site_id TEXT PRIMARY KEY,
  endpoint_url TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('POST', 'PUT')),
  auth_type TEXT NOT NULL CHECK (auth_type IN ('none', 'bearer', 'api_key')),
  auth_header TEXT,
  credential_encrypted TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
);
