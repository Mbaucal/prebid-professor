import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {createUnitRule,updateUnitRule,deleteUnitRule,duplicateUnitRule,listUnitRules} from '../../worker/unit-rules.ts';
import {createPublisher} from '../../worker/publishers.ts';
import {defaultUserIdSettings,initializeMissingUserSync,getUserIdConfig,updateUserIdConfig} from '../../worker/user-id-config.ts';
import {updatePrebidMode} from '../../worker/prebid-mode.ts';
import {previewInput} from '../../worker/runtime/preview-snapshot.mjs';
import {previewInput as catalogPreviewInput,runtimeCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';
import {readPreviewSnapshot} from '../../worker/runtime/builtin-preview-service.mjs';
import {siteSetupState} from '../../worker/site-runtime/setup-state.mjs';
import {listAdvancedRules,updateAdvancedRule} from '../../worker/advanced-rules.ts';
import {generatedIntervals as compiledIntervals} from '../support/generated-refresh.mjs';
import {baselineFor,requestBody,withEdit} from '../../src/refresh-form.ts';
const request=(body,method='POST')=>new Request('https://test.invalid/api/settings',{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const fixtures=[];const setup=options=>{const f=adminAuditStore(options);fixtures.push(f);return f;};test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
const refresh=n=>({enabled:true,minSeconds:n,minViewPct:50,requirePreviousViewable:false,checkEveryMs:5000});
function seedRule(f,key,rule,advanced){f.sqlite.prepare('INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES(?,?,?,?)').run(key,'audit-site',key,JSON.stringify(rule));const c=f.readConfig();c.unitRules??={};c.unitRules[key]=rule;c.advancedUnitRules??={};c.advancedUnitRules[key]=advanced;f.writeConfig(c);}
test('Unit rules save updates the fixed Refresh mirror and generated timeout atomically',async()=>{
 const f=setup();seedRule(f,'__DEFAULT__',{timeout:2500,refresh:refresh(30)},{timeout:2500,cmpTimeout:1500,refresh:{...refresh(30),schedule:{mode:'fixed',fixedSeconds:30,firstSeconds:30,nextSeconds:30}}});
 const rule={timeout:1200,refresh:{...refresh(60),enabled:false}};
 const r=await updateUnitRule(request({rule},'PATCH'),f.env,'audit-site','__DEFAULT__');assert.equal(r.status,200,await r.clone().text());
 const c=f.readConfig();assert.equal(c.advancedUnitRules.__DEFAULT__.timeout,1200);assert.equal(c.advancedUnitRules.__DEFAULT__.cmpTimeout,1500);assert.equal(c.advancedUnitRules.__DEFAULT__.refresh.enabled,false);assert.equal(c.advancedUnitRules.__DEFAULT__.refresh.schedule.fixedSeconds,60);assert.deepEqual(c.unitRules.__DEFAULT__,rule);
 assert.equal(f.log.batches,1);const input=previewInput(await readPreviewSnapshot(f.env.DB,'audit-site'),'20261024_120000');assert.equal(input.core.defaultTimeout,1200);assert.equal(input.core.globalRefresh.enabled,false);assert.equal(input.core.globalRefresh.schedule.fixedSeconds,60);
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM audit_log WHERE action='unit_rule.updated'").get().n,1);
});
test('removing override deletes Refresh ownership while preserving display lazy settings',async()=>{
 const f=setup();const lazy={enabled:true,fetchMarginPx:500,renderMarginPx:100};seedRule(f,'P1',{timeout:2500,refresh:refresh(15)},{timeout:2500,cmpTimeout:1500,refresh:{...refresh(15),schedule:{mode:'fixed',fixedSeconds:15}},lazy});
 const r=await deleteUnitRule(request({},'DELETE'),f.env,'audit-site','P1');assert.equal(r.status,200);assert.deepEqual(f.readConfig().advancedUnitRules.P1,{lazy});assert.equal(f.readConfig().unitRules.P1,undefined);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM unit_rules WHERE rule_key='P1' AND publisher_id='audit-site'").get().n,0);
 const input=catalogPreviewInput(await readPreviewSnapshot(f.env.DB,'audit-site'),runtimeCatalog.find(r=>r.version==='3.16.0'),'20261024_120000');assert.equal(input.core.adUnitRules.P1.timeout,undefined);assert.deepEqual(input.lazyRules.P1,lazy);
});
test('removing inheritance overrides cannot leave stale advanced timeout or refresh values',async()=>{
 const f=setup();seedRule(f,'P1',{timeout:2500,refresh:refresh(15)},{timeout:2500,refresh:{...refresh(15),schedule:{mode:'fixed',fixedSeconds:15}}});
 const r=await updateUnitRule(request({rule:{}},'PATCH'),f.env,'audit-site','P1');assert.equal(r.status,200);assert.equal(f.readConfig().advancedUnitRules.P1,undefined);assert.deepEqual(f.readConfig().unitRules.P1,{});
});
test('sequence refresh changes are rejected without touching data; timeout-only update retains schedule',async()=>{
 const f=setup();const schedule={mode:'sequence',firstSeconds:10,nextSeconds:20};seedRule(f,'P1',{timeout:2500,refresh:refresh(10)},{timeout:2500,refresh:{...refresh(10),schedule}});const before=f.readConfig();
 const r=await updateUnitRule(request({rule:{timeout:1200,refresh:refresh(60)}},'PATCH'),f.env,'audit-site','P1');assert.equal(r.status,409);assert.match(await r.text(),/Refresh schedules/);assert.deepEqual(f.readConfig(),before);assert.equal(f.log.batches,0);
 assert.equal((await updateUnitRule(request({rule:{timeout:1200,refresh:refresh(10)}},'PATCH'),f.env,'audit-site','P1')).status,200);assert.deepEqual(f.readConfig().advancedUnitRules.P1.refresh.schedule,schedule);assert.equal(f.readConfig().advancedUnitRules.P1.timeout,1200);
});
test('duplicating a rule preserves its actual advanced schedule without copying position lazy',async()=>{
 const f=setup();const schedule={mode:'percentage',firstSeconds:30,growthPercent:20,maxSeconds:120};seedRule(f,'__DEFAULT__',{timeout:2000,refresh:refresh(30)},{timeout:2000,cmpTimeout:1500,refresh:{...refresh(30),schedule},lazy:{enabled:true}});
 const r=await duplicateUnitRule(request({ruleKey:'P1'}),f.env,'audit-site','__DEFAULT__');assert.equal(r.status,201);assert.deepEqual(f.readConfig().advancedUnitRules.P1,{timeout:2000,cmpTimeout:1500,refresh:{...refresh(30),schedule}});
});
test('stale concurrent config causes no unit-rule or audit write',async()=>{
 const f=setup();seedRule(f,'P1',{timeout:2500},{});const original=f.env.DB.batch;f.env.DB.batch=async items=>{const c=f.readConfig();c.concurrent=true;f.writeConfig(c);return original(items);};
 const r=await updateUnitRule(request({rule:{timeout:1200}},'PATCH'),f.env,'audit-site','P1');assert.equal(r.status,409);assert.equal(JSON.parse(f.sqlite.prepare("SELECT rule_json FROM unit_rules WHERE publisher_id='audit-site' AND rule_key='P1'").get().rule_json).timeout,2500);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM audit_log WHERE publisher_id='audit-site'").get().n,0);assert.equal(f.readConfig().concurrent,true);
});
test('new sites store the same sync defaults as the editable User ID panel',async()=>{
 const f=setup();const r=await createPublisher(request({id:'new-audit-site',name:'New audit',domain:'new-audit.invalid',gamPath:'/123/new/'}),f.env);assert.equal(r.status,201,await r.clone().text());const c=JSON.parse(f.sqlite.prepare("SELECT config_json FROM publisher_configs WHERE publisher_id='new-audit-site'").get().config_json);const defaults=defaultUserIdSettings();assert.deepEqual(c.userSync,defaults.userSync);assert.deepEqual(c.userIdConfig,defaults.userIdConfig);assert.equal(c.userSync.syncEnabled,true);assert.equal(c.userSync.syncsPerBidder,5);assert.equal(c.userSync.syncDelay,3000);assert.equal(c.userSync.auctionDelay,150);assert.deepEqual(c.userSync.userIds,[]);
 const get=await getUserIdConfig(f.env,'new-audit-site');const payload=await get.json();assert.equal(payload.saved,true);assert.deepEqual(payload.userSyncPreview,c.userSync);
});
test('missing old sync config warns on read without backfill; explicit save removes warning',async()=>{
 const f=setup();const before=f.readConfig(),response=await getUserIdConfig(f.env,'audit-site'),body=await response.json();assert.equal(body.saved,false);assert(body.warnings.some(s=>s.includes('have not been saved')));assert.deepEqual(f.readConfig(),before);assert.equal(f.log.batches,0);
 const saved=await readPreviewSnapshot(f.env.DB,'audit-site',{includePrebid:true});assert.match(siteSetupState(saved).userSyncWarning,/cookie sync off/);
 const r=await updateUserIdConfig(request(body.userIdConfig,'PUT'),f.env,'audit-site');assert.equal(r.status,200);assert.equal((await getUserIdConfig(f.env,'audit-site').then(r=>r.json())).saved,true);
});
test('explicit mode enable initializes absent sync but preserves an intentional disabled sync',async()=>{
 for(const explicitOff of [false,true]){const f=setup();const c=f.readConfig();c.enablePrebid=false;if(explicitOff)c.userSync={syncEnabled:false,userIds:[],privateSetting:'retained'};f.writeConfig(c);const r=await updatePrebidMode(request({enabled:true},'PUT'),f.env,'audit-site');assert.equal(r.status,200,await r.clone().text());const next=f.readConfig();if(explicitOff)assert.deepEqual(next.userSync,c.userSync);else assert.deepEqual(next.userSync,defaultUserIdSettings().userSync);}
 const intentional={userSync:{syncEnabled:false,userIds:[]},userIdConfig:{enabled:false,modules:[]}};assert.equal(initializeMissingUserSync(intentional),intentional);
});

// R2-03: an inherited Refresh schedule must not replace a Unit rules interval in generated scripts.
const schedules={fixed:{mode:'fixed',fixedSeconds:30},firstThenFixed:{mode:'firstThenFixed',firstSeconds:20,nextSeconds:45},percentage:{mode:'percentage',firstSeconds:20,growthPercent:50,maxSeconds:120},sequence:{mode:'sequence',sequenceSeconds:[20,40,80]}};
const scripts=['3.16.0','3.16.1'];
function addUnit(f,code,type){f.sqlite.prepare('INSERT INTO ad_units(id,publisher_id,code,type,size_map_key) VALUES(?,?,?,?,?)').run('unit-'+code,'audit-site',code,type,'display');}
async function saveSchedule(f,key,schedule){const r=await updateAdvancedRule(request({refresh:{enabled:true,schedule}},'PUT'),f.env,'audit-site',key);assert.equal(r.status,200,await r.clone().text());return r.json();}
async function saveInterval(f,key,minSeconds){const r=await createUnitRule(request({ruleKey:key,rule:{refresh:{enabled:true,minSeconds}}}),f.env,'audit-site');assert.equal(r.status,201,await r.clone().text());return (await r.json()).unitRule;}
/** Intervals from the real generated scheduler of each script version, after 0..3 refreshes. */
const generatedIntervals=(f,codes)=>compiledIntervals(f,codes,scripts);
const every=(values,seconds)=>values.every(v=>v===seconds);
test('a new Unit rules interval is used instead of an inherited Refresh schedule in every mode and script',async()=>{
 for(const [mode,schedule] of Object.entries(schedules))for(const [parent,key,code,type] of [['__DEFAULT__','P1','P1','BTF'],['__BTF__','P1','P1','BTF'],['__ATF__','A1','A1','ATF'],['__DEFAULT__','__BTF__','P1','BTF']]){
  const f=setup({config:{enablePrebid:false}});addUnit(f,'A1','ATF');
  await saveSchedule(f,parent,schedule);const saved=await saveInterval(f,key,60);assert.equal(saved.rule.refresh.minSeconds,60);
  const c=f.readConfig();assert.deepEqual(c.advancedUnitRules[key].refresh.schedule,{mode:'fixed',fixedSeconds:60,firstSeconds:60,nextSeconds:60},`${mode} ${parent}->${key}`);assert.equal(c.advancedUnitRules[key].refresh.minSeconds,60);assert.equal(c.advancedUnitRules[key].timeout,undefined);
  assert.equal(c.advancedUnitRules[parent].refresh.schedule.mode,mode,'the parent schedule is unchanged');
  const result=await generatedIntervals(f,[code]);for(const version of scripts){assert(every(result[version+' '+code],60),`${mode} ${parent}->${key} ${version}: ${result[version+' '+code]}`);assert.deepEqual(result['summary '+version].warnings.filter(w=>w.includes('Unit rules is not used')),[]);}
  assert.equal(result['summary 3.16.1'].units.find(u=>u.code===code).label,'60s · 50%');
 }
});
// The "Create base rules" presets (UnitRulesPanel presetForKey); lazy is display-only and not part of refresh.
const preset={__DEFAULT__:{timeout:2500,refresh:refresh(30),conditionalMappings:[]},__ATF__:{timeout:2200,refresh:{...refresh(30),minViewPct:60},conditionalMappings:[]},__BTF__:{timeout:2500,refresh:refresh(30),conditionalMappings:[]}};
async function createBaseRules(f,extra={}){const kept=[];for(const key of ['__DEFAULT__','__ATF__','__BTF__']){if(f.sqlite.prepare('SELECT 1 FROM unit_rules WHERE rule_key=?').get(key))continue;const r=await createUnitRule(request({ruleKey:key,rule:preset[key],...extra}),f.env,'audit-site');assert.equal(r.status,201,await r.clone().text());kept.push(...(await r.json()).keptUnitRuleIntervals);}return kept;}
const ruleId=(f,key)=>f.sqlite.prepare('SELECT id FROM unit_rules WHERE rule_key=?').get(key).id;
async function editRule(f,key,rule){const r=await updateUnitRule(request({rule},'PATCH'),f.env,'audit-site',ruleId(f,key));assert.equal(r.status,200,await r.clone().text());return r.json();}
const intervalWarnings=summary=>summary.warnings.filter(w=>w.includes('Unit rules is not used'));
const advice='If the inherited schedule is intended, remove the refresh override from that rule in Unit rules. To use the saved interval, edit and save the rule in Unit rules, or set “Same every time” for it in Refresh schedules.';
test('Refresh schedules saved later keep chosen child intervals and name them; inheriting positions follow the schedule',async()=>{
 const f=setup({config:{enablePrebid:false}});addUnit(f,'A1','ATF');addUnit(f,'P2','BTF');
 await saveInterval(f,'__BTF__',45);await saveInterval(f,'P1',60);const before=f.readConfig();assert.equal(before.advancedUnitRules,undefined,'no schedule exists, so nothing is added');
 const saved=await saveSchedule(f,'__DEFAULT__',schedules.sequence);assert.deepEqual(saved.keptUnitRuleIntervals,['__BTF__','P1']);assert.deepEqual(saved.appliesToAdUnits,['A1']);
 const c=f.readConfig();assert.equal(c.advancedUnitRules.__BTF__.refresh.schedule.fixedSeconds,45);assert.equal(c.advancedUnitRules.P1.refresh.schedule.fixedSeconds,60);assert.equal(c.advancedUnitRules.P2,undefined);assert.equal(c.advancedUnitRules.A1,undefined);
 const audit=JSON.parse(f.sqlite.prepare("SELECT details_json FROM audit_log WHERE action='unit_rule.advanced_updated'").get().details_json);assert.deepEqual(audit.keptUnitRuleIntervals,['__BTF__','P1']);
 const result=await generatedIntervals(f,['P1','P2','A1']);
 for(const version of scripts){assert(every(result[version+' P1'],60));assert(every(result[version+' P2'],45));assert.deepEqual(result[version+' A1'],[20,40,80,80]);}
 // Editing the parent again only changes positions that inherit it.
 const again=await saveSchedule(f,'__DEFAULT__',{mode:'fixed',fixedSeconds:90});assert.deepEqual(again.keptUnitRuleIntervals,[]);const next=await generatedIntervals(f,['P1','P2','A1']);for(const version of scripts){assert(every(next[version+' P1'],60));assert(every(next[version+' P2'],45));assert(every(next[version+' A1'],90));}
});
test('base-rule presets follow a Default schedule saved later in Refresh schedules or Unit rules',async()=>{
 const f=setup({config:{enablePrebid:false}});addUnit(f,'Billboard','ATF');addUnit(f,'P2','BTF');const codes=['P1','Billboard','P2'];
 assert.deepEqual(await createBaseRules(f),[]);assert.equal(f.readConfig().advancedUnitRules,undefined);
 const saved=await saveSchedule(f,'__DEFAULT__',schedules.sequence);assert.deepEqual(saved.keptUnitRuleIntervals,[]);assert.deepEqual(saved.appliesToAdUnits,codes);
 assert.deepEqual(Object.keys(f.readConfig().advancedUnitRules),['__DEFAULT__'],'the 30s presets only repeated Default, so they are not pinned');
 let result=await generatedIntervals(f,codes);
 for(const version of scripts){for(const code of codes)assert.deepEqual(result[version+' '+code],[20,40,80,80],`${version} ${code}`);
  const summary=result['summary '+version];assert.deepEqual(intervalWarnings(summary),[],'presets that follow the site schedule are not a warning');
  assert.equal(summary.units.find(u=>u.code==='Billboard').detail,'Uses the inherited Default schedule (20s, 40s, 80s…); the 30s interval saved for ATF group in Unit rules is not used.');}
 // A site-wide change of the fixed interval applies to every position.
 await saveSchedule(f,'__DEFAULT__',schedules.fixed);const slower=await saveSchedule(f,'__DEFAULT__',{mode:'fixed',fixedSeconds:45});assert.deepEqual(slower.keptUnitRuleIntervals,[]);assert.deepEqual(slower.appliesToAdUnits,codes);
 result=await generatedIntervals(f,codes);for(const version of scripts)for(const code of codes)assert(every(result[version+' '+code],45),`${version} ${code} ${result[version+' '+code]}`);
 // The same change made on the Default rule in Unit rules.
 const edited=await editRule(f,'__DEFAULT__',{...preset.__DEFAULT__,refresh:refresh(60)});assert.deepEqual(edited.keptUnitRuleIntervals,[]);
 result=await generatedIntervals(f,codes);for(const version of scripts)for(const code of codes)assert(every(result[version+' '+code],60));
 assert.deepEqual(Object.keys(f.readConfig().advancedUnitRules),['__DEFAULT__']);
});
test('Create base rules keeps an earlier Refresh schedule; only an interval set in the editor is used over it',async()=>{
 const f=setup({config:{enablePrebid:false}});addUnit(f,'Billboard','ATF');
 await saveSchedule(f,'__DEFAULT__',schedules.sequence);
 assert.deepEqual(await createBaseRules(f,{followInheritedSchedule:true}),[]);assert.deepEqual(Object.keys(f.readConfig().advancedUnitRules),['__DEFAULT__']);
 let result=await generatedIntervals(f,['P1','Billboard']);for(const version of scripts){assert.deepEqual(result[version+' P1'],[20,40,80,80]);assert.deepEqual(result[version+' Billboard'],[20,40,80,80]);}
 // An unrelated edit of a group rule never retimes its positions.
 const timeoutOnly=await editRule(f,'__ATF__',{...preset.__ATF__,timeout:2000});assert.deepEqual(timeoutOnly.keptUnitRuleIntervals,[]);assert.equal(f.readConfig().advancedUnitRules.__ATF__,undefined);
 result=await generatedIntervals(f,['Billboard']);for(const version of scripts)assert.deepEqual(result[version+' Billboard'],[20,40,80,80]);
 // Changing the group interval is a choice: it is used and named.
 const changed=await editRule(f,'__ATF__',{...preset.__ATF__,refresh:{...preset.__ATF__.refresh,minSeconds:45}});assert.deepEqual(changed.keptUnitRuleIntervals,['__ATF__']);
 const audit=JSON.parse(f.sqlite.prepare("SELECT details_json FROM audit_log WHERE action='unit_rule.updated' ORDER BY rowid DESC LIMIT 1").get().details_json);assert.deepEqual(audit.keptUnitRuleIntervals,['__ATF__']);
 result=await generatedIntervals(f,['P1','Billboard']);for(const version of scripts){assert(every(result[version+' Billboard'],45));assert.deepEqual(result[version+' P1'],[20,40,80,80]);}
 // A group rule created in the editor under the schedule is used too.
 const g=setup({config:{enablePrebid:false}});await saveSchedule(g,'__DEFAULT__',schedules.sequence);
 const r=await createUnitRule(request({ruleKey:'__BTF__',rule:preset.__BTF__}),g.env,'audit-site');assert.equal(r.status,201);assert.deepEqual((await r.json()).keptUnitRuleIntervals,['__BTF__']);
 result=await generatedIntervals(g,['P1']);for(const version of scripts)assert(every(result[version+' P1'],30));
});
test('an exact interval equal to its parent keeps its value when the parent changes; an equal group interval follows the parent',async()=>{
 const f=setup({config:{enablePrebid:false}});addUnit(f,'P2','BTF');addUnit(f,'A1','ATF');
 await saveSchedule(f,'__DEFAULT__',schedules.fixed);await saveInterval(f,'P1',30);await saveInterval(f,'__ATF__',30);assert.equal(f.readConfig().advancedUnitRules.P1,undefined,'already consistent: generated rules stay byte-identical');assert.equal(f.readConfig().advancedUnitRules.__ATF__,undefined);
 const r=await editRule(f,'__DEFAULT__',{refresh:refresh(45)});assert.deepEqual(r.keptUnitRuleIntervals,['P1']);
 let c=f.readConfig();assert.equal(c.advancedUnitRules.__DEFAULT__.refresh.schedule.fixedSeconds,45);assert.equal(c.advancedUnitRules.P1.refresh.schedule.fixedSeconds,30);assert.equal(c.advancedUnitRules.__ATF__,undefined);
 let result=await generatedIntervals(f,['P1','P2','A1']);for(const version of scripts){assert(every(result[version+' P1'],30));assert(every(result[version+' P2'],45));assert(every(result[version+' A1'],45));}
 // A group interval set in the editor keeps exact children that matched it when it is deleted.
 await saveInterval(f,'__BTF__',50);await saveInterval(f,'P2',50);c=f.readConfig();assert.equal(c.advancedUnitRules.__BTF__.refresh.schedule.fixedSeconds,50);assert.equal(c.advancedUnitRules.P2,undefined);
 const group=ruleId(f,'__BTF__');const removed=await deleteUnitRule(request({},'DELETE'),f.env,'audit-site',group);assert.equal(removed.status,200);assert.deepEqual((await removed.json()).keptUnitRuleIntervals,['P2']);
 c=f.readConfig();assert.equal(c.advancedUnitRules.__BTF__,undefined);assert.equal(c.advancedUnitRules.P2.refresh.schedule.fixedSeconds,50);
 result=await generatedIntervals(f,['P1','P2']);for(const version of scripts){assert(every(result[version+' P1'],30));assert(every(result[version+' P2'],50));}
 // Deleting the exact rule returns the position to the inherited schedule, as Unit rules shows.
 assert.equal((await deleteUnitRule(request({},'DELETE'),f.env,'audit-site',ruleId(f,'P1'))).status,200);assert.equal(f.readConfig().advancedUnitRules.P1,undefined);
 result=await generatedIntervals(f,['P1']);for(const version of scripts)assert(every(result[version+' P1'],45));
});
test('update and copy apply the saved interval; Refresh-owned schedules and disabled refresh are untouched',async()=>{
 const f=setup({config:{enablePrebid:false}});addUnit(f,'A1','ATF');addUnit(f,'P2','BTF');
 await saveSchedule(f,'__DEFAULT__',schedules.sequence);const p1=await saveInterval(f,'P1',60);
 assert.equal((await updateUnitRule(request({rule:{timeout:1200,refresh:refresh(90)}},'PATCH'),f.env,'audit-site',p1.id)).status,200);
 assert.equal(f.readConfig().advancedUnitRules.P1.refresh.schedule.fixedSeconds,90);
 const copy=await duplicateUnitRule(request({ruleKey:'A1'}),f.env,'audit-site',p1.id);assert.equal(copy.status,201);
 assert.equal(f.readConfig().advancedUnitRules.A1.refresh.schedule.fixedSeconds,90);
 const p2=await createUnitRule(request({ruleKey:'P2',rule:{refresh:{...refresh(60),enabled:false}}}),f.env,'audit-site');assert.equal(p2.status,201);assert.equal(f.readConfig().advancedUnitRules.P2,undefined,'disabled refresh has no interval to keep');
 await saveSchedule(f,'P1',schedules.percentage);const owned=structuredClone(f.readConfig().advancedUnitRules.P1);
 assert.deepEqual((await saveSchedule(f,'__DEFAULT__',schedules.firstThenFixed)).keptUnitRuleIntervals,[]);assert.deepEqual(f.readConfig().advancedUnitRules.P1,owned);
 const result=await generatedIntervals(f,['P1','A1']);for(const version of scripts){assert.deepEqual(result[version+' P1'],[20,30,45,68]);assert(every(result[version+' A1'],90));}
});
test('Sticky uses the Unit rules interval in 3.16.0 and 3.16.1 under an inherited schedule',async()=>{
 const f=setup({config:{enablePrebid:false,runtimeControls:{sticky:{bottomAdUnitId:'Sticky'}}}});addUnit(f,'Sticky','ATF');
 await saveSchedule(f,'__DEFAULT__',schedules.fixed);await saveInterval(f,'Sticky',60);
 const result=await generatedIntervals(f,['Sticky']);for(const version of scripts){assert.equal(result['sticky '+version],60);assert(every(result[version+' Sticky'],60));}
});
test('existing exact-rule data that follows an inherited schedule is reported with the used value until the rule is saved again',async()=>{
 const f=setup({config:{enablePrebid:false}});addUnit(f,'A1','ATF');
 seedRule(f,'__DEFAULT__',{refresh:refresh(30)},{refresh:{...refresh(20),schedule:{mode:'firstThenFixed',fixedSeconds:30,firstSeconds:20,nextSeconds:45}}});seedRule(f,'P1',{refresh:refresh(60)},undefined);
 const c=f.readConfig();delete c.advancedUnitRules.P1;f.writeConfig(c);const before=JSON.stringify(f.readConfig());
 let result=await generatedIntervals(f,['P1']);for(const version of scripts){assert.deepEqual(result[version+' P1'],[20,45,45,45]);
  assert.deepEqual(intervalWarnings(result['summary '+version]),[`The refresh interval saved in Unit rules is not used for: P1 (60s; the script uses the inherited Default schedule: 20s, then 45s). ${advice}`]);
  const row=result['summary '+version].units.find(u=>u.code==='P1');assert.equal(row.label,'20s, then 45s · 50%');assert.equal(row.detail,'Uses the inherited Default schedule (20s, then 45s); the 60s interval saved for P1 in Unit rules is not used.');}
 assert.equal(JSON.stringify(f.readConfig()),before,'reading settings never writes');
 assert.deepEqual((await editRule(f,'P1',{refresh:refresh(60)})).keptUnitRuleIntervals,['P1']);
 result=await generatedIntervals(f,['P1']);for(const version of scripts){assert(every(result[version+' P1'],60));assert.deepEqual(intervalWarnings(result['summary '+version]),[]);}
});
test('a group interval that already followed the inherited schedule keeps following it until its interval is changed',async()=>{
 const f=setup({config:{enablePrebid:false}});
 seedRule(f,'__DEFAULT__',{refresh:refresh(20)},{refresh:{...refresh(20),schedule:{mode:'sequence',sequenceSeconds:[20,40,80]}}});seedRule(f,'__BTF__',{refresh:refresh(30)},undefined);
 const c=f.readConfig();delete c.advancedUnitRules.__BTF__;f.writeConfig(c);
 assert.deepEqual((await saveSchedule(f,'__DEFAULT__',{mode:'sequence',sequenceSeconds:[25,50]})).keptUnitRuleIntervals,[]);assert.equal(f.readConfig().advancedUnitRules.__BTF__,undefined);
 let result=await generatedIntervals(f,['P1']);for(const version of scripts){assert.deepEqual(result[version+' P1'],[25,50,50,50]);assert.deepEqual(intervalWarnings(result['summary '+version]),[]);
  assert.equal(result['summary '+version].units.find(u=>u.code==='P1').detail,'Uses the inherited Default schedule (25s, 50s…); the 30s interval saved for BTF group in Unit rules is not used.');}
 assert.deepEqual((await editRule(f,'__BTF__',{refresh:refresh(30)})).keptUnitRuleIntervals,[],'saving the same value is not a new choice');
 result=await generatedIntervals(f,['P1']);for(const version of scripts)assert.deepEqual(result[version+' P1'],[25,50,50,50]);
 assert.deepEqual((await editRule(f,'__BTF__',{refresh:refresh(40)})).keptUnitRuleIntervals,['__BTF__']);
 result=await generatedIntervals(f,['P1']);for(const version of scripts)assert(every(result[version+' P1'],40));
});
test('a Refresh schedules save that races a Unit rules save is refused with no partial write',async()=>{
 for(const injectAt of [1,2]){
  const f=setup({config:{enablePrebid:false}});const base=f.env.DB;let reads=0,created=null;
  const wrap=statement=>({...statement,bind:(...values)=>wrap(statement.bind(...values)),async all(){const result=await statement.all();if(/FROM unit_rules/.test(statement.sql)&&++reads===injectAt&&!created)created=await createUnitRule(request({ruleKey:'P1',rule:{refresh:refresh(60)}}),f.env,'audit-site');return result;}});
  const DB={...base,prepare:sql=>wrap(base.prepare(sql))};
  const r=await updateAdvancedRule(request({refresh:{enabled:true,schedule:schedules.fixed}},'PUT'),{...f.env,DB},'audit-site','__DEFAULT__');
  assert.equal(created.status,201);assert.equal(r.status,409,await r.clone().text());assert.match((await r.json()).error,/changed in another tab/);
  assert.equal(f.readConfig().advancedUnitRules?.__DEFAULT__,undefined,`${injectAt}: no Refresh schedule was written`);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM unit_rules WHERE rule_key='__DEFAULT__'").get().n,0,'nor its Unit rules mirror');
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM audit_log WHERE action='unit_rule.advanced_updated'").get().n,0);
  // Saving again after a reload keeps the interval the other save chose.
  assert.deepEqual((await saveSchedule(f,'__DEFAULT__',schedules.fixed)).keptUnitRuleIntervals,['P1']);
  const result=await generatedIntervals(f,['P1']);for(const version of scripts)assert(every(result[version+' P1'],60));
 }
});
// The Refresh schedules tab: the panel builds the form with src/refresh-form.ts from one
// GET /unit-rules-advanced read and Save PUTs requestBody(form, baseline); the real component is
// driven in scripts/verify-admin-audit-ui.py.
test('a kept interval saved unchanged in Refresh schedules keeps its Unit rules timeout and interval in 3.16.1 and 3.16.2',async()=>{
 const f=setup({config:{enablePrebid:false}});await saveSchedule(f,'__DEFAULT__',schedules.sequence);
 const created=await createUnitRule(request({ruleKey:'P1',rule:{timeout:1800,refresh:refresh(60)}}),f.env,'audit-site');assert.equal(created.status,201,await created.clone().text());
 assert.deepEqual((await created.json()).keptUnitRuleIntervals,['P1']);
 const row=()=>JSON.parse(f.sqlite.prepare("SELECT rule_json FROM unit_rules WHERE rule_key='P1'").get().rule_json),before=row();
 const cmp=async version=>catalogPreviewInput(await readPreviewSnapshot(f.env.DB,'audit-site'),runtimeCatalog.find(r=>r.version===version),'20261024_120000').core.maxCmpTimeout;
 const cmpBefore=[await cmp('3.16.1'),await cmp('3.16.2')];
 // The tab loads GET /unit-rules-advanced; then P1 is selected and saved unchanged.
 const {advancedRules,unitRuleRows}=await (await listAdvancedRules(f.env,'audit-site')).json();
 const baseline=baselineFor('P1','BTF',advancedRules,unitRuleRows),{form,rowId,updatedAt}=baseline;
 assert.equal(form.timeout,1800,'the form shows the timeout saved in Unit rules');assert.equal(form.mode,'fixed');assert.equal(form.fixedSeconds,60);assert.equal(form.minViewPct,50);
 assert.deepEqual(requestBody(form,baseline),{timeout:1800},'only the timeout P1 stores is sent; its unchanged refresh is not');
 const saved=await updateAdvancedRule(request({expectedUpdatedAt:updatedAt,expectedUnitRuleId:rowId,...requestBody(form,baseline)},'PUT'),f.env,'audit-site','P1');assert.equal(saved.status,200,await saved.clone().text());
 assert.deepEqual(row(),before,'the Unit rules row keeps timeout 1800, its interval and no CMP timeout');assert.equal(row().timeout,1800);assert.equal(Object.hasOwn(row(),'cmpTimeout'),false);
 assert.deepEqual([await cmp('3.16.1'),await cmp('3.16.2')],cmpBefore,'the generated CMP timeout is unchanged');
 const result=await compiledIntervals(f,['P1'],['3.16.1','3.16.2']);
 for(const version of ['3.16.1','3.16.2']){assert(every(result[version+' P1'],60),`${version}: ${result[version+' P1']}`);assert.equal(result['rules '+version].P1.timeout,1800);assert.deepEqual(intervalWarnings(result['summary '+version]),[]);}
});
// The Refresh tab for a scope, as AdvancedRefreshPanel runs it: one listing read, the form, the
// edits through the same helper the inputs use, and the PUT body.
async function refreshTab(f,key,edits={}){
 const {advancedRules,unitRuleRows}=await (await listAdvancedRules(f.env,'audit-site')).json();
 const type=f.sqlite.prepare("SELECT type FROM ad_units WHERE publisher_id='audit-site' AND code=?").get(key)?.type??null;
 const baseline=baselineFor(key,type,advancedRules,unitRuleRows);
 const form=Object.entries(edits).reduce((current,[field,value])=>withEdit(current,field,value),baseline.form);
 return {baseline,form,body:{expectedUpdatedAt:baseline.updatedAt,expectedUnitRuleId:baseline.rowId,...requestBody(form,baseline)}};
}
test('a group preset saved in Refresh schedules, unchanged or with a new timeout, keeps following the Default schedule',async()=>{
 const f=setup({config:{enablePrebid:false}});addUnit(f,'A1','ATF');
 await saveSchedule(f,'__DEFAULT__',schedules.sequence);
 assert.deepEqual(await createBaseRules(f,{followInheritedSchedule:true}),[]);assert.deepEqual(Object.keys(f.readConfig().advancedUnitRules),['__DEFAULT__']);
 const row=()=>JSON.parse(f.sqlite.prepare("SELECT rule_json FROM unit_rules WHERE rule_key='__ATF__'").get().rule_json),before=row();
 const unchanged=await refreshTab(f,'__ATF__');
 assert.deepEqual([unchanged.form.ownRefresh,unchanged.form.mode,unchanged.form.sequenceText,unchanged.form.minViewPct],[true,'sequence','20, 40, 80',60],'the tab shows the group values and the inherited schedule');
 assert.equal(Object.hasOwn(unchanged.body,'refresh'),false,'an unchanged save sends no refresh');
 assert.equal((await updateAdvancedRule(request(unchanged.body,'PUT'),f.env,'audit-site','__ATF__')).status,200);
 const timeoutOnly=await refreshTab(f,'__ATF__',{timeout:2000});
 assert.deepEqual(Object.keys(timeoutOnly.body).filter(key=>!key.startsWith('expected')),['timeout'],'a timeout-only save sends only the timeout');
 assert.equal((await updateAdvancedRule(request(timeoutOnly.body,'PUT'),f.env,'audit-site','__ATF__')).status,200);
 assert.deepEqual(row(),{...before,timeout:2000},'the row keeps its 30 s and 60%; only the timeout changed');
 assert.equal(Object.hasOwn(f.readConfig().advancedUnitRules.__ATF__,'refresh'),false,'no schedule was copied from Default');
 // A1 still follows Default: a new Default sequence applies to it.
 await saveSchedule(f,'__DEFAULT__',{mode:'sequence',sequenceSeconds:[60,90]});
 const result=await compiledIntervals(f,['A1'],['3.16.1','3.16.2']);
 for(const version of ['3.16.1','3.16.2'])for(const device of ['',' mobile'])assert.deepEqual(result[version+' A1'+device],[60,90,90,90],`${version} A1${device}`);
 // And the group interval can still be changed in Unit rules.
 const edited=await editRule(f,'__ATF__',{...row(),refresh:{...row().refresh,minSeconds:45}});assert.deepEqual(edited.keptUnitRuleIntervals,['__ATF__']);
});
test('Refresh tab on a new site: an ATF group interval entered here stores 50%, so the 3.16.2 positions keep 50%',async()=>{
 const f=setup({config:{enablePrebid:false}});addUnit(f,'A1','ATF');
 const {form,body}=await refreshTab(f,'__ATF__',{fixedSeconds:45});
 assert.deepEqual([form.ownRefresh,form.minViewPct],[true,50],'the form shows the 50% the script checks when no scope saves one');
 assert.equal(body.refresh.minViewPct,50);
 assert.deepEqual(['timeout','cmpTimeout'].filter(key=>Object.hasOwn(body,key)),[],'an interval entered here sends neither the shown 2200 ms nor the CMP wait');
 assert.equal((await updateAdvancedRule(request(body,'PUT'),f.env,'audit-site','__ATF__')).status,200);
 assert.equal(f.readConfig().advancedUnitRules.__ATF__.refresh.minViewPct,50);
 assert.equal(Object.hasOwn(f.readConfig().advancedUnitRules.__ATF__,'timeout'),false);
 const result=await compiledIntervals(f,['A1','P1'],['3.16.2']);const units=result['summary 3.16.2'].units;
 for(const code of ['A1','P1'])assert.match(units.find(unit=>unit.code===code).label,/· 50%$/,`${code}: ${units.find(unit=>unit.code===code).label}`);
 assert.equal(units.find(unit=>unit.code==='A1').timeout,2500,'A1 keeps the script\'s 2500 ms');
});
