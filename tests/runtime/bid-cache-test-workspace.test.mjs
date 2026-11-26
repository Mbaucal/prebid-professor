// TEST workspace: the test site saves bid cache settings through the shared Demand → Prebid API and
// generates a 3.23.0 package with them, through the existing TEST flow. Local SQLite and memory R2 only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
import {enableTestPrebid,selectTestRuntime} from '../support/test-bid-cache-site.mjs';
import {BID_CACHE_GENERATOR_MESSAGE,bidCacheScriptVersions} from '../../worker/site-runtime/prebid-cache-settings.mjs';
import {TEST_BID_CACHE_GENERATOR_MESSAGE,TEST_BID_CACHE_BIDDER_RULES_MESSAGE,BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE} from '../../worker/test-workspace/bid-cache-messages.mjs';
import {TEST_BID_CACHE_GENERATOR_MESSAGE as SITE_WORKSPACE_MESSAGE} from '../../worker/test-workspace/site-workspace.mjs';
import {getPrebidSettings,savePrebidSettings} from '../../worker/test-workspace/prebid-settings.mjs';
import {scriptVersionLabels} from '../../worker/site-runtime/script-version-guidance.mjs';
import {runtimeCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';
import {configurationErrorMessage} from '../../worker/runtime/configuration-error.mjs';
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
 assert.equal(SITE_WORKSPACE_MESSAGE,TEST_BID_CACHE_GENERATOR_MESSAGE);
 const keepPrefix='To use this script version, ';assert.ok(BID_CACHE_GENERATOR_MESSAGE.includes(keepPrefix));
 assert.ok(TEST_BID_CACHE_GENERATOR_MESSAGE.startsWith(BID_CACHE_GENERATOR_MESSAGE.slice(0,BID_CACHE_GENERATOR_MESSAGE.indexOf(keepPrefix)+keepPrefix.length)));assert.doesNotMatch(TEST_BID_CACHE_GENERATOR_MESSAGE,/Config|scripopen/);
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

test('historical scripts refuse combined settings with no corrected TEST choice and preserve explicit off-switches',async()=>{
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
  // 3.24.0 applies both but has a runtime notice: it is not named, and the text does not say that no version applies them.
  assert.match(message,/ No corrected script version is offered that applies bid caching and bidder rules together\. Versions with a runtime notice in Script setup still apply them\. /);assert.doesNotMatch(message,/select 3\.24|3\.24\.0|3\.25|or later|Config|No available/);
 }
 // Bid caching off: 3.23.0 is still refused for the bidder rules, with the shared guidance that names the version
 // the Bidder rules panel names, not the bid caching reason.
 const off=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:off.revision,bidCache:{enabled:false,maxBidAgeSeconds:45}},'PUT')).status,200);
 assert.equal((await f.req('/test-api/site-packages')).data.ready,true);
 const again=(await f.req('/test-api/site-runtime')).data;
 const refusedOff=await f.req('/test-api/site-runtime',{action:'setup',revision:again.revision,runtime:r323.pin,allowPreview:false,enablePrebid:true});
 assert.equal(refusedOff.status,422);
 assert.equal(refusedOff.data.error,'Script 3.23.0 cannot apply enabled bidder rules. Select 3.22.2 (Preview) in Script setup and save, or turn off bidder rules. Your saved settings and previous packages are unchanged.');
 assert.deepEqual((await f.req('/test-api/bidder-rules')).data.scriptVersions,['3.22.2 (Preview)']);
 // Without bidder rules, the bid cache reason is the plain TEST one.
 const rulesNow=(await f.req('/test-api/bidder-rules')).data;
 assert.equal((await f.req('/test-api/bidder-rules',{revision:rulesNow.revision,settings:{schemaVersion:1,enabled:false,rules:[]}})).status,200);
 const on=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:on.revision,bidCache:{enabled:true,maxBidAgeSeconds:45}},'PUT')).status,200);
 assert.equal((await f.req('/test-api/site-packages')).data.error,TEST_BID_CACHE_GENERATOR_MESSAGE);
});

