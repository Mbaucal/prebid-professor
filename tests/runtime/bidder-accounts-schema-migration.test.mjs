import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyStatements, legacySchemaSha256} from '../../.generated/test-workspace-schema.mjs';
import {initializeTestSchema, inspectTestSchema, migrateBidderAccountSchema, schemaSha256} from '../../worker/test-workspace/schema.mjs';
import {TEST_DATABASE, TEST_BUCKET} from '../../worker/test-workspace/boundary.mjs';
import {workspaceStore, TEST_EMAIL, TEST_PASSWORD, ORIGIN} from '../support/test-workspace-store.mjs';
import worker from '../../worker/test-workspace/index.mjs';

function legacy() {
  const f = workspaceStore();
  for (const sql of legacyStatements) f.sqlite.exec(sql);
  f.sqlite.prepare('INSERT INTO tessera_test_environment VALUES (1,?,?,?)').run(legacySchemaSha256,TEST_DATABASE,TEST_BUCKET);
  f.sqlite.exec("INSERT INTO publishers (id,name,domain,gam_path) VALUES ('test-site','Existing','example.invalid','/123/test/'); INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES('config','test-site','{\"enablePrebid\":false}'); INSERT INTO bidders(id,publisher_id,bidder,params_json) VALUES('adf','test-site','adf','{\"mid\":123}');");
  f.objects.set('saved-zip',new Uint8Array([1,2,3]));
  return f;
}

test('known predecessor is readable but upgraded only by explicit action, preserving all data',async()=>{
  const f=legacy();
  try {
    const before=f.sqlite.prepare('SELECT * FROM bidders').all().map(row=>({...row}));
    assert.deepEqual(await inspectTestSchema(f.env.DB),{ready:false,empty:false,requiresMigration:'bidder-accounts'});
    assert.equal(f.log.batches,0);
    await assert.rejects(initializeTestSchema(f.env.DB,TEST_EMAIL),{status:409});
    assert.equal(f.log.batches,0);
    assert.equal((await migrateBidderAccountSchema(f.env.DB,TEST_EMAIL)).migrated,true);
    assert.deepEqual(f.sqlite.prepare('SELECT * FROM bidders').all().map(({account_json,...row})=>{assert.equal(account_json,'{}');return row;}),before);
    assert.equal(f.sqlite.prepare('SELECT schema_sha256 FROM tessera_test_environment').get().schema_sha256,schemaSha256);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,1);
    assert.deepEqual([...f.objects],[['saved-zip',new Uint8Array([1,2,3])]]);
    const batches=f.log.batches;
    assert.equal((await migrateBidderAccountSchema(f.env.DB,TEST_EMAIL)).migrated,false);
    assert.equal(f.log.batches,batches,'retry after lost response is read-only');
  }finally{f.close();}
});

test('migration failure rolls back the new column, marker and audit together',async()=>{
  const f=legacy();
  try {
    f.faults.batchAt=3;
    await assert.rejects(migrateBidderAccountSchema(f.env.DB,TEST_EMAIL));
    assert.equal(f.sqlite.prepare('PRAGMA table_info(bidders)').all().some(r=>r.name==='account_json'),false);
    assert.equal(f.sqlite.prepare('SELECT schema_sha256 FROM tessera_test_environment').get().schema_sha256,legacySchemaSha256);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM builtin_draft_assertions').get().n,0);
    f.faults.batchAt=-1;
    assert.equal((await migrateBidderAccountSchema(f.env.DB,TEST_EMAIL)).migrated,true);
  }finally{f.close();}
});

for(const [label,sql] of [
  ['altered identity',"UPDATE tessera_test_environment SET database_id='other'"],
  ['altered schema marker',"UPDATE tessera_test_environment SET schema_sha256='unknown'"],
  ['missing safety trigger','DROP TRIGGER test_no_promotion'],
  ['unexpected column','ALTER TABLE bidders ADD COLUMN extra TEXT'],
])test(`migration refuses ${label} without writes`,async()=>{
  const f=legacy();
  try{f.sqlite.exec(sql);await assert.rejects(migrateBidderAccountSchema(f.env.DB,TEST_EMAIL),{status:409});assert.equal(f.log.batches,0);}finally{f.close();}
});

test('fresh initialization includes the account column without requiring a second migration',async()=>{
  const f=workspaceStore();
  try{await initializeTestSchema(f.env.DB,TEST_EMAIL);assert.deepEqual(await inspectTestSchema(f.env.DB),{ready:true,empty:false});assert.equal((await migrateBidderAccountSchema(f.env.DB,TEST_EMAIL)).migrated,false);}finally{f.close();}
});

test('existing TEST users can sign in and explicitly upgrade; auth and origin checks stay enforced',async()=>{
  const f=legacy();
  try {
    const call=(cookie,origin,confirm='migrate-bidder-accounts')=>worker.fetch(new Request(ORIGIN+'/test-api/setup',{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...(origin?{origin}:{})},body:JSON.stringify({confirm})}),f.env);
    assert.equal((await call('',ORIGIN)).status,401);
    const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD}).toString()}),f.env);
    assert.equal(login.status,303);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const before=f.log.batches;
    assert.equal((await call(cookie,'https://other.invalid')).status,403);
    assert.equal((await call(cookie,'')).status,403);
    assert.equal((await call(cookie,ORIGIN,'upgrade')).status,422);
    assert.equal(f.log.batches,before);
    const response=await call(cookie,ORIGIN);
    assert.equal(response.status,200,await response.clone().text());
    assert.equal((await response.json()).migrated,true);
    assert.equal((await inspectTestSchema(f.env.DB)).ready,true);
  }finally{f.close();}
});
