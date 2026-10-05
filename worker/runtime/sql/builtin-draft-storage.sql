-- Additive extension for an ISOLATED test database with Tessera's existing schema.
-- Deliberately not in migrations/: no automatic production schema change.
-- Apply only after resource isolation/backup is verified. No publisher seeds.
CREATE TABLE IF NOT EXISTS builtin_draft_uploads (
  release_id TEXT PRIMARY KEY NOT NULL,
  publisher_id TEXT NOT NULL REFERENCES publishers(id) ON DELETE RESTRICT,
  package_sha256 TEXT NOT NULL,
  descriptor_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','stored')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT,
  UNIQUE (publisher_id, package_sha256)
);
CREATE INDEX IF NOT EXISTS idx_builtin_drafts_site
  ON builtin_draft_uploads(publisher_id, state, created_at DESC, release_id);
CREATE TABLE IF NOT EXISTS builtin_draft_assertions (
  id TEXT PRIMARY KEY NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1)
);
