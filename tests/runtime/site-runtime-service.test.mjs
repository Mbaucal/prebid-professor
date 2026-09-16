import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { build } from 'esbuild';
import worker from '../../worker/test-workspace/index.mjs';
import { workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD } from '../support/test-workspace-store.mjs';
import { siteRuntimeSettings,changeSiteRuntime,siteRuntimeBundle,commitSiteConfiguration } from '../../worker/site-runtime/service.mjs';
import { readPreviewSnapshot } from '../../worker/runtime/builtin-preview-service.mjs';
const fixtures=[];
test('saved bottom Sticky with group loading cannot be renamed or deleted',async()=>{
 const {f}=await setup();let s=await select(f);
 await changeSiteRuntime(f.env,'test-site',TEST_EMAIL,{action:'position',revision:s.revision,position:{code:'Billboard',display:'sticky',overlay:null,lazy:null}});
 const compiled=await build({entryPoints:['worker/ad-units.ts'],bundle:true,write:false,platform:'node',format:'esm'});
 const {updateAdUnit,deleteAdUnit}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
 const unit=f.sqlite.prepare("SELECT * FROM ad_units WHERE code='Billboard'").get();
 const request=new Request(ORIGIN+'/api/publishers/test-site/ad-units/'+unit.id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({code:'Renamed'})});
 assert.equal((await updateAdUnit(request,f.env,'test-site',unit.id)).status,409);
 assert.equal((await updateAdUnit(new Request(request.url,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:false})}),f.env,'test-site',unit.id)).status,409);
 assert.equal((await deleteAdUnit(new Request(request.url,{method:'DELETE'}),f.env,'test-site',unit.id)).status,409);
 assert.equal(f.sqlite.prepare('SELECT code FROM ad_units WHERE id=?').get(unit.id).code,'Billboard');
});
test('concurrent position save prevents ad-unit mutation and its audit atomically',async()=>{
 const compiled=await build({entryPoints:['worker/ad-units.ts'],bundle:true,write:false,platform:'node',format:'esm'});
 const {updateAdUnit,deleteAdUnit}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
 for(const remove of [false,true]){
  const {f}=await setup();await select(f);const unit=f.sqlite.prepare("SELECT * FROM ad_units WHERE code='Billboard'").get();
  const before=f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n;
  const originalBatch=f.env.DB.batch.bind(f.env.DB);
  f.env.DB.batch=async items=>{
   const config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);
   config.runtimeControls??={};config.runtimeControls.sticky={bottomAdUnitId:'Billboard'};
   f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
   return originalBatch(items);
  };
  const request=new Request(ORIGIN+'/unit',{method:remove?'DELETE':'PATCH',headers:{'content-type':'application/json'},...(remove?{}:{body:JSON.stringify({code:'Renamed'})})});
  const response=await (remove?deleteAdUnit:updateAdUnit)(request,f.env,'test-site',unit.id);
  assert.equal(response.status,409,await response.text());
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM ad_units WHERE id=?').get(unit.id),unit);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n,before);
  f.env.DB.batch=originalBatch;
  const config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);config.runtimeControls.sticky.bottomAdUnitId='';
  f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
  const retry=new Request(ORIGIN+'/unit',{method:remove?'DELETE':'PATCH',headers:{'content-type':'application/json'},...(remove?{}:{body:JSON.stringify({code:'Renamed'})})});
  assert.equal((await (remove?deleteAdUnit:updateAdUnit)(retry,f.env,'test-site',unit.id)).status,200);
 }
});
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
async function setup(options){const f=workspaceStore(options);fixtures.push(f);const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);const cookie=login.headers.get('set-cookie').split(';')[0];const r=await worker.fetch(new Request(ORIGIN+'/test-api/setup',{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({confirm:'prepare-empty-test-database'})}),f.env);assert.equal(r.status,200);return {f,cookie};}
async function select(f,siteId='test-site'){const s=await siteRuntimeSettings(f.env,siteId);await changeSiteRuntime(f.env,siteId,TEST_EMAIL,{action:'version',revision:s.revision,runtime:s.runtimes[0].pin,allowPreview:true});return siteRuntimeSettings(f.env,siteId);}
test('unconfigured site uses the built-in workflow and gives one actionable missing-Prebid step without writing',async()=>{
 const {f}=await setup();
 const config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);
 config.enablePrebid=true;config.importedSettings={keep:'original'};
 const original=JSON.stringify(config);f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(original);
 const audits=f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n;
 const s=await siteRuntimeSettings(f.env,'test-site');
 assert.equal(s.releaseWorkflow,'builtin');assert.equal(s.selected,null);assert.equal(s.nextStep,'prebid');assert.equal(s.prebid.status,'missing');
 assert.match(s.prebid.message,/Open Prebid.js.*Set current/);
 await assert.rejects(changeSiteRuntime(f.env,'test-site',TEST_EMAIL,{action:'version',revision:s.revision,runtime:s.runtimes[0].pin,allowPreview:true}),e=>e.status===422&&e.message===s.prebid.message);
 assert.equal(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json,original);
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n,audits);
});
test('configured legacy profiles retain their workflow; a saved built-in choice takes precedence',async()=>{
 const {f}=await setup();
 const config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);
 config.generatorProfileId='existing-profile';f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
 let s=await siteRuntimeSettings(f.env,'test-site');assert.equal(s.releaseWorkflow,'legacy');assert.equal(s.prebid.status,'off');
 s=await select(f);assert.equal(s.releaseWorkflow,'builtin');assert.equal(s.nextStep,null);
 assert.equal(JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json).generatorProfileId,'existing-profile');
});
test('site API saves runtime, position and lazy choices then builds selected version without template or row loss',async()=>{
 const {f}=await setup();const rows=f.sqlite.prepare('SELECT * FROM ad_units ORDER BY id').all();
 let s=await select(f);const p=s.positions.find(p=>p.code==='Billboard');
 await changeSiteRuntime(f.env,'test-site',TEST_EMAIL,{action:'position',revision:s.revision,position:{code:p.code,display:'takeover',overlay:{demand:'gam',desktopMinWidth:1024,desktopSeconds:10,mobileSeconds:5,countdown:true,frequencyMinutes:15},lazy:null}});
 s=await siteRuntimeSettings(f.env,'test-site');assert.equal(s.positions.find(p=>p.code==='Billboard').display,'takeover');assert.deepEqual(f.sqlite.prepare('SELECT * FROM ad_units ORDER BY id').all(),rows);
 const zip=unzipSync(new Uint8Array(await(await siteRuntimeBundle(f.env,'test-site',{action:'bundle',revision:s.revision,acknowledge:true})).arrayBuffer()));
 assert.match(new TextDecoder().decode(zip['ads.js']),/TESSERA_OVERLAY/);assert.equal(f.log.puts.length,0);
 await assert.rejects(changeSiteRuntime(f.env,'test-site',TEST_EMAIL,{action:'version',revision:s.revision,runtime:s.runtimes[1].pin,allowPreview:true}));
 assert.equal((await siteRuntimeSettings(f.env,'test-site')).selected.runtimeVersion,'3.10.0-tessera.preview.1');
});
test('CAS compares all referenced rows and never saves or audits a stale snapshot',async()=>{
 const {f}=await setup();await select(f);const before=await readPreviewSnapshot(f.env.DB,'test-site',{includePrebid:true});
 const audits=f.sqlite.prepare('SELECT count(*) AS n FROM audit_log').get().n;
 f.sqlite.prepare("UPDATE size_maps SET map_json='[]' WHERE name='display'").run();
 await assert.rejects(commitSiteConfiguration(f.env,before,JSON.stringify({...JSON.parse(before.config.config_json),anything:'bad'}),TEST_EMAIL),e=>e.status===409);
 assert.equal(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json,before.config.config_json);
 assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM audit_log').get().n,audits);
});
test('different site saves preserve every other site and unrelated configuration',async()=>{
 const {f}=await setup();const config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);delete config.testSiteDraft;config.privateExtra={keep:true};
 f.sqlite.prepare("INSERT INTO publishers(id,name,domain,gam_path) VALUES ('second-site','Second','second.invalid','/123/second/')").run();
 f.sqlite.prepare("INSERT INTO publisher_configs(publisher_id,config_json) VALUES ('second-site',?)").run(JSON.stringify(config));
 f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,media_type,size_map_key,enabled,sort_order) SELECT 'second-'||id,'second-site',code,type,media_type,size_map_key,enabled,sort_order FROM ad_units WHERE publisher_id='test-site'").run();
 f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) SELECT 'second-'||id,'second-site',name,map_json FROM size_maps WHERE publisher_id='test-site'").run();
 const before=f.sqlite.prepare("SELECT config_json FROM publisher_configs WHERE publisher_id='test-site'").get().config_json;
 await select(f,'second-site');assert.equal(f.sqlite.prepare("SELECT config_json FROM publisher_configs WHERE publisher_id='test-site'").get().config_json,before);
 assert.deepEqual(JSON.parse(f.sqlite.prepare("SELECT config_json FROM publisher_configs WHERE publisher_id='second-site'").get().config_json).privateExtra,{keep:true});
});
test('new TEST routes retain auth, same origin, schema and site scope guards',async()=>{
 const {f,cookie}=await setup();
 for(const p of ['/site-workspace','/site-workspace.js','/test-api/site-runtime'])assert([303,401].includes((await worker.fetch(new Request(ORIGIN+p),f.env)).status));
 const get=()=>worker.fetch(new Request(ORIGIN+'/test-api/site-runtime',{headers:{cookie}}),f.env);
 let state=await(await get()).json();assert.equal(state.site.id,'test-site');
 const body={action:'version',revision:state.revision,runtime:state.runtimes[0].pin,allowPreview:true};
 const send=(value,origin=ORIGIN)=>worker.fetch(new Request(ORIGIN+'/test-api/site-runtime',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify(value)}),f.env);
 assert.equal((await send(body,'https://evil.invalid')).status,403);
 assert.equal((await send({...body,siteId:'second-site'})).status,422);
 assert.equal((await send(body)).status,200);
 assert.equal((await send(body)).status,409);
 const html=await worker.fetch(new Request(ORIGIN+'/site-workspace',{headers:{cookie}}),f.env);assert.equal(html.status,200);assert.match(html.headers.get('content-security-policy'),/connect-src 'self'/);
});

