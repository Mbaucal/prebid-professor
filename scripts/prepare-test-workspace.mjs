import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Only these already reviewed schema sources, never the publisher seeds after them.
const root = new URL('../', import.meta.url);
function source(path, expected) {
  const bytes = readFileSync(new URL(path, root));
  const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Schema source changed and needs review: ${path}`);
  return bytes.toString('utf8');
}
const initial = source('migrations/0001_initial.sql', '86bb446e67b47bea5ffc1256c67bd459c25567c1');
const extension = source('worker/runtime/sql/builtin-draft-storage.sql', 'd962dd7b943f8aa614f963055a90206a137ac77b');
const marker = 'INSERT OR IGNORE INTO publishers';
if (initial.split(marker).length !== 2) throw new Error('The reviewed schema/seed boundary changed.');
function ddl(sql) {
  return sql.replace(/^--.*$/gm, '').split(';').map((v) => v.trim()).filter(Boolean)
    .filter((v) => !v.startsWith('PRAGMA ')).map((v) => {
      if (!/^CREATE (?:TABLE|INDEX) IF NOT EXISTS /.test(v)) throw new Error('Unexpected schema statement.');
      return v.replace(' IF NOT EXISTS ', ' ');
    });
}
const statements = [
  'CREATE TABLE tessera_test_environment (id INTEGER PRIMARY KEY CHECK(id=1), schema_sha256 TEXT NOT NULL, database_id TEXT NOT NULL, bucket_name TEXT NOT NULL)',
  ...ddl(initial.slice(0, initial.indexOf(marker))), ...ddl(extension),
  `CREATE TRIGGER test_draft_quota BEFORE INSERT ON builtin_draft_uploads
    WHEN NEW.publisher_id <> 'test-site' OR (NOT EXISTS (SELECT 1 FROM builtin_draft_uploads WHERE publisher_id=NEW.publisher_id AND package_sha256=NEW.package_sha256)
    AND (SELECT COUNT(*) FROM builtin_draft_uploads) >= 20)
    BEGIN SELECT RAISE(ABORT, 'TEST_DRAFT_QUOTA'); END`,
  `CREATE TRIGGER test_no_site_delete BEFORE DELETE ON publishers BEGIN SELECT RAISE(ABORT, 'TEST_SITE_DELETE_DISABLED'); END`,
  `CREATE TRIGGER test_no_promotion BEFORE UPDATE OF status ON releases WHEN NEW.status <> 'draft'
    BEGIN SELECT RAISE(ABORT, 'TEST_PUBLISH_DISABLED'); END`,
  `CREATE TRIGGER test_drafts_only BEFORE INSERT ON releases WHEN NEW.status <> 'draft' OR NEW.version NOT GLOB 'builtin-draft-*'
    BEGIN SELECT RAISE(ABORT, 'TEST_PUBLISH_DISABLED'); END`,
];
const tables = statements.filter((v) => v.startsWith('CREATE TABLE ')).map((v) => v.match(/^CREATE TABLE (\w+)/)[1]).sort();
const schemaSha256 = createHash('sha256').update(JSON.stringify(statements)).digest('hex');
mkdirSync(new URL('.generated/', root), { recursive: true });
writeFileSync(new URL('.generated/test-workspace-schema.mjs', root),
  `// Generated from checksum-locked DDL only. No production seed data.\nexport const schemaSha256=${JSON.stringify(schemaSha256)};\nexport const tables=${JSON.stringify(tables)};\nexport const statements=${JSON.stringify(statements)};\n`);
console.log(`Prepared isolated workspace schema: ${tables.length} tables; no database connection or mutation.`);
execFileSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./prepare-tanjug-pilot.mjs', import.meta.url))], { stdio: 'inherit' });
execFileSync(process.execPath, [fileURLToPath(new URL('./prepare-ads-versions-preview.mjs', import.meta.url))], { stdio: 'inherit' });
execFileSync(process.execPath, [fileURLToPath(new URL('./prepare-site-workspace.mjs', import.meta.url))], { stdio: 'inherit' });

execFileSync(process.execPath, [fileURLToPath(new URL('./prepare-download.mjs', import.meta.url))], { stdio: 'inherit' });

execFileSync(process.execPath, [fileURLToPath(new URL('./prepare-api-integrations.mjs', import.meta.url))], { stdio: 'inherit' });

execFileSync(process.execPath, [fileURLToPath(new URL('./prepare-creative-templates.mjs', import.meta.url))], { stdio: 'inherit' });

execFileSync(process.execPath, [fileURLToPath(new URL('./prepare-inventory-preview.mjs', import.meta.url))], { stdio: 'inherit' });
execFileSync(process.execPath, [fileURLToPath(new URL('./prepare-layout-preview.mjs', import.meta.url))], { stdio: 'inherit' });

execFileSync(process.execPath, [fileURLToPath(new URL('./prepare-agency-workspace.mjs', import.meta.url))], { stdio: 'inherit' });
