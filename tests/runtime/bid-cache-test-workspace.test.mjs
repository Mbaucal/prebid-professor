// TEST workspace: the test site saves bid cache settings through the shared Demand → Prebid API and
// generates a 3.23.0 package with them, through the existing TEST flow. Local SQLite and memory R2 only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
import {enableTestPrebid,selectTestRuntime} from '../support/test-bid-cache-site.mjs';
import {BID_CACHE_GENERATOR_MESSAGE} from '../../worker/site-runtime/prebid-cache-settings.mjs';
import {TEST_BID_CACHE_GENERATOR_MESSAGE} from '../../worker/test-workspace/site-workspace.mjs';
const MODE='/api/publishers/test-site/prebid-mode';
const fixtures=[];
test.before(()=>{globalThis.fetch=()=>assert.fail('No external request in the TEST bid cache flow');});
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
const text=bytes=>new TextDecoder().decode(bytes);
async function fixture(){
 const f=workspaceStore({prebidFiles:true});fixtures.push(f);
 const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
 assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
 f.req=async(path,body,method=body===undefined?'GET':'POST',headers={})=>{
  const response=await worker.fetch(new Request(ORIGIN+path,{method,headers:{origin:ORIGIN,cookie,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)}),f.env);
  return {status:response.status,response,data:response.headers.get('content-type')?.includes('json')?await response.json():null};
 };
 assert.equal((await f.req('/test-api/setup',{confirm:'prepare-empty-test-database'})).status,200);
 return f;
}
const select=(f,version,enablePrebid)=>selectTestRuntime(f.req,version,enablePrebid);
const enablePrebid=f=>enableTestPrebid(f.env,f.req);
const config=f=>JSON.parse(f.sqlite.prepare("SELECT config_json FROM publisher_configs WHERE publisher_id='test-site'").get().config_json);

test('the TEST site reads and saves bid cache settings for its own positions through the shared API',async()=>{
 const f=await fixture();
 // Prebid is off in an empty TEST copy, and only the TEST Prebid editor turns it on.
 const off=(await f.req(MODE)).data,before=config(f);
 assert.equal(off.prebidMode.enabled,false);
 const toggled=await f.req(MODE,{enabled:true,revision:off.revision,bidCache:{enabled:true,maxBidAgeSeconds:45}},'PUT');
 assert.equal(toggled.status,409);assert.equal(toggled.data.error,'Turn Prebid on or off in Prebid and bidders. Here you can change bid caching only.');
 assert.deepEqual(config(f),before);
 await enablePrebid(f);
 const state=(await f.req(MODE)).data;
 assert.equal(state.bidCacheAvailable,true);assert.deepEqual(state.bidCachePositions,['Billboard','Sticky']);
 assert.equal(state.namedScriptLibrary,false);assert.equal(state.bidCacheRuntimeVersion,'3.23.0');
 const saved=await f.req(MODE,{enabled:true,revision:state.revision,bidCache:{enabled:true,maxBidAgeSeconds:45,positionOverrides:{Sticky:false}}},'PUT');
 assert.equal(saved.status,200,JSON.stringify(saved.data));
 assert.deepEqual(config(f).prebidBidCache,{enabled:true,maxBidAgeSeconds:45,positionOverrides:{Sticky:false}});
 const audits=f.sqlite.prepare("SELECT actor FROM audit_log WHERE action='prebid_mode.updated'").all();assert.equal(audits.length,1);assert.equal(audits[0].actor,TEST_EMAIL);
 const now=(await f.req(MODE)).data;
 const foreign=await f.req(MODE,{enabled:true,revision:now.revision,bidCache:{enabled:true,maxBidAgeSeconds:45,positionOverrides:{Home_Top:true}}},'PUT');
 assert.equal(foreign.status,422);assert.match(foreign.data.error,/Home_Top is not an enabled ATF or BTF banner position on this site/);
 assert.equal((await f.req(MODE,{enabled:true,revision:state.revision,bidCache:{enabled:false,maxBidAgeSeconds:60}},'PUT')).status,409);
 assert.deepEqual(config(f).prebidBidCache,{enabled:true,maxBidAgeSeconds:45,positionOverrides:{Sticky:false}});
});

