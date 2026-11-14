import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {runInNewContext} from 'node:vm';
import {parse} from 'acorn';
import worker from '../../worker/app-builtin-runtime-preview.ts';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {TEST_EMAIL,TEST_PASSWORD,TEST_SECRET} from '../support/test-workspace-store.mjs';
import {updateSizeMap} from '../../worker/size-maps.ts';
import {configurationErrorMessage} from '../../worker/runtime/configuration-error.mjs';
import {compactCodes,pageTypeOf,pageTypeRenames} from '../../shared/size-maps/page-type.mjs';
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
 assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];f.cookie=cookie;
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

// ADM-1 / ADM-2: page-type maps are selected by name (<page type>_<base>); renames carry them.
const P=[{minViewPort:[0,0],sizes:[[300,250],[300,600]]},{minViewPort:[768,0],sizes:[[300,600],[160,600],[300,250]]}];
const NP=[{minViewPort:[0,0],sizes:[[300,250]]},{minViewPort:[768,0],sizes:[[300,250],[250,250]]}];
const VIDEO={'P@0x0':[300,250],'P@768x0':[300,250],'naslovna_P@768x0':[300,250],'vesti_sport_P@768x0':[300,250],'Naslovna_P@768x0':[300,250]};
async function pageSetup({video=false}={}){
 const f=await setup();
 const insert=(id,name,rows)=>f.sqlite.prepare('INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES(?,?,?,?)').run(id,site,name,JSON.stringify(rows));
 insert('p-map','P',P);insert('np-map','naslovna_P',NP);insert('vs-map','vesti_sport_P',NP);insert('upper-map','Naslovna_P',NP);
 f.sqlite.prepare("UPDATE ad_units SET size_map_key='P',sort_order=0 WHERE id='audit-unit'").run();
 for(const [index,code] of ['P2','P3'].entries())f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,sort_order) VALUES(?,?,?,'BTF','P',?)").run('unit-'+code,site,code,index+1);
 if(video){const c=f.readConfig();c.runtimeControls={...c.runtimeControls,outstream:{schemaVersion:1,units:{P1:{format:'banner-outstream',minDuration:1,maxDuration:30,playbackMethod:2,placement:3,plcmt:4,partner:{bidder:'pubmatic',adapter:'pubmatic',outstreamAU:'fixture',activationConfirmed:true},cacheUrl:'https://prebid.adnxs.com/pbc/v1/cache',playerSizing:'size-map',playerSizes:{...VIDEO}}}}};f.writeConfig(c);}
 return f;
}
const names=f=>f.sqlite.prepare('SELECT name FROM size_maps ORDER BY name').all().map(row=>row.name);
const refsOf=async(f,name)=>(await f.json('/size-maps')).data.sizeMaps.find(row=>row.name===name)?.references;
const reviewOf=async f=>(await f.json('/outstream-settings')).data.formatReviewRequired;

