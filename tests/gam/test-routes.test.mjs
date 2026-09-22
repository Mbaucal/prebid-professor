import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
import {MemoryBucket} from './fixture.mjs';

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
  const body=JSON.stringify({networkCode:'123456',credentials:{private_key:'NOT-A-KEY'}});
  for(const origin of ['https://other.invalid',''])assert.equal((await worker.fetch(new Request(ORIGIN+'/test-api/integrations/gam/connect',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body}),env)).status,403);
  const connect=await worker.fetch(new Request(ORIGIN+'/test-api/integrations/gam/connect',{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json'},body}),env);
  assert.equal(connect.status,503);assert.equal(env.BUILDS.data.size,0);
  const home=await worker.fetch(new Request(ORIGIN+'/',{headers:{cookie}}),env);assert.match(await home.text(),/href="\/api-integrations"/);
 }finally{f.close();}
});
