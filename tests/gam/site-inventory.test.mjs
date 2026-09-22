import {readRuntimeSelectionSettings,saveRuntimeSelectionSettings} from '../../worker/test-workspace/runtime-selection.mjs';
import {getSiteDraft,saveSiteDraft} from '../../worker/test-workspace/site-draft-service.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceStore} from '../support/test-workspace-store.mjs';
import {initializeTestSchema,inspectTestSchema} from '../../worker/test-workspace/schema.mjs';
import {siteInventoryStore,planSiteInventory} from '../../worker/integrations/site-inventory.mjs';
import {fixture} from './fixture.mjs';
import {gamResponse} from '../../worker/integrations/gam-service.mjs';
import {expandGroup} from '../../shared/gam/plan.mjs';
import presets from '../../shared/gam/presets.json' with {type:'json'};
import {sizeMapDefaults,sizeMapsTemplateCsv,adUnitsTemplateCsv,mapSizes} from '../../shared/inventory/defaults.mjs';
const origin='https://example.invalid',actor='test@example.invalid',base='/api/integrations/gam';
const credentials={type:'service_account',client_email:'fixture@fixture.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\nsynthetic-not-real\n-----END PRIVATE KEY-----'};
async function setup(){
 const d=workspaceStore(),f=fixture();await initializeTestSchema(d.env.DB,actor);
 const selection=await readRuntimeSelectionSettings(d.env);await saveRuntimeSelectionSettings(d.env,actor,{expectedRevision:selection.revision,selection:{runtime:selection.runtimes[0].pin,allowPreview:true,enablePrebid:false,prebidBuildId:null}});
 const saved=await getSiteDraft(d.env);saved.draft.site.gamPath='/123456/Example/';await saveSiteDraft(d.env,actor,{expectedRevision:saved.revision,acknowledge:true,draft:saved.draft});
 f.env.DB=d.env.DB;f.d=d;f.store=siteInventoryStore(f.env,{siteScope:'test-site'});
 f.request=async(path,body,options={})=>{const r=await gamResponse(new Request(origin+base+path,{method:body?'POST':'GET',headers:body?{origin,'content-type':'application/json',...options.headers}:{},body:body?JSON.stringify(body):undefined}),f.env,options.actor||actor,{clientFactory:()=>f.client,siteScope:'test-site'});return {status:r.status,data:await r.json()};};
 assert.equal((await f.request('/connect',{networkCode:'123456',credentials})).status,201);return f;
}
const input=(rows=expandGroup({...presets[3],count:2}))=>({networkCode:'123456',siteId:'test-site',siteLabel:'Example',parent:{mode:'new',name:'Example',code:'Example'},rows});
async function create(f,value=input()) {const p=await f.request('/preview',value);assert.equal(p.status,200,JSON.stringify(p));return f.request('/create',{id:p.data.id,confirmNetwork:'123456'});}
test('exact complete map catalogue, CSV and GAM size unions share the supplied rules',()=>{
 assert.deepEqual(Object.keys(sizeMapDefaults),['Sticky','Billboard','InFeed','P','InText','Branding_Map','Under_Article']);
 assert.equal(Object.values(sizeMapDefaults).flat().length,25);
 assert.deepEqual(sizeMapDefaults.Sticky.map(r=>r.minViewPort[0]),[1600,1024,469,0]);
 assert.deepEqual(sizeMapDefaults.InFeed[0].sizes,[[800,250],[750,200],[750,100],[728,90],[580,280],[300,250]]);
 assert.deepEqual(sizeMapDefaults.Branding_Map.at(-1).sizes,[]);
 assert.deepEqual(sizeMapDefaults.InText[1].sizes,sizeMapDefaults.InText[2].sizes);
 assert.equal(sizeMapDefaults.InText[0].sizes[0],'fluid');
 assert.equal(sizeMapsTemplateCsv.split('\n').length,26);assert.equal(adUnitsTemplateCsv.split('\n').length,27);
 for(const preset of presets)assert.equal(preset.sizes,mapSizes(preset.mapKey));
 for(const line of sizeMapsTemplateCsv.split('\n').slice(1)){const [name,width,height,sizes]=line.split(',');assert.deepEqual(sizes?sizes.split('|').map(s=>s==='fluid'?s:s.split('x').map(Number)):[],sizeMapDefaults[name].find(r=>r.minViewPort[0]===Number(width)).sizes);assert.equal(height,'0');}
});
test('default maps add missing only, preserve custom definitions and strict TEST schema',async t=>{
 const f=await setup();t.after(()=>f.d.close());const custom='[{"minViewPort":[0,0],"sizes":[[1,1]]}]';
 f.d.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES ('custom','test-site','Sticky',?)").run(custom);
 const before=f.d.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json;
 const plan=await planSiteInventory(f.store,'test-site');assert.equal(plan.maps.length,6);await f.store.commit(plan,actor,'defaults');
 assert.equal(f.d.sqlite.prepare("SELECT map_json FROM size_maps WHERE name='Sticky'").get().map_json,custom);
 assert.equal(f.d.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json,before);
 assert.equal((await planSiteInventory(f.store,'test-site')).maps.length,0);assert.equal(f.counters.creates,0);
 assert.equal((await inspectTestSchema(f.d.env.DB)).ready,true);
});
test('GAM confirmed IDs, paths and maps persist in site atomically; repeat does not duplicate',async t=>{
 const f=await setup();t.after(()=>f.d.close());const before=f.d.sqlite.prepare('SELECT * FROM ad_units ORDER BY code').all();
 const r=await create(f);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.siteSync.state,'saved');assert.equal(r.data.siteSync.addedUnits,2);assert.equal(r.data.siteSync.addedMaps,7);
 assert.equal(f.d.sqlite.prepare('SELECT count(*) AS n FROM ad_units').get().n,4);
 assert.deepEqual(f.d.sqlite.prepare("SELECT * FROM ad_units WHERE code IN ('Billboard','Sticky') ORDER BY code").all(),before);
 const receipt=await f.store.receipt('test-site',r.data.id);assert.equal(receipt.rows[0].path,'/123456/Example/InFeed_1');assert.equal(receipt.rows[0].id,r.data.rows[0].id);
 assert((await getSiteDraft(f.d.env)).draft.units.some(u=>u.code==='InFeed_1'&&u.sizeMap==='InFeed'));
 const replay=await f.request('/create',{id:r.data.id,confirmNetwork:'123456'});assert.equal(replay.data.siteSync.state,'saved');assert.equal(f.counters.creates,2);
 const again=await create(f);assert.equal(again.data.siteSync.addedUnits,0);assert.equal(f.d.sqlite.prepare('SELECT count(*) AS n FROM ad_units').get().n,4);
});
test('wrong site, network path and stale local review stop BEFORE any Google write',async t=>{
 const f=await setup();t.after(()=>f.d.close());
 assert.equal((await f.request('/preview',{...input(),siteId:'other-site'})).status,404);
 assert.equal((await f.request('/preview',{...input(),parent:{mode:'new',name:'Other',code:'Other'}})).status,409);
 const p=await f.request('/preview',input());f.d.sqlite.prepare("UPDATE ad_units SET notes='manual edit' WHERE code='Sticky'").run();
 assert.equal((await f.request('/create',{id:p.data.id,confirmNetwork:'123456'})).status,409);assert.equal(f.counters.creates,0);
});
test('concurrent site edit during Google call keeps GAM result recoverable without replaying Google create',async t=>{
 const f=await setup();t.after(()=>f.d.close());const createGoogle=f.client.create.bind(f.client);let edited=false;
 f.client.create=async(...args)=>{const result=await createGoogle(...args);if(!edited){edited=true;f.d.sqlite.prepare("UPDATE ad_units SET notes='changed during GAM' WHERE code='Sticky'").run();}return result;};
 const result=await create(f);assert.equal(result.data.siteSync.state,'pending');assert.equal(f.d.sqlite.prepare('SELECT count(*) AS n FROM ad_units').get().n,2);const count=f.counters.creates;
 const p=await f.request('/site-sync/preview',{id:result.data.id,siteId:'test-site'});assert.equal(p.status,200,JSON.stringify(p));
 const saved=await f.request('/site-sync/apply',{id:p.data.id,confirmSite:'test-site'});assert.equal(saved.data.state,'saved');assert.equal(f.counters.creates,count);
 assert.equal(f.d.sqlite.prepare("SELECT notes FROM ad_units WHERE code='Sticky'").get().notes,'changed during GAM');
 assert.equal((await f.request('/site-sync/apply',{id:p.data.id,confirmSite:'test-site'})).data.state,'saved');
});
test('partial GAM result adds only confirmed rows; fresh GAM review fills remaining positions',async t=>{
 const f=await setup();t.after(()=>f.d.close());f.failOnCreate(3);
 const r=await create(f,input(expandGroup({...presets[3],count:25})));assert.equal(r.data.completed,false);assert.equal(r.data.siteSync.addedUnits,20);
 assert.equal(f.d.sqlite.prepare('SELECT count(*) AS n FROM ad_units').get().n,22);f.failOnCreate(0);
 const retry=await create(f,input(expandGroup({...presets[3],count:25})));assert.equal(retry.data.siteSync.addedUnits,5);assert.equal(f.units.length,27);
});
test('legacy GAM-only history can attach to a site after preview; custom names retain selected map',async t=>{
 const f=await setup();t.after(()=>f.d.close());const value=input(expandGroup({...presets[4],names:'CustomAlpha'}));delete value.siteId;
 const r=await create(f,value);assert.equal(r.data.siteSync,undefined);assert.equal(f.d.sqlite.prepare('SELECT count(*) AS n FROM ad_units').get().n,2);
 const p=await f.request('/site-sync/preview',{id:r.data.id,siteId:'test-site'});assert.equal(p.data.rows[0].mapKey,'InText');
 assert.equal((await f.request('/site-sync/apply',{id:p.data.id,confirmSite:'other-site'})).status,422);
 assert.equal((await f.request('/site-sync/apply',{id:p.data.id,confirmSite:'test-site'},{actor:'other@example.invalid'})).status,404);
 assert.equal((await f.request('/site-sync/apply',{id:p.data.id,confirmSite:'test-site'},{headers:{origin:'https://evil.invalid'}})).status,403);
 const saved=await f.request('/site-sync/apply',{id:p.data.id,confirmSite:'test-site'});assert.equal(saved.data.state,'saved');assert.equal(f.d.sqlite.prepare("SELECT size_map_key FROM ad_units WHERE code='CustomAlpha'").get().size_map_key,'InText');
 assert.equal((await f.request('/history')).data.results[0].siteSync.state,'saved');
});
test('CAS and injected transaction failure leave no partial receipt or inventory',async t=>{
 const f=await setup();t.after(()=>f.d.close());const plan=await planSiteInventory(f.store,'test-site',{rows:[{code:'InFeed_1',id:'22',path:'/123456/Example/InFeed_1',sizes:'300x250',mapKey:'InFeed'}]});
 f.d.faults.batchAt=2;await assert.rejects(f.store.commit(plan,actor,'failure'));f.d.faults.batchAt=-1;
 assert.equal(await f.store.receipt('test-site','failure'),null);assert.equal(f.d.sqlite.prepare('SELECT count(*) AS n FROM size_maps').get().n,2);
 f.d.sqlite.prepare("UPDATE ad_units SET enabled=0 WHERE code='Sticky'").run();await assert.rejects(f.store.commit(plan,actor,'stale'),/izmenjen/);
 assert.equal(await f.store.receipt('test-site','stale'),null);
});