test('page-type maps list the positions that select them; uppercase names and TakeOver positions never do',async()=>{
 const f=await pageSetup();
 assert.deepEqual((await refsOf(f,'naslovna_P')).map(row=>[row.source,row.label]),[['page-type','Page type naslovna: P1–P3 (via P)']]);
 assert.deepEqual((await refsOf(f,'vesti_sport_P')).map(row=>row.label),['Page type vesti_sport: P1–P3 (via P)']);
 assert.deepEqual(await refsOf(f,'Naslovna_P'),[]);
 const c=f.readConfig();c.runtimeControls={...c.runtimeControls,adPositions:{P3:{}}};f.writeConfig(c);
 assert.deepEqual((await refsOf(f,'naslovna_P')).map(row=>row.label),['Page type naslovna: P1, P2 (via P)']);
});
for(const endpoint of ['flexible HTTP','classic handler'])test(`${endpoint} base rename carries page-type maps, their rule references and Outstream sizes in one audited write`,async()=>{
 const f=await pageSetup({video:true});
 const rule={conditionalMappings:[{...mapping('Home exact'),sizeMapKey:'naslovna_P'}]};
 f.sqlite.prepare("INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES('p2-rule',?,'P2',?)").run(site,JSON.stringify(rule));
 const c=f.readConfig();c.unitRules={P2:rule};c.advancedUnitRules={P2:{conditionalMappings:[{...mapping('Advanced home'),sizeMapKey:'naslovna_P'}]}};f.writeConfig(c);
 assert.deepEqual(await reviewOf(f),[]);
 const body={name:'Pravougaonik',map:P};
 const response=endpoint==='flexible HTTP'?await f.http('/size-maps/p-map','PATCH',body):await updateSizeMap(new Request(origin,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),f.env,site,'p-map');
 assert.equal(response.status,200,await response.clone().text());
 assert.deepEqual(names(f),['Naslovna_P','Pravougaonik','display','home','naslovna_Pravougaonik','vesti_sport_Pravougaonik']);
 assert.deepEqual(f.sqlite.prepare("SELECT DISTINCT size_map_key FROM ad_units").all().map(row=>row.size_map_key),['Pravougaonik']);
 const after=f.readConfig();
 assert.equal(JSON.parse(f.sqlite.prepare("SELECT rule_json FROM unit_rules WHERE id='p2-rule'").get().rule_json).conditionalMappings[0].sizeMapKey,'naslovna_Pravougaonik');
 assert.equal(after.unitRules.P2.conditionalMappings[0].sizeMapKey,'naslovna_Pravougaonik');
 assert.equal(after.advancedUnitRules.P2.conditionalMappings[0].sizeMapKey,'naslovna_Pravougaonik');
 assert.deepEqual(Object.keys(after.runtimeControls.outstream.units.P1.playerSizes).sort(),['Pravougaonik@0x0','Pravougaonik@768x0','naslovna_Pravougaonik@768x0','vesti_sport_Pravougaonik@768x0']);
 assert.deepEqual(await reviewOf(f),[],'Generate is not blocked by stale Outstream keys');
 const audits=f.sqlite.prepare('SELECT details_json FROM audit_log').all();assert.equal(audits.length,1);
 assert.deepEqual(JSON.parse(audits[0].details_json).pageTypeMaps,[['naslovna_P','naslovna_Pravougaonik'],['vesti_sport_P','vesti_sport_Pravougaonik']]);
 assert.deepEqual((await refsOf(f,'naslovna_Pravougaonik')).map(row=>row.label).sort(),['P1: Outstream video sizes','P2: Advanced home (advanced)','P2: Home exact','Page type naslovna: P1–P3 (via Pravougaonik)']);
});
test('rename refuses an existing or over-long page-type target before any write',async()=>{
 const f=await pageSetup();f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('nq',?,'naslovna_Q',?)").run(site,JSON.stringify(NP));const before=saved(f);
 let {response,data}=await f.json('/size-maps/p-map','PATCH',{name:'Q',map:P});
 assert.equal(response.status,409);assert.match(data.error,/"naslovna_Q" already exists.*page-type map naslovna_P to naslovna_Q/);assert.deepEqual(saved(f),before);
 ({response,data}=await f.json('/size-maps/p-map','PATCH',{name:'Q'+'x'.repeat(118),map:P}));
 assert.equal(response.status,422);assert.match(data.error,/longer than 128 characters/);assert.deepEqual(saved(f),before);
});
test('deleting a page-type map asks for confirmation of exactly the current impact, then removes its Outstream sizes',async()=>{
 const f=await pageSetup({video:true});const before=saved(f);
 let {response,data}=await f.json('/size-maps/np-map','DELETE');
 assert.equal(response.status,409);assert.deepEqual(data.details.confirmation.changes.map(row=>row.message),['Page type naslovna: P1–P3 will use P instead of naslovna_P.']);
 assert.match(data.error,/Saved Outstream video sizes for this map are removed from P1\. Reload size maps to review and confirm this change\.$/);assert.deepEqual(data.details.confirmation.videoUnits,['P1']);assert.deepEqual(saved(f),before);
 assert.equal((await f.json('/size-maps/np-map','DELETE',{confirmPageTypeChanges:'0'.repeat(64)})).response.status,409);assert.deepEqual(saved(f),before);
 const stale=data.details.confirmation.token;
 f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,sort_order) VALUES('unit-P4',?,'P4','BTF','P',3)").run(site);
 ({response,data}=await f.json('/size-maps/np-map','DELETE',{confirmPageTypeChanges:stale}));
 assert.equal(response.status,409,'a token never covers positions added after it was shown');assert.match(data.details.confirmation.changes[0].message,/P1–P4/);
 ({response,data}=await f.json('/size-maps/np-map','DELETE',{confirmPageTypeChanges:data.details.confirmation.token}));
 assert.equal(response.status,200,JSON.stringify(data));assert(!names(f).includes('naslovna_P'));
 assert(!Object.keys(f.readConfig().runtimeControls.outstream.units.P1.playerSizes).includes('naslovna_P@768x0'));assert.deepEqual(await reviewOf(f),[]);
 assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT details_json FROM audit_log').get().details_json).pageTypeChanges,['Page type naslovna: P1–P4 will use P instead of naslovna_P.']);
});
test('an explicit rule reference still blocks deleting a page-type map',async()=>{
 const f=await pageSetup();f.sqlite.prepare("INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES('p2-rule',?,'P2',?)").run(site,JSON.stringify({conditionalMappings:[{...mapping('Home exact'),sizeMapKey:'naslovna_P'}]}));
 const {response,data}=await f.json('/size-maps/np-map','DELETE');assert.equal(response.status,409);assert.match(data.error,/P2: Home exact.*Reassign/);assert(!data.details.confirmation);
});
test('renaming a page-type map out of its family is confirmed, then carries its references',async()=>{
 const f=await pageSetup();
 let {response,data}=await f.json('/size-maps/np-map','PATCH',{name:'home_P',map:NP});
 assert.equal(response.status,409);assert.deepEqual(data.details.confirmation.changes.map(row=>row.message),['Page type home: P1–P3 will use home_P instead of P.','Page type naslovna: P1–P3 will use P instead of naslovna_P.']);
 ({response}=await f.json('/size-maps/np-map','PATCH',{name:'home_P',map:NP,confirmPageTypeChanges:data.details.confirmation.token}));
 assert.equal(response.status,200);assert(names(f).includes('home_P'));
 assert.equal((await f.json('/size-maps/upper-map','PATCH',{name:'Pocetna_P',map:NP})).response.status,200,'a name the generator never selects needs no confirmation');
});
for(const kind of ['variant-rename','new-variant','variant-content','outstream'])test(`concurrent ${kind} edit blocks a base rename with page-type maps`,async()=>{
 const f=await pageSetup({video:true});const original=f.env.DB.batch;let concurrent;
 f.env.DB.batch=async items=>{f.env.DB.batch=original;
  if(kind==='variant-rename')f.sqlite.prepare("UPDATE size_maps SET name='sport_P' WHERE id='vs-map'").run();
  if(kind==='new-variant')f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('new',?,'sport_P',?)").run(site,JSON.stringify(NP));
  if(kind==='variant-content')f.sqlite.prepare("UPDATE size_maps SET map_json=? WHERE id='np-map'").run(JSON.stringify(P));
  if(kind==='outstream'){const c=f.readConfig();c.runtimeControls.outstream.units.P1.playerSizes['P@0x0']=[300,600];f.writeConfig(c);}
  concurrent=saved(f);return original(items);
 };
 const response=await f.http('/size-maps/p-map','PATCH',{name:'Pravougaonik',map:P});assert.equal(response.status,409,await response.clone().text());assert.deepEqual(saved(f),concurrent);
});
/** Generates with 3.21.1 and evaluates the generated baseUnitConfigById for P1 on each page type. */
async function selectedMaps(f,pageTypes,rename){
 let state=(await f.json('/builtin-site-settings')).data;const runtime=state.runtimes.find(row=>row.version==='3.21.1');
 let response=await f.http('/builtin-site-settings','POST',{action:'setup',revision:state.revision,runtime:runtime.pin,allowPreview:false,enablePrebid:false});assert.equal(response.status,200,await response.clone().text());
 if(rename)await rename();
 state=(await f.json('/builtin-site-settings')).data;response=await f.http('/builtin-site-settings','POST',{action:'bundle',revision:state.revision,acknowledge:true});assert.equal(response.status,200,await response.clone().text());
 const zip=unzipSync(new Uint8Array(await response.arrayBuffer())),source=new TextDecoder().decode(zip['ads.js']),config=JSON.parse(new TextDecoder().decode(zip['config.json']));
 const wanted=new Set(['computePageTypePrefixes','baseUnitConfigById','findExplicitUnit']),functions=[];
 (function walk(node){if(!node||typeof node!=='object')return;if(node.type==='FunctionDeclaration'&&wanted.has(node.id?.name))functions.push(source.slice(node.start,node.end));for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);})(parse(source,{ecmaVersion:2015}));
 assert.equal(functions.length,wanted.size);
 const selected={};
 for(const pageType of pageTypes){
  const ctx={window:{adsKeywords:{pageType}},TESSERA_OVERLAY:{code:null},PAGE_TYPE_KEYS:['pageType'],UNIT_RANGE:null,UNIT_DEFAULTS:null,UNIT_OVERRIDES:{},EXPLICIT_UNITS:config.core.explicitUnits,SIZE_MAPS_RAW:config.core.sizeMapsRaw,PREBID_SIZE_CONFIGS_RAW:config.core.prebidSizeConfigsRaw};
  runInNewContext(functions.join('\n')+'\nvar PAGE_TYPE_PREFIXES=computePageTypePrefixes();var selected=baseUnitConfigById("P1");',ctx);
  assert.equal(ctx.selected.prebidSizeConfigName,ctx.selected.sizeMapName,pageType);
  selected[pageType]=ctx.selected.sizeMapName;
 }
 return selected;
}
test('3.21.1 Generate after a base rename still selects the page-type map on that page type',async()=>{
 const f=await pageSetup();
 const selected=await selectedMaps(f,['Naslovna','Vesti Sport','Galerija'],async()=>assert.equal((await f.http('/size-maps/p-map','PATCH',{name:'Pravougaonik',map:P})).status,200));
 assert.deepEqual(selected,{Naslovna:'naslovna_Pravougaonik','Vesti Sport':'vesti_sport_Pravougaonik',Galerija:'Pravougaonik'});
});
// ADM-5: the selected map is re-checked inside the rule save batch.
for(const action of ['rename','delete'])test(`a rule save racing a map ${action} saves nothing and names the map`,async()=>{
 const f=await setup();const original=f.env.DB.batch;let other;
 f.env.DB.batch=async items=>{f.env.DB.batch=original;other=action==='rename'?await f.http('/size-maps/home-map','PATCH',{name:'renamed',map}):await f.http('/size-maps/home-map','DELETE');return original(items);};
 const {response,data}=await f.json('/unit-rules','POST',{ruleKey:'P1',rule:{conditionalMappings:[mapping('Homepage')]}});
 assert.equal(other.status,200);assert.equal(response.status,409,JSON.stringify(data));assert.match(data.error,/"home" was renamed or deleted in another tab/);
 assert(!f.sqlite.prepare("SELECT 1 FROM unit_rules WHERE rule_key='P1'").get());assert(!f.readConfig().unitRules?.P1);
});

