PRAGMA foreign_keys = ON;

-- Publisher is the business/account (for example Minacord).
-- The existing `publishers` table continues to hold individual sites/domains
-- so all current ad-unit, bidder, release and import data stays intact.
CREATE TABLE IF NOT EXISTS publisher_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

ALTER TABLE publishers
  ADD COLUMN publisher_account_id TEXT REFERENCES publisher_accounts(id);

-- Politika.rs and Magazin Politika are grouped together as the first example
-- of one publisher with multiple domains. All other existing sites get their
-- own publisher account automatically, so no existing data is lost.
INSERT OR IGNORE INTO publisher_accounts (
  id, name, status, notes
) VALUES (
  'politika-media',
  'Politika',
  'active',
  'Created by migration 0002; contains Politika.rs and Magazin Politika.'
);

UPDATE publishers
SET publisher_account_id = 'politika-media'
WHERE id IN ('politika', 'magazin-politika')
  AND publisher_account_id IS NULL;

INSERT OR IGNORE INTO publisher_accounts (
  id, name, status, notes, created_at, updated_at
)
SELECT
  'publisher-' || id,
  name,
  CASE WHEN status = 'archived' THEN 'archived' ELSE 'active' END,
  'Automatically created from an existing site during migration 0002.',
  created_at,
  updated_at
FROM publishers
WHERE publisher_account_id IS NULL;

UPDATE publishers
SET publisher_account_id = 'publisher-' || id
WHERE publisher_account_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_publishers_account
  ON publishers(publisher_account_id, name);

CREATE INDEX IF NOT EXISTS idx_publisher_accounts_name
  ON publisher_accounts(name);