test('the TEST prebid-mode route keeps authentication, origin, method, query and site boundaries',async()=>{
 const f=await fixture();await enablePrebid(f);
 const before=config(f),state=(await f.req(MODE)).data;
 const body={enabled:true,revision:state.revision,bidCache:{enabled:true,maxBidAgeSeconds:60}};
 assert.equal((await f.req(MODE,{...body,enabled:false},'PUT')).status,409);
 assert.equal((await f.req(MODE,undefined,'GET',{cookie:''})).status,401);
 assert.equal((await f.req(MODE,body,'PUT',{origin:'https://other.invalid','sec-fetch-site':'cross-site'})).status,403);
 for(const method of ['DELETE','PATCH'])assert.equal((await f.req(MODE,body,method)).status,405);
 assert.equal((await f.req(MODE,body,'POST')).status,405);
 assert.equal((await f.req(MODE+'?site=politika')).status,400);
 assert.equal((await f.req('/api/publishers/politika/prebid-mode',body,'PUT')).status,405);
 assert.equal((await f.req(MODE,{...body,extra:true},'PUT')).status,422);
 assert.equal((await f.req(MODE,{revision:state.revision,bidCache:body.bidCache},'PUT')).status,422);
 assert.deepEqual(config(f),before);
});

test('the TEST site generates 3.23.0 with its saved bid caching; 3.21.2 is blocked with the reason',async()=>{
 const f=await fixture();await enablePrebid(f);await select(f,'3.23.0',true);
 const mode=(await f.req(MODE)).data;
 assert.deepEqual(mode.selectedRuntime,{id:'tessera-3.23.0',version:'3.23.0'});assert.equal(mode.runtimeSupportsBidCache,true);
 assert.equal((await f.req(MODE,{enabled:true,revision:mode.revision,bidCache:{enabled:true,maxBidAgeSeconds:45,positionOverrides:{Sticky:false}}},'PUT')).status,200);
 const state=(await f.req('/test-api/site-packages')).data;
 assert.equal(state.ready,true,state.error);assert.equal(state.runtime.runtimeVersion,'3.23.0');
 const created=await f.req('/test-api/site-packages',{action:'generate',revision:state.revision,notes:'Bid cache package'});
 assert.equal(created.status,201,JSON.stringify(created.data));
 const download=await f.req('/test-api/releases/'+created.data.release.id+'/download');assert.equal(download.status,200);
 const files=unzipSync(new Uint8Array(await download.response.arrayBuffer()));
 assert.deepEqual(JSON.parse(text(files['config.json'])).bidCache,{defaultEnabled:true,maxAgeSeconds:45,positions:{Billboard:true,Sticky:false}});
 assert.equal(JSON.parse(text(files['manifest.json'])).runtime.runtimeVersion,'3.23.0');
 assert.match(text(files['ads.min.js']),/createTesseraBidCache/);
 await select(f,'3.21.2',true);
 const blocked=(await f.req('/test-api/site-packages')).data;
 assert.equal(blocked.ready,false);assert.equal(blocked.nextStep,'demand');assert.equal(blocked.error,TEST_BID_CACHE_GENERATOR_MESSAGE);
 // Same reason as the shared message, with this workspace's own menus instead of Config.
 assert.ok(TEST_BID_CACHE_GENERATOR_MESSAGE.startsWith(BID_CACHE_GENERATOR_MESSAGE.slice(0,BID_CACHE_GENERATOR_MESSAGE.indexOf('To keep'))));assert.doesNotMatch(TEST_BID_CACHE_GENERATOR_MESSAGE,/Config/);
 const refused=await f.req('/test-api/site-packages',{action:'generate',revision:blocked.revision,notes:'Refused'});
 assert.equal(refused.status,409);assert.equal(refused.data.error,TEST_BID_CACHE_GENERATOR_MESSAGE);
 const off=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:off.revision,bidCache:{enabled:false,maxBidAgeSeconds:45}},'PUT')).status,200);
 const unblocked=(await f.req('/test-api/site-packages')).data;
 assert.equal(unblocked.ready,true,unblocked.error);assert.equal(unblocked.runtime.runtimeVersion,'3.21.2');
});
