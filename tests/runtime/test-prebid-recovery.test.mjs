import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/test-workspace/index.mjs';
import { workspaceStore, ORIGIN, TEST_EMAIL, TEST_PASSWORD } from '../support/test-workspace-store.mjs';
import { readPreviewSnapshot } from '../../worker/runtime/builtin-preview-service.mjs';
import { savePrebidSettings } from '../../worker/test-workspace/prebid-settings.mjs';
const active = [];
test.afterEach(() => { while (active.length) active.pop().close(); });
async function call(f, path, body, raw = false) {
  const response = await worker.fetch(new Request(ORIGIN + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: f.cookie, ...(body === undefined ? {} : { origin: ORIGIN,
      ...(raw ? {'content-type':'application/javascript','x-tessera-upload':'prebid-test-file'} : {'content-type':'application/json'}) }) },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  }), f.env);
  return {status:response.status,data:await response.json()};
}
async function ready() {
  const f=workspaceStore({prebidFiles:true}); active.push(f);
  const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
  f.cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await call(f,'/test-api/setup',{confirm:'prepare-empty-test-database'})).status,200);
  const s=(await call(f,'/test-api/runtime-selection')).data;
  assert.equal((await call(f,'/test-api/runtime-selection',{expectedRevision:s.revision,selection:{runtime:s.runtimes[0].pin,allowPreview:true,enablePrebid:false,prebidBuildId:null}})).status,200);
  const uploaded=await call(f,'/test-api/prebid/upload','/* prebid.js v11.11.0\nModules: adformBidAdapter, consentManagementTcf, tcfControl, currency */\nwindow.fixtureOnly=true;',true);
  assert.equal(uploaded.status,200);
  const state=(await call(f,'/test-api/prebid-settings')).data;
  assert.equal((await call(f,'/test-api/prebid-settings',{expectedRevision:state.revision,acknowledge:true,draft:{...state.draft,enablePrebid:true,buildId:uploaded.data.file.id,bidders:[{bidder:'adform',params:{mid:123},enabled:true}]}})).status,200);
  return f;
}
for(const fault of ['missing','corrupt','unreadable']) test('OFF works without reading '+fault+' bytes; ON still verifies them',async()=>{
  const f=await ready(), s=(await call(f,'/test-api/prebid-settings')).data;
  const before=await readPreviewSnapshot(f.env.DB,'test-site',{includePrebid:true});
  const key=before.prebidBuilds[0].file_key, original=f.env.BUILDS.get;
  if(fault==='missing')f.objects.delete(key);
  if(fault==='corrupt')f.objects.get(key)[0]^=1;
  f.env.BUILDS.get=async()=>assert.fail('OFF must not read unavailable Prebid bytes');
  const off=await savePrebidSettings(f.env,TEST_EMAIL,{expectedRevision:s.revision,acknowledge:true,draft:{...s.draft,enablePrebid:false}});
  assert(off.persisted);
  const after=await readPreviewSnapshot(f.env.DB,'test-site',{includePrebid:true});
  assert.deepEqual(after.prebidBuilds,before.prebidBuilds); assert.deepEqual(after.bidders,before.bidders);
  const generated=await call(f,'/test-api/generate',{acknowledge:true,takeOverEnabled:false});
  assert.equal(generated.status,200); assert.equal(generated.data.descriptor.files.length,9);
  f.env.BUILDS.get=fault==='unreadable'?async()=>{throw Error('temporary R2 failure');}:original;
  const next=(await call(f,'/test-api/prebid-settings')).data;
  const enabled=await call(f,'/test-api/prebid-settings',{expectedRevision:next.revision,acknowledge:true,draft:{...next.draft,enablePrebid:true}});
  assert(enabled.status>=400); assert.equal((await call(f,'/test-api/prebid-settings')).data.draft.enablePrebid,false);
});
test('HTTP OFF preserves current record and partner data when its R2 object is missing',async()=>{
  const f=await ready(),s=(await call(f,'/test-api/prebid-settings')).data; f.objects.clear();
  const off=await call(f,'/test-api/prebid-settings',{expectedRevision:s.revision,acknowledge:true,draft:{...s.draft,enablePrebid:false}});
  assert.equal(off.status,200,JSON.stringify(off.data));
  const next=(await call(f,'/test-api/prebid-settings')).data;
  assert.equal(next.draft.buildId,s.draft.buildId); assert.deepEqual(next.draft.bidders,s.draft.bidders);
});
