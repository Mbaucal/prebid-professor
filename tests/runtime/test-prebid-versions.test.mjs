import test from 'node:test';
import assert from 'node:assert/strict';
import {prebidVersions} from '../../worker/test-workspace/prebid-versions.mjs';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN} from '../support/test-workspace-store.mjs';
const original=globalThis.fetch;
test.afterEach(()=>{globalThis.fetch=original;});
test('version lookup uses only the fixed public endpoint, rejects redirects and has a deadline',async()=>{
  globalThis.fetch=async(url,options)=>{assert.equal(url,'https://js-download.prebid.org/versions');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.method,'GET');assert.equal(options.body,undefined);assert(options.signal instanceof AbortSignal);return Response.json({versions:['11.34.0','11.33.0','8.0.0']});};
  assert.deepEqual((await prebidVersions()).versions,['11.34.0','11.33.0']);
});
test('invalid, oversized and failed catalogs return a safe error without replacing entered settings',async()=>{
  for(const value of ['private upstream error',JSON.stringify({versions:['latest']}),JSON.stringify({versions:['8.0.0']}),'x'.repeat(32769)]){
    globalThis.fetch=async()=>new Response(value);await assert.rejects(prebidVersions(),e=>e.status===503&&!e.message.includes(value));
  }
});
test('new plan and version endpoints require authentication before data or network access',async()=>{
  const f=workspaceStore();try{
    Object.defineProperty(f.env,'DB',{get(){assert.fail('No data access without session');}});
    globalThis.fetch=()=>assert.fail('No network without session');
    for(const [path,method] of [['/test-api/prebid/versions','GET'],['/test-api/prebid/plan','POST'],['/test-api/prebid/plan/save','POST']]){
      const r=await worker.fetch(new Request(ORIGIN+path,{method,headers:{origin:ORIGIN,'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})}),f.env);assert.equal(r.status,401);
    }
  }finally{f.close();}
});
