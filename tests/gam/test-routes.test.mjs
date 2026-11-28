import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
import {MemoryBucket} from './fixture.mjs';
import {initializeTestSchema} from '../../worker/test-workspace/schema.mjs';

test('TEST integration page and API require isolated host/session; read-only setup never touches GAM or D1',async()=>{
 const f=workspaceStore();
 try{
  f.env.BUILDS=new MemoryBucket();
  const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
  assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
  const env={...f.env,DB:new Proxy({},{get(){assert.fail('Integrations must not touch existing site database');}})};
  for(const path of ['/api-integrations','/api-integrations.js','/test-api/integrations/gam/status']){
   const unauth=await worker.fetch(new Request(ORIGIN+path),env);assert.equal(unauth.status,path.startsWith('/test-api/')?401:303);
   const result=await worker.fetch(new Request(ORIGIN+path,{headers:{cookie}}),env);assert.equal(result.status,200);assert.match(result.headers.get('cache-control'),/no-store/);
   assert.equal((await worker.fetch(new Request('https://production.invalid'+path,{headers:{cookie}}),env)).status,404);
  }
  const defaultsPath='/test-api/integrations/gam/line-items/defaults?network=123456';
  assert.equal((await worker.fetch(new Request(ORIGIN+defaultsPath),env)).status,401);
  assert.equal((await worker.fetch(new Request('https://production.invalid'+defaultsPath,{headers:{cookie}}),env)).status,404);
  assert.equal((await worker.fetch(new Request(ORIGIN+defaultsPath,{headers:{cookie}}),env)).status,503);
  const body=JSON.stringify({networkCode:'123456',credentials:{private_key:'NOT-A-KEY'}});
  for(const origin of ['https://other.invalid',''])assert.equal((await worker.fetch(new Request(ORIGIN+'/test-api/integrations/gam/connect',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body}),env)).status,403);
  const connect=await worker.fetch(new Request(ORIGIN+'/test-api/integrations/gam/connect',{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json'},body}),env);
  assert.equal(connect.status,503);assert.equal(env.BUILDS.data.size,0);
  const home=await worker.fetch(new Request(ORIGIN+'/',{headers:{cookie}}),env);assert.match(await home.text(),/href="\/api-integrations"/);
 }finally{f.close();}
});

test('site inventory routes require TEST session, exact site scope, origin and schema; defaults remain editable',async()=>{
 const f=workspaceStore();try{
  f.env.BUILDS=new MemoryBucket();await initializeTestSchema(f.env.DB,TEST_EMAIL);
  const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
  const cookie=login.headers.get('set-cookie').split(';')[0],base=ORIGIN+'/test-api/integrations/gam';
  const call=async(path,body,headers={cookie})=>worker.fetch(new Request(base+path,{method:body?'POST':'GET',headers:{...headers,...(body?{origin:ORIGIN,'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),f.env);
  assert.equal((await call('/sites',null,{})).status,401);
  const list=await (await call('/sites')).json();assert.equal(list.sites.length,1);assert.equal(list.sites[0].id,'test-site');
  assert.equal((await call('/site-inventory?siteId=other-site')).status,404);
  const state=await (await call('/site-inventory?siteId=test-site')).json();
  assert.equal((await call('/defaults',{siteId:'other-site',revision:state.revision})).status,404);
  const saved=await call('/defaults',{siteId:'test-site',revision:state.revision});assert.equal(saved.status,200,await saved.clone().text());assert.equal((await saved.json()).addedMaps,7);
  assert.equal((await call('/defaults',{siteId:'test-site',revision:state.revision})).status,409);
  const settings=await worker.fetch(new Request(ORIGIN+'/test-api/site-settings',{headers:{cookie}}),f.env);assert.equal(settings.status,200);assert((await settings.json()).draft.maps.some(m=>m.name==='Branding_Map'));
  f.sqlite.exec('CREATE TABLE unexpected_table (id TEXT)');assert.equal((await call('/sites')).status,409);
  assert.equal(f.env.BUILDS.data.size,0);
 }finally{f.close();}
});
