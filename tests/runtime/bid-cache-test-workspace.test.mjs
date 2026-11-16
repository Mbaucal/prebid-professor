// TEST workspace: the test site saves bid cache settings through the shared Demand → Prebid API and
// generates a 3.23.0 package with them, through the existing TEST flow. Local SQLite and memory R2 only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
import {enableTestPrebid,selectTestRuntime} from '../support/test-bid-cache-site.mjs';
import {BID_CACHE_GENERATOR_MESSAGE} from '../../worker/site-runtime/prebid-cache-settings.mjs';
import {TEST_BID_CACHE_GENERATOR_MESSAGE,TEST_BID_CACHE_BIDDER_RULES_MESSAGE,BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE} from '../../worker/test-workspace/bid-cache-messages.mjs';
import {TEST_BID_CACHE_GENERATOR_MESSAGE as SITE_WORKSPACE_MESSAGE} from '../../worker/test-workspace/site-workspace.mjs';
import {getPrebidSettings,savePrebidSettings} from '../../worker/test-workspace/prebid-settings.mjs';
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
 assert.equal(SITE_WORKSPACE_MESSAGE,TEST_BID_CACHE_GENERATOR_MESSAGE);assert.ok(TEST_BID_CACHE_GENERATOR_MESSAGE.startsWith(BID_CACHE_GENERATOR_MESSAGE.slice(0,BID_CACHE_GENERATOR_MESSAGE.indexOf('To keep'))));assert.doesNotMatch(TEST_BID_CACHE_GENERATOR_MESSAGE,/Config/);
 const refused=await f.req('/test-api/site-packages',{action:'generate',revision:blocked.revision,notes:'Refused'});
 assert.equal(refused.status,409);assert.equal(refused.data.error,TEST_BID_CACHE_GENERATOR_MESSAGE);
 const off=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:off.revision,bidCache:{enabled:false,maxBidAgeSeconds:45}},'PUT')).status,200);
 const unblocked=(await f.req('/test-api/site-packages')).data;
 assert.equal(unblocked.ready,true,unblocked.error);assert.equal(unblocked.runtime.runtimeVersion,'3.21.2');
});

test('the older TEST Generate (/test-api/generate) refuses saved bid caching on 3.21.2 with the TEST reason, not a storage error',async()=>{
 const f=await fixture();await enablePrebid(f);
 const mode=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:mode.revision,bidCache:{enabled:true,maxBidAgeSeconds:45}},'PUT')).status,200);
 await select(f,'3.21.2',true);
 const before=config(f);
 // The home page reads the reason up front.
 const status=(await f.req('/test-api/status')).data;
 assert.equal(status.runtime.version,'3.21.2');assert.equal(status.validationIssue,TEST_BID_CACHE_GENERATOR_MESSAGE);
 const generated=await f.req('/test-api/generate',{acknowledge:true});
 assert.equal(generated.status,409,JSON.stringify(generated.data));assert.equal(generated.data.error,TEST_BID_CACHE_GENERATOR_MESSAGE);
 assert.deepEqual(config(f),before);assert.deepEqual((await f.req('/test-api/releases')).data.releases,[]);
 // With 3.23.0 selected the same Generate works and carries the saved settings.
 await select(f,'3.23.0',true);
 assert.equal((await f.req('/test-api/status')).data.validationIssue,null);
 const ok=await f.req('/test-api/generate',{acknowledge:true});
 assert.equal(ok.status,200,JSON.stringify(ok.data));assert.equal(ok.data.descriptor.runtime.runtimeVersion,'3.23.0');assert.match(ok.data.adsJs,/createTesseraBidCache/);
});

test('a stale TEST Bid caching form is told to reload, not to change Prebid on/off',async()=>{
 const f=await fixture();await enablePrebid(f);
 const stale=(await f.req(MODE)).data;assert.equal(stale.prebidMode.enabled,true);
 // Another tab turns Prebid off in the TEST Prebid editor.
 const settings=await getPrebidSettings(f.env);
 await savePrebidSettings(f.env,TEST_EMAIL,{expectedRevision:settings.revision,draft:{...settings.draft,enablePrebid:false},acknowledge:true});
 const before=config(f);assert.equal(before.enablePrebid,false);
 const refused=await f.req(MODE,{enabled:true,revision:stale.revision,bidCache:{enabled:true,maxBidAgeSeconds:30}},'PUT');
 assert.equal(refused.status,409);assert.equal(refused.data.error,'Prebid settings changed. Reload before saving.');
 assert.deepEqual(config(f),before);
 // With the current revision, a form that would change Prebid on/off is still sent to the TEST Prebid editor.
 const current=(await f.req(MODE)).data;
 const toggle=await f.req(MODE,{enabled:true,revision:current.revision,bidCache:{enabled:true,maxBidAgeSeconds:30}},'PUT');
 assert.equal(toggle.status,409);assert.equal(toggle.data.error,'Turn Prebid on or off in Prebid and bidders. Here you can change bid caching only.');
 assert.deepEqual(config(f),before);
});

