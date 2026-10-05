/** No foreign key: failed writes must remain discoverable after a site disappears. */
export async function ensureAdsTxtVersionIntents(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_version_intents (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('writing', 'cleanup')),
    created_at TEXT NOT NULL
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_ads_txt_intents_site ON ads_txt_version_intents(site_id)').run();
}
