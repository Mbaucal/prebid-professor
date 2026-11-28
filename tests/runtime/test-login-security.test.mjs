import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/test-workspace/index.mjs';
import { workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD } from '../support/test-workspace-store.mjs';
import { inspectTestSchema,initializeTestSchema } from '../../worker/test-workspace/schema.mjs';
const login=(f,headers={})=>worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
test('TEST adapter preserves trusted source, reports 429 retry, and separate source can sign in',async()=>{
 const f=workspaceStore();try{
  for(let i=0;i<5;i++)assert.equal((await login(f,{'cf-connecting-ip':'192.0.2.1','x-forwarded-for':`198.51.100.${i}`})).status,303);
  const r=await login(f,{'cf-connecting-ip':'192.0.2.1'});assert.equal(r.status,429);assert(+r.headers.get('retry-after')<=60);const body=await r.text();assert.match(body,/Too many sign-in attempts/);assert.match(body,/value="tester@example.invalid"/);assert(!body.includes(TEST_PASSWORD));
  assert.equal((await login(f,{'cf-connecting-ip':'192.0.2.2'})).status,303);
  assert.deepEqual(await inspectTestSchema(f.env.DB),{ready:false,empty:true});
  assert.equal((await initializeTestSchema(f.env.DB,TEST_EMAIL)).ready,true);
 }finally{f.close();}
});
test('TEST limiter never writes an unknown or wrongly identified database',async()=>{
 const f=workspaceStore();try{
  f.sqlite.exec('CREATE TABLE foreign_table (id TEXT)');const before=f.sqlite.prepare('SELECT name,type,sql FROM sqlite_master').all();
  assert.equal((await login(f)).status,503);assert.equal(f.log.batches,0);assert.deepEqual(f.sqlite.prepare('SELECT name,type,sql FROM sqlite_master').all(),before);
 }finally{f.close();}
});
test('TEST schema reads have a deadline and fail closed with retry',async()=>{
 const f=workspaceStore();try{
  const original=f.env.DB;f.env.DB={...original,withSession(){return {prepare(){return {all(){return new Promise(()=>{});}};}};}};
  const r=await login(f);assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),'30');assert.match(await r.text(),/temporarily unavailable/);assert.equal(f.log.batches,0);
 }finally{f.close();}
});
test('TEST exact schema guard refuses malformed auth extension without repairing it',async()=>{
 const f=workspaceStore();try{
  await login(f);await initializeTestSchema(f.env.DB,TEST_EMAIL);f.sqlite.exec('DROP INDEX auth_login_limits_expiry');const before=f.log.batches;
  await assert.rejects(inspectTestSchema(f.env.DB),/Login limiter schema/);
  assert.equal((await login(f)).status,503);assert.equal(f.log.batches,before);
 }finally{f.close();}
});
