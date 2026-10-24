import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {createUnitRule,updateUnitRule,deleteUnitRule,duplicateUnitRule} from '../../worker/unit-rules.ts';
import {createPublisher} from '../../worker/publishers.ts';
import {defaultUserIdSettings,initializeMissingUserSync,getUserIdConfig,updateUserIdConfig} from '../../worker/user-id-config.ts';
import {updatePrebidMode} from '../../worker/prebid-mode.ts';
import {previewInput} from '../../worker/runtime/preview-snapshot.mjs';
import {previewInput as catalogPreviewInput,runtimeCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';
import {readPreviewSnapshot} from '../../worker/runtime/builtin-preview-service.mjs';
import {siteSetupState} from '../../worker/site-runtime/setup-state.mjs';
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
