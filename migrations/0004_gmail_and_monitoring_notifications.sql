PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS gmail_oauth_states (
  state TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gmail_connections (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  email TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  scope TEXT NOT NULL,
  connected_by TEXT,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitoring_notification_settings (
  site_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS monitoring_notification_state (
  site_id TEXT PRIMARY KEY,
  last_status TEXT,
  last_fingerprint TEXT,
  last_checked_at TEXT,
  last_notified_fingerprint TEXT,
  last_notified_at TEXT,
  last_recovery_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS monitoring_notification_log (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  message_id TEXT,
  recipients_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT,
  attachment_name TEXT,
  error_message TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_monitoring_notification_log_site
  ON monitoring_notification_log(site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS monitoring_notification_claims (
  site_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
);