for(const step of ['update','duplicate'])test(`ADM-5: a rule ${step} racing a map change saves nothing and names the map`,async()=>{
 const f=await setup();f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key) VALUES('unit-P2',?,'P2','BTF','display')").run(site);
 const created=await f.json('/unit-rules','POST',{ruleKey:'P1',rule:{conditionalMappings:[{...mapping('Homepage'),sizeMapKey:step==='update'?'display':'home'}]}});
 assert.equal(created.response.status,201,JSON.stringify(created.data));const rule=created.data.unitRule??created.data.rule;assert(rule?.id,JSON.stringify(created.data));
 const before=saved(f);const original=f.env.DB.batch;let other;
 f.env.DB.batch=async items=>{f.env.DB.batch=original;
  // update: an HTTP rename of a map the saved row does not use yet. duplicate: the HTTP rename would
  // rewrite the source row (row guard), so a writer that renames only the map row exercises this gate.
  if(step==='update')other=await f.http('/size-maps/home-map','PATCH',{name:'renamed',map});
  else{f.sqlite.prepare("UPDATE size_maps SET name='renamed' WHERE id='home-map'").run();other={status:200};}
  return original(items);};
 const {response,data}=step==='update'
  ?await f.json('/unit-rules/'+rule.id,'PATCH',{rule:{conditionalMappings:[mapping('Homepage')]}})
  :await f.json('/unit-rules/'+rule.id+'/duplicate','POST',{ruleKey:'P2'});
 assert.equal(other.status,200);assert.equal(response.status,409,JSON.stringify(data));assert.match(data.error,/Size map "home" was renamed or deleted in another tab, so nothing was saved\./);
 const after=saved(f);assert.deepEqual(after.rules,before.rules);assert.deepEqual(after.config.unitRules,before.config.unitRules);
 assert(!f.sqlite.prepare("SELECT 1 FROM unit_rules WHERE rule_key='P2'").get());
});

test('page-type rule matches the generator for CSV-imported names: diacritics, dots and leading digits select, uppercase never does',()=>{
 assert.equal(pageTypeOf('članak_P','P'),'članak');assert.equal(pageTypeOf('naslovna.v2_P','P'),'naslovna.v2');assert.equal(pageTypeOf('1x_P','P'),'1x');
 assert.equal(pageTypeOf('vesti_sport_P','P'),'vesti_sport');assert.equal(pageTypeOf('Naslovna_P','P'),null);assert.equal(pageTypeOf('Članak_P','P'),null);
 assert.equal(pageTypeOf('a b_P','P'),null,'whitespace is folded to _ by the runtime');assert.equal(pageTypeOf('_P','P'),null);assert.equal(pageTypeOf('P','P'),null);
 // computePageTypePrefixes(): String(v).toLowerCase().replace(/\s+/g,'_') yields exactly these prefixes.
 for(const value of ['Članak','Naslovna.V2','1X','Vesti Sport','Početna','Društvo'])assert.equal(pageTypeOf(String(value).toLowerCase().replace(/\s+/g,'_')+'_P','P'),String(value).toLowerCase().replace(/\s+/g,'_'));
 assert.equal(compactCodes(['P1','P2','P3','P5','Sticky']),'P1–P3, P5, Sticky');
});
test('cascade scope never carries ad-unit maps or page-type maps of other bases in use',()=>{
 const names=['P','naslovna_P','sport_P','vesti_sport_P','mobile','billboard_mobile','naslovna_billboard_mobile'];
 assert.deepEqual([...pageTypeRenames(names,'P','X',new Set(['P']))],[['P','X'],['naslovna_P','naslovna_X'],['sport_P','sport_X'],['vesti_sport_P','vesti_sport_X']]);
 assert.deepEqual([...pageTypeRenames(names,'sport_P','fudbal_P',new Set(['P']))],[['sport_P','fudbal_P']],'a page-type map of a base in use is not a family head');
 assert.deepEqual([...pageTypeRenames(names,'mobile','mob',new Set(['P','mobile','billboard_mobile']))],[['mobile','mob']],'an ad-unit base and its page-type maps are not variants of mobile');
 assert.deepEqual([...pageTypeRenames(names,'mobile','mob',new Set(['P']))],[['mobile','mob'],['billboard_mobile','billboard_mob'],['naslovna_billboard_mobile','naslovna_billboard_mob']]);
 assert.deepEqual([...pageTypeRenames(names,'P','P',new Set(['P']))],[]);
});

