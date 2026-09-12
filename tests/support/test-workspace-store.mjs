import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { TEST_DATABASE, TEST_BUCKET, TEST_WORKER } from '../../worker/test-workspace/boundary.mjs';
export const ORIGIN = 'https://prebid-professor-test.mbaucal.workers.dev';
export const TEST_EMAIL = 'tester@example.invalid';
export const TEST_PASSWORD = 'Local-fixture-only-password-927!';
export const TEST_SECRET = 'Local-fixture-only-session-key-not-a-live-credential-927!';
export function workspaceStore() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const objects=new Map(), log={sql:[],puts:[],gets:[],batches:0};
  const faults={batchAt:-1,batchAfter:false,putName:''};
  function execute(sql,args) {
    log.sql.push(sql);
    const statement=sqlite.prepare(sql);
    if(statement.columns().length)return {success:true,results:statement.all(...args),meta:{changes:0}};
    return {success:true,results:[],meta:{changes:Number(statement.run(...args).changes)}};
  }
  const db={
    withSession(constraint){assert.equal(constraint,'first-primary');return db;},
    prepare(sql){const prepare=(args)=>({sql,args,bind(...values){return prepare(values);},async run(){return execute(sql,args);},async all(){return execute(sql,args);},async first(){return execute(sql,args).results[0]??null;}});return prepare([]);},
    async batch(items){log.batches++;sqlite.exec('BEGIN IMMEDIATE');let result;try{result=items.map((item,index)=>{if(index===faults.batchAt)throw Error('injected schema failure');return execute(item.sql,item.args);});sqlite.exec('COMMIT');}catch(error){sqlite.exec('ROLLBACK');throw error;}
      // Inject loss after the release registration commit, not an earlier SELECT snapshot.
      if(faults.batchAfter && items.some((item)=>/^INSERT INTO releases /.test(item.sql)))throw Error('response lost after commit');return result;},
  };
  const bucket={
    async get(key){log.gets.push(key);assert.match(key,/^publishers\/test-site\/releases\/builtin-draft-[a-f0-9]{64}\//);const value=objects.get(key);if(!value)return null;const copy=value.slice();return {size:copy.length,async arrayBuffer(){return copy.buffer;}};},
    async put(key,bytes,options){log.puts.push(key);assert.equal(options.onlyIf.get('If-None-Match'),'*');assert.equal(options.httpMetadata.cacheControl,'private, no-store');if(faults.putName&&key.endsWith('/'+faults.putName))throw Error('injected R2 failure');if(objects.has(key))return null;objects.set(key,new Uint8Array(bytes).slice());return {key};},
    delete(){assert.fail('No automatic object deletion');},list(){assert.fail('No bucket-wide listing');},
  };
  const env={TEST_WORKSPACE_ENABLED:'true',TEST_PUBLIC_ORIGIN:ORIGIN,TEST_WORKER_NAME:TEST_WORKER,TEST_DATABASE_ID:TEST_DATABASE,TEST_BUCKET_NAME:TEST_BUCKET,
    TEST_ADMIN_EMAIL:TEST_EMAIL,TEST_ADMIN_PASSWORD:TEST_PASSWORD,TEST_SESSION_SECRET:TEST_SECRET,DB:db,BUILDS:bucket};
  return {env,sqlite,objects,log,faults,close(){sqlite.close();}};
}
