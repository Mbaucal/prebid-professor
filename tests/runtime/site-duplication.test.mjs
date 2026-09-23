import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {workspaceStore} from '../support/test-workspace-store.mjs';
import {createSite,duplicateSite} from '../../worker/publishers.ts';
import {deletePrebidBuild} from '../../worker/prebid-builds.ts';
import {siteRuntimeSettings,changeSiteRuntime,siteRuntimeBundle} from '../../worker/site-runtime/service.mjs';
import {readPreviewSnapshot} from '../../worker/runtime/builtin-preview-service.mjs';
import {readPinnedSiteRuntime,runtimeCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';
const fixtures=[];
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
const req=(body)=>new Request('https://audit.example.invalid/api/sites',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const snapshot=f=>readPreviewSnapshot(f.env.DB,'source',{includePrebid:true});
const duplicate=(f,copyPrebidBuild=true)=>duplicateSite(req({id:'copy',name:'Copy',domain:'copy.example.invalid',gamPath:'/123/copy/',copyPrebidBuild}),f.env,'source');
const deletion=(f,site,id)=>deletePrebidBuild(new Request('https://audit.example.invalid/build',{method:'DELETE',headers:{'x-confirm-delete':id}}),f.env,site,id);
async function setup(prebid=true){
 const f=workspaceStore();fixtures.push(f);
 f.sqlite.exec((await readFile('migrations/0001_initial.sql','utf8')).split('INSERT OR IGNORE INTO publishers')[0]);
 f.sqlite.exec((await readFile('migrations/0002_publisher_accounts.sql','utf8')).split('-- Politika.rs')[0]);
 assert.equal((await createSite(req({id:'source',name:'Source',domain:'source.example.invalid',gamPath:'/123/source/'}),f.env)).status,201);
 f.sqlite.exec(`INSERT INTO ad_units(id,publisher_id,code,type,media_type,size_map_key,enabled,sort_order) VALUES('unit','source','Billboard','ATF','banner','Billboard',1,0);
 INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('map','source','Billboard','[{"minViewPort":[0,0],"sizes":[[300,250]]}]');`);
 f.env.BUILDS={
  async get(key){const bytes=f.objects.get(key);return bytes?{size:bytes.length,customMetadata:f.metadata.get(key),async arrayBuffer(){return bytes.slice().buffer;}}:null;},
  async put(key,bytes,options){assert.equal(options.onlyIf.get('If-None-Match'),'*');if(f.objects.has(key))return null;f.objects.set(key,new Uint8Array(bytes));f.metadata.set(key,options.customMetadata);return {key};},
  async delete(key){f.objects.delete(key);},
 };
 if(prebid){
  const bytes=new TextEncoder().encode('/* prebid.js v11.34.0\nModules: consentManagementTcf, currency, priceFloors, tcfControl */\nwindow.pbjs=window.pbjs||{};');
  f.sourceKey='publishers/source/prebid-builds/original/prebid.js';
  f.objects.set(f.sourceKey,bytes);f.metadata.set(f.sourceKey,{sha256:createHash('sha256').update(bytes).digest('hex'),version:'11.34.0'});
  f.sqlite.prepare("INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES('original','source','11.34.0',?,?,'current')")
   .run(f.sourceKey,JSON.stringify(['consentManagementTcf','currency','priceFloors','tcfControl']));
 }
 const s=await siteRuntimeSettings(f.env,'source');
 await changeSiteRuntime(f.env,'source','audit@example.invalid',{action:'setup',revision:s.revision,runtime:s.runtimes[0].pin,allowPreview:true,enablePrebid:prebid});
 return f;
}
test('duplicate owns verified Prebid bytes and pin; generates; deleting its build keeps original usable',async()=>{
 const f=await setup(),before=await snapshot(f),sourceBytes=f.objects.get(f.sourceKey).slice();
 const response=await duplicate(f);assert.equal(response.status,201,await response.text());
 const copy=await readPreviewSnapshot(f.env.DB,'copy',{includePrebid:true}),row=copy.prebidBuilds[0];
 assert.notEqual(row.file_key,f.sourceKey);assert.match(row.file_key,new RegExp('^publishers/copy/prebid-builds/'+row.id+'/'));
 assert.deepEqual(f.objects.get(row.file_key),sourceBytes);
 const ready=await readPinnedSiteRuntime({siteId:'copy',snapshot:copy,catalog:runtimeCatalog},f.env.BUILDS);
 assert.equal(ready.prebid.report.status,'checked');assert.equal(ready.pin.runtimeVersion,JSON.parse(before.config.config_json).builtinRuntimeSelection.runtime.runtimeVersion);
 const state=await siteRuntimeSettings(f.env,'copy');
 assert.equal((await siteRuntimeBundle(f.env,'copy',{action:'bundle',revision:state.revision,acknowledge:true})).status,200);
 f.sqlite.prepare("UPDATE prebid_builds SET status='archived' WHERE id=?").run(row.id);
 assert.equal((await deletion(f,'copy',row.id)).status,200);
 assert.deepEqual(await snapshot(f),before);assert.deepEqual(f.objects.get(f.sourceKey),sourceBytes);
 await readPinnedSiteRuntime({siteId:'source',snapshot:before,catalog:runtimeCatalog},f.env.BUILDS);
});
test('without a Prebid copy, retain script version and demand but clear foreign pin and require setup',async()=>{
 const f=await setup(),before=await snapshot(f);assert.equal((await duplicate(f,false)).status,201);
 const copy=await readPreviewSnapshot(f.env.DB,'copy',{includePrebid:true}),config=JSON.parse(copy.config.config_json);
 assert.equal(config.enablePrebid,true);assert.equal(config.builtinRuntimeSelection.prebid,null);assert.deepEqual(config.builtinRuntimeSelection.runtime,JSON.parse(before.config.config_json).builtinRuntimeSelection.runtime);
 const state=await siteRuntimeSettings(f.env,'copy');assert.equal(state.nextStep,'prebid');assert.equal(copy.prebidBuilds.length,0);
});
test('GAM-only duplicate needs no Prebid file and generates with the same runtime',async()=>{
 const f=await setup(false);assert.equal((await duplicate(f)).status,201);
 const s=await siteRuntimeSettings(f.env,'copy');assert.equal(s.enablePrebid,false);assert.equal(s.nextStep,null);
 assert.equal((await siteRuntimeBundle(f.env,'copy',{action:'bundle',revision:s.revision,acknowledge:true})).status,200);
});
for(const scenario of ['corrupt source','R2 put failure','SQL rollback','source change during copy','lost SQL response'])test('duplicate failure: '+scenario,async()=>{
 const f=await setup(),before=await snapshot(f);let committed=false;
 if(scenario==='corrupt source')f.metadata.get(f.sourceKey).sha256='0'.repeat(64);
 if(scenario==='R2 put failure')f.env.BUILDS.put=async()=>{throw Error('injected R2 failure');};
 if(scenario==='SQL rollback')f.faults.batchAt=2;
 if(scenario==='source change during copy'){
  const put=f.env.BUILDS.put;f.env.BUILDS.put=async(...args)=>{const r=await put(...args);f.sqlite.exec("UPDATE publisher_configs SET config_json=json_set(config_json,'$.changed',true) WHERE publisher_id='source'");return r;};
 }
 if(scenario==='lost SQL response'){
  const batch=f.env.DB.batch;f.env.DB.batch=async items=>{const result=await batch(items);if(items.some(i=>/INSERT INTO publishers/.test(i.sql))){committed=true;throw Error('injected lost response');}return result;};
 }
 const r=await duplicate(f);assert.notEqual(r.status,201);f.faults.batchAt=-1;
 assert.equal(Boolean(f.sqlite.prepare("SELECT id FROM publishers WHERE id='copy'").get()),committed);
 assert(f.objects.has(f.sourceKey));
 if(scenario!=='source change during copy')assert.deepEqual(await snapshot(f),before);
 if(committed){const saved=await readPreviewSnapshot(f.env.DB,'copy',{includePrebid:true});await readPinnedSiteRuntime({siteId:'copy',snapshot:saved,catalog:runtimeCatalog},f.env.BUILDS);}
});
for(const owner of ['source','copy'])test('legacy shared object cannot be deleted from '+owner,async()=>{
 const f=await setup();await duplicate(f,false);
 f.sqlite.prepare("INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES('legacy','copy','11.34.0',?,'[]','archived')").run(f.sourceKey);
 f.sqlite.exec("UPDATE prebid_builds SET status='archived' WHERE id='original'");
 assert.equal((await deletion(f,owner,owner==='source'?'original':'legacy')).status,409);
 assert(f.objects.has(f.sourceKey));assert.equal(f.sqlite.prepare('SELECT count(*) n FROM prebid_builds').get().n,2);
});
test('concurrent activation prevents deletion of its R2 bytes and delete audit',async()=>{
 const f=await setup();f.sqlite.exec("UPDATE prebid_builds SET status='archived' WHERE id='original'");
 const before=f.sqlite.prepare("SELECT count(*) n FROM audit_log WHERE action='prebid_build.deleted'").get().n;
 const batch=f.env.DB.batch;f.env.DB.batch=async items=>{f.sqlite.exec("UPDATE prebid_builds SET status='current' WHERE id='original'");return batch(items);};
 assert.equal((await deletion(f,'source','original')).status,409);assert(f.objects.has(f.sourceKey));
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM audit_log WHERE action='prebid_build.deleted'").get().n,before);
});
test('unconfirmed delete transaction never removes R2 bytes',async()=>{
 const f=await setup();f.sqlite.exec("UPDATE prebid_builds SET status='archived' WHERE id='original'");
 const batch=f.env.DB.batch;f.env.DB.batch=async items=>{await batch(items);throw Error('lost response');};
 assert.equal((await deletion(f,'source','original')).status,500);assert(f.objects.has(f.sourceKey));
});