const CSV_NAMES=['članak_P','naslovna.v2_P','1x_P'];
async function csvSetup(options){
 const f=await pageSetup(options);
 const {response,data}=await f.json('/imports/apply','POST',{kind:'size-maps',csv:'name,minWidth,sizes\n'+CSV_NAMES.map(name=>name+',0,300x250').join('\n')+'\n'});
 assert.equal(response.status,200,JSON.stringify(data));for(const name of CSV_NAMES)assert(names(f).includes(name),name);
 return f;
}
test('CSV-imported page-type maps with diacritics, a dot or a leading digit are listed, carried by a base rename and confirmed on delete',async()=>{
 const f=await csvSetup();
 assert.deepEqual((await refsOf(f,'članak_P')).map(row=>row.label),['Page type članak: P1–P3 (via P)']);
 assert.deepEqual((await refsOf(f,'naslovna.v2_P')).map(row=>row.label),['Page type naslovna.v2: P1–P3 (via P)']);
 assert.deepEqual((await refsOf(f,'1x_P')).map(row=>row.label),['Page type 1x: P1–P3 (via P)']);
 let {response,data}=await f.json('/size-maps/'+f.sqlite.prepare("SELECT id FROM size_maps WHERE name='članak_P'").get().id,'DELETE');
 assert.equal(response.status,409);assert.deepEqual(data.details.confirmation.changes.map(row=>row.message),['Page type članak: P1–P3 will use P instead of članak_P.']);
 const id=f.sqlite.prepare("SELECT id FROM size_maps WHERE name='članak_P'").get().id;
 ({response}=await f.json('/size-maps/'+id,'DELETE',{confirmPageTypeChanges:data.details.confirmation.token}));assert.equal(response.status,200);assert(!names(f).includes('članak_P'));
 ({response,data}=await f.json('/size-maps/p-map','PATCH',{name:'X',map:P}));assert.equal(response.status,200,JSON.stringify(data));
 for(const name of ['naslovna.v2_X','1x_X','naslovna_X','vesti_sport_X'])assert(names(f).includes(name),name);
 assert.deepEqual(JSON.parse(f.sqlite.prepare("SELECT details_json FROM audit_log WHERE action='size_map.updated'").get().details_json).pageTypeMaps.map(([from])=>from).sort(),['1x_P','naslovna.v2_P','naslovna_P','vesti_sport_P']);
});
test('3.21.1 Generate selects CSV-imported page-type maps after a base rename (pageType "Članak")',async()=>{
 const f=await csvSetup();
 const selected=await selectedMaps(f,['Članak','naslovna.v2','1x','Galerija'],async()=>assert.equal((await f.http('/size-maps/p-map','PATCH',{name:'Pravougaonik',map:P})).status,200));
 assert.deepEqual(selected,{'Članak':'članak_Pravougaonik','naslovna.v2':'naslovna.v2_Pravougaonik','1x':'1x_Pravougaonik',Galerija:'Pravougaonik'});
});

test('cascade scope: renaming a base never renames another in-use base that ends with its name',async()=>{
 const f=await pageSetup();
 for(const [id,name,rows] of [['m','mobile',NP],['bm','billboard_mobile',P],['nbm','naslovna_billboard_mobile',NP]])f.sqlite.prepare('INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES(?,?,?,?)').run(id,site,name,JSON.stringify(rows));
 f.sqlite.prepare("UPDATE ad_units SET size_map_key='mobile' WHERE code='P2'").run();f.sqlite.prepare("UPDATE ad_units SET size_map_key='billboard_mobile' WHERE code='P3'").run();
 const before=saved(f);
 let {response,data}=await f.json('/size-maps/m','PATCH',{name:'mob',map:NP});
 assert.equal(response.status,409);assert.deepEqual(saved(f),before);
 assert.deepEqual(data.details.confirmation.changes.map(row=>row.message),['Page type billboard: P2 will use mob instead of billboard_mobile.','Page type naslovna_billboard: P2 will use mob instead of naslovna_billboard_mobile.']);
 ({response,data}=await f.json('/size-maps/m','PATCH',{name:'mob',map:NP,confirmPageTypeChanges:data.details.confirmation.token}));assert.equal(response.status,200,JSON.stringify(data));
 assert.deepEqual(f.sqlite.prepare('SELECT code,size_map_key FROM ad_units ORDER BY code').all().map(row=>[row.code,row.size_map_key]),[['P1','P'],['P2','mob'],['P3','billboard_mobile']]);
 for(const name of ['mob','billboard_mobile','naslovna_billboard_mobile'])assert(names(f).includes(name),name);
 assert.deepEqual((await refsOf(f,'naslovna_billboard_mobile')).map(row=>row.label),['Page type naslovna: P3 (via billboard_mobile)']);
});
test('cascade scope: renaming a page-type map never drags a longer page-type map along',async()=>{
 const f=await pageSetup();
 f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('s',?,'sport_P',?)").run(site,JSON.stringify(NP));
 let {response,data}=await f.json('/size-maps/s','PATCH',{name:'fudbal_P',map:NP});
 assert.equal(response.status,409);assert.deepEqual(data.details.confirmation.changes.map(row=>row.message),['Page type fudbal: P1–P3 will use fudbal_P instead of P.','Page type sport: P1–P3 will use P instead of sport_P.']);
 ({response}=await f.json('/size-maps/s','PATCH',{name:'fudbal_P',map:NP,confirmPageTypeChanges:data.details.confirmation.token}));assert.equal(response.status,200);
 assert.deepEqual(names(f),['Naslovna_P','P','display','fudbal_P','home','naslovna_P','vesti_sport_P']);
});

for(const endpoint of ['flexible HTTP','classic handler'])test(`${endpoint} PATCH refuses a forged or stale confirmation and accepts the fresh one`,async()=>{
 const f=await pageSetup();const before=saved(f);
 const patch=async body=>{const response=endpoint==='flexible HTTP'?await f.http('/size-maps/np-map','PATCH',body):await updateSizeMap(new Request(origin,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),f.env,site,'np-map');return {response,data:await response.json()};};
 const body={name:'home_P',map:NP};
 let {response,data}=await patch(body);assert.equal(response.status,409);assert.match(data.error,/Reload size maps to review and confirm this change\.$/);const stale=data.details.confirmation.token;
 ({response,data}=await patch({...body,confirmPageTypeChanges:'f'.repeat(64)}));assert.equal(response.status,409,'a forged token is refused');assert.equal(data.details.confirmation.token,stale);assert.deepEqual(saved(f),before);
 f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,sort_order) VALUES('unit-P4',?,'P4','BTF','P',3)").run(site);const changed=saved(f);
 ({response,data}=await patch({...body,confirmPageTypeChanges:stale}));assert.equal(response.status,409,'a token never covers positions added after it was shown');
 assert.deepEqual(data.details.confirmation.changes.map(row=>row.message),['Page type home: P1–P4 will use home_P instead of P.','Page type naslovna: P1–P4 will use P instead of naslovna_P.']);assert.deepEqual(saved(f),changed);
 ({response,data}=await patch({...body,confirmPageTypeChanges:data.details.confirmation.token}));assert.equal(response.status,200,JSON.stringify(data));assert(names(f).includes('home_P'));
});

test('a sizes-only edit compares only its own row; a rename still compares every map',async()=>{
 const f=await pageSetup();const original=f.env.DB.batch;
 f.env.DB.batch=async items=>{f.env.DB.batch=original;f.sqlite.prepare("UPDATE size_maps SET map_json=? WHERE id='np-map'").run(JSON.stringify(P));return original(items);};
 const edited=[{minViewPort:[0,0],sizes:[[300,250]]}];
 let response=await f.http('/size-maps/p-map','PATCH',{name:'P',map:edited});assert.equal(response.status,200,await response.clone().text());
 assert.equal(f.sqlite.prepare("SELECT map_json FROM size_maps WHERE id='p-map'").get().map_json,JSON.stringify(edited));assert.equal(f.sqlite.prepare("SELECT map_json FROM size_maps WHERE id='np-map'").get().map_json,JSON.stringify(P));
 f.env.DB.batch=async items=>{f.env.DB.batch=original;f.sqlite.prepare("UPDATE size_maps SET updated_at='other-tab' WHERE id='p-map'").run();return original(items);};
 response=await f.http('/size-maps/p-map','PATCH',{name:'P',map:P});assert.equal(response.status,409);assert.equal(f.sqlite.prepare("SELECT map_json FROM size_maps WHERE id='p-map'").get().map_json,JSON.stringify(edited));
});