test('with bidder rules and bid caching on 3.21.2, every TEST view shows the Script setup guidance first',async()=>{
 const f=await fixture();await enablePrebid(f);
 const mode=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:mode.revision,bidCache:{enabled:true,maxBidAgeSeconds:45}},'PUT')).status,200);
 await select(f,'3.21.2',true);
 const rules=(await f.req('/test-api/bidder-rules')).data;
 assert.equal((await f.req('/test-api/bidder-rules',{revision:rules.revision,settings:{schemaVersion:1,enabled:true,rules:[]}})).status,200);
 // 3.21.2 applies neither, so turning bid caching off alone would not let it generate: Generate names the bidder
 // rules first, and every view says the same instead of sending the site to Demand for bid caching.
 const guidance='Script 3.21.2 cannot apply enabled bidder rules. No corrected script version is offered that applies bidder rules and bid caching together. Versions with a runtime notice in Script setup still apply them. Your saved settings and previous packages are unchanged.';
 const before=config(f);
 const generated=await f.req('/test-api/generate',{acknowledge:true});
 assert.equal(generated.status,422,JSON.stringify(generated.data));assert.equal(generated.data.error,guidance);
 const packages=(await f.req('/test-api/site-packages')).data;
 assert.equal(packages.ready,false);assert.equal(packages.error,guidance);assert.notEqual(packages.nextStep,'demand');
 assert.equal((await f.req('/test-api/status')).data.validationIssue,guidance);
 assert.equal((await f.req('/test-api/site-runtime')).data.validationIssue,guidance);
 assert.deepEqual(config(f),before);
});

test('with bid caching saved, every TEST view shows the refusal Script setup and Generate show first, for every script',async()=>{
 // Generate checks the saved settings against the selected script (contextual signals, bidder accounts, bidder rules)
 // before bid caching. Releases, the home page status and both Generate routes show that refusal; only the bare bid
 // caching refusal sends the site to Demand. Every selectable TEST release, Preview and noticed ones included, with
 // each combination of the saved options that only some scripts apply. TEST has no adaptive auction timeout.
 const contextual={schemaVersion:1,enabled:true,sourceKey:'category',gam:{enabled:true},bidders:[],mappings:[{value:'Books',taxonomies:{'iab-content-2.2':['48'],'iab-content-3.0':[]}}]};
 const combinations=[{},{rules:true},{alias:true},{contextual:true},{rules:true,alias:true},{rules:true,contextual:true},{alias:true,contextual:true},{rules:true,alias:true,contextual:true}];
 const seen={contextual:0,guidance:0,demand:0,generated:0};
 for(const {version} of runtimeCatalog){
  const f=await fixture();await enablePrebid(f);await select(f,version,true);
  const mode=(await f.req(MODE)).data;
  assert.equal((await f.req(MODE,{enabled:true,revision:mode.revision,bidCache:{enabled:true,maxBidAgeSeconds:45}},'PUT')).status,200,version);
  const saved={rules:false,alias:false,contextual:false};
  for(const options of combinations){
   const label=JSON.stringify({...options,version});
   // Each option is saved or removed through its own view; the alias account row as in the test above.
   if(saved.rules!==Boolean(options.rules)){
    const rules=(await f.req('/test-api/bidder-rules')).data;
    assert.equal((await f.req('/test-api/bidder-rules',{revision:rules.revision,settings:{schemaVersion:1,enabled:Boolean(options.rules),rules:[]}})).status,200,label);
   }
   if(saved.contextual!==Boolean(options.contextual)){
    const state=(await f.req('/test-api/contextual-signals')).data;
    assert.equal((await f.req('/test-api/contextual-signals',{revision:state.revision,settings:options.contextual?contextual:{...state.settings,enabled:false}})).status,200,label);
   }
   if(saved.alias!==Boolean(options.alias)){
    if(options.alias)f.sqlite.prepare("INSERT INTO bidders(id,publisher_id,bidder,params_json,account_json,enabled) VALUES('alias-ox','test-site','ox_ag',?,?,1)")
     .run(JSON.stringify({unit:'synthetic-unit',delDomain:'synthetic.example.invalid'}),JSON.stringify({baseAdapter:'openx',displayName:'Agency',schain:{mode:'none'}}));
    else f.sqlite.prepare("DELETE FROM bidders WHERE id='alias-ox'").run();
   }
   Object.assign(saved,{rules:Boolean(options.rules),alias:Boolean(options.alias),contextual:Boolean(options.contextual)});
   const issue=(await f.req('/test-api/site-runtime')).data.validationIssue;
   const packages=(await f.req('/test-api/site-packages')).data,status=(await f.req('/test-api/status')).data.validationIssue;
   const generated=await f.req('/test-api/site-packages',{action:'generate',revision:packages.revision,notes:'Matrix'}),older=await f.req('/test-api/generate',{acknowledge:true});
   if(issue){
    assert.equal(packages.error,issue,label);assert.notEqual(packages.nextStep,'demand',label);assert.equal(status,issue,label);
    assert.equal(generated.data.error,issue,label);assert.equal(older.data.error,issue,label);
    seen[/^Contextual signals /.test(issue)?'contextual':'guidance']++;
   }else if(generated.status===201){
    assert.equal(packages.error,null,label);assert.equal(status,null,label);assert.equal(older.status,200,label);seen.generated++;
   }else{
    // Bid caching alone (or with bidder rules on a script without them, in the TEST wording) is what Generate refuses.
    assert.equal(packages.error,generated.data.error,label);assert.equal(status,generated.data.error,label);assert.equal(older.data.error,generated.data.error,label);
    if(packages.nextStep==='demand')seen.demand++;
   }
  }
  fixtures.splice(fixtures.indexOf(f),1);f.close();
 }
 assert.ok(seen.contextual>0&&seen.guidance>0&&seen.demand>0&&seen.generated>0,JSON.stringify(seen));
 // Generate words an unknown reason with the generic text, so Releases and the home page keep the bid caching refusal:
 // here a GAM code that scripts before 3.19.1 cannot use, which Script setup names.
 const f=await fixture();await enablePrebid(f);await select(f,'3.18.0',true);
 const mode=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:mode.revision,bidCache:{enabled:true,maxBidAgeSeconds:45}},'PUT')).status,200);
 f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,media_type,size_map_key,enabled) SELECT 'unit-dot',publisher_id,'Top.Unit','BTF',media_type,size_map_key,1 FROM ad_units WHERE publisher_id='test-site' AND code='Billboard'").run();
 assert.match((await f.req('/test-api/site-runtime')).data.validationIssue,/^Ad unit Top\.Unit uses a GAM code /);
 const kept=(await f.req('/test-api/site-packages')).data,generic=configurationErrorMessage(Error('unknown'));
 assert.equal((await f.req('/test-api/site-packages',{action:'generate',revision:kept.revision,notes:'Matrix'})).data.error,generic);
 assert.equal((await f.req('/test-api/generate',{acknowledge:true})).data.error,generic);
 assert.equal(kept.error,TEST_BID_CACHE_GENERATOR_MESSAGE);assert.equal(kept.nextStep,'demand');
 assert.equal((await f.req('/test-api/status')).data.validationIssue,TEST_BID_CACHE_GENERATOR_MESSAGE);
 // Without a saved script, a TEST site with Prebid on is refused in every view before any saved option.
 f.sqlite.prepare("DELETE FROM ad_units WHERE id='unit-dot'").run();
 const unpinned=config(f);delete unpinned.builtinRuntimeSelection;
 f.sqlite.prepare("UPDATE publisher_configs SET config_json=? WHERE publisher_id='test-site'").run(JSON.stringify(unpinned));
 const reason='Save Prebid settings through the TEST editor first.';
 for(const path of ['/test-api/site-runtime','/test-api/site-packages','/test-api/status'])assert.equal((await f.req(path)).data.error,reason,path);
 assert.equal((await f.req('/test-api/site-packages',{action:'generate',revision:'0',notes:'Matrix'})).data.error,reason);
 assert.equal((await f.req('/test-api/generate',{acknowledge:true})).data.error,reason);
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

