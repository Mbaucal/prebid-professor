PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS site_monitoring_settings (
  site_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS site_monitoring_state (
  site_id TEXT PRIMARY KEY,
  last_checked_at TEXT,
  status_json TEXT NOT NULL DEFAULT '{}',
  ads_txt_fingerprint TEXT,
  last_notified_fingerprint TEXT,
  last_notified_at TEXT,
  last_recovery_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS monitoring_notification_log (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('test', 'missing', 'reminder', 'recovery', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  recipients_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT,
  attachment_name TEXT,
  message_id TEXT,
  error_message TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_monitoring_notification_site
  ON monitoring_notification_log(site_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_monitoring_state_checked
  ON site_monitoring_state(last_checked_at DESC);