test('a rename that would overwrite a saved Outstream key is refused with nothing written',async()=>{
 const f=await pageSetup({video:true});const c=f.readConfig();c.runtimeControls.outstream.units.P1.playerSizes['X@0x0']=[300,600];f.writeConfig(c);const before=saved(f);
 const {response,data}=await f.json('/size-maps/p-map','PATCH',{name:'X',map:P});
 assert.equal(response.status,409);assert.equal(data.error,'Renaming P to X would replace the saved Outstream video size X@0x0 on P1. Reopen Formats and review the video size choices for P1, or choose another name.');
 assert.deepEqual(saved(f),before);
});
test('Outstream: a rename that adds a multi-size map to a unit family needs a Formats choice (strict names are confirmed first)',async()=>{
 const f=await pageSetup({video:true});const multi=[{minViewPort:[0,0],sizes:[[300,250],[400,300]]}];
 for(const [id,name] of [['hq','Home_Q'],['hr','home_R']])f.sqlite.prepare('INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES(?,?,?,?)').run(id,site,name,JSON.stringify(multi));
 assert.deepEqual(await reviewOf(f),[]);
 // Not a page-type name (uppercase): no selection changes, so no confirmation; Formats review names P1 (R4.6).
 let {response,data}=await f.json('/size-maps/hq','PATCH',{name:'Home_P',map:multi});assert.equal(response.status,200,JSON.stringify(data));
 assert.deepEqual((await reviewOf(f)).map(row=>row.code),['P1']);
 ({response,data}=await f.json('/size-maps/hr','PATCH',{name:'home_P',map:multi}));assert.equal(response.status,409);
 assert.deepEqual(data.details.confirmation.changes.map(row=>row.message),['Page type home: P1–P3 will use home_P instead of P.']);
 assert.deepEqual(data.details.confirmation.videoSizes,[{code:'P1',map:'home_P',message:'Outstream on P1: no video size is chosen for home_P. Choose one in Formats before Generate.'}]);
});
// F2: the confirmation names the Outstream position and the page-type map that needs a video size before Generate.
const VIDEO_ROWS={multi:[{minViewPort:[0,0],sizes:[[300,250],[400,300]]}],banner:[{minViewPort:[0,0],sizes:[[728,90]]}],single:[{minViewPort:[0,0],sizes:[[320,180],[728,90]]}]};
for(const [kind,rows] of Object.entries(VIDEO_ROWS))test(`F2: renaming a ${kind} map into a page-type family of an Outstream position ${kind==='single'?'needs no video-size line':'adds a video-size line'} to the confirmation`,async()=>{
 const f=await pageSetup({video:true});f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('foo',?,'foo',?)").run(site,JSON.stringify(rows));const before=saved(f);
 let {response,data}=await f.json('/size-maps/foo','PATCH',{name:'sport_P',map:rows});
 assert.equal(response.status,409);assert.deepEqual(data.details.confirmation.changes.map(row=>row.message),['Page type sport: P1–P3 will use sport_P instead of P.']);assert.deepEqual(saved(f),before);
 const expected={multi:'Outstream on P1: no video size is chosen for sport_P. Choose one in Formats before Generate.',banner:'Outstream on P1: sport_P has no supported video size. Add a video size to that map before Generate.'}[kind];
 assert.deepEqual(data.details.confirmation.videoSizes,expected?[{code:'P1',map:'sport_P',message:expected}]:[],'only P1 is Outstream; P2 and P3 are not named');
 if(expected)assert(data.error.endsWith(`will use sport_P instead of P. ${expected} Reload size maps to review and confirm this change.`),data.error);
 ({response,data}=await f.json('/size-maps/foo','PATCH',{name:'sport_P',map:rows,confirmPageTypeChanges:data.details.confirmation.token}));assert.equal(response.status,200,JSON.stringify(data));
 // The line says exactly what the Formats review (and Generate) then asks for.
 const review=await reviewOf(f);
 if(kind==='multi')assert.deepEqual(review,[{code:'P1',message:'P1: sport_P, minimum width 0px: choose one of the available video sizes in Formats.'}]);
 else if(kind==='banner')assert.match(review[0].message,/^P1: sport_P, minimum width 0px has no supported video size/);
 else assert.deepEqual(review,[]);
});
test('F2: a page-type rename that carries its saved video size, and a delete that falls back to the base, add no video-size line',async()=>{
 const f=await pageSetup({video:true});
 let {response,data}=await f.json('/size-maps/np-map','PATCH',{name:'home_P',map:NP});
 assert.equal(response.status,409);assert.deepEqual(data.details.confirmation.videoSizes,[],'naslovna_P@768x0 moves to home_P@768x0');
 ({response,data}=await f.json('/size-maps/vs-map','DELETE'));assert.equal(response.status,409);assert.deepEqual(data.details.confirmation.videoSizes,[]);
 // A breakpoint that already needed a choice before the change (Formats review already names P1) is not reported as new.
 const c=f.readConfig();delete c.runtimeControls.outstream.units.P1.playerSizes['naslovna_P@768x0'];f.writeConfig(c);
 assert.deepEqual((await reviewOf(f)).map(row=>row.message),['P1: naslovna_P, minimum width 768px: choose one of the available video sizes in Formats.']);
 ({response,data}=await f.json('/size-maps/np-map','PATCH',{name:'home_P',map:NP}));assert.equal(response.status,409);assert.deepEqual(data.details.confirmation.videoSizes,[]);
});
// F4: a confirmation token covers one operation on one map with one target name.
test('F4: a token issued for a delete never confirms a rename of the same map with the same impact, and the reverse',async()=>{
 const f=await pageSetup();const before=saved(f);
 const removal=(await f.json('/size-maps/np-map','DELETE')).data.details.confirmation;
 let {response,data}=await f.json('/size-maps/np-map','PATCH',{name:'Naslovna_X',map:NP});
 assert.equal(response.status,409);assert.deepEqual(data.details.confirmation.changes,removal.changes,'same page-type impact as the delete');assert.notEqual(data.details.confirmation.token,removal.token);
 ({response,data}=await f.json('/size-maps/np-map','PATCH',{name:'Naslovna_X',map:NP,confirmPageTypeChanges:removal.token}));
 assert.equal(response.status,409);assert.match(data.error,/Reload size maps to review and confirm this change\.$/);assert.deepEqual(saved(f),before);
 const rename=data.details.confirmation.token;
 ({response,data}=await f.json('/size-maps/np-map','DELETE',{confirmPageTypeChanges:rename}));
 assert.equal(response.status,409);assert.match(data.error,/Reload size maps to review and confirm this change\.$/);assert.deepEqual(saved(f),before);
 ({response,data}=await f.json('/size-maps/np-map','PATCH',{name:'Naslovna_X',map:NP,confirmPageTypeChanges:rename}));assert.equal(response.status,200,JSON.stringify(data));assert(names(f).includes('Naslovna_X'));
});
test('F4: a token covers its target name and its map; another name or a recreated map with the old name is refused',async()=>{
 const f=await pageSetup();let before=saved(f);
 const toA=(await f.json('/size-maps/np-map','PATCH',{name:'Aaa',map:NP})).data.details.confirmation;
 let {response,data}=await f.json('/size-maps/np-map','PATCH',{name:'Bbb',map:NP,confirmPageTypeChanges:toA.token});
 assert.equal(response.status,409);assert.deepEqual(data.details.confirmation.changes,toA.changes);assert.notEqual(data.details.confirmation.token,toA.token);assert.deepEqual(saved(f),before);
 const vs=(await f.json('/size-maps/vs-map','DELETE')).data.details.confirmation;
 assert.equal((await f.json('/size-maps/vs-map','DELETE',{confirmPageTypeChanges:vs.token})).response.status,200);assert(!names(f).includes('vesti_sport_P'));
 f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('vs-map-2',?,'vesti_sport_P',?)").run(site,JSON.stringify(NP));before=saved(f);
 ({response,data}=await f.json('/size-maps/vs-map-2','DELETE',{confirmPageTypeChanges:vs.token}));
 assert.equal(response.status,409,'the token of the deleted map never deletes the new map with its name');assert.match(data.error,/Reload size maps to review and confirm this change\.$/);assert.deepEqual(saved(f),before);
 assert.deepEqual(data.details.confirmation.changes.map(row=>row.message),vs.changes.map(row=>row.message));
});
// F7: the renamed map frees its own name for its page-type map.
test('F7: renaming sport_Q to Q carries sport_sport_Q to sport_Q instead of refusing with the name being renamed',async()=>{
 const f=await setup();const A=[{minViewPort:[0,0],sizes:[[300,250],[300,600]]}],B=[{minViewPort:[0,0],sizes:[[320,100],[250,250]]}];
 for(const [id,name,rows] of [['sq','sport_Q',A],['ssq','sport_sport_Q',B]])f.sqlite.prepare('INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES(?,?,?,?)').run(id,site,name,JSON.stringify(rows));
 f.sqlite.prepare("UPDATE ad_units SET size_map_key='sport_Q' WHERE id='audit-unit'").run();
 assert.deepEqual((await refsOf(f,'sport_sport_Q')).map(row=>row.label),['Page type sport: P1 (via sport_Q)']);
 const {response,data}=await f.json('/size-maps/sq','PATCH',{name:'Q',map:A});assert.equal(response.status,200,JSON.stringify(data));
 assert.deepEqual(f.sqlite.prepare("SELECT id,name,map_json FROM size_maps WHERE id IN ('sq','ssq') ORDER BY id").all().map(row=>[row.id,row.name,JSON.parse(row.map_json)]),[['sq','Q',A],['ssq','sport_Q',B]]);
 assert.equal(f.sqlite.prepare("SELECT size_map_key FROM ad_units WHERE id='audit-unit'").get().size_map_key,'Q');
 assert.deepEqual((await refsOf(f,'sport_Q')).map(row=>row.label),['Page type sport: P1 (via Q)'],'page type sport keeps the same sizes');
 assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT details_json FROM audit_log').get().details_json).pageTypeMaps,[['sport_sport_Q','sport_Q']]);
 // A real collision is still refused and names the existing map.
 f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('r',?,'R',?)").run(site,JSON.stringify(A));const kept=saved(f);
 const taken=await f.json('/size-maps/sq','PATCH',{name:'R',map:A});assert.equal(taken.response.status,409);assert.equal(taken.data.error,'Size map "R" already exists on this site.');assert.deepEqual(saved(f),kept);
});