test('saved bidder accounts on 3.23.0: no corrected TEST choice is offered, while explicit 3.24.0 remains valid',async()=>{
 const f=await fixture();await enablePrebid(f);
 // An account alias of the saved bidder, without an upstream SChain: only scripts with bidder accounts apply it.
 f.sqlite.prepare("INSERT INTO bidders(id,publisher_id,bidder,params_json,account_json,enabled) VALUES('alias-ox','test-site','ox_ag',?,?,1)")
  .run(JSON.stringify({unit:'synthetic-unit',delDomain:'synthetic.example.invalid'}),JSON.stringify({baseAdapter:'openx',displayName:'Agency',schain:{mode:'none'}}));
 const mode=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:mode.revision,bidCache:{enabled:true,maxBidAgeSeconds:45}},'PUT')).status,200);
 // TEST has no corrected available cache/account choice after excluding its exact runtime notices.
 assert.deepEqual(scriptVersionLabels(['bidder-accounts','bid-cache']),[]);
 const expected='Script 3.23.0 cannot apply bidder accounts (ox_ag). No corrected script version is offered that applies bidder accounts and bid caching together. Versions with a runtime notice in Script setup still apply them. Your saved settings and previous packages are unchanged.';
 const setup=(await f.req('/test-api/site-runtime')).data;
 assert.equal(setup.validationIssue,expected);
 // Generate and releases shows the same reason, not the generic configuration text.
 const packages=(await f.req('/test-api/site-packages')).data;
 assert.equal(packages.ready,false);assert.equal(packages.error,expected);
 // Saving 3.23.0 again is refused with it; 3.22.1, which cannot apply bid caching, is not named.
 const before=config(f),r323=setup.runtimes.find(r=>r.version==='3.23.0');
 const refused=await f.req('/test-api/site-runtime',{action:'setup',revision:setup.revision,runtime:r323.pin,allowPreview:false,enablePrebid:true});
 assert.equal(refused.status,422);assert.equal(refused.data.error,expected);assert.deepEqual(config(f),before);
 // Explicit selection of the registered, noticed 3.24.0 remains possible: the notice is not a capability removal.
 const newest='3.24.0';assert.ok(setup.runtimes.some(r=>r.version===newest));
 await select(f,newest,true);
 const ready=(await f.req('/test-api/site-packages')).data;
 assert.equal(ready.ready,true,ready.error);assert.equal(ready.runtime.runtimeVersion,newest);
});

