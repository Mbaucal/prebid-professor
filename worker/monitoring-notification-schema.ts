type TableColumn = {
  name: string;
};

type ColumnDefinition = {
  name: string;
  sql: string;
};

const LEGACY_LOG_COLUMNS: ColumnDefinition[] = [
  { name: 'provider', sql: 'provider TEXT' },
  { name: 'message_id', sql: 'message_id TEXT' },
  { name: 'recipients_json', sql: "recipients_json TEXT NOT NULL DEFAULT '[]'" },
  { name: 'subject', sql: 'subject TEXT' },
  { name: 'attachment_name', sql: 'attachment_name TEXT' },
  { name: 'error_message', sql: 'error_message TEXT' },
  { name: 'details_json', sql: "details_json TEXT NOT NULL DEFAULT '{}'" },
  { name: 'created_at', sql: 'created_at TEXT' },
];

const LEGACY_STATE_COLUMNS: ColumnDefinition[] = [
  { name: 'last_status', sql: 'last_status TEXT' },
  { name: 'last_fingerprint', sql: 'last_fingerprint TEXT' },
  { name: 'last_checked_at', sql: 'last_checked_at TEXT' },
  { name: 'last_notified_fingerprint', sql: 'last_notified_fingerprint TEXT' },
  { name: 'last_notified_at', sql: 'last_notified_at TEXT' },
  { name: 'last_recovery_at', sql: 'last_recovery_at TEXT' },
  { name: 'last_error', sql: 'last_error TEXT' },
  { name: 'updated_at', sql: 'updated_at TEXT' },
];

const LEGACY_SETTINGS_COLUMNS: ColumnDefinition[] = [
  { name: 'settings_json', sql: "settings_json TEXT NOT NULL DEFAULT '{}'" },
  { name: 'updated_by', sql: 'updated_by TEXT' },
  { name: 'created_at', sql: 'created_at TEXT' },
  { name: 'updated_at', sql: 'updated_at TEXT' },
];

async function columnNames(db: D1Database, table: string): Promise<Set<string>> {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<TableColumn>();
  return new Set((result.results ?? []).map((column) => column.name));
}

async function addMissingColumns(
  db: D1Database,
  table: string,
  definitions: ColumnDefinition[],
): Promise<void> {
  const existing = await columnNames(db, table);
  for (const definition of definitions) {
    if (existing.has(definition.name)) continue;
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${definition.sql}`).run();
      existing.add(definition.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Multiple Worker isolates can reconcile the same legacy table at once.
      // Treat another isolate adding the column first as success.
      if (/duplicate column name/i.test(message)) {
        existing.add(definition.name);
        continue;
      }
      throw error;
    }
  }
}

export async function reconcileMonitoringNotificationSchema(db: D1Database): Promise<void> {
  await addMissingColumns(db, 'monitoring_notification_settings', LEGACY_SETTINGS_COLUMNS);
  await addMissingColumns(db, 'monitoring_notification_state', LEGACY_STATE_COLUMNS);
  await addMissingColumns(db, 'monitoring_notification_log', LEGACY_LOG_COLUMNS);
}