function takeOverSetup(){
 return pageSetup().then(f=>{
  const one=[{minViewPort:[0,0],sizes:[[320,480]]}],other=[{minViewPort:[0,0],sizes:[[300,250]]}];
  for(const [id,name,rows] of [['t','T',one],['nx','naslovna_X',other],['foo','foo',other]])f.sqlite.prepare('INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES(?,?,?,?)').run(id,site,name,JSON.stringify(rows));
  f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,sort_order) VALUES('unit-TO',?,'TO','BTF','T',9)").run(site);
  const c=f.readConfig();c.runtimeControls={...c.runtimeControls,adPositions:{TO:{}}};f.writeConfig(c);
  return f;
 });
}
test('renaming a TakeOver map into a page-type family with different sizes is refused with the Generate guard message',async()=>{
 const f=await takeOverSetup();const before=saved(f);
 let {response,data}=await f.json('/size-maps/t','PATCH',{name:'X',map:[{minViewPort:[0,0],sizes:[[320,480]]}]});
 assert.equal(response.status,409);assert.match(data.error,/^Renaming T to X would make naslovna_X a page-type map of TakeOver position TO \(size map X\) with different sizes\. This script version does not support TakeOver maps by page type\. Your maps are kept; this requires a future script version, or an explicit change to Standard display\.$/);
 assert.deepEqual(saved(f),before);
 ({response,data}=await f.json('/size-maps/foo','PATCH',{name:'home_T',map:[{minViewPort:[0,0],sizes:[[300,250]]}]}));
 assert.equal(response.status,409);assert.match(data.error,/would make home_T a page-type map of TakeOver position TO/);assert.deepEqual(saved(f),before);
 f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('nt',?,'naslovna_T',?)").run(site,JSON.stringify([{minViewPort:[0,0],sizes:[[320,480]]}]));
 ({response,data}=await f.json('/size-maps/t','PATCH',{name:'Y',map:[{minViewPort:[0,0],sizes:[[320,480]]}]}));
 assert.equal(response.status,200,JSON.stringify(data));assert(names(f).includes('naslovna_Y'),'equal-size TakeOver page-type maps move with the base');
 assert.equal(f.sqlite.prepare("SELECT size_map_key FROM ad_units WHERE code='TO'").get().size_map_key,'Y');
});

