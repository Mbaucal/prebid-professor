let schemaReady: Promise<void> | null = null;

const ACTIVE_TABLE = 'ads_txt_requirements';
const NEXT_TABLE = 'ads_txt_requirements_duplicate_ready';
const BACKUP_TABLE = 'ads_txt_requirements_unique_backup';

function createTableSql(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
    id TEXT PRIMARY KEY,
    publisher_id TEXT NOT NULL,
    source_label TEXT,
    entry TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
  )`;
}

async function tableSql(db: D1Database, name: string): Promise<string | null> {
  const row = await db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).bind(name).first<{ sql: string | null }>();
  return row?.sql ?? null;
}

function hasLegacyUniqueConstraint(sql: string): boolean {
  return /UNIQUE\s*\(\s*publisher_id\s*,\s*entry\s*\)/i.test(sql);
}

async function cleanUpAndIndex(db: D1Database): Promise<void> {
  await db.prepare(`DROP TABLE IF EXISTS ${BACKUP_TABLE}`).run();
  await db.prepare(`DROP TABLE IF EXISTS ${NEXT_TABLE}`).run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_ads_txt_publisher ON ads_txt_requirements(publisher_id)',
  ).run();
}

async function recoverMissingActiveTable(db: D1Database): Promise<void> {
  if (await tableSql(db, NEXT_TABLE)) {
    await db.prepare(`ALTER TABLE ${NEXT_TABLE} RENAME TO ${ACTIVE_TABLE}`).run();
    await cleanUpAndIndex(db);
    return;
  }
  if (await tableSql(db, BACKUP_TABLE)) {
    await db.prepare(`ALTER TABLE ${BACKUP_TABLE} RENAME TO ${ACTIVE_TABLE}`).run();
    await cleanUpAndIndex(db);
    return;
  }
  await db.prepare(createTableSql(ACTIVE_TABLE)).run();
  await cleanUpAndIndex(db);
}

async function reconcile(db: D1Database): Promise<void> {
  let activeSql = await tableSql(db, ACTIVE_TABLE);
  if (!activeSql) {
    await recoverMissingActiveTable(db);
    activeSql = await tableSql(db, ACTIVE_TABLE);
  }
  if (!activeSql) throw new Error('ads_txt_requirements could not be created.');

  if (!hasLegacyUniqueConstraint(activeSql)) {
    await cleanUpAndIndex(db);
    return;
  }

  try {
    await db.prepare(`DROP TABLE IF EXISTS ${NEXT_TABLE}`).run();
    await db.prepare(createTableSql(NEXT_TABLE)).run();
    await db.prepare(`INSERT INTO ${NEXT_TABLE} (
      id, publisher_id, source_label, entry, required, created_at, updated_at
    ) SELECT
      id, publisher_id, source_label, entry, required, created_at, updated_at
    FROM ${ACTIVE_TABLE}`).run();
    await db.prepare(`DROP TABLE IF EXISTS ${BACKUP_TABLE}`).run();
    await db.prepare(`ALTER TABLE ${ACTIVE_TABLE} RENAME TO ${BACKUP_TABLE}`).run();
    await db.prepare(`ALTER TABLE ${NEXT_TABLE} RENAME TO ${ACTIVE_TABLE}`).run();
    await cleanUpAndIndex(db);
  } catch (error) {
    const current = await tableSql(db, ACTIVE_TABLE);
    if (current && !hasLegacyUniqueConstraint(current)) {
      await cleanUpAndIndex(db);
      return;
    }
    if (!current) {
      await recoverMissingActiveTable(db);
      const recovered = await tableSql(db, ACTIVE_TABLE);
      if (recovered && !hasLegacyUniqueConstraint(recovered)) return;
    }
    throw error;
  }
}

export async function ensureAdsTxtRequirementDuplicateSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = reconcile(db).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}
