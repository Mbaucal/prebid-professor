import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
import {siteRuntimeSettings,changeSiteRuntime} from '../../worker/site-runtime/service.mjs';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
import {recommendedRuntimeRelease} from '../../shared/runtime-notices.mjs';

test('recommendation excludes only the exact known earlier cache source and never auto-promotes preview',()=>{
  const before=JSON.stringify(runtimeReleaseHistory);
  assert.equal(runtimeReleaseHistory.find(r=>r.channel==='stable').version,'3.23.0','immutable history remains factual');
  assert.equal(recommendedRuntimeRelease(runtimeReleaseHistory).version,'3.21.2');
  const future={id:'tessera-3.25.0',version:'3.25.0',channel:'stable',codeSha256:'a'.repeat(64)};
  assert.equal(recommendedRuntimeRelease([future,...runtimeReleaseHistory]),future,'a later stable record is not permanently pinned out');
  const otherSource={...future,id:'other',version:'3.23.0'};
  assert.equal(recommendedRuntimeRelease([otherSource,...runtimeReleaseHistory]),otherSource,'the exclusion is source-specific');
  assert.equal(recommendedRuntimeRelease(runtimeReleaseHistory.filter(r=>r.channel==='preview')),undefined);
  assert.equal(JSON.stringify(runtimeReleaseHistory),before);
});

test('the real settings read recommends 3.21.2 without writes; explicit 3.23.0 selection stays valid',async()=>{
  const f=workspaceStore();
  try{
    const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const prepared=await worker.fetch(new Request(ORIGIN+'/test-api/setup',{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({confirm:'prepare-empty-test-database'})}),f.env);
    assert.equal(prepared.status,200);
    const before=f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json;
    const audits=f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n;
    let state=await siteRuntimeSettings(f.env,'test-site');
    assert.equal(state.currentRuntime.version,'3.21.2');assert.equal(state.selected,null);
    assert.equal(state.runtimes.find(r=>r.version==='3.24.0').channel,'preview');
    assert.equal(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json,before);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n,audits);
    const earlier=state.runtimes.find(r=>r.version==='3.23.0');
    await changeSiteRuntime(f.env,'test-site',TEST_EMAIL,{action:'setup',revision:state.revision,runtime:earlier.pin,allowPreview:false,enablePrebid:false});
    state=await siteRuntimeSettings(f.env,'test-site');
    assert.deepEqual(state.selected,earlier.pin);
    assert.equal(state.currentRuntime.version,'3.21.2');assert.equal(earlier.channel,'stable');
  }finally{f.close();}
});