test('F3 (was R4.7): a stale ad-unit form saved after a cascade rename is refused, so Generate keeps working',async()=>{
 const f=await pageSetup();let state=(await f.json('/builtin-site-settings')).data;const runtime=state.runtimes.find(row=>row.version==='3.21.1');
 assert.equal((await f.http('/builtin-site-settings','POST',{action:'setup',revision:state.revision,runtime:runtime.pin,allowPreview:false,enablePrebid:false})).status,200);
 const p2=(await f.json('/ad-units')).data.adUnits.find(unit=>unit.code==='P2');
 assert.equal((await f.http('/size-maps/p-map','PATCH',{name:'X',map:P})).status,200);
 const {response,data}=await f.json('/ad-units/'+p2.id,'PATCH',{code:p2.code,type:p2.type,mediaType:p2.mediaType,enabled:p2.enabled,sortOrder:p2.sortOrder,notes:'edited',sizeMapKey:p2.sizeMapKey});
 assert.equal(response.status,409);assert.equal(data.error,'Size map "P" does not exist on this site, so nothing was saved. Reload ad units and choose a current size map.');
 assert.deepEqual({...f.sqlite.prepare("SELECT size_map_key,notes FROM ad_units WHERE code='P2'").get()},{size_map_key:'X',notes:null});
 assert.deepEqual((await refsOf(f,'naslovna_X')).map(row=>row.label),['Page type naslovna: P1–P3 (via X)']);
 state=(await f.json('/builtin-site-settings')).data;const bundle=await f.http('/builtin-site-settings','POST',{action:'bundle',revision:state.revision,acknowledge:true});
 assert.equal(bundle.status,200,await bundle.clone().text());
});
test('DELETE reads its optional confirmation body only when it is JSON; an empty JSON body counts as none',async()=>{
 const f=await pageSetup();const before=saved(f);
 const remove=body=>f.http('/size-maps/np-map','DELETE',body);
 const raw=text=>worker.fetch(new Request(origin+base+'/size-maps/np-map',{method:'DELETE',headers:{origin,cookie:f.cookie,'content-type':'application/json'},body:text}),f.env,{waitUntil(){},passThroughOnException(){}});
 let response=await raw('');assert.equal(response.status,409);assert((await response.json()).details.confirmation.token);
 response=await raw('{not json');assert.equal(response.status,400);assert.equal((await response.json()).error,'Invalid JSON body.');
 assert.deepEqual(saved(f),before);
 const token=(await (await remove()).json()).details.confirmation.token;
 assert.equal((await remove({confirmPageTypeChanges:token})).status,200);
});

// F3: an ad-unit write stores only size map names that are saved when its batch commits.
const unitRow=(f,code)=>f.sqlite.prepare('SELECT * FROM ad_units WHERE code=?').get(code)??null;
const siteUpdatedAt=f=>f.sqlite.prepare('SELECT updated_at FROM publishers WHERE id=?').get(site).updated_at;
const notSaved=name=>`Size map "${name}" does not exist on this site, so nothing was saved. Reload ad units and choose a current size map.`;
const staleForm=(unit,sizeMapKey)=>({code:unit.code,type:unit.type,mediaType:unit.media_type,enabled:Boolean(unit.enabled),sortOrder:unit.sort_order,notes:'stale form',sizeMapKey});
const unitsCsv=rows=>'code,type,mediaType,sizeMapKey,enabled,sortOrder\n'+rows.map(([code,key])=>[code,'BTF','banner',key,'true','1'].join(',')).join('\n');
// Runs `other` (another tab) just before the first batch that writes an ad unit, as D1 would order them.
function beforeUnitBatch(f,other){
 const original=f.env.DB.batch;const result={};
 f.env.DB.batch=async items=>{
  if(items.some(item=>/(INSERT INTO|UPDATE) ad_units/.test(item.sql))){f.env.DB.batch=original;result.other=await other();result.concurrent=saved(f);}
  return original(items);
 };
 return result;
}

test('F3: ad-unit create and update store saved, trimmed or empty keys and refuse any other name, case variants included',async()=>{
 const f=await setup();
 const create=(code,sizeMapKey)=>f.json('/ad-units','POST',{code,type:'BTF',mediaType:'banner',enabled:true,sortOrder:1,...(sizeMapKey===undefined?{}:{sizeMapKey})});
 for(const [code,key,stored] of [['C1','home','home'],['C2','  home  ','home'],['C3','',null],['C4','   ',null],['C5',null,null],['C6',undefined,null]]){
  const {response,data}=await create(code,key);assert.equal(response.status,201,JSON.stringify(data));assert.equal(unitRow(f,code).size_map_key,stored,code);
 }
 let before=saved(f);
 for(const [code,key,name] of [['C7','Home','Home'],['C8','HOME','HOME'],['C9','missing','missing'],['C10',' home_ ','home_']]){
  const {response,data}=await create(code,key);assert.equal(response.status,409,JSON.stringify(data));assert.equal(data.error,notSaved(name));
 }
 assert.deepEqual(saved(f),before,'a refused create writes no ad unit and no audit');
 const patch=body=>f.json('/ad-units/audit-unit','PATCH',body);
 for(const [body,stored] of [[{sizeMapKey:'home'},'home'],[{notes:'absent key keeps the map'},'home'],[{sizeMapKey:' display '},'display'],[{sizeMapKey:''},null],[{notes:'absent key keeps no map'},null],[{sizeMapKey:'display'},'display']]){
  const {response,data}=await patch(body);assert.equal(response.status,200,JSON.stringify(data));assert.equal(unitRow(f,'P1').size_map_key,stored,JSON.stringify(body));
 }
 before=saved(f);
 for(const name of ['Display','DISPLAY','display_v2','missing']){
  const {response,data}=await patch({notes:'refused',sizeMapKey:name});assert.equal(response.status,409,JSON.stringify(data));assert.equal(data.error,notSaved(name));
 }
 assert.deepEqual(saved(f),before,'a refused update keeps the row, its version and the audit log');
});

test('F3: an ad-unit form opened before a map rename or delete cannot save the old name back',async()=>{
 const f=await setup();const p1=unitRow(f,'P1');
 assert.equal((await f.http('/size-maps/audit-map','PATCH',{name:'renamed',map})).status,200);assert.equal(unitRow(f,'P1').size_map_key,'renamed');
 assert.equal((await f.http('/size-maps/home-map','DELETE')).status,200);
 const before=saved(f);
 for(const [name,request] of [['display',()=>f.json('/ad-units/audit-unit','PATCH',staleForm(p1,'display'))],['home',()=>f.json('/ad-units/audit-unit','PATCH',staleForm(p1,'home'))],
  ['display',()=>f.json('/ad-units','POST',{code:'P9',type:'BTF',sizeMapKey:'display'})]]){
  const {response,data}=await request();assert.equal(response.status,409,JSON.stringify(data));assert.equal(data.error,notSaved(name));
 }
 assert.deepEqual(saved(f),before);
 // Choosing the current map in the same form saves, and the listing names P1 under it.
 const {response,data}=await f.json('/ad-units/audit-unit','PATCH',staleForm(p1,'renamed'));assert.equal(response.status,200,JSON.stringify(data));
 assert.deepEqual([unitRow(f,'P1').size_map_key,unitRow(f,'P1').notes],['renamed','stale form']);
 assert.deepEqual((await refsOf(f,'renamed')).map(row=>row.label),['P1']);
});

