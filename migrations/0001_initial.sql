PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS publishers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  gam_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('live', 'staging', 'draft', 'archived')),
  current_release_id TEXT,
  current_version TEXT NOT NULL DEFAULT 'draft',
  last_published_at TEXT,
  ads_txt_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS publisher_configs (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL DEFAULT '{}',
  config_hash TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ad_units (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  code TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'BTF' CHECK (type IN ('ATF', 'BTF', 'DRAFT')),
  media_type TEXT NOT NULL DEFAULT 'banner',
  size_map_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (publisher_id, code),
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bidders (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  bidder TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (publisher_id, bidder),
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bidder_overrides (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  bidder TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('slot', 'device', 'adunit')),
  scope_key TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (publisher_id, bidder, scope_type, scope_key),
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS size_maps (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  name TEXT NOT NULL,
  map_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (publisher_id, name),
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS unit_rules (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  rule_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (publisher_id, rule_key),
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS prebid_builds (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  version TEXT NOT NULL,
  file_key TEXT NOT NULL,
  file_url TEXT,
  modules_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'archived' CHECK (status IN ('current', 'archived', 'invalid')),
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'staging', 'production', 'archived', 'failed')),
  config_hash TEXT,
  ads_js_key TEXT,
  ads_min_js_key TEXT,
  prebid_js_key TEXT,
  config_key TEXT,
  manifest_key TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_at TEXT,
  UNIQUE (publisher_id, version),
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ads_txt_requirements (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  source_label TEXT,
  entry TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (publisher_id, entry),
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  publisher_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ad_units_publisher ON ad_units(publisher_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_bidders_publisher ON bidders(publisher_id);
CREATE INDEX IF NOT EXISTS idx_overrides_publisher ON bidder_overrides(publisher_id, bidder);
CREATE INDEX IF NOT EXISTS idx_size_maps_publisher ON size_maps(publisher_id);
CREATE INDEX IF NOT EXISTS idx_rules_publisher ON unit_rules(publisher_id);
CREATE INDEX IF NOT EXISTS idx_prebid_builds_publisher ON prebid_builds(publisher_id, status);
CREATE INDEX IF NOT EXISTS idx_releases_publisher ON releases(publisher_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ads_txt_publisher ON ads_txt_requirements(publisher_id);
CREATE INDEX IF NOT EXISTS idx_audit_publisher ON audit_log(publisher_id, created_at DESC);

INSERT OR IGNORE INTO publishers (
  id, name, domain, gam_path, status, current_version, last_published_at, ads_txt_url
) VALUES
  ('politika', 'Politika.rs', 'politika.rs', '/23339552141/Politika.rs/', 'live', '20260714_122757', '2026-07-14T12:27:57Z', 'https://www.politika.rs/ads.txt'),
  ('magazin-politika', 'Magazin Politika', 'magazin.politika.rs', '/23339552141/Magazin.politika.rs/', 'live', '20260713_184200', '2026-07-13T18:42:00Z', 'https://magazin.politika.rs/ads.txt'),
  ('zurnal', 'Žurnal', 'zurnal.rs', '/23339552141/Zurnal/', 'staging', 'draft', NULL, 'https://www.zurnal.rs/ads.txt');

INSERT OR IGNORE INTO publisher_configs (id, publisher_id, config_json, created_by)
VALUES
  ('config-politika', 'politika', '{"enablePrebid":true,"gamPath":"/23339552141/Politika.rs/","adUnits":[],"bidders":[],"sizeMaps":{},"unitRules":{}}', 'system'),
  ('config-magazin-politika', 'magazin-politika', '{"enablePrebid":true,"gamPath":"/23339552141/Magazin.politika.rs/","adUnits":[],"bidders":[],"sizeMaps":{},"unitRules":{}}', 'system'),
  ('config-zurnal', 'zurnal', '{"enablePrebid":true,"gamPath":"/23339552141/Zurnal/","adUnits":[],"bidders":[],"sizeMaps":{},"unitRules":{}}', 'system');
