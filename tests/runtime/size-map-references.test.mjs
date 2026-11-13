import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import worker from '../../worker/app-builtin-runtime-preview.ts';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {TEST_EMAIL,TEST_PASSWORD,TEST_SECRET} from '../support/test-workspace-store.mjs';
import {updateSizeMap} from '../../worker/size-maps.ts';
import {configurationErrorMessage} from '../../worker/runtime/configuration-error.mjs';
const origin='https://map-audit.invalid',site='audit-site',base='/api/publishers/'+site;
const fixtures=[];test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
const map=[{minViewPort:[0,0],sizes:[[300,250]]}];
const mapping=(name='Homepage',enabled=true)=>({id:name,name,enabled,priority:100,match:'all',conditions:[{key:'category',operator:'equals',value:'Naslovna'}],sizeMapKey:'home',slotAction:'inherit'});
async function setup(){
 const f=adminAuditStore({config:{enablePrebid:false}});fixtures.push(f);
 Object.assign(f.env,{ADMIN_EMAIL:TEST_EMAIL,ADMIN_PASSWORD:TEST_PASSWORD,SESSION_SECRET:TEST_SECRET,ASSETS:{fetch(){assert.fail('No remote assets');}}});
 f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('home-map',?,?,?)").run(site,'home',JSON.stringify(map));
 const ctx={waitUntil(){},passThroughOnException(){}};
 const login=await worker.fetch(new Request(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env,ctx);
 assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
 f.http=(path,method='GET',body)=>worker.fetch(new Request(origin+base+path,{method,headers:{origin,cookie,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}),f.env,ctx);
 f.json=async(path,method='GET',body)=>{const response=await f.http(path,method,body);return {response,data:await response.json()};};
 return f;
}
function seed(f,{direct=false,basic=true,advanced=true,mirror=true}={}){
 if(direct)f.sqlite.prepare("UPDATE ad_units SET size_map_key='home',enabled=0,type='DRAFT'").run();
 const rule={timeout:1500,conditionalMappings:[mapping(),mapping('Disabled future rule',false)]};
 if(basic)f.sqlite.prepare("INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES('p1-rule',?,'P1',?)").run(site,JSON.stringify(rule));
 const c=f.readConfig();c.unrelated={retained:true};
 if(mirror)c.unitRules={P1:rule};
 if(advanced)c.advancedUnitRules={P1:{conditionalMappings:[mapping('Advanced homepage')],refresh:{enabled:false}},__BTF__:{conditionalMappings:[mapping('Group disabled',false)]}};
 f.writeConfig(c);return rule;
}
function saved(f){return {maps:f.sqlite.prepare('SELECT * FROM size_maps ORDER BY id').all(),units:f.sqlite.prepare('SELECT * FROM ad_units ORDER BY id').all(),rules:f.sqlite.prepare('SELECT * FROM unit_rules ORDER BY id').all(),config:f.readConfig(),audits:f.sqlite.prepare('SELECT * FROM audit_log ORDER BY id').all()};}
function auditCount(f){return f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n;}

test('HTTP list includes basic, shadowing advanced and disabled references without duplicating the config mirror',async()=>{
 const f=await setup();seed(f,{direct:true});const {response,data}=await f.json('/size-maps');assert.equal(response.status,200);
 const refs=data.sizeMaps.find(row=>row.name==='home').references;assert.equal(refs.length,5);assert.deepEqual(refs.map(row=>row.source),['ad-unit','rule','rule','advanced-rule','advanced-rule']);
 assert(refs.some(row=>row.label==='P1: Homepage'));assert(refs.some(row=>row.label==='P1: Disabled future rule (disabled)'));assert(refs.some(row=>row.label==='BTF group: Group disabled (advanced) (disabled)'));
});
for(const source of ['basic','advanced','mirror'])test(`HTTP delete refuses ${source}-only references and names the rule`,async()=>{
 const f=await setup();seed(f,{basic:source==='basic',advanced:source==='advanced',mirror:source==='mirror'});const before=saved(f);
 const {response,data}=await f.json('/size-maps/home-map','DELETE');assert.equal(response.status,409);assert.match(data.error,/P1:.*[Hh]omepage/);assert.match(data.error,/Reassign/);assert.deepEqual(saved(f),before);
});
for(const endpoint of ['flexible HTTP','classic handler'])test(`${endpoint} rename atomically updates all saved map references and retains unrelated settings`,async()=>{
 const f=await setup();seed(f,{direct:true});const before=saved(f);
 const response=endpoint==='flexible HTTP'?await f.http('/size-maps/home-map','PATCH',{name:'renamed',map}):await updateSizeMap(new Request(origin,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({name:'renamed',map})}),f.env,site,'home-map');
 assert.equal(response.status,200,await response.clone().text());const after=saved(f);assert.equal(after.maps.find(row=>row.id==='home-map').name,'renamed');assert.equal(after.units[0].size_map_key,'renamed');
 const basic=JSON.parse(after.rules[0].rule_json);assert(basic.conditionalMappings.every(m=>m.sizeMapKey==='renamed'));assert.equal(basic.timeout,1500);assert.equal(basic.conditionalMappings[1].enabled,false);
 assert(after.config.unitRules.P1.conditionalMappings.every(m=>m.sizeMapKey==='renamed'));assert.equal(after.config.advancedUnitRules.P1.conditionalMappings[0].sizeMapKey,'renamed');assert.equal(after.config.advancedUnitRules.__BTF__.conditionalMappings[0].sizeMapKey,'renamed');assert.deepEqual(after.config.advancedUnitRules.P1.refresh,before.config.advancedUnitRules.P1.refresh);assert.deepEqual(after.config.unrelated,before.config.unrelated);assert.equal(after.audits.length,1);
 assert.equal((await f.json('/size-maps')).data.sizeMaps.find(row=>row.name==='renamed').references.length,5);
});
test('HTTP rename collision rolls back map, every reference and audit',async()=>{
 const f=await setup();seed(f,{direct:true});const before=saved(f);const response=await f.http('/size-maps/home-map','PATCH',{name:'display',map});assert.equal(response.status,409);assert.deepEqual(saved(f),before);
});
for(const kind of ['config','rule','unit','map','new-rule'])test(`concurrent ${kind} edit blocks the whole rename while keeping the other tab change`,async()=>{
 const f=await setup();seed(f);const original=f.env.DB.batch;let concurrent;
 f.env.DB.batch=async items=>{f.env.DB.batch=original;
  if(kind==='config')f.writeConfig({...f.readConfig(),otherTab:'kept'});
  if(kind==='rule')f.sqlite.prepare("UPDATE unit_rules SET rule_json=? WHERE id='p1-rule'").run(JSON.stringify({otherTab:'kept'}));
  if(kind==='unit')f.sqlite.prepare("UPDATE ad_units SET size_map_key='home'").run();
  if(kind==='map')f.sqlite.prepare("UPDATE size_maps SET map_json=? WHERE id='home-map'").run(JSON.stringify([{minViewPort:[0,0],sizes:[[320,50]]}]));
  if(kind==='new-rule')f.sqlite.prepare("INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES('new',?,'P2',?)").run(site,JSON.stringify({conditionalMappings:[mapping('Other tab')]}));
  concurrent=saved(f);return original(items);
 };
 const response=await f.http('/size-maps/home-map','PATCH',{name:'renamed',map});assert.equal(response.status,409,await response.clone().text());assert.deepEqual(saved(f),concurrent);
});
test('a reference introduced between delete checks and batch prevents deletion',async()=>{
 const f=await setup();const original=f.env.DB.batch;f.env.DB.batch=async items=>{seed(f,{advanced:false});return original(items);};
 const response=await f.http('/size-maps/home-map','DELETE');assert.equal(response.status,409);assert(f.sqlite.prepare("SELECT 1 FROM size_maps WHERE id='home-map'").get());assert.equal(auditCount(f),0);
});
for(const invalid of ['config','rule','mappings','advanced'])test(`invalid saved ${invalid} fails before writes and can be recovered`,async()=>{
 const f=await setup();seed(f);const before=saved(f),batches=f.log.batches;
 if(invalid==='config')f.sqlite.prepare("UPDATE publisher_configs SET config_json='BROKEN_JSON'").run();
 if(invalid==='rule')f.sqlite.prepare("UPDATE unit_rules SET rule_json='BROKEN_JSON'").run();
 if(invalid==='mappings')f.sqlite.prepare("UPDATE unit_rules SET rule_json=?").run(JSON.stringify({conditionalMappings:{sizeMapKey:'home'}}));
 if(invalid==='advanced')f.writeConfig({...f.readConfig(),advancedUnitRules:[]});
 assert.notEqual((await f.http('/size-maps/home-map','PATCH',{name:'renamed',map})).status,200);assert.equal(f.log.batches,batches);assert.deepEqual(f.sqlite.prepare('SELECT * FROM size_maps ORDER BY id').all(),before.maps);assert.equal(auditCount(f),0);
 f.writeConfig(before.config);f.sqlite.prepare('UPDATE unit_rules SET rule_json=?').run(before.rules[0].rule_json);assert.equal((await f.http('/size-maps/home-map','PATCH',{name:'renamed',map})).status,200);
});
test('unused delete remains available and never touches another publisher',async()=>{
 const f=await setup();f.sqlite.prepare("INSERT INTO publishers(id,name,domain,gam_path) VALUES('other','Other','other.invalid','/123/other/')").run();f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('other-home','other','home',?)").run(JSON.stringify(map));
 assert.equal((await f.http('/size-maps/home-map','DELETE')).status,200);assert(f.sqlite.prepare("SELECT 1 FROM size_maps WHERE id='other-home'").get());assert.equal(auditCount(f),1);
});
test('HTTP Generate names the broken conditional rule, then generates after rename without page-category data',async()=>{
 const f=await setup();seed(f,{advanced:false});let state=(await f.json('/builtin-site-settings')).data;const runtime=state.runtimes.find(row=>row.version==='3.21.0');
 let response=await f.http('/builtin-site-settings','POST',{action:'setup',revision:state.revision,runtime:runtime.pin,allowPreview:false,enablePrebid:false});assert.equal(response.status,200,await response.clone().text());
 // Simulate an already-orphaned saved reference from an earlier buggy delete.
 const row=f.sqlite.prepare("SELECT rule_json FROM unit_rules WHERE id='p1-rule'").get();const broken=JSON.parse(row.rule_json);broken.conditionalMappings[0].sizeMapKey='missing';f.sqlite.prepare("UPDATE unit_rules SET rule_json=? WHERE id='p1-rule'").run(JSON.stringify(broken));
 state=(await f.json('/builtin-site-settings')).data;response=await f.http('/builtin-site-settings','POST',{action:'bundle',revision:state.revision,acknowledge:true});assert.equal(response.status,422);assert.match(await response.text(),/P1, mapping 1: selected size map does not exist/);
 f.sqlite.prepare("UPDATE unit_rules SET rule_json=? WHERE id='p1-rule'").run(row.rule_json);
 assert.equal((await f.http('/size-maps/home-map','PATCH',{name:'renamed',map})).status,200);
 state=(await f.json('/builtin-site-settings')).data;response=await f.http('/builtin-site-settings','POST',{action:'bundle',revision:state.revision,acknowledge:true});assert.equal(response.status,200,await response.clone().text());
 const zip=unzipSync(new Uint8Array(await response.arrayBuffer())),script=new TextDecoder().decode(zip['ads.js']);assert.match(script,/renamed/);assert.match(script,/Naslovna/);assert(zip['config.json']);
});
test('public configuration diagnostics expose only allowlisted validation messages',()=>{
 const message='P2, mapping 1: selected size map does not exist.';assert.equal(configurationErrorMessage(Error(message)),message);
 for(const sensitive of ['SENSITIVE_DATABASE_PASSWORD','D1_ERROR: query failed','TypeError: Cannot read properties of undefined',message+'\nSENSITIVE','Compiler hook boundary changed'])assert(!configurationErrorMessage(Error(sensitive)).includes(sensitive));
});

for(const format of ['TakeOver','Outstream'])test(`3.21.1 exact ${format} rule validation stays actionable`,()=>{
 const message=`Overlay: conditional rules on this ${format} position are not supported. Keep its saved responsive map; use Banner or Sticky rules, or the separate Interstitial fallback rule.`;
 assert.equal(configurationErrorMessage(Error(message)),message);
 assert.notEqual(configurationErrorMessage(Error(message+' SENSITIVE_STORAGE')),message+' SENSITIVE_STORAGE');
});