test('runtime selection repairs an archived Prebid pin using the activated current file',async()=>{
 const {storePrebidFile}=await import('../../worker/test-workspace/prebid-files.mjs');
 const {prebidStore,getPrebidSettings,savePrebidSettings}=await import('../../worker/test-workspace/prebid-settings.mjs');
 const {f}=await setup({prebidFiles:true});await select(f);
 const bytes=new TextEncoder().encode('/* prebid.js v11.11.0\nModules: consentManagementTcf, tcfControl, currency, adformBidAdapter */\nwindow.prebidFixtureOnly=true;');
 const uploaded=await storePrebidFile(prebidStore(f.env),bytes,TEST_EMAIL);
 const settings=await getPrebidSettings(f.env);
 await savePrebidSettings(f.env,TEST_EMAIL,{expectedRevision:settings.revision,acknowledge:true,draft:{...settings.draft,enablePrebid:true,buildId:uploaded.file.id,bidders:[{bidder:'adform',params:{mid:123},enabled:true}]}});
 const config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);
 config.builtinRuntimeSelection.prebid.id='previous-archived-file';
 f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
 await select(f);
 assert.equal(JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json).builtinRuntimeSelection.prebid.id,uploaded.file.id);
});
test('disabled banner cannot save TakeOver',async()=>{
 const {f}=await setup();await select(f);f.sqlite.prepare("UPDATE ad_units SET enabled=0 WHERE code='Billboard'").run();
 const s=await siteRuntimeSettings(f.env,'test-site');
 await assert.rejects(changeSiteRuntime(f.env,'test-site',TEST_EMAIL,{action:'position',revision:s.revision,position:{code:'Billboard',display:'takeover',overlay:{demand:'gam'},lazy:null}}),/Enable this ad unit/);
});
test('older runtime-control form preserves position-owned Sticky and rejects concurrent config changes',async()=>{
 const compiled=await build({entryPoints:['worker/runtime-controls.ts'],bundle:true,write:false,platform:'node',format:'esm'});
 const {getRuntimeControls,updateRuntimeControls}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
 const {f}=await setup();let s=await select(f);
 const old=await(await getRuntimeControls(f.env,'test-site')).json();
 await changeSiteRuntime(f.env,'test-site',TEST_EMAIL,{action:'position',revision:s.revision,position:{code:'Billboard',display:'sticky',overlay:null,lazy:null}});
 const request=()=>new Request(ORIGIN+'/controls',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(old.controls)});
 const saved=await updateRuntimeControls(request(),f.env,'test-site');assert.equal(saved.status,200,await saved.clone().text());
 assert.equal((await saved.json()).controls.sticky.bottomAdUnitId,'Billboard');
 const before=f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n;
 const originalBatch=f.env.DB.batch.bind(f.env.DB);
 f.env.DB.batch=async items=>{
  const config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);config.runtimeControls.sticky.bottomAdUnitId='';
  f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));return originalBatch(items);
 };
 assert.equal((await updateRuntimeControls(request(),f.env,'test-site')).status,409);
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n,before);
 assert.equal(JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json).runtimeControls.sticky.bottomAdUnitId,'');
});

test('Prebid demand is rejected when the site has Prebid disabled',async()=>{
 const {f}=await setup();const s=await select(f);
 await assert.rejects(changeSiteRuntime(f.env,'test-site',TEST_EMAIL,{action:'position',revision:s.revision,position:{code:'Billboard',display:'takeover',overlay:{demand:'site',desktopMinWidth:1024,desktopSeconds:10,mobileSeconds:5,countdown:true,frequencyMinutes:15},lazy:null}}),/Enable Prebid for this site/);
 assert.equal((await siteRuntimeSettings(f.env,'test-site')).positions.find(p=>p.code==='Billboard').display,'standard');
});