test('historical scripts refuse combined settings with an actionable combined Preview choice',async()=>{
 const f=await fixture();await enablePrebid(f);
 const mode=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:mode.revision,bidCache:{enabled:true,maxBidAgeSeconds:45}},'PUT')).status,200);
 const rules=(await f.req('/test-api/bidder-rules')).data;
 const savedRules=await f.req('/test-api/bidder-rules',{revision:rules.revision,settings:{schemaVersion:1,enabled:true,rules:[]}});
 assert.equal(savedRules.status,200,JSON.stringify(savedRules.data));
 await select(f,'3.22.0',true);
 // 3.22.0: bid caching is refused, and the reason names bidder rules.
 const packages=(await f.req('/test-api/site-packages')).data;
 assert.equal(packages.ready,false);assert.equal(packages.nextStep,'demand');assert.equal(packages.error,TEST_BID_CACHE_BIDDER_RULES_MESSAGE);
 const generated=await f.req('/test-api/generate',{acknowledge:true});
 assert.equal(generated.status,409);assert.equal(generated.data.error,TEST_BID_CACHE_BIDDER_RULES_MESSAGE);
 // Script setup with 3.23.0 (the request the Script setup panel sends): refused with the combined reason, not 'require script 3.22.0 or later'.
 const before=config(f),setup=(await f.req('/test-api/site-runtime')).data;
 const r323=setup.runtimes.find(r=>r.version==='3.23.0');
 const refused=await f.req('/test-api/site-runtime',{action:'setup',revision:setup.revision,runtime:r323.pin,allowPreview:false,enablePrebid:true});
 assert.equal(refused.status,422);assert.equal(refused.data.error,BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE);
 assert.deepEqual(config(f),before);
 for(const message of [TEST_BID_CACHE_BIDDER_RULES_MESSAGE,BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE]){
  assert.match(message,/select 3\.24\.0 Preview in Script setup, allow Preview scripts, and save/);assert.doesNotMatch(message,/No script version has both|or later|Config/);
 }
 // Bid caching off: 3.23.0 is still refused for the bidder rules, with the same reason.
 const off=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:off.revision,bidCache:{enabled:false,maxBidAgeSeconds:45}},'PUT')).status,200);
 assert.equal((await f.req('/test-api/site-packages')).data.ready,true);
 const again=(await f.req('/test-api/site-runtime')).data;
 const refusedOff=await f.req('/test-api/site-runtime',{action:'setup',revision:again.revision,runtime:r323.pin,allowPreview:false,enablePrebid:true});
 assert.equal(refusedOff.status,422);assert.equal(refusedOff.data.error,BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE);
 // Without bidder rules, the bid cache reason is the plain TEST one.
 const rulesNow=(await f.req('/test-api/bidder-rules')).data;
 assert.equal((await f.req('/test-api/bidder-rules',{revision:rulesNow.revision,settings:{schemaVersion:1,enabled:false,rules:[]}})).status,200);
 const on=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:on.revision,bidCache:{enabled:true,maxBidAgeSeconds:45}},'PUT')).status,200);
 assert.equal((await f.req('/test-api/site-packages')).data.error,TEST_BID_CACHE_GENERATOR_MESSAGE);
});


test('the TEST site explicitly selects combined Preview and generates both saved caching and bidder rules',async()=>{
 const f=await fixture();await enablePrebid(f);
 const mode=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:mode.revision,bidCache:{enabled:true,maxBidAgeSeconds:45}},'PUT')).status,200);
 const rules=(await f.req('/test-api/bidder-rules')).data;
 assert.equal((await f.req('/test-api/bidder-rules',{revision:rules.revision,settings:{schemaVersion:1,enabled:true,rules:[]}})).status,200);
 await select(f,'3.24.0',true);
 const before=config(f),state=(await f.req('/test-api/site-packages')).data;
 assert.equal(state.ready,true,state.error);assert.equal(state.runtime.runtimeVersion,'3.24.0');
 const created=await f.req('/test-api/site-packages',{action:'generate',revision:state.revision,notes:'Combined Preview package'});
 assert.equal(created.status,201,JSON.stringify(created.data));
 const download=await f.req('/test-api/releases/'+created.data.release.id+'/download');assert.equal(download.status,200);
 const files=unzipSync(new Uint8Array(await download.response.arrayBuffer())),exported=JSON.parse(text(files['config.json']));
 assert.equal(JSON.parse(text(files['manifest.json'])).runtime.runtimeVersion,'3.24.0');
 assert.equal(exported.bidCache.defaultEnabled,true);assert.equal(exported.bidCache.maxAgeSeconds,45);
 assert.deepEqual(exported.bidderRules,{schemaVersion:1,enabled:true,rules:[]});
 assert.match(text(files['ads.min.js']),/createTesseraBidCache/);assert.match(text(files['ads.min.js']),/__AD_BIDDER_RULES/);
 assert.deepEqual(config(f),before,'Generating leaves the explicitly selected configuration unchanged');
});

