PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS deployment_targets (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'cloudflare-pages'
    CHECK (provider IN ('cloudflare-pages')),
  account_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  github_environment TEXT NOT NULL,
  production_branch TEXT NOT NULL DEFAULT 'main',
  preview_branch TEXT NOT NULL DEFAULT 'staging',
  public_base_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (publisher_id, name),
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS external_deployments (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  release_version TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('staging', 'production')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'success', 'failed')),
  correlation_id TEXT NOT NULL UNIQUE,
  github_run_id TEXT,
  github_run_url TEXT,
  provider_deployment_url TEXT,
  provider_alias_url TEXT,
  message TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES deployment_targets(id) ON DELETE CASCADE,
  FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deployment_targets_publisher
  ON deployment_targets(publisher_id, enabled, name);

CREATE INDEX IF NOT EXISTS idx_external_deployments_publisher
  ON external_deployments(publisher_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_external_deployments_target
  ON external_deployments(target_id, created_at DESC);