test('the TEST Bidder rules view and Prebid editor name the versions for their option plus the saved ones',async()=>{
 const f=await fixture();await enablePrebid(f);
 // TEST offers the newest corrected patch 3.22.2 for these options without cache. Cache releases carry notices.
 assert.deepEqual(scriptVersionLabels(['bidder-rules']),['3.22.2 (Preview)']);
 assert.deepEqual(scriptVersionLabels(['bidder-accounts']),['3.22.2 (Preview)']);
 assert.deepEqual((await f.req('/test-api/bidder-rules')).data.scriptVersions,scriptVersionLabels(['bidder-rules']));
 assert.deepEqual((await f.req('/test-api/prebid-settings')).data.accountScriptVersions,scriptVersionLabels(['bidder-accounts']));
 // Saved bid caching: no corrected TEST script is offered for the combined options.
 assert.deepEqual(scriptVersionLabels(['bidder-rules','bid-cache']),[]);
 assert.deepEqual(scriptVersionLabels(['bidder-accounts','bid-cache']),[]);
 const mode=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:mode.revision,bidCache:{enabled:true,maxBidAgeSeconds:45}},'PUT')).status,200);
 const rules=(await f.req('/test-api/bidder-rules')).data,prebid=(await f.req('/test-api/prebid-settings')).data;
 assert.deepEqual(rules.scriptVersions,scriptVersionLabels(['bidder-rules','bid-cache']));
 assert.deepEqual(prebid.accountScriptVersions,scriptVersionLabels(['bidder-accounts','bid-cache']));
 // 3.24.0 still applies them with its runtime notice, so the views do not say that no version applies them.
 assert.equal(rules.noticedScriptApplies,true);assert.equal(prebid.accountNoticedScriptApplies,true);
 // The Prebid editor also says whether the selected script applies them: 3.23.0 has no bidder accounts, 3.24.0 does.
 assert.equal(prebid.selectedScriptAppliesAccounts,false);
 await select(f,'3.24.0',true);
 const selected=(await f.req('/test-api/prebid-settings')).data;
 assert.deepEqual([selected.accountScriptVersions,selected.accountNoticedScriptApplies,selected.selectedScriptAppliesAccounts],[[],true,true]);
 assert.notDeepEqual(scriptVersionLabels(['bidder-rules']),scriptVersionLabels(['bidder-rules','bid-cache']),'saved bid caching narrows the versions');
});

test('the TEST Bid caching view names the scripts that apply bid caching, never "or later"',async()=>{
 const f=await fixture();await enablePrebid(f);
 // 3.23.0 (selected by the TEST Prebid editor helper) applies bid caching; the panels then say "the selected script".
 // The offered versions come from the registry, leaving out exact noticed sources.
 const capable=(await f.req(MODE)).data,named=bidCacheScriptVersions(config(f),[]);
 assert.deepEqual(named,[]);
 assert.equal(capable.runtimeSupportsBidCache,true);assert.deepEqual(capable.bidCacheScriptVersions,named);assert.equal(capable.bidCacheNoticedScriptApplies,true);
 // The first version with bid caching stays as it is (3.23.0, which has a runtime notice).
 assert.equal(capable.bidCacheRuntimeVersion,'3.23.0');
 await select(f,'3.21.2',true);
 const earlier=(await f.req(MODE)).data;
 assert.equal(earlier.runtimeSupportsBidCache,false);assert.deepEqual(earlier.bidCacheScriptVersions,named);
 // With bid caching saved, the TEST Generate reason names the same versions.
 assert.equal((await f.req(MODE,{enabled:true,revision:earlier.revision,bidCache:{enabled:true,maxBidAgeSeconds:45}},'PUT')).status,200);
 const blocked=(await f.req('/test-api/site-packages')).data;
 assert.equal(blocked.error,TEST_BID_CACHE_GENERATOR_MESSAGE);assert.ok(blocked.error.startsWith('Bid caching needs a compatible script version. No corrected script version is offered that applies bid caching. Versions with a runtime notice in Script setup still apply it. '),blocked.error);
 // The panels can tell that no corrected version is offered from no version applying bid caching at all.
 assert.equal((await f.req(MODE)).data.bidCacheNoticedScriptApplies,true);
 assert.doesNotMatch(blocked.error,/Select |select |3\.24|3\.25/);
});
