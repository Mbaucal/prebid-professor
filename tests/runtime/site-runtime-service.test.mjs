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
 assert.equal((await deleteAdUnit(new Request(request.url,{method:'DELETE'}),f.env,'test-site',unit.id)).status,409);
 assert.equal(f.sqlite.prepare('SELECT code FROM ad_units WHERE id=?').get(unit.id).code,'Billboard');
});
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
async function setup(){const f=workspaceStore();fixtures.push(f);const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);const cookie=login.headers.get('set-cookie').split(';')[0];const r=await worker.fetch(new Request(ORIGIN+'/test-api/setup',{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({confirm:'prepare-empty-test-database'})}),f.env);assert.equal(r.status,200);return {f,cookie};}
async function select(f,siteId='test-site'){const s=await siteRuntimeSettings(f.env,siteId);await changeSiteRuntime(f.env,siteId,TEST_EMAIL,{action:'version',revision:s.revision,runtime:s.runtimes[0].pin,allowPreview:true});return siteRuntimeSettings(f.env,siteId);}
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