for(const [step,action] of [['create','rename'],['create','delete'],['update','rename'],['update','delete'],['duplicate','rename'],['duplicate','delete']])test(`F3: an ad-unit ${step} racing a map ${action} writes nothing and names the map`,async()=>{
 const f=await setup();
 // The unused map "home": the other tab's rename or delete touches no ad-unit row, so only the map gate can refuse.
 if(step==='duplicate')f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key) VALUES('unit-P2',?,'P2','BTF','home')").run(site);
 // The copy's source P2 uses "home", and HTTP refuses to delete a map in use: that writer removes only the map row.
 const race=beforeUnitBatch(f,async()=>action==='rename'?f.http('/size-maps/home-map','PATCH',{name:'renamed',map})
  :step==='duplicate'?(f.sqlite.prepare("DELETE FROM size_maps WHERE id='home-map'").run(),{status:200}):f.http('/size-maps/home-map','DELETE'));
 const {response,data}=step==='create'?await f.json('/ad-units','POST',{code:'P9',type:'BTF',sizeMapKey:'home'})
  :step==='update'?await f.json('/ad-units/audit-unit','PATCH',{notes:'raced',sizeMapKey:'home'})
  :await f.json('/ad-units/unit-P2/duplicate','POST',{code:'P9'});
 assert.equal(race.other?.status,200,'the other tab ran first');
 assert.equal(response.status,409,JSON.stringify(data));
 assert.equal(data.error,step==='duplicate'?'Size map "home" does not exist on this site, so nothing was copied. Reload ad units, or copy without the size-map reference.':notSaved('home'));
 assert.deepEqual(saved(f),race.concurrent,'only the other tab change is saved');
});

test('F3: a refused ad-unit save still explains other concurrent changes; an earlier missing key is kept, never copied',async()=>{
 const f=await setup();
 const race=beforeUnitBatch(f,async()=>{f.sqlite.prepare("UPDATE ad_units SET updated_at='2000-01-01T00:00:00.000Z' WHERE id='audit-unit'").run();return {status:200};});
 const {response,data}=await f.json('/ad-units/audit-unit','PATCH',{notes:'raced',sizeMapKey:'home'});
 assert.equal(response.status,409);assert.equal(data.error,'Site settings changed. Reload before editing this ad unit.');assert.deepEqual(saved(f),race.concurrent);
 // A unit saved earlier with a missing map (before this check) keeps that key on other edits; another missing name or a copy of it is refused.
 f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key) VALUES('unit-P2',?,'P2','BTF','gone')").run(site);
 let result=await f.json('/ad-units/unit-P2','PATCH',{notes:'absent key'});assert.equal(result.response.status,200,JSON.stringify(result.data));
 result=await f.json('/ad-units/unit-P2','PATCH',{notes:'unchanged key',sizeMapKey:' gone '});assert.equal(result.response.status,200,JSON.stringify(result.data));
 assert.deepEqual([unitRow(f,'P2').size_map_key,unitRow(f,'P2').notes],['gone','unchanged key']);
 result=await f.json('/ad-units/unit-P2','PATCH',{notes:'refused',sizeMapKey:'Gone'});assert.equal(result.response.status,409);assert.equal(result.data.error,notSaved('Gone'));
 result=await f.json('/ad-units/unit-P2/duplicate','POST',{code:'P3'});assert.equal(result.response.status,409);
 assert.equal(result.data.error,'Size map "gone" does not exist on this site, so nothing was copied. Reload ad units, or copy without the size-map reference.');assert.equal(unitRow(f,'P3'),null);
 result=await f.json('/ad-units/unit-P2/duplicate','POST',{code:'P3',copySizeMapReference:false});assert.equal(result.response.status,201,JSON.stringify(result.data));assert.equal(unitRow(f,'P3').size_map_key,null);
 result=await f.json('/ad-units/unit-P2','PATCH',{notes:'fixed',sizeMapKey:'home'});assert.equal(result.response.status,200);assert.equal(unitRow(f,'P2').size_map_key,'home');
});

test('F3: the CSV ad-unit preview names each missing map on its row and apply refuses the whole file',async()=>{
 const f=await setup();
 assert.equal((await f.http('/size-maps/audit-map','PATCH',{name:'renamed',map})).status,200);
 const rows=[['P1','home'],['P2',' renamed '],['P3',''],['P4','Home'],['P5','display'],['P6','missing']];
 const missing=name=>[`Size map "${name}" does not exist on this site. Import or create it first, or use a current size map name.`];
 const before=saved(f),stamp=siteUpdatedAt(f);
 let {response,data}=await f.json('/imports/preview','POST',{kind:'ad-units',csv:unitsCsv(rows)});
 assert.equal(response.status,200);assert.equal(data.preview.errorCount,3);
 assert.deepEqual(data.preview.rows.map(row=>[row.key,row.status,row.errors]),[['P1','update',[]],['P2','create',[]],['P3','create',[]],['P4','error',missing('Home')],['P5','error',missing('display')],['P6','error',missing('missing')]]);
 ({response,data}=await f.json('/imports/apply','POST',{kind:'ad-units',csv:unitsCsv(rows)}));
 assert.equal(response.status,422);assert.equal(data.error,'CSV contains validation errors. Preview and fix the failing rows first.');assert.equal(data.details.errorCount,3);
 assert.deepEqual(saved(f),before);assert.equal(siteUpdatedAt(f),stamp);
 ({response,data}=await f.json('/imports/apply','POST',{kind:'ad-units',csv:unitsCsv(rows.slice(0,3))}));assert.equal(response.status,200,JSON.stringify(data));
 assert.deepEqual(['P1','P2','P3'].map(code=>unitRow(f,code).size_map_key),['home','renamed',null]);
});

for(const action of ['rename','delete'])test(`F3: a CSV ad-unit apply racing a map ${action} writes no row, no audit and names the map`,async()=>{
 const f=await setup();const stamp=siteUpdatedAt(f);
 const race=beforeUnitBatch(f,()=>action==='rename'?f.http('/size-maps/home-map','PATCH',{name:'renamed',map}):f.http('/size-maps/home-map','DELETE'));
 const {response,data}=await f.json('/imports/apply','POST',{kind:'ad-units',csv:unitsCsv([['P1','display'],['P2','home'],['P3','']])});
 assert.equal(race.other?.status,200);assert.equal(response.status,409,JSON.stringify(data));
 assert.equal(data.error,'Size map "home" does not exist on this site, so nothing was imported. Preview the CSV again and use a current size map name.');
 assert.deepEqual(saved(f),race.concurrent);assert.equal(siteUpdatedAt(f),stamp);
 // Without a map name the import keeps its ungated statements.
 const ok=await f.json('/imports/apply','POST',{kind:'ad-units',csv:unitsCsv([['P3','']])});assert.equal(ok.response.status,200,JSON.stringify(ok.data));assert.equal(unitRow(f,'P3').size_map_key,null);
});
