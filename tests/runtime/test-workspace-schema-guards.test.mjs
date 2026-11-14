import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeTestSchema, inspectTestSchema } from '../../worker/test-workspace/schema.mjs';
import { workspaceStore, TEST_EMAIL } from '../support/test-workspace-store.mjs';
const changes = [
  ['missing quota trigger', (sql) => sql.exec('DROP TRIGGER test_draft_quota')],
  ['changed quota trigger', (sql) => sql.exec("DROP TRIGGER test_draft_quota; CREATE TRIGGER test_draft_quota BEFORE INSERT ON builtin_draft_uploads BEGIN SELECT 1; END")],
  ['missing promotion protection', (sql) => sql.exec('DROP TRIGGER test_no_promotion')],
  ['missing index', (sql) => { const row=sql.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL LIMIT 1").get(); assert.match(row.name,/^\w+$/);sql.exec('DROP INDEX '+row.name); }],
  ['changed table definition', (sql) => sql.exec('ALTER TABLE publishers ADD COLUMN unreviewed TEXT')],
  ['unexpected view', (sql) => sql.exec('CREATE VIEW unexpected_view AS SELECT id FROM publishers')],
];
for(const [name,change] of changes) test(`refuses ${name} even with the original marker intact`,async()=>{
  const fixture=workspaceStore();
  try{
    await initializeTestSchema(fixture.env.DB,TEST_EMAIL);
    assert.equal((await inspectTestSchema(fixture.env.DB)).ready,true);
    const marker=fixture.sqlite.prepare('SELECT schema_sha256 FROM tessera_test_environment').get().schema_sha256;
    change(fixture.sqlite);
    assert.equal(fixture.sqlite.prepare('SELECT schema_sha256 FROM tessera_test_environment').get().schema_sha256,marker);
    const batches=fixture.log.batches;
    await assert.rejects(inspectTestSchema(fixture.env.DB),(error)=>error.status===409);
    await assert.rejects(initializeTestSchema(fixture.env.DB,TEST_EMAIL),(error)=>error.status===409);
    assert.equal(fixture.log.batches,batches,'No automatic DDL repair');
    assert.equal(fixture.objects.size,0,'No storage writes');
  }finally{fixture.close();}
});
