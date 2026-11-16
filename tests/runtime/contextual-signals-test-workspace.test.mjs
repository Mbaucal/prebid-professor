import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
const fixtures=[];
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
async function fixture(){
 const f=workspaceStore();fixtures.push(f);
 const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
 assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
 f.req=(path,body,headers={})=>worker.fetch(new Request(ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{origin:ORIGIN,cookie,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)}),f.env);
 assert.equal((await f.req('/test-api/setup',{confirm:'prepare-empty-test-database'})).status,200);
 return f;
}
const endpoint='/test-api/contextual-signals';
const config=f=>JSON.parse(f.sqlite.prepare("SELECT config_json FROM publisher_configs WHERE publisher_id='test-site'").get().config_json);
test('TEST contextual settings save only the isolated copy, preserve selection and return the canonical integration kit',async()=>{
 const f=await fixture(),before=config(f);
 const response=await f.req(endpoint);assert.equal(response.status,200);const state=await response.json();assert.equal(state.settings.enabled,false);
 const settings={...state.settings,enabled:true,gam:{enabled:true},mappings:[{value:'Books',taxonomies:{'iab-content-2.2':['48']}}]};
 const saved=await f.req(endpoint,{revision:state.revision,settings});assert.equal(saved.status,200,await saved.clone().text());
 assert.deepEqual(config(f).builtinRuntimeSelection,before.builtinRuntimeSelection);
 assert.deepEqual(config(f).runtimeControls.contextualSignals,settings);
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM publishers WHERE id<>'test-site'").get().n,0);
 const stale=await f.req(endpoint,{revision:state.revision,settings});assert.equal(stale.status,409);
 const kit=await f.req(endpoint+'/build-kit');assert.equal(kit.status,200,await kit.clone().text());assert.equal(kit.headers.get('content-type'),'application/zip');
 const files=unzipSync(new Uint8Array(await kit.arrayBuffer()));assert(files['modules/contextualSignalsRtdProvider.js']);
 assert.equal(JSON.parse(new TextDecoder().decode(files['integration.json'])).siteId,'test-site');
 assert.equal(f.objects.size,0);
 const audits=f.sqlite.prepare("SELECT actor FROM audit_log WHERE action='contextual_signals.saved'").all();assert.equal(audits.length,1);assert.equal(audits[0].actor,TEST_EMAIL);
});
test('TEST contextual routes preserve authentication, origin, host and exact site boundaries',async()=>{
 const f=await fixture(),before=config(f);
 for(const path of [endpoint,endpoint+'/build-kit']){
  assert.equal((await f.req(path,undefined,{cookie:''})).status,401);
  assert.equal((await f.req(path,{}, {origin:'https://other.invalid','sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await f.req(path+'?site=politika')).status,404);
 }
 assert.equal((await f.req(endpoint,{}, {origin:'https://other.invalid'})).status,403);
 assert.equal((await f.req('/api/publishers/politika/contextual-signals')).status,404);
 assert.equal((await f.req('/api/publishers/test-site/contextual-signals')).status,404);
 const wrong=await worker.fetch(new Request('https://prebid-professor.mbaucal.workers.dev'+endpoint),f.env);assert.equal(wrong.status,404);
 assert.deepEqual(config(f),before);assert.equal(f.objects.size,0);
});
