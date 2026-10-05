import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { sha256 } from '../../worker/runtime/prebid-artifact-check.mjs';

/** Real SQLite engine; narrow D1 API adapter. R2 is a fault-injectable memory double,
 * NOT real R2. Production resource IDs, credentials and remote HTTP are never used.
 */
export function isolatedStore({ databasePath = ':memory:', persistedObjects = null } = {}) {
  const sqlite = new DatabaseSync(databasePath);
  const sql = readFileSync(new URL('../../migrations/0001_initial.sql',import.meta.url),'utf8');
  sqlite.exec(sql.slice(0,sql.indexOf('INSERT OR IGNORE INTO publishers')));
  sqlite.exec(readFileSync(new URL('../../worker/runtime/sql/builtin-draft-storage.sql',import.meta.url),'utf8'));
  sqlite.prepare('INSERT OR IGNORE INTO publishers (id,name,domain,gam_path) VALUES (?,?,?,?)')
    .run('test-site','Offline fixture','example.invalid','/123/test/');
  sqlite.prepare('INSERT OR IGNORE INTO publishers (id,name,domain,gam_path) VALUES (?,?,?,?)')
    .run('other-site','Other isolated site','other.invalid','/123/other/');
  sqlite.prepare("INSERT OR IGNORE INTO publisher_configs (id,publisher_id,config_json) VALUES ('config-test','test-site','{}')").run();
  const faults = { batchBefore: false, batchAfter: false, failPutName: '', failGetName: '', afterPut: null,
    beforeBatch: null, afterIntent: false };
  const log = { sessions: [], sql: [], puts: [], gets: [] };
  function runSQL(sql, args, read = false) {
    log.sql.push(sql);
    const statement = sqlite.prepare(sql);
    if (read || statement.columns().length) return { success: true, results: statement.all(...args), meta: { changes: 0 } };
    const result = statement.run(...args);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  const db = {
    withSession(constraint) { log.sessions.push(constraint); assert.equal(constraint,'first-primary'); return db; },
    prepare(sql) {
      const prepared = (args) => ({ sql, args,
        bind(...values) { return prepared(values); },
        async run() { const result = runSQL(sql,args); if (faults.afterIntent && sql.startsWith('INSERT INTO builtin_draft_uploads')) throw new Error('response lost after intent'); return result; },
        async first() { return runSQL(sql,args,true).results[0] ?? null; },
        async all() { return runSQL(sql,args,true); },
      });
      return prepared([]);
    },
    async batch(statements) {
      if (faults.beforeBatch) await faults.beforeBatch();
      if (faults.batchBefore) throw new Error('SQL unavailable before commit');
      sqlite.exec('BEGIN IMMEDIATE');
      let result;
      try { result = statements.map((stmt) => runSQL(stmt.sql,stmt.args)); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      if (faults.batchAfter) throw new Error('response lost after commit');
      return result;
    },
  };
  const objects = persistedObjects ?? new Map();
  const bucket = {
    async get(key) {
      log.gets.push(key);
      if (faults.failGetName && key.endsWith('/'+faults.failGetName)) throw new Error('R2 temporary read failure');
      const stored = objects.get(key);
      if (!stored) return null;
      const copy = stored.slice();
      return { size: copy.length, async arrayBuffer() { return copy.buffer; } };
    },
    async put(key,value,options) {
      log.puts.push(key);
      assert.equal(options.onlyIf.get('If-None-Match'),'*');
      assert.equal(options.httpMetadata.cacheControl,'private, no-store');
      assert(!key.includes('/current/') && !key.includes('/staging/'));
      assert.match(key,/^publishers\/(test-site|other-site)\/releases\/builtin-draft-[a-f0-9]{64}\//);
      if (objects.has(key)) return null;
      if (faults.failPutName && key.endsWith('/'+faults.failPutName)) throw new Error('R2 write failure');
      const copy = new Uint8Array(value).slice();
      assert.equal(await sha256(copy),options.sha256);
      // Recheck atomically after digest await to model conditional write.
      if (objects.has(key)) return null;
      objects.set(key,copy);
      if (faults.afterPut) await faults.afterPut(key);
      return { key, size: copy.length };
    },
    delete() { assert.fail('A failed save must never automatically delete stored bytes.'); },
    list() { assert.fail('No broad storage listing is allowed.'); },
  };
  const count = (table) => Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  return { store: { isolation: 'explicit-test-store', db, bucket }, db, bucket, sqlite, faults, objects, log, count,
    close() { sqlite.close(); } };
}