test('saved bidder accounts on 3.23.0: TEST Script setup and Releases name the script that applies every saved option',async()=>{
 const f=await fixture();await enablePrebid(f);
 // An account alias of the saved bidder, without an upstream SChain: only scripts with bidder accounts apply it.
 f.sqlite.prepare("INSERT INTO bidders(id,publisher_id,bidder,params_json,account_json,enabled) VALUES('alias-ox','test-site','ox_ag',?,?,1)")
  .run(JSON.stringify({unit:'synthetic-unit',delDomain:'synthetic.example.invalid'}),JSON.stringify({baseAdapter:'openx',displayName:'Agency',schain:{mode:'none'}}));
 const mode=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:mode.revision,bidCache:{enabled:true,maxBidAgeSeconds:45}},'PUT')).status,200);
 const expected='Script 3.23.0 cannot apply bidder accounts (ox_ag). To keep them with your saved bid caching, select 3.24.0 (Preview) in Script setup and save. Your saved settings and previous packages are unchanged.';
 const setup=(await f.req('/test-api/site-runtime')).data;
 assert.equal(setup.validationIssue,expected);
 // Generate and releases shows the same reason, not the generic configuration text.
 const packages=(await f.req('/test-api/site-packages')).data;
 assert.equal(packages.ready,false);assert.equal(packages.error,expected);
 // Saving 3.23.0 again is refused with it; 3.22.1, which cannot apply bid caching, is not named.
 const before=config(f),r323=setup.runtimes.find(r=>r.version==='3.23.0');
 const refused=await f.req('/test-api/site-runtime',{action:'setup',revision:setup.revision,runtime:r323.pin,allowPreview:false,enablePrebid:true});
 assert.equal(refused.status,422);assert.equal(refused.data.error,expected);assert.deepEqual(config(f),before);
 // Following it: 3.24.0 is ready.
 await select(f,'3.24.0',true);
 const ready=(await f.req('/test-api/site-packages')).data;
 assert.equal(ready.ready,true,ready.error);assert.equal(ready.runtime.runtimeVersion,'3.24.0');
});

test('the TEST Bidder rules view and Prebid editor name the versions for their option plus the saved ones',async()=>{
 const f=await fixture();await enablePrebid(f);
 // 3.22.1 is superseded by 3.22.2; 3.22.0 and 3.23.0 carry runtime notices; 3.23.0 has neither option.
 const both=['3.22.2 (Preview)','3.24.0 (Preview)'];
 assert.deepEqual((await f.req('/test-api/bidder-rules')).data.scriptVersions,both);
 assert.deepEqual((await f.req('/test-api/prebid-settings')).data.accountScriptVersions,both);
 // Saved bid caching: only the script that applies bid caching with bidder rules or bidder accounts.
 const mode=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:mode.revision,bidCache:{enabled:true,maxBidAgeSeconds:45}},'PUT')).status,200);
 assert.deepEqual((await f.req('/test-api/bidder-rules')).data.scriptVersions,['3.24.0 (Preview)']);
 assert.deepEqual((await f.req('/test-api/prebid-settings')).data.accountScriptVersions,['3.24.0 (Preview)']);
});

test('the TEST Bid caching view names the script that applies bid caching, never "or later"',async()=>{
 const f=await fixture();await enablePrebid(f);
 // 3.23.0 (selected by the TEST Prebid editor helper) applies bid caching; the panels then say "the selected script".
 const capable=(await f.req(MODE)).data;
 assert.equal(capable.runtimeSupportsBidCache,true);assert.equal(capable.bidCacheScriptVersion,'3.24.0 (Preview)');
 // The first version with bid caching stays as it is (3.23.0, which has a runtime notice).
 assert.equal(capable.bidCacheRuntimeVersion,'3.23.0');
 await select(f,'3.21.2',true);
 const earlier=(await f.req(MODE)).data;
 assert.equal(earlier.runtimeSupportsBidCache,false);assert.equal(earlier.bidCacheScriptVersion,'3.24.0 (Preview)');
});
