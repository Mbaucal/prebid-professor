import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/app-builtin-runtime-preview.ts';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {TEST_EMAIL,TEST_PASSWORD,TEST_SECRET} from '../support/test-workspace-store.mjs';
const origin='https://bidder-rules.fixture.invalid',path='/api/publishers/audit-site/bidder-rules';
const ctx={waitUntil(){},passThroughOnException(){}};
async function fixture(){
  const f=adminAuditStore();
  Object.assign(f.env,{ADMIN_EMAIL:TEST_EMAIL,ADMIN_PASSWORD:TEST_PASSWORD,SESSION_SECRET:TEST_SECRET,ASSETS:{fetch(){throw Error('No remote assets');}}});
  const login=await worker.fetch(new Request(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env,ctx);
  assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
  return {...f,call:(suffix=path,options={})=>worker.fetch(new Request(origin+suffix,{headers:{cookie},...options}),f.env,ctx),cookie};
}
test('actual route enforces authentication, origin, method and query boundaries',async()=>{
  const f=await fixture();try{
    assert.equal((await f.call(path,{headers:{}})).status,401);
    assert.equal((await f.call(path,{headers:{'cf-access-authenticated-user-email':TEST_EMAIL}})).status,401);
    for(const requestOrigin of [null,'https://foreign.invalid']){
      const headers={cookie:f.cookie,'content-type':'application/json'};if(requestOrigin)headers.origin=requestOrigin;
      assert.equal((await f.call(path,{method:'POST',headers,body:'{}'})).status,403);
    }
    assert.equal((await f.call(path,{method:'DELETE',headers:{cookie:f.cookie,origin}})).status,405);
    assert.equal((await f.call(path+'?ignored=true')).status,400);
    assert.equal((await f.call(path+'/build-kit')).status,404);
    const result=await f.call();assert.equal(result.status,200);assert.equal((await result.json()).settings.enabled,false);
  }finally{f.close();}
});
test('all legacy generation and preview paths reject enabled rules instead of silently dropping them',async()=>{
  const f=await fixture();try{
    const config=f.readConfig();config.runtimeControls.bidderRules={schemaVersion:1,enabled:true,rules:[]};f.writeConfig(config);
    for(const [suffix,method] of [['releases/generate','POST'],['releases/validate','POST'],['builtin-runtime-preview','GET'],['builtin-runtime-preview','POST'],['builtin-runtime-bundle','POST'],['builtin-runtime-prebid-check','GET']]){
      const response=await f.call('/api/publishers/audit-site/'+suffix,{method,headers:{cookie:f.cookie,origin,'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
      assert.equal(response.status,409,suffix);assert.match((await response.json()).error,/Bidder rules require script 3.22.0/);
    }
  }finally{f.close();}
});
