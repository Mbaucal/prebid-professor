// R2-02: unit-rule and advanced-rule saves racing each other must never leave
// publisher_configs.config_json (unitRules mirror and advancedUnitRules overrides)
// out of step with unit_rules rows. Interleavings are injected at the two windows a
// request has: after its first row read, and after its snapshot reads but before its
// D1 batch. Local SQLite only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {createUnitRule,updateUnitRule,deleteUnitRule,duplicateUnitRule,listUnitRules} from '../../worker/unit-rules.ts';
import {listAdvancedRules,updateAdvancedRule} from '../../worker/advanced-rules.ts';
import {updateUserIdConfig} from '../../worker/user-id-config.ts';
import {updateRuntimeIntegrations} from '../../worker/runtime-integrations.ts';
import {rebaseEdits,rebaseReview} from '../../src/edit-rebase.ts';
import {intervalText,mergeRefresh,ruleChain} from '../../worker/refresh-inheritance.ts';
import {readPreviewSnapshot} from '../../worker/runtime/builtin-preview-service.mjs';
import {previewInput,runtimeCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';
import {createAdUnit,updateAdUnit,duplicateAdUnit,deleteAdUnit} from '../../worker/ad-units.ts';
import {generatedCmpTimeouts,generatedIntervals} from '../support/generated-refresh.mjs';

const SITE='audit-site';
const request=(body,method='PATCH')=>new Request('https://test.invalid/api/unit-rules',{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const refresh=n=>({enabled:true,minSeconds:n,minViewPct:50,requirePreviousViewable:false,checkEveryMs:5000});
const fixedAdvanced=(timeout,n)=>({timeout,cmpTimeout:1500,refresh:{...refresh(n),schedule:{mode:'fixed',fixedSeconds:n,firstSeconds:n,nextSeconds:n}}});
const lazy={enabled:true,fetchMarginPx:500,renderMarginPx:100};
const fixtures=[];
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});

function setup(){const f=adminAuditStore();fixtures.push(f);return f;}
function seedRule(f,{id,key,rule,advanced}){
 f.sqlite.prepare('INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES(?,?,?,?)').run(id??key,SITE,key,JSON.stringify(rule));
 const c=f.readConfig();c.unitRules={...c.unitRules,[key]:rule};if(advanced)c.advancedUnitRules={...c.advancedUnitRules,[key]:advanced};f.writeConfig(c);
}
const rows=f=>f.sqlite.prepare('SELECT id,rule_key,rule_json FROM unit_rules WHERE publisher_id=? ORDER BY rule_key').all(SITE);
const audits=f=>f.sqlite.prepare('SELECT action FROM audit_log WHERE publisher_id=? ORDER BY rowid').all(SITE).map(r=>r.action);
const compiledRule=async(f,key)=>previewInput(await readPreviewSnapshot(f.env.DB,SITE),runtimeCatalog.find(r=>r.version==='3.16.1'),'20261024_120000').core.adUnitRules[key];

// The invariant R2-02 broke: the config mirror equals the rows, and an advanced record
// that owns timeout/cmpTimeout/refresh always has its row with the same timeout.
function assertConsistent(f){
 const byKey=Object.fromEntries(rows(f).map(r=>[r.rule_key,JSON.parse(r.rule_json)]));
 const config=f.readConfig();
 assert.deepEqual(config.unitRules??{},byKey,'config.unitRules must mirror unit_rules rows');
 for(const [key,advanced] of Object.entries(config.advancedUnitRules??{})){
  const owned=['timeout','cmpTimeout','refresh'].filter(field=>Object.hasOwn(advanced,field));
  if(!owned.length)continue;
  assert(Object.hasOwn(byKey,key),`advancedUnitRules.${key} keeps ${owned.join('/')} without a unit rule row`);
  assert.equal(advanced.timeout,byKey[key].timeout,`advancedUnitRules.${key}.timeout must match its row`);
 }
}

// Window 1: run `operation` right after the request's first single-row unit_rules read.
function afterFirstRuleRead(f,operation){
 const original=f.env.DB.prepare;let fired=false;
 const wrap=statement=>({...statement,bind(...args){return wrap(statement.bind(...args));},async first(){
  const value=await statement.first();
  if(!fired&&/FROM unit_rules/.test(statement.sql)){fired=true;f.env.DB.prepare=original;await operation();}
  return value;
 }});
 f.env.DB.prepare=sql=>wrap(original(sql));
 return ()=>assert(fired,'interleaving was not injected');
}
// Window 2: run `operation` after the request's snapshot reads, just before its batch.
function beforeFirstBatch(f,operation){
 const original=f.env.DB.batch;let fired=false;
 f.env.DB.batch=async items=>{f.env.DB.batch=original;fired=true;await operation();return original(items);};
 return ()=>assert(fired,'interleaving was not injected');
}
const ok=async(response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return response.json();};
const refused=async(response,status,pattern)=>{const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));assert.equal(body.ok,false);assert.match(body.error,pattern);};

test('R2-02 reviewer interleaving: delete after the update read is a 404 and leaves no invisible override',async()=>{
 const f=setup();seedRule(f,{key:'P1',rule:{timeout:2500,refresh:refresh(30)},advanced:{timeout:2500,refresh:refresh(30),lazy}});
 const injected=afterFirstRuleRead(f,async()=>ok(await deleteUnitRule(request({},'DELETE'),f.env,SITE,'P1')));
 const response=await updateUnitRule(request({rule:{timeout:1200}}),f.env,SITE,'P1');injected();
 await refused(response,404,/deleted in another tab/);
 assert.deepEqual(rows(f),[]);assert.deepEqual(f.readConfig().advancedUnitRules,{P1:{lazy}});assert.deepEqual(f.readConfig().unitRules,{});
 assert.equal((await compiledRule(f,'P1'))?.timeout,undefined);assert.deepEqual(audits(f),['unit_rule.deleted']);assertConsistent(f);
});

test('delete committed between the update snapshot and its batch is caught inside the batch',async()=>{
 const f=setup();seedRule(f,{key:'P1',rule:{timeout:2500,refresh:refresh(30)},advanced:{timeout:2500,refresh:refresh(30),lazy}});
 const injected=beforeFirstBatch(f,async()=>ok(await deleteUnitRule(request({},'DELETE'),f.env,SITE,'P1')));
 const response=await updateUnitRule(request({rule:{timeout:1200}}),f.env,SITE,'P1');injected();
 await refused(response,404,/deleted in another tab/);
 assert.deepEqual(rows(f),[]);assert.deepEqual(f.readConfig().advancedUnitRules,{P1:{lazy}});
 assert.equal((await compiledRule(f,'P1'))?.timeout,undefined);assert.deepEqual(audits(f),['unit_rule.deleted']);assertConsistent(f);
});

test('row guard does not depend on config_json changing: a delete that rewrites identical config still blocks the update',async()=>{
 // No advanced record and a mirror that already lacks P1 (as left by an unguarded
 // config writer), so the competing delete writes byte-identical config_json and only
 // the in-batch unit_rules guard can notice the vanished row.
 const f=setup();f.sqlite.prepare('INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES(?,?,?,?)').run('P1',SITE,'P1',JSON.stringify({timeout:2500}));
 const c=f.readConfig();c.unitRules={};f.writeConfig(c);
 const injected=beforeFirstBatch(f,async()=>{const before=f.readConfig();await ok(await deleteUnitRule(request({},'DELETE'),f.env,SITE,'P1'));assert.deepEqual(f.readConfig(),before);});
 const response=await updateUnitRule(request({rule:{timeout:1200}}),f.env,SITE,'P1');injected();
 await refused(response,404,/deleted in another tab/);
 assert.deepEqual(rows(f),[]);assert.deepEqual(f.readConfig().unitRules,{});assert.equal(f.readConfig().advancedUnitRules,undefined);assertConsistent(f);
});

test('update cannot write its values onto a rule that was deleted and re-created under the same key',async()=>{
 const f=setup();seedRule(f,{key:'P1',rule:{timeout:2500},advanced:{timeout:2500,lazy}});
 const injected=afterFirstRuleRead(f,async()=>{
  await ok(await deleteUnitRule(request({},'DELETE'),f.env,SITE,'P1'));
  await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:3000}},'POST'),f.env,SITE),201);
 });
 const response=await updateUnitRule(request({rule:{timeout:1200}}),f.env,SITE,'P1');injected();
 await refused(response,404,/deleted in another tab/);
 const [row]=rows(f);assert.notEqual(row.id,'P1');assert.equal(JSON.parse(row.rule_json).timeout,3000);
 assert.equal(f.readConfig().advancedUnitRules.P1.timeout,3000);assert.equal((await compiledRule(f,'P1')).timeout,3000);
 assert.deepEqual(audits(f),['unit_rule.deleted','unit_rule.created']);assertConsistent(f);
});

test('delete is refused when the rule was updated after the delete read it',async()=>{
 const f=setup();seedRule(f,{key:'P1',rule:{timeout:2500},advanced:{timeout:2500,lazy}});
 const injected=afterFirstRuleRead(f,async()=>ok(await updateUnitRule(request({rule:{timeout:1200}}),f.env,SITE,'P1')));
 const response=await deleteUnitRule(request({},'DELETE'),f.env,SITE,'P1');injected();
 await refused(response,409,/changed in another tab/);
 assert.equal(JSON.parse(rows(f)[0].rule_json).timeout,1200);assert.equal(f.readConfig().advancedUnitRules.P1.timeout,1200);
 assert.deepEqual(audits(f),['unit_rule.updated']);assertConsistent(f);
});

// Every write lands in one millisecond (frozen Date), so updated_at alone cannot tell the
// rows apart: versions still move forward and work built from an older read is refused.
test('same-millisecond saves still version the row: delete, duplicate and update from an older read are refused',async t=>{
 const at=Date.parse('2026-10-24T12:00:00.000Z');t.mock.timers.enable({apis:['Date'],now:at});
 const seed=(key,advanced)=>{const f=setup();seedRule(f,{key,rule:{timeout:2500},advanced});f.sqlite.prepare('UPDATE unit_rules SET updated_at=? WHERE publisher_id=?').run(new Date(at).toISOString(),SITE);return f;};
 let f=seed('P1',{timeout:2500,lazy});
 let injected=afterFirstRuleRead(f,async()=>ok(await updateUnitRule(request({rule:{timeout:1200}}),f.env,SITE,'P1')));
 await refused(await deleteUnitRule(request({},'DELETE'),f.env,SITE,'P1'),409,/changed in another tab/);injected();
 assert.equal(f.sqlite.prepare('SELECT updated_at FROM unit_rules WHERE publisher_id=?').get(SITE).updated_at,'2026-10-24T12:00:00.001Z');
 assert.equal(JSON.parse(rows(f)[0].rule_json).timeout,1200);assert.deepEqual(audits(f),['unit_rule.updated']);assertConsistent(f);
 f=seed('__ATF__');
 injected=afterFirstRuleRead(f,async()=>ok(await updateUnitRule(request({rule:{timeout:1200}}),f.env,SITE,'__ATF__')));
 await refused(await duplicateUnitRule(request({ruleKey:'P1'},'POST'),f.env,SITE,'__ATF__'),409,/changed in another tab/);injected();
 assert.deepEqual(rows(f).map(r=>[r.rule_key,JSON.parse(r.rule_json).timeout]),[['__ATF__',1200]]);assertConsistent(f);
 f=seed('P1',{timeout:2500,lazy});
 injected=afterFirstRuleRead(f,async()=>ok(await updateAdvancedRule(request({timeout:1800},'PUT'),f.env,SITE,'P1')));
 await refused(await updateUnitRule(request({rule:{timeout:1200}}),f.env,SITE,'P1'),409,/changed in another tab/);injected();
 assert.equal(JSON.parse(rows(f)[0].rule_json).timeout,1800);assert.equal(f.readConfig().advancedUnitRules.P1.timeout,1800);assertConsistent(f);
});

test('concurrent updates: the later batch is refused and the committed save stays consistent',async()=>{
 const f=setup();seedRule(f,{key:'P1',rule:{timeout:2500},advanced:{timeout:2500,lazy}});
 const injected=beforeFirstBatch(f,async()=>ok(await updateUnitRule(request({rule:{timeout:1500}}),f.env,SITE,'P1')));
 const response=await updateUnitRule(request({rule:{timeout:1200}}),f.env,SITE,'P1');injected();
 await refused(response,409,/changed in another tab/);
 assert.equal(JSON.parse(rows(f)[0].rule_json).timeout,1500);assert.equal(f.readConfig().advancedUnitRules.P1.timeout,1500);
 assert.deepEqual(audits(f),['unit_rule.updated']);assertConsistent(f);
});

test('create of a key created concurrently is a 409 without touching the winner',async()=>{
 const f=setup();
 const injected=beforeFirstBatch(f,async()=>ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:3000}},'POST'),f.env,SITE),201));
 const response=await createUnitRule(request({ruleKey:'P1',rule:{timeout:1200}},'POST'),f.env,SITE);injected();
 await refused(response,409,/already exists/);
 assert.equal(rows(f).length,1);assert.equal(JSON.parse(rows(f)[0].rule_json).timeout,3000);assert.deepEqual(audits(f),['unit_rule.created']);assertConsistent(f);
});

for(const [label,window] of [['after the source read',afterFirstRuleRead],['before the duplicate batch',beforeFirstBatch]]){
 test(`duplicate is a 404 when its source is deleted ${label}`,async()=>{
  const f=setup();seedRule(f,{key:'__ATF__',rule:{timeout:2000,refresh:refresh(30)},advanced:fixedAdvanced(2000,30)});
  const injected=window(f,async()=>ok(await deleteUnitRule(request({},'DELETE'),f.env,SITE,'__ATF__')));
  const response=await duplicateUnitRule(request({ruleKey:'P1'},'POST'),f.env,SITE,'__ATF__');injected();
  await refused(response,404,/source rule no longer exists/);
  assert.deepEqual(rows(f),[]);assert.equal(f.readConfig().advancedUnitRules?.P1,undefined);assert.deepEqual(audits(f),['unit_rule.deleted']);assertConsistent(f);
 });
}

test('advanced schedule save is refused when a unit-rule delete commits first; no resurrected or invisible override',async()=>{
 const f=setup();seedRule(f,{key:'P1',rule:{timeout:2500,refresh:refresh(30)},advanced:{...fixedAdvanced(2500,30),lazy}});
 const injected=beforeFirstBatch(f,async()=>ok(await deleteUnitRule(request({},'DELETE'),f.env,SITE,'P1')));
 const response=await updateAdvancedRule(request({timeout:1800,refresh:{...refresh(45),schedule:{mode:'fixed',fixedSeconds:45}}},'PUT'),f.env,SITE,'P1');injected();
 await refused(response,409,/changed in another tab/);
 assert.deepEqual(rows(f),[]);assert.deepEqual(f.readConfig().advancedUnitRules,{P1:{lazy}});
 assert.equal((await compiledRule(f,'P1'))?.timeout,undefined);assert.deepEqual(audits(f),['unit_rule.deleted']);assertConsistent(f);
});

test('advanced schedule save and unit-rule save cannot overwrite each other in either order',async()=>{
 {
  const f=setup();seedRule(f,{key:'P1',rule:{timeout:2500,refresh:refresh(30)},advanced:fixedAdvanced(2500,30)});
  const injected=beforeFirstBatch(f,async()=>ok(await updateUnitRule(request({rule:{timeout:1200,refresh:refresh(30)}}),f.env,SITE,'P1')));
  const response=await updateAdvancedRule(request({timeout:1800,refresh:{schedule:{mode:'fixed',fixedSeconds:30}}},'PUT'),f.env,SITE,'P1');injected();
  await refused(response,409,/changed in another tab/);
  assert.equal(JSON.parse(rows(f)[0].rule_json).timeout,1200);assert.equal(f.readConfig().advancedUnitRules.P1.timeout,1200);
  assert.equal((await compiledRule(f,'P1')).timeout,1200);assert.deepEqual(audits(f),['unit_rule.updated']);assertConsistent(f);
 }
 {
  const f=setup();seedRule(f,{key:'P1',rule:{timeout:2500,refresh:refresh(30)},advanced:fixedAdvanced(2500,30)});
  const injected=beforeFirstBatch(f,async()=>ok(await updateAdvancedRule(request({timeout:1800,refresh:{schedule:{mode:'fixed',fixedSeconds:30}}},'PUT'),f.env,SITE,'P1')));
  const response=await updateUnitRule(request({rule:{timeout:1200,refresh:refresh(30)}}),f.env,SITE,'P1');injected();
  await refused(response,409,/changed in another tab/);
  assert.equal(JSON.parse(rows(f)[0].rule_json).timeout,1800);assert.equal(f.readConfig().advancedUnitRules.P1.timeout,1800);
  assert.deepEqual(audits(f),['unit_rule.advanced_updated']);assertConsistent(f);
 }
});

test('normal paths keep their contract: written rule returned, one batch, one audit, consistent config',async()=>{
 const f=setup();
 const created=await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:2500}},'POST'),f.env,SITE),201);
 assert.equal(created.unitRule.ruleKey,'P1');assert.deepEqual(created.unitRule.rule,{timeout:2500});
 const updated=await ok(await updateUnitRule(request({rule:{timeout:1200}}),f.env,SITE,created.unitRule.id));
 assert.equal(updated.unitRule.id,created.unitRule.id);assert.deepEqual(updated.unitRule.rule,{timeout:1200});assert.equal(updated.unitRule.createdAt,created.unitRule.createdAt);
 assert.deepEqual((await (await listUnitRules(f.env,SITE)).json()).unitRules,[updated.unitRule],'response is the committed row');
 const batches=f.log.batches;
 const advanced=await ok(await updateAdvancedRule(request({timeout:1800,refresh:{schedule:{mode:'fixed',fixedSeconds:45}}},'PUT'),f.env,SITE,'__DEFAULT__'));
 assert.equal(f.log.batches,batches+1,'advanced save writes row, config and audit in one batch');
 const mirrored=rows(f).find(r=>r.rule_key==='__DEFAULT__');assert(mirrored,'advanced save mirrors a missing basic row');
 assert.equal(JSON.parse(mirrored.rule_json).timeout,1800);assert.equal(JSON.parse(mirrored.rule_json).refresh.minSeconds,45);assert.equal(advanced.advancedRule.timeout,1800);
 await ok(await updateAdvancedRule(request({timeout:1700},'PUT'),f.env,SITE,'P1'));
 assert.equal(rows(f).find(r=>r.rule_key==='P1').id,created.unitRule.id,'advanced save updates the existing row in place');
 assert.equal(f.readConfig().advancedUnitRules.P1.timeout,1700);assert.equal(JSON.parse(rows(f).find(r=>r.rule_key==='P1').rule_json).timeout,1700);
 await ok(await deleteUnitRule(request({},'DELETE'),f.env,SITE,created.unitRule.id));
 assert.deepEqual(audits(f),['unit_rule.created','unit_rule.updated','unit_rule.advanced_updated','unit_rule.advanced_updated','unit_rule.deleted']);
 assertConsistent(f);
});

// Point 2 (review of #160): a position's Unit rules settings live under its code in the
// unit_rules row, the config.unitRules mirror and the Refresh schedules record. Copy and
// rename must carry all three, and a copy or an ATF/BTF group change must keep the saved
// interval in the target group, in one guarded batch, so the generated 3.16.1 and 3.16.2
// scheduler uses the interval Unit rules shows. (Ad-unit delete cleanup is a separate task.)
const SEQUENCE={mode:'sequence',sequenceSeconds:[20,40,80]};
const adUnitRow=(f,code)=>f.sqlite.prepare('SELECT id,code,type FROM ad_units WHERE publisher_id=? AND code=?').get(SITE,code);
async function positionWithInterval({timeout,cmpTimeout}={}){
 const f=setup();
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,schedule:SEQUENCE}},'PUT'),f.env,SITE,'__DEFAULT__'));
 const saved=await ok(await createUnitRule(request({ruleKey:'P1',rule:{...(timeout?{timeout}:{}),refresh:{enabled:true,minSeconds:60}}},'POST'),f.env,SITE),201);
 assert.deepEqual(saved.keptUnitRuleIntervals,['P1'],'P1 keeps its 60 s under the Default sequence');
 assert.equal(f.readConfig().advancedUnitRules.P1.timeout,timeout,'the kept record starts from the rule timeout');
 if(cmpTimeout)await ok(await updateAdvancedRule(request({cmpTimeout},'PUT'),f.env,SITE,'P1'));
 assertConsistent(f);
 return f;
}
// An ATF group sequence and P1 (BTF) with its own 60 s, which needs no own schedule in BTF.
async function groupScheduleSite(){
 const f=setup();
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,schedule:SEQUENCE}},'PUT'),f.env,SITE,'__ATF__'));
 const saved=await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:1800,refresh:{enabled:true,minSeconds:60}}},'POST'),f.env,SITE),201);
 assert.deepEqual(saved.keptUnitRuleIntervals,[]);assert.equal(f.readConfig().advancedUnitRules.P1,undefined);
 return f;
}
async function assertIntervals(f,expected){
 const result=await generatedIntervals(f,Object.keys(expected));
 for(const version of ['3.16.1','3.16.2']){
  for(const [code,values] of Object.entries(expected))for(const device of ['',' mobile'])assert.deepEqual(result[version+' '+code+device],values,`${version} ${code}${device}`);
  assert.deepEqual(result['summary '+version].warnings.filter(w=>w.includes('Unit rules is not used')),[],`${version} has no interval mismatch`);
 }
 return result;
}
// FALLBACK: a position without refresh settings uses the script's fallback interval, the
// global refresh minSeconds (20 s: the first step of the ATF group sequence here).
const SIXTY=[60,60,60,60],INHERITED=[20,40,80,80],FALLBACK=[20,20,20,20],FIXED_SIXTY={mode:'fixed',fixedSeconds:60,firstSeconds:60,nextSeconds:60};
const auditDetails=(f,action)=>JSON.parse(f.sqlite.prepare('SELECT details_json FROM audit_log WHERE action=? ORDER BY rowid DESC LIMIT 1').get(action).details_json);

test('copying a position carries its unit rule, Refresh schedules record and mirror, so the copy uses 60 s in 3.16.1 and 3.16.2',async()=>{
 const f=await positionWithInterval({timeout:1800,cmpTimeout:2000});const source=structuredClone(f.readConfig().advancedUnitRules.P1);const batches=f.log.batches;
 assert.equal(source.cmpTimeout,2000);
 await ok(await duplicateAdUnit(request({code:'P2'},'POST'),f.env,SITE,'audit-unit'),201);
 assert.equal(f.log.batches,batches+1,'one batch');
 assert.deepEqual(rows(f).map(r=>r.rule_key),['P1','P2','__DEFAULT__']);assert.equal(rows(f)[1].rule_json,rows(f)[0].rule_json,'the rule row is copied');
 assert.equal(JSON.parse(rows(f)[1].rule_json).timeout,1800);
 assert.deepEqual(f.readConfig().advancedUnitRules.P2,source,'the schedule, timeout and cmpTimeout are copied');
 assert.deepEqual(f.readConfig().advancedUnitRules.P1,source,'the source is unchanged');
 const result=await assertIntervals(f,{P1:SIXTY,P2:SIXTY});assert.equal(result['rules 3.16.2'].P2.timeout,1800);assert.equal(result['rules 3.16.2'].P2.cmpTimeout,2000);
 assert.deepEqual(audits(f).slice(-1),['ad_unit.duplicated']);assertConsistent(f);
});

test('a copy without its unit rule follows the inherited schedule and takes nothing from the source',async()=>{
 const f=await positionWithInterval({timeout:1800});
 await ok(await duplicateAdUnit(request({code:'P2',copyUnitRule:false},'POST'),f.env,SITE,'audit-unit'),201);
 assert.deepEqual(rows(f).map(r=>r.rule_key),['P1','__DEFAULT__']);assert.equal(f.readConfig().advancedUnitRules.P2,undefined);assert.equal(f.readConfig().unitRules.P2,undefined);
 const result=await assertIntervals(f,{P1:SIXTY,P2:INHERITED});assert.equal(result['rules 3.16.2'].P2,undefined);assertConsistent(f);
});

test('a copy that joins a group with its own schedule keeps the copied interval and names it',async()=>{
 const f=await groupScheduleSite();
 assert.deepEqual((await ok(await duplicateAdUnit(request({code:'P2',type:'ATF'},'POST'),f.env,SITE,'audit-unit'),201)).keptUnitRuleIntervals,['P2']);
 const copy=f.readConfig().advancedUnitRules.P2;assert.deepEqual(copy.refresh.schedule,FIXED_SIXTY);assert.equal(copy.timeout,1800,'Refresh schedules shows the Unit rules timeout');
 assert.equal(f.readConfig().advancedUnitRules.P1,undefined,'the source needs no own schedule in BTF');
 assert.deepEqual(auditDetails(f,'ad_unit.duplicated').keptUnitRuleIntervals,['P2']);
 await assertIntervals(f,{P1:SIXTY,P2:SIXTY});assertConsistent(f);
});

test('renaming a position moves its unit rule, Refresh schedules record and mirror, so it keeps 60 s in 3.16.1 and 3.16.2',async()=>{
 const f=await positionWithInterval({timeout:1800});const before=structuredClone(f.readConfig().advancedUnitRules.P1);const batches=f.log.batches;
 await ok(await updateAdUnit(request({code:'P2'}),f.env,SITE,'audit-unit'));
 assert.equal(f.log.batches,batches+1,'one batch');
 assert.deepEqual(rows(f).map(r=>r.rule_key),['P2','__DEFAULT__']);
 const config=f.readConfig();assert.deepEqual(config.advancedUnitRules.P2,before);assert.equal(config.advancedUnitRules.P1,undefined);assert.equal(config.unitRules.P1,undefined);
 const result=await assertIntervals(f,{P2:SIXTY});assert.equal(result['rules 3.16.1'].P2.timeout,1800);assert.equal(result['rules 3.16.1'].P1,undefined);
 assertConsistent(f);
 // Renaming back restores the same data under the original code.
 await ok(await updateAdUnit(request({code:'P1'}),f.env,SITE,'audit-unit'));
 assert.deepEqual(f.readConfig().advancedUnitRules.P1,before);await assertIntervals(f,{P1:SIXTY});assertConsistent(f);
});

test('a rename that also moves the position into a group with its own schedule keeps 60 s in 3.16.1 and 3.16.2',async()=>{
 // The edit form sends code and type in one save.
 const f=await groupScheduleSite();
 await ok(await updateAdUnit(request({code:'P2',type:'ATF'}),f.env,SITE,'audit-unit'));
 assert.deepEqual(rows(f).map(r=>r.rule_key),['P2','__ATF__']);
 const moved=f.readConfig().advancedUnitRules.P2;assert.deepEqual(moved.refresh.schedule,FIXED_SIXTY);assert.equal(moved.timeout,1800);assert.equal(f.readConfig().advancedUnitRules.P1,undefined);
 assert.deepEqual(auditDetails(f,'ad_unit.updated').keptUnitRuleIntervals,['P2']);
 await assertIntervals(f,{P2:SIXTY});assertConsistent(f);
});

test('a group change without a rename keeps the saved interval and leaves other positions alone',async()=>{
 const f=await groupScheduleSite();
 // P3 (ATF) already keeps its own 45 s; P4 (BTF, no schedule: the 30 s default) has a timeout-only rule.
 await ok(await createAdUnit(request({code:'P3',type:'ATF',sizeMapKey:'display'},'POST'),f.env,SITE),201);
 await ok(await createAdUnit(request({code:'P4',type:'BTF',sizeMapKey:'display'},'POST'),f.env,SITE),201);
 assert.deepEqual((await ok(await createUnitRule(request({ruleKey:'P3',rule:{refresh:{enabled:true,minSeconds:45}}},'POST'),f.env,SITE),201)).keptUnitRuleIntervals,['P3']);
 await ok(await createUnitRule(request({ruleKey:'P4',rule:{timeout:1200}},'POST'),f.env,SITE),201);
 const before=f.readConfig(),rowsBefore=rows(f),batches=f.log.batches;
 assert.deepEqual((await ok(await updateAdUnit(request({type:'ATF'}),f.env,SITE,'audit-unit'))).keptUnitRuleIntervals,['P1'],'the response names the kept interval');
 assert.equal(f.log.batches,batches+1,'one batch');assert.equal(adUnitRow(f,'P1').type,'ATF');
 const after=f.readConfig(),{P1,...others}=after.advancedUnitRules;
 assert.deepEqual(P1.refresh.schedule,FIXED_SIXTY);assert.equal(P1.timeout,1800);
 assert.deepEqual(others,before.advancedUnitRules,'no other Refresh schedules record changes');assert.deepEqual(after.unitRules,before.unitRules);
 assert.deepEqual({...after,advancedUnitRules:others},before,'nothing else in site settings changes');assert.deepEqual(rows(f),rowsBefore,'no rule row content changes');
 assert.deepEqual(auditDetails(f,'ad_unit.updated').keptUnitRuleIntervals,['P1']);
 await assertIntervals(f,{P1:SIXTY,P3:[45,45,45,45],P4:FALLBACK});assertConsistent(f);
 // Moving it back keeps its own schedule (owned by Refresh schedules now) and the interval.
 await ok(await updateAdUnit(request({type:'BTF'}),f.env,SITE,'audit-unit'));
 await assertIntervals(f,{P1:SIXTY,P3:[45,45,45,45]});assertConsistent(f);
});

test('a group change or rename of a position without its own saved interval writes no site settings',async()=>{
 // P1 has no rule; P2 and A2 have timeout-only rules. None has an interval to keep. The
 // mirror lists A2 after P2 (save order), unlike the rows, and is still left as stored.
 const f=setup();
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,schedule:SEQUENCE}},'PUT'),f.env,SITE,'__ATF__'));
 const p2=await ok(await createAdUnit(request({code:'P2',type:'BTF',sizeMapKey:'display'},'POST'),f.env,SITE),201);
 await ok(await createAdUnit(request({code:'A2',type:'BTF',sizeMapKey:'display'},'POST'),f.env,SITE),201);
 await ok(await createUnitRule(request({ruleKey:'P2',rule:{timeout:1200}},'POST'),f.env,SITE),201);
 await ok(await createUnitRule(request({ruleKey:'A2',rule:{timeout:1500}},'POST'),f.env,SITE),201);
 assert.deepEqual(Object.keys(f.readConfig().unitRules),['__ATF__','P2','A2']);
 const before=JSON.stringify(f.readConfig()),rowsBefore=rows(f);
 await ok(await updateAdUnit(request({type:'ATF'}),f.env,SITE,'audit-unit'));
 await ok(await updateAdUnit(request({type:'ATF'}),f.env,SITE,p2.adUnit.id));
 await ok(await updateAdUnit(request({code:'P9'}),f.env,SITE,'audit-unit'));
 assert.equal(adUnitRow(f,'P9').type,'ATF');assert.equal(adUnitRow(f,'P2').type,'ATF');
 assert.equal(JSON.stringify(f.readConfig()),before,'no record is invented and the stored settings stay byte-identical');assert.deepEqual(rows(f),rowsBefore);
 assert.equal(auditDetails(f,'ad_unit.updated').keptUnitRuleIntervals,undefined);
 await assertIntervals(f,{P9:INHERITED,P2:INHERITED,A2:FALLBACK});assertConsistent(f);
});

test('edits that keep the code and the group do not write site settings',async()=>{
 const f=await positionWithInterval();const before=JSON.stringify(f.readConfig());
 await ok(await updateAdUnit(request({notes:'moved below the fold',sortOrder:3,type:'BTF'}),f.env,SITE,'audit-unit'));
 assert.equal(JSON.stringify(f.readConfig()),before);assertConsistent(f);
});

test('a Unit rules save that commits before the copy batch refuses the copy; nothing is written',async()=>{
 const f=await positionWithInterval();const before=audits(f).length;
 const injected=beforeFirstBatch(f,async()=>ok(await updateUnitRule(request({rule:{refresh:{enabled:true,minSeconds:90}}}),f.env,SITE,rows(f).find(r=>r.rule_key==='P1').id)));
 await refused(await duplicateAdUnit(request({code:'P2'},'POST'),f.env,SITE,'audit-unit'),409,/changed/);injected();
 assert.equal(adUnitRow(f,'P2'),undefined);assert.deepEqual(rows(f).map(r=>r.rule_key),['P1','__DEFAULT__']);
 assert.equal(f.readConfig().advancedUnitRules.P2,undefined);assert.equal(f.readConfig().advancedUnitRules.P1.refresh.schedule.fixedSeconds,90);
 assert.deepEqual(audits(f).slice(before),['unit_rule.updated']);await assertIntervals(f,{P1:[90,90,90,90]});assertConsistent(f);
});

test('a Refresh schedules save that commits before the rename batch refuses the rename; nothing moves',async()=>{
 const f=await positionWithInterval();const before=audits(f).length;
 const injected=beforeFirstBatch(f,async()=>ok(await updateAdvancedRule(request({timeout:1700},'PUT'),f.env,SITE,'P1')));
 await refused(await updateAdUnit(request({code:'P2'}),f.env,SITE,'audit-unit'),409,/changed/);injected();
 assert.equal(adUnitRow(f,'P1').code,'P1');assert.deepEqual(rows(f).map(r=>r.rule_key),['P1','__DEFAULT__']);
 assert.equal(f.readConfig().advancedUnitRules.P1.timeout,1700);assert.equal(f.readConfig().advancedUnitRules.P2,undefined);
 assert.deepEqual(audits(f).slice(before),['unit_rule.advanced_updated']);assertConsistent(f);
});

test('a Unit rules save that commits before a group change batch refuses the group change; nothing is written',async()=>{
 const f=await groupScheduleSite();const before=audits(f).length;
 const injected=beforeFirstBatch(f,async()=>ok(await updateUnitRule(request({rule:{timeout:1800,refresh:{enabled:true,minSeconds:90}}}),f.env,SITE,rows(f).find(r=>r.rule_key==='P1').id)));
 await refused(await updateAdUnit(request({type:'ATF'}),f.env,SITE,'audit-unit'),409,/changed/);injected();
 assert.equal(adUnitRow(f,'P1').type,'BTF');assert.equal(f.readConfig().advancedUnitRules.P1,undefined);
 assert.deepEqual(audits(f).slice(before),['unit_rule.updated']);await assertIntervals(f,{P1:[90,90,90,90]});assertConsistent(f);
});

test('a Unit rules save read before a rename cannot write under the old code',async()=>{
 const f=await positionWithInterval();const id=rows(f).find(r=>r.rule_key==='P1').id;
 const injected=afterFirstRuleRead(f,async()=>ok(await updateAdUnit(request({code:'P2'}),f.env,SITE,'audit-unit')));
 await refused(await updateUnitRule(request({rule:{refresh:{enabled:true,minSeconds:90}}}),f.env,SITE,id),409,/changed in another tab/);injected();
 assert.deepEqual(rows(f).map(r=>r.rule_key),['P2','__DEFAULT__']);assert.equal(f.readConfig().advancedUnitRules.P1,undefined);
 await assertIntervals(f,{P2:SIXTY});assertConsistent(f);
});

// Every write lands in one millisecond (frozen Date): the renamed row still gets a newer
// version, so a save built from the row before a rename and back is refused.
test('same-millisecond renames still version the renamed row',async t=>{
 const at=Date.parse('2026-10-24T12:00:00.000Z');t.mock.timers.enable({apis:['Date'],now:at});
 const f=setup();seedRule(f,{key:'P1',rule:{timeout:2500}});f.sqlite.prepare('UPDATE unit_rules SET updated_at=? WHERE publisher_id=?').run(new Date(at).toISOString(),SITE);
 const version=()=>f.sqlite.prepare('SELECT updated_at FROM unit_rules WHERE publisher_id=?').get(SITE).updated_at;
 const injected=afterFirstRuleRead(f,async()=>{
  await ok(await updateAdUnit(request({code:'P2'}),f.env,SITE,'audit-unit'));assert.equal(version(),'2026-10-24T12:00:00.001Z');
  await ok(await updateAdUnit(request({code:'P1'}),f.env,SITE,'audit-unit'));assert.equal(version(),'2026-10-24T12:00:00.002Z');
 });
 await refused(await updateUnitRule(request({rule:{timeout:1200}}),f.env,SITE,'P1'),409,/changed in another tab/);injected();
 assert.equal(JSON.parse(rows(f)[0].rule_json).timeout,2500);assert.deepEqual(audits(f),['ad_unit.updated','ad_unit.updated']);assertConsistent(f);
});

test('an edit that keeps the code and the group leaves the rule row version as it is',async t=>{
 // A group change moves the row version forward in the same millisecond; a later notes
 // edit must not move it back, or a save built from the row before the group change would match again.
 const at=Date.parse('2026-10-24T12:00:00.000Z');t.mock.timers.enable({apis:['Date'],now:at});
 const f=setup();seedRule(f,{key:'P1',rule:{timeout:2500}});f.sqlite.prepare('UPDATE unit_rules SET updated_at=? WHERE publisher_id=?').run(new Date(at).toISOString(),SITE);
 const version=()=>f.sqlite.prepare('SELECT updated_at FROM unit_rules WHERE publisher_id=?').get(SITE).updated_at;
 const injected=afterFirstRuleRead(f,async()=>{
  await ok(await updateAdUnit(request({type:'ATF'}),f.env,SITE,'audit-unit'));assert.equal(version(),'2026-10-24T12:00:00.001Z');
  await ok(await updateAdUnit(request({notes:'checked',sortOrder:4}),f.env,SITE,'audit-unit'));assert.equal(version(),'2026-10-24T12:00:00.001Z','the notes edit leaves the version');
 });
 await refused(await updateUnitRule(request({rule:{timeout:1200}}),f.env,SITE,'P1'),409,/changed in another tab/);injected();
 assert.equal(JSON.parse(rows(f)[0].rule_json).timeout,2500);assert.deepEqual(audits(f),['ad_unit.updated','ad_unit.updated']);
});

test('a Unit rules create that read before its position changed group or code is refused; nothing is written',async()=>{
 // P1 (BTF) has no rule yet, so the ad-unit edit moves no row; the ATF group runs a sequence.
 for(const edit of [{type:'ATF'},{code:'P2'}]){
  const f=setup();await ok(await updateAdvancedRule(request({refresh:{enabled:true,schedule:SEQUENCE}},'PUT'),f.env,SITE,'__ATF__'));
  const before=f.readConfig(),count=audits(f).length;
  const create=()=>createUnitRule(request({ruleKey:'P1',rule:{timeout:1800,refresh:{enabled:true,minSeconds:60}}},'POST'),f.env,SITE);
  const injected=beforeFirstBatch(f,async()=>ok(await updateAdUnit(request(edit),f.env,SITE,'audit-unit')));
  await refused(await create(),409,/changed/);injected();
  assert.deepEqual(rows(f).map(r=>r.rule_key),['__ATF__'],JSON.stringify(edit));assert.deepEqual(f.readConfig(),before,'site settings stay as stored');
  assert.deepEqual(audits(f).slice(count),['ad_unit.updated'],'no Unit rules audit');
  if(edit.type){
   await assertIntervals(f,{P1:INHERITED});
   // The same save made now, in the ATF group, keeps its 60 s.
   assert.deepEqual((await ok(await create(),201)).keptUnitRuleIntervals,['P1']);await assertIntervals(f,{P1:SIXTY});
  }
  assertConsistent(f);
 }
});

test('a Refresh schedules save that read before its position changed group or code, or was deleted, is refused; nothing is written',async()=>{
 // P1 (BTF) has no rule row and no record, so the ad-unit edit writes no site settings and moves no row.
 const edits=[['group change',f=>updateAdUnit(request({type:'ATF'}),f.env,SITE,'audit-unit')],['rename',f=>updateAdUnit(request({code:'P2'}),f.env,SITE,'audit-unit')],
  ['delete',f=>deleteAdUnit(request({},'DELETE'),f.env,SITE,'audit-unit')]];
 for(const [name,edit] of edits){
  const f=setup();await ok(await updateAdvancedRule(request({refresh:{enabled:true,schedule:SEQUENCE}},'PUT'),f.env,SITE,'__ATF__'));
  const before=f.readConfig(),count=audits(f).length;
  const save=()=>updateAdvancedRule(refreshForm(1800,60,null),f.env,SITE,'P1');
  const injected=beforeFirstBatch(f,async()=>ok(await edit(f)));
  await refused(await save(),409,/changed in another tab/);injected();
  assert.deepEqual(rows(f).map(r=>r.rule_key),['__ATF__'],name);assert.deepEqual(f.readConfig(),before,`${name}: site settings stay as stored`);
  assert.equal(audits(f).slice(count).includes('unit_rule.advanced_updated'),false,`${name}: no Refresh audit`);
  if(name==='group change'){
   // The same save made now, in the ATF group, applies its 60 s.
   await ok(await save());await assertIntervals(f,{P1:SIXTY});
  }
  assertConsistent(f);
 }
});

// Window 0: run `operation` right after the request has checked that its target ad unit exists.
function afterTargetCheck(f,operation){
 const original=f.env.DB.prepare;let fired=false;
 const wrap=statement=>({...statement,bind(...args){return wrap(statement.bind(...args));},async first(){
  const value=await statement.first();
  if(!fired&&/SELECT code FROM ad_units WHERE publisher_id = \? AND code = \?/.test(statement.sql)){fired=true;f.env.DB.prepare=original;await operation();}
  return value;
 }});
 f.env.DB.prepare=sql=>wrap(original(sql));
 return ()=>assert(fired,'interleaving was not injected');
}

test('a create, copy or Refresh save for a position renamed or deleted right after its target check is refused; nothing is written',async()=>{
 const saves=[['Unit rules create',f=>createUnitRule(request({ruleKey:'P1',rule:{timeout:1800,refresh:{enabled:true,minSeconds:60}}},'POST'),f.env,SITE)],
  ['Unit rules copy',f=>duplicateUnitRule(request({ruleKey:'P1'},'POST'),f.env,SITE,'__ATF__')],
  ['Refresh schedules save',f=>updateAdvancedRule(refreshForm(1800,60,null),f.env,SITE,'P1')]];
 for(const [name,save] of saves)for(const edit of [f=>updateAdUnit(request({code:'P2'}),f.env,SITE,'audit-unit'),f=>deleteAdUnit(request({},'DELETE'),f.env,SITE,'audit-unit')]){
  const f=setup();seedRule(f,{key:'__ATF__',rule:{timeout:2200}});
  const before=f.readConfig(),beforeRows=rows(f),count=audits(f).length;
  const injected=afterTargetCheck(f,async()=>ok(await edit(f)));
  await refused(await save(f),409,/P1 was renamed or deleted in Ad units .*so nothing was saved/);injected();
  assert.deepEqual(rows(f),beforeRows,name);assert.deepEqual(f.readConfig().unitRules,before.unitRules,name);
  assert.equal(f.readConfig().advancedUnitRules?.P1,undefined,`${name}: no record under the old code`);
  assert(audits(f).slice(count).every(action=>action.startsWith('ad_unit.')),`${name}: only the ad-unit edit is audited`);
 }
});

test('a rename or group change without a rule row leaves a config without a mirror, and delete residue, as stored',async()=>{
 // The fixture config has no config.unitRules; nothing here carries a row.
 const f=setup();const legacy=JSON.stringify(f.readConfig());
 await ok(await updateAdUnit(request({type:'ATF'}),f.env,SITE,'audit-unit'));
 await ok(await updateAdUnit(request({code:'P9'}),f.env,SITE,'audit-unit'));
 assert.equal(JSON.stringify(f.readConfig()),legacy);
 // A deleted position leaves its mirror entry (delete cleanup is a separate task).
 const p2=await ok(await createAdUnit(request({code:'P2',type:'BTF',sizeMapKey:'display'},'POST'),f.env,SITE),201);
 await ok(await createUnitRule(request({ruleKey:'P2',rule:{timeout:1200}},'POST'),f.env,SITE),201);
 await ok(await deleteAdUnit(request({},'DELETE'),f.env,SITE,p2.adUnit.id));
 const residue=JSON.stringify(f.readConfig());assert.deepEqual(f.readConfig().unitRules,{P2:{timeout:1200}});
 await ok(await updateAdUnit(request({type:'BTF'}),f.env,SITE,'audit-unit'));
 await ok(await updateAdUnit(request({code:'P1'}),f.env,SITE,'audit-unit'));
 assert.equal(JSON.stringify(f.readConfig()),residue);
});

// A deleted position leaves its Refresh schedules record behind, and the generated CMP wait
// is the longest of every record. Re-using such a code stays exactly as before this change
// (cleanup on delete is a separate task): a copy or rename onto it does not replace, move
// into or remove that record, so the generated CMP wait does not change.
async function leftoverSite(){
 // P1 keeps 60 s with timeout 1800 under the Default sequence; P2 had a CMP wait of 5000 ms and is deleted.
 const f=await positionWithInterval({timeout:1800});
 const p2=await ok(await createAdUnit(request({code:'P2',type:'BTF',sizeMapKey:'display'},'POST'),f.env,SITE),201);
 await ok(await createUnitRule(request({ruleKey:'P2',rule:{timeout:1200,refresh:{enabled:true,minSeconds:45}}},'POST'),f.env,SITE),201);
 await ok(await updateAdvancedRule(request({cmpTimeout:5000},'PUT'),f.env,SITE,'P2'));
 await ok(await deleteAdUnit(request({},'DELETE'),f.env,SITE,p2.adUnit.id));
 const config=f.readConfig();assert.equal(config.advancedUnitRules.P2.cmpTimeout,5000);assert(config.unitRules.P2);
 const cmp=await generatedCmpTimeouts(f);for(const version of ['3.16.1','3.16.2'])assert.deepEqual(cmp[version],{maxCmpTimeout:5000,timeout:5000,actionTimeout:5000});
 return {f,config,cmp};
}

test('a copy or rename onto a code a deleted position left settings under keeps them and the generated CMP wait',async()=>{
 const p3=async f=>(await ok(await createAdUnit(request({code:'P3',type:'BTF',sizeMapKey:'display'},'POST'),f.env,SITE),201)).adUnit.id;
 for(const [name,run] of [
  ['copy without its unit rule',f=>duplicateAdUnit(request({code:'P2',copyUnitRule:false},'POST'),f.env,SITE,'audit-unit')],
  ['copy with its unit rule',f=>duplicateAdUnit(request({code:'P2'},'POST'),f.env,SITE,'audit-unit')],
  ['rename of a position with a rule and a record',f=>updateAdUnit(request({code:'P2'}),f.env,SITE,'audit-unit')],
  ['rename of a position without a rule',async f=>updateAdUnit(request({code:'P2'}),f.env,SITE,await p3(f))],
 ]){
  const {f,config,cmp}=await leftoverSite();const status=name.startsWith('copy')?201:200;
  const response=await ok(await run(f),status);assert.deepEqual(response.keptUnitRuleIntervals,[],name);
  const after=f.readConfig();
  assert.deepEqual(after.advancedUnitRules.P2,config.advancedUnitRules.P2,`${name}: the left record stays as stored`);
  assert.deepEqual(await generatedCmpTimeouts(f),cmp,`${name}: the generated CMP wait is unchanged`);
  const ruleKeys=rows(f).map(r=>r.rule_key);
  if(name==='copy with its unit rule'){
   assert.deepEqual(ruleKeys,['P1','P2','__DEFAULT__']);assert.deepEqual(after.unitRules.P2,after.unitRules.P1,'the mirror follows the copied row');
   assert.deepEqual(after.advancedUnitRules.P1,config.advancedUnitRules.P1);
  }else if(name==='rename of a position with a rule and a record'){
   assert.deepEqual(ruleKeys,['P2','__DEFAULT__']);assert.deepEqual(after.unitRules,{__DEFAULT__:config.unitRules.__DEFAULT__,P2:config.unitRules.P1},'the mirror follows the moved row');
   assert.deepEqual(after.advancedUnitRules.P1,config.advancedUnitRules.P1,'the record does not move into the left one (as before this change)');
  }else{
   assert.deepEqual(after,config,`${name}: nothing is carried, so site settings stay as stored`);
  }
 }
});
// Point 3a: the editor sends the version it loaded. A tab opened before another tab's
// save is refused instead of putting back values it never changed.
const listed=async(f,key)=>(await (await listUnitRules(f.env,SITE)).json()).unitRules.find(r=>r.ruleKey===key);
// Interval the generated 3.16.1 script uses for P1 (BTF), merged Default -> BTF -> P1 like the runtime.
const p1Interval=async f=>{const rules=previewInput(await readPreviewSnapshot(f.env.DB,SITE),runtimeCatalog.find(r=>r.version==='3.16.1'),'20261024_120000').core.adUnitRules??{};return intervalText(mergeRefresh(...ruleChain('P1','BTF').map(k=>rules[k]?.refresh)));};
for(const frozen of [false,true]){
 test(`stale Unit rules editor: changing only the timeout cannot put the interval back from 75 to 60 s${frozen?' (same millisecond)':''}`,async t=>{
  if(frozen)t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-24T12:00:00.000Z')});
  const f=setup();await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:2500,refresh:refresh(60)}},'POST'),f.env,SITE),201);
  const tabA=await listed(f,'P1'),tabB=await listed(f,'P1');
  await ok(await updateUnitRule(request({rule:{...tabB.rule,refresh:refresh(75)},expectedUpdatedAt:tabB.updatedAt}),f.env,SITE,tabB.id));
  await refused(await updateUnitRule(request({rule:{...tabA.rule,timeout:1200},expectedUpdatedAt:tabA.updatedAt}),f.env,SITE,tabA.id),409,/changed in another tab/);
  assert.deepEqual(JSON.parse(rows(f)[0].rule_json),{timeout:2500,refresh:refresh(75)});assert.equal(await p1Interval(f),'75s');
  assert.deepEqual(audits(f),['unit_rule.created','unit_rule.updated']);assertConsistent(f);
  const reloaded=await listed(f,'P1');
  const saved=await ok(await updateUnitRule(request({rule:{...reloaded.rule,timeout:1200},expectedUpdatedAt:reloaded.updatedAt}),f.env,SITE,reloaded.id));
  assert.deepEqual(saved.unitRule.rule,{timeout:1200,refresh:refresh(75)});assert.equal(await p1Interval(f),'75s');assertConsistent(f);
 });
}

test('Unit rules and Refresh saves without the expected fields keep the previous contract for other callers',async()=>{
 const f=setup();const created=await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:2500}},'POST'),f.env,SITE),201);
 await ok(await updateUnitRule(request({rule:{timeout:1500}}),f.env,SITE,created.unitRule.id));
 await ok(await updateUnitRule(request({rule:{timeout:1200}}),f.env,SITE,created.unitRule.id));
 assert.equal(JSON.parse(rows(f)[0].rule_json).timeout,1200);assertConsistent(f);
 await ok(await updateAdvancedRule(request({timeout:1300},'PUT'),f.env,SITE,'P1'));
 await ok(await updateAdvancedRule(request({timeout:1400},'PUT'),f.env,SITE,'P1'));
 assert.equal(JSON.parse(rows(f)[0].rule_json).timeout,1400);assert.equal(f.readConfig().advancedUnitRules.P1.timeout,1400);assertConsistent(f);
});

// The Refresh tab's own read: the advanced records and every scope's Unit rules row, one response.
const refreshTab=async(f,key)=>{const body=await ok(await listAdvancedRules(f.env,SITE));return {advanced:body.advancedRules[key],row:body.unitRuleRows[key]??null,body};};
const refreshForm=(timeout,n,row)=>request({expectedUpdatedAt:row?.updatedAt??null,expectedUnitRuleId:row?.id??null,timeout,cmpTimeout:1500,refresh:{enabled:true,minViewPct:50,schedule:{mode:'fixed',fixedSeconds:n}}},'PUT');

test('stale Refresh tab: an older schedule is not put back and a rule deleted in Unit rules is not re-created',async()=>{
 const f=setup();
 await refused(await updateAdvancedRule(refreshForm(2500,60,{updatedAt:'2026-10-24T12:00:00.000Z',id:'P1'}),f.env,SITE,'P1'),409,/changed in another tab/);
 assert.deepEqual(rows(f),[],'a version for a scope without a row is refused');
 await ok(await updateAdvancedRule(refreshForm(2500,60,null),f.env,SITE,'P1'));
 const {row:loaded}=await refreshTab(f,'P1');
 await refused(await updateAdvancedRule(refreshForm(2500,60,null),f.env,SITE,'P1'),409,/changed in another tab/);
 await ok(await updateAdvancedRule(refreshForm(2500,75,loaded),f.env,SITE,'P1'));
 await refused(await updateAdvancedRule(refreshForm(1200,60,loaded),f.env,SITE,'P1'),409,/changed in another tab/);
 assert.equal(f.readConfig().advancedUnitRules.P1.timeout,2500);assert.equal(f.readConfig().advancedUnitRules.P1.refresh.schedule.fixedSeconds,75);assert.equal(await p1Interval(f),'75s');
 assert.deepEqual(audits(f),['unit_rule.advanced_updated','unit_rule.advanced_updated']);assertConsistent(f);
 const {row:current}=await refreshTab(f,'P1');
 await ok(await deleteUnitRule(request({},'DELETE'),f.env,SITE,current.id));
 await refused(await updateAdvancedRule(refreshForm(1200,60,current),f.env,SITE,'P1'),409,/changed in another tab/);
 assert.deepEqual(rows(f),[]);assert.equal(f.readConfig().advancedUnitRules?.P1,undefined);assertConsistent(f);
 const {row:gone}=await refreshTab(f,'P1');assert.equal(gone,null,'the reload shows the rule as deleted');
 await ok(await updateAdvancedRule(refreshForm(1200,60,gone),f.env,SITE,'P1'));
 assert.equal(JSON.parse(rows(f)[0].rule_json).timeout,1200,'saving from the reloaded state creates the rule again');assertConsistent(f);
});

test('stale Refresh tab: a rule deleted and re-created in the same millisecond is not overwritten',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-24T12:00:00.000Z')});
 const f=setup();
 await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:2500,refresh:refresh(60)}},'POST'),f.env,SITE),201);
 const {row:tabA}=await refreshTab(f,'P1');
 await ok(await deleteUnitRule(request({},'DELETE'),f.env,SITE,tabA.id));
 await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:2500,refresh:refresh(75)}},'POST'),f.env,SITE),201);
 const {row:recreated}=await refreshTab(f,'P1');assert.equal(recreated.updatedAt,tabA.updatedAt,'same millisecond: only the id tells the rows apart');
 await refused(await updateAdvancedRule(refreshForm(1200,60,tabA),f.env,SITE,'P1'),409,/changed in another tab/);
 assert.equal(JSON.parse(rows(f)[0].rule_json).refresh.minSeconds,75);assert.equal(await p1Interval(f),'75s');assertConsistent(f);
 await ok(await updateAdvancedRule(refreshForm(1200,75,recreated),f.env,SITE,'P1'));assert.equal(await p1Interval(f),'75s');assertConsistent(f);
});

test('Refresh listing returns each scope with its Unit rules row version from the same read',async()=>{
 const f=setup();
 await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:2500,refresh:refresh(60)}},'POST'),f.env,SITE),201);
 await ok(await updateAdvancedRule(refreshForm(2500,60,(await refreshTab(f,'P1')).row),f.env,SITE,'P1'));
 const {body}=await refreshTab(f,'P1');
 const stored=f.sqlite.prepare('SELECT id,rule_key,rule_json,updated_at FROM unit_rules WHERE publisher_id=?').all(SITE);
 assert.deepEqual(body.unitRuleRows,Object.fromEntries(stored.map(r=>[r.rule_key,{id:r.id,ruleKey:r.rule_key,updatedAt:r.updated_at,rule:JSON.parse(r.rule_json)}])));
 assert.deepEqual(body.advancedRules,f.readConfig().advancedUnitRules);
 // Another tab saves P1 = 75 s while the listing reads: whatever the timing, the schedule and
 // the version in the response belong to one saved state, never 60 s with the 75 s version.
 const before={fixed:60,version:body.unitRuleRows.P1.updatedAt};
 const original={prepare:f.env.DB.prepare,batch:f.env.DB.batch};let fired=false;
 const other=async()=>{if(fired)return;fired=true;Object.assign(f.env.DB,original);await ok(await updateAdvancedRule(refreshForm(2500,75,body.unitRuleRows.P1),f.env,SITE,'P1'));};
 const wrap=statement=>({...statement,bind(...args){return wrap(statement.bind(...args));},
  async first(){const value=await statement.first();if(/FROM (publisher_configs|unit_rules)/.test(statement.sql))await other();return value;},
  async all(){const value=await statement.all();if(/FROM (publisher_configs|unit_rules)/.test(statement.sql))await other();return value;}});
 f.env.DB.prepare=sql=>wrap(original.prepare(sql));
 f.env.DB.batch=async items=>{const value=await original.batch.call(f.env.DB,items);await other();return value;};
 const raced=await ok(await listAdvancedRules(f.env,SITE));assert(fired,'interleaving was not injected');
 const after={fixed:75,version:f.sqlite.prepare("SELECT updated_at FROM unit_rules WHERE rule_key='P1'").get().updated_at};
 const pair={fixed:raced.advancedRules.P1.refresh.schedule.fixedSeconds,version:raced.unitRuleRows.P1.updatedAt};
 assert(JSON.stringify(pair)===JSON.stringify(before)||JSON.stringify(pair)===JSON.stringify(after),`schedule and version from different reads: ${JSON.stringify(pair)}`);
 // A tab that built its form from that response cannot put 60 s back over the newer save.
 if(pair.fixed===60)await refused(await updateAdvancedRule(refreshForm(1200,60,raced.unitRuleRows.P1),f.env,SITE,'P1'),409,/changed in another tab/);
 assert.equal(await p1Interval(f),'75s');assertConsistent(f);
});

for(const frozen of [false,true]){
 test(`Refresh tab saves again against the version its own save returned${frozen?' (same millisecond)':''}`,async t=>{
  if(frozen)t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-24T12:00:00.000Z')});
  const f=setup();
  await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:2500,refresh:refresh(60)}},'POST'),f.env,SITE),201);
  const {row:loaded}=await refreshTab(f,'P1');
  // Tab A saves; the response names the row it wrote.
  const savedA=await ok(await updateAdvancedRule(refreshForm(2500,60,loaded),f.env,SITE,'P1'));
  const stored=f.sqlite.prepare("SELECT id,rule_key,rule_json,updated_at FROM unit_rules WHERE rule_key='P1'").get();
  assert.deepEqual(savedA.unitRule,{id:stored.id,ruleKey:'P1',updatedAt:stored.updated_at,rule:JSON.parse(stored.rule_json)});
  assert.equal(savedA.unitRule.id,loaded.id);assert.notEqual(savedA.unitRule.updatedAt,loaded.updatedAt,'the save moved the version');
  assert.deepEqual(savedA.advancedRule,f.readConfig().advancedUnitRules.P1);
  // Tab B saves 75 s against its own fresh read.
  const {row:tabB}=await refreshTab(f,'P1');assert.deepEqual(tabB,savedA.unitRule);
  const savedB=await ok(await updateAdvancedRule(refreshForm(2500,75,tabB),f.env,SITE,'P1'));
  assert.notEqual(savedB.unitRule.updatedAt,savedA.unitRule.updatedAt);
  // Tab A changes only the timeout and saves from its baseline: refused, 75 s stays.
  await refused(await updateAdvancedRule(refreshForm(1200,60,savedA.unitRule),f.env,SITE,'P1'),409,/changed in another tab/);
  assert.equal(await p1Interval(f),'75s');assert.equal(f.readConfig().advancedUnitRules.P1.timeout,2500);
  assert.deepEqual(audits(f),['unit_rule.created','unit_rule.advanced_updated','unit_rule.advanced_updated']);assertConsistent(f);
  // A rule created by the Refresh tab returns its new row the same way.
  const {row:none}=await refreshTab(f,'__ATF__');assert.equal(none,null);
  const createdAtf=await ok(await updateAdvancedRule(refreshForm(2200,45,none),f.env,SITE,'__ATF__'));
  assert.deepEqual(createdAtf.unitRule,(await refreshTab(f,'__ATF__')).row);
  await ok(await updateAdvancedRule(refreshForm(2100,45,createdAtf.unitRule),f.env,SITE,'__ATF__'));assertConsistent(f);
 });
}

test('rebaseEdits: changed fields are carried, untouched fields take the saved values, both-changed fields are conflicts',()=>{
 const loaded={ruleKey:'P1',timeout:2500,minSeconds:60,checkEveryMs:5000,minViewPct:50,conditionalMappings:[{id:'m',priority:1}]};
 const saved={...loaded,minSeconds:75,checkEveryMs:4000,minViewPct:70,conditionalMappings:[{id:'m',priority:2}]};
 // This tab changed timeout (only here), minSeconds (also changed elsewhere, differently)
 // and minViewPct (also changed elsewhere, to the same value).
 const edited={...loaded,timeout:1200,minSeconds:90,minViewPct:70};
 const result=rebaseEdits(edited,loaded,saved);
 assert.deepEqual(result,{
  form:{ruleKey:'P1',timeout:1200,minSeconds:90,checkEveryMs:4000,minViewPct:70,conditionalMappings:[{id:'m',priority:2}]},
  changed:['timeout','minSeconds','minViewPct'],
  conflicts:['minSeconds'],
 });
 const labels={timeout:'Timeout',minSeconds:'Minimum time',minViewPct:'Minimum in view',conditionalMappings:'Key-value mappings'};
 const text=(key,value)=>key==='conditionalMappings'?`${value.length} mapping`:`${value}${key==='minSeconds'?' sec':key==='timeout'?' ms':'%'}`;
 assert.deepEqual(rebaseReview(result,saved,key=>labels[key],text),{conflicts:[{field:'Minimum time',yours:'90 sec',saved:'75 sec'}],applied:['Timeout','Minimum in view']});
 // Mappings are compared as a whole field; values that read the same are still told apart.
 const mappings=rebaseEdits({...loaded,conditionalMappings:[{id:'m',priority:3}]},loaded,saved);
 assert.deepEqual(mappings.conflicts,['conditionalMappings']);assert.deepEqual(mappings.form.conditionalMappings,[{id:'m',priority:3}]);
 assert.deepEqual(rebaseReview(mappings,saved,key=>labels[key],text).conflicts,[{field:'Key-value mappings',yours:'your version',saved:'a different version'}]);
 assert.deepEqual(rebaseEdits(loaded,loaded,saved),{form:saved,changed:[],conflicts:[]},'nothing changed here: the saved values as they are');
 assert.deepEqual(rebaseEdits(edited,loaded,loaded).conflicts,[],'nothing changed elsewhere: no conflicts');
});

test('rebaseEdits with gates: an override or strategy the other tab switched is the conflict, and the edited values stay in effect',()=>{
 // Unit rules dialog: the same gates as UnitRulesPanel (section overrides store nothing while off).
 const unitGates=[
  {gate:'overrideTimeout',fields:['timeout'],storedOnlyWhenUsed:true},
  {gate:'overrideRefresh',fields:['refreshEnabled','minSeconds','minViewPct','requirePreviousViewable','checkEveryMs'],storedOnlyWhenUsed:true},
  {gate:'refreshEnabled',fields:['minSeconds','minViewPct','requirePreviousViewable','checkEveryMs']},
 ];
 const loaded={ruleKey:'P1',overrideTimeout:true,timeout:2500,overrideRefresh:true,refreshEnabled:true,minSeconds:15,minViewPct:70,requirePreviousViewable:true,checkEveryMs:2000};
 // The other tab removed the refresh override; the saved form shows placeholders (30 sec, 50%, 5000 ms) it never saved.
 const overrideOff={...loaded,overrideRefresh:false,refreshEnabled:true,minSeconds:30,minViewPct:50,requirePreviousViewable:false,checkEveryMs:5000};
 const result=rebaseEdits({...loaded,minSeconds:20},loaded,overrideOff,unitGates);
 assert.deepEqual(result,{form:{...loaded,minSeconds:20},changed:['overrideRefresh','minSeconds'],conflicts:['overrideRefresh']});
 const labels={overrideRefresh:'Override inherited refresh',refreshEnabled:'Refresh enabled',minSeconds:'Minimum time',timeout:'Timeout'};
 const text=(key,value)=>typeof value==='boolean'?(value?'on':key.startsWith('override')?'off (inherited)':'off'):`${value}`;
 const review=rebaseReview(result,overrideOff,key=>labels[key],text);
 assert.deepEqual(review,{conflicts:[{field:'Override inherited refresh',yours:'on',saved:'off (inherited)'}],applied:['Minimum time']});
 assert.doesNotMatch(JSON.stringify(review),/30/,'a form default is never shown as the other tab\'s value');
 // A field this tab left alone follows the other tab: the override stays off, no conflict.
 assert.deepEqual(rebaseEdits({...loaded,timeout:1200},loaded,overrideOff,unitGates),{form:{...overrideOff,timeout:1200},changed:['timeout'],conflicts:[]});
 // The other tab turned refresh off but kept the override: the stored values are real, so untouched ones follow it.
 const disabled={...loaded,refreshEnabled:false,minViewPct:80};
 assert.deepEqual(rebaseEdits({...loaded,minSeconds:20},loaded,disabled,unitGates),{form:{...disabled,refreshEnabled:true,minSeconds:20},changed:['refreshEnabled','minSeconds'],conflicts:['refreshEnabled']});
 // Both tabs changed the same value under a section the other tab kept: the value is the conflict.
 assert.deepEqual(rebaseEdits({...loaded,minSeconds:20},loaded,{...loaded,minSeconds:45},unitGates).conflicts,['minSeconds']);

 // Refresh schedules: interval fields belong to their strategy, as in AdvancedRefreshPanel.
 const modeFields={fixed:['fixedSeconds'],firstThenFixed:['firstSeconds','nextSeconds'],percentage:['firstSeconds','growthPercent','maxSeconds'],sequence:['sequenceText']};
 const refreshGates=[
  {gate:'refreshEnabled',fields:['mode','fixedSeconds','firstSeconds','nextSeconds','growthPercent','maxSeconds','sequenceText','maxRefreshes']},
  {gate:'mode',fields:['fixedSeconds','firstSeconds','nextSeconds','growthPercent','maxSeconds','sequenceText'],uses:(mode,field)=>modeFields[mode]?.includes(field)??false},
 ];
 const schedule={refreshEnabled:true,mode:'sequence',fixedSeconds:15,firstSeconds:15,nextSeconds:15,growthPercent:20,maxSeconds:120,sequenceText:'15, 30',maxRefreshes:20};
 const switched={...schedule,mode:'fixed',fixedSeconds:40};
 const sequence=rebaseEdits({...schedule,sequenceText:'25, 50'},schedule,switched,refreshGates);
 // The other tab's 40 s applies only under its strategy, so the conflict names it too.
 assert.deepEqual(sequence,{form:{...switched,mode:'sequence',sequenceText:'25, 50'},changed:['mode','sequenceText'],conflicts:['mode'],switchedOff:{mode:['fixedSeconds']}});
 const modeText=(key,value)=>({fixed:'Same every time',sequence:'Explicit sequence',percentage:'Percentage increase'})[value]??(typeof value==='boolean'?(value?'on':'off'):key==='fixedSeconds'?`${value} sec`:`${value}`);
 const refreshLabels={refreshEnabled:'Refresh enabled',mode:'Interval strategy',fixedSeconds:'Every refresh',sequenceText:'Intervals, in seconds',maxRefreshes:'Maximum refreshes',maxSeconds:'Maximum interval'};
 assert.deepEqual(rebaseReview(sequence,switched,key=>refreshLabels[key],modeText),
  {conflicts:[{field:'Interval strategy',yours:'Explicit sequence',saved:'Same every time (Every refresh: 40 sec)'}],applied:['Intervals, in seconds']});
 // A field both strategies use keeps working under the other tab's strategy: no strategy conflict.
 const first={...schedule,mode:'firstThenFixed'};
 assert.deepEqual(rebaseEdits({...first,firstSeconds:25},first,{...first,mode:'percentage'},refreshGates),{form:{...first,mode:'percentage',firstSeconds:25},changed:['firstSeconds'],conflicts:[]});
 // The other tab disabled refresh while this tab changed an interval: refresh enabled is the conflict.
 assert.deepEqual(rebaseEdits({...schedule,sequenceText:'25, 50'},schedule,{...schedule,refreshEnabled:false,maxRefreshes:9},refreshGates),
  {form:{...schedule,maxRefreshes:9,sequenceText:'25, 50'},changed:['refreshEnabled','sequenceText'],conflicts:['refreshEnabled']});
 // This tab changed the strategy itself and the other tab chose a different one: one conflict, on the strategy.
 assert.deepEqual(rebaseEdits({...schedule,mode:'percentage',maxSeconds:90},schedule,switched,refreshGates),
  {form:{...switched,mode:'percentage',maxSeconds:90},changed:['mode','maxSeconds'],conflicts:['mode'],switchedOff:{mode:['fixedSeconds']}});
});

test('rebaseEdits with gates: a switch made here that turns off values the other tab changed is a conflict naming them',()=>{
 const unitGates=[
  {gate:'overrideTimeout',fields:['timeout'],storedOnlyWhenUsed:true},
  {gate:'overrideRefresh',fields:['refreshEnabled','minSeconds','minViewPct','requirePreviousViewable','checkEveryMs'],storedOnlyWhenUsed:true},
  {gate:'refreshEnabled',fields:['minSeconds','minViewPct','requirePreviousViewable','checkEveryMs']},
 ];
 const labels={overrideTimeout:'Override inherited timeout',timeout:'Timeout',overrideRefresh:'Override inherited refresh',refreshEnabled:'Refresh enabled',minSeconds:'Minimum time',minViewPct:'Minimum in view'};
 const text=(key,value)=>typeof value==='boolean'?(value?'on':key.startsWith('override')?'off (inherited)':'off'):`${value}${key==='minSeconds'?' sec':key==='timeout'?' ms':key==='minViewPct'?'%':''}`;
 const loaded={ruleKey:'P1',overrideTimeout:true,timeout:2500,overrideRefresh:true,refreshEnabled:true,minSeconds:15,minViewPct:70,requirePreviousViewable:true,checkEveryMs:2000};
 // This tab removed the refresh override; the other tab saved Minimum time 45 sec and 60% under it.
 const other={...loaded,minSeconds:45,minViewPct:60};
 const off=rebaseEdits({...loaded,overrideRefresh:false},loaded,other,unitGates);
 assert.deepEqual(off,{form:{...other,overrideRefresh:false},changed:['overrideRefresh'],conflicts:['overrideRefresh'],switchedOff:{overrideRefresh:['minSeconds','minViewPct']}});
 assert.deepEqual(rebaseReview(off,other,key=>labels[key],text),
  {conflicts:[{field:'Override inherited refresh',yours:'off (inherited)',saved:'on (Minimum time: 45 sec; Minimum in view: 60%)'}],applied:[]});
 // Turning refresh off under a kept override: the inner switch is the conflict.
 const disabled=rebaseEdits({...loaded,refreshEnabled:false,timeout:1200},loaded,{...loaded,minSeconds:45},unitGates);
 assert.deepEqual(disabled,{form:{...loaded,refreshEnabled:false,timeout:1200,minSeconds:45},changed:['timeout','refreshEnabled'],conflicts:['refreshEnabled'],switchedOff:{refreshEnabled:['minSeconds']}});
 assert.deepEqual(rebaseReview(disabled,{...loaded,minSeconds:45},key=>labels[key],text),
  {conflicts:[{field:'Refresh enabled',yours:'off',saved:'on (Minimum time: 45 sec)'}],applied:['Timeout']});
 // The other tab changed a value this tab's switch leaves in effect, or a form default it never saved: no conflict.
 assert.deepEqual(rebaseEdits({...loaded,overrideTimeout:false},loaded,other,unitGates),{form:{...other,overrideTimeout:false},changed:['overrideTimeout'],conflicts:[]});
 const inherited={...loaded,overrideRefresh:false,minSeconds:30,minViewPct:50};
 assert.deepEqual(rebaseEdits({...loaded,refreshEnabled:false},loaded,inherited,unitGates).switchedOff,undefined,'placeholders under the other tab\'s inherited section are not its values');
 // Both tabs switched the section off: nothing of the other tab's is lost.
 assert.deepEqual(rebaseEdits({...loaded,overrideRefresh:false},loaded,inherited,unitGates),{form:inherited,changed:['overrideRefresh'],conflicts:[]});

 // Refresh schedules: this tab switched the strategy or turned refresh off while the other tab changed the old strategy's intervals.
 const modeFields={fixed:['fixedSeconds'],firstThenFixed:['firstSeconds','nextSeconds'],percentage:['firstSeconds','growthPercent','maxSeconds'],sequence:['sequenceText']};
 const refreshGates=[
  {gate:'refreshEnabled',fields:['mode','fixedSeconds','firstSeconds','nextSeconds','growthPercent','maxSeconds','sequenceText','maxRefreshes']},
  {gate:'mode',fields:['fixedSeconds','firstSeconds','nextSeconds','growthPercent','maxSeconds','sequenceText'],uses:(mode,field)=>modeFields[mode]?.includes(field)??false},
 ];
 const schedule={refreshEnabled:true,mode:'sequence',fixedSeconds:15,firstSeconds:15,nextSeconds:15,growthPercent:20,maxSeconds:120,sequenceText:'15, 30',maxRefreshes:20};
 const longer={...schedule,sequenceText:'25, 50',maxRefreshes:12};
 const refreshLabels={refreshEnabled:'Refresh enabled',mode:'Interval strategy',fixedSeconds:'Every refresh',sequenceText:'Intervals, in seconds',maxRefreshes:'Maximum refreshes'};
 const refreshText=(key,value)=>({fixed:'Same every time',sequence:'Explicit sequence'})[value]??(typeof value==='boolean'?(value?'on':'off'):key==='fixedSeconds'?`${value} sec`:`${value}`);
 const toFixed=rebaseEdits({...schedule,mode:'fixed',fixedSeconds:45},schedule,longer,refreshGates);
 assert.deepEqual(toFixed,{form:{...longer,mode:'fixed',fixedSeconds:45},changed:['mode','fixedSeconds'],conflicts:['mode'],switchedOff:{mode:['sequenceText']}});
 assert.deepEqual(rebaseReview(toFixed,longer,key=>refreshLabels[key],refreshText),
  {conflicts:[{field:'Interval strategy',yours:'Same every time',saved:'Explicit sequence (Intervals, in seconds: 25, 50)'}],applied:['Every refresh']});
 // Refresh turned off here: every value of the other tab's that refresh used is named once, under the outer switch.
 const stopped=rebaseEdits({...schedule,refreshEnabled:false,mode:'fixed'},schedule,longer,refreshGates);
 assert.deepEqual(stopped.conflicts,['refreshEnabled']);assert.deepEqual(stopped.switchedOff,{refreshEnabled:['sequenceText','maxRefreshes']});
 assert.deepEqual(rebaseReview(stopped,longer,key=>refreshLabels[key],refreshText).conflicts,
  [{field:'Refresh enabled',yours:'off',saved:'on (Intervals, in seconds: 25, 50; Maximum refreshes: 12)'}]);
});

// Point 3b / D4: a whole-config writer that read config_json before another save must not
// write the older config back (unit rules, Refresh schedules, consent mode), and a refused
// write records no audit row.
// A kept interval owns only refresh, so check the mirror instead of assertConsistent's timeout rule.
const assertMirror=f=>assert.deepEqual(f.readConfig().unitRules,Object.fromEntries(rows(f).map(r=>[r.rule_key,JSON.parse(r.rule_json)])));
function afterConfigRead(f,operation){
 const original=f.env.DB.prepare;let fired=false;
 const wrap=statement=>({...statement,bind(...args){return wrap(statement.bind(...args));},async first(){
  const value=await statement.first();
  if(!fired&&/FROM publisher_configs/.test(statement.sql)){fired=true;f.env.DB.prepare=original;await operation();}
  return value;
 }});
 f.env.DB.prepare=sql=>wrap(original(sql));
 return ()=>assert(fired,'interleaving was not injected');
}
const auditCount=(f,action)=>f.sqlite.prepare('SELECT count(*) AS n FROM audit_log WHERE publisher_id=? AND action=?').get(SITE,action).n;
const schainBody=(consent='cmp',enabled=false)=>({schain:{enabled,version:'1.0',complete:1,nodes:enabled?[{asi:'example.com',sid:'pub-1',hp:1}]:[]},consent:{mode:consent}});
const writers=[
 {name:'User ID save',action:'user_id_config.updated',write:f=>updateUserIdConfig(request({enabled:true,auctionDelay:150,syncDelay:3000,syncsPerBidder:5,modules:[]},'PUT'),f.env,SITE),
  own:f=>f.readConfig().userIdConfig?.enabled===true},
 {name:'Supply-chain and consent save',action:'runtime_integrations.updated',write:(f,consent='cmp')=>updateRuntimeIntegrations(request(schainBody(consent,true),'PUT'),f.env,SITE),
  own:f=>f.readConfig().runtimeControls?.schain?.enabled===true},
];
for(const writer of writers){
 test(`${writer.name} that read the config before a Unit rules save is a 409, keeps the just-saved 60 s interval and records no audit`,async()=>{
  const f=setup();
  await ok(await updateAdvancedRule(request({timeout:2500,cmpTimeout:1500,refresh:{enabled:true,schedule:{mode:'sequence',sequenceSeconds:[20,40,80]}}},'PUT'),f.env,SITE,'__DEFAULT__'));
  const configBefore=f.readConfig(),auditsBefore=audits(f);
  const injected=afterConfigRead(f,async()=>{
   const saved=await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:2500,refresh:refresh(60)}},'POST'),f.env,SITE),201);
   assert.deepEqual(saved.keptUnitRuleIntervals,['P1']);
  });
  await refused(await writer.write(f),409,/saved at the same time, so nothing was saved\. Select Save again\./);injected();
  assert.equal(JSON.parse(rows(f)[0].rule_json).refresh.minSeconds,60);
  assert.equal(f.readConfig().advancedUnitRules.P1.refresh.schedule.fixedSeconds,60);assert.equal(await p1Interval(f),'60s');assertMirror(f);
  assert.equal(writer.own(f),false,'the refused write changed nothing of its own');
  assert.deepEqual(f.readConfig().userIdConfig,configBefore.userIdConfig);assert.deepEqual(f.readConfig().runtimeControls,configBefore.runtimeControls);
  assert.deepEqual(audits(f),[...auditsBefore,'unit_rule.created'],'only the Unit rules save is audited');assert.equal(auditCount(f,writer.action),0);
  // Select Save again: it now builds on the saved config and keeps the interval.
  await ok(await writer.write(f));
  assert.equal(writer.own(f),true);assert.equal(f.readConfig().advancedUnitRules.P1.refresh.schedule.fixedSeconds,60);assert.equal(await p1Interval(f),'60s');assertMirror(f);
  assert.deepEqual(audits(f),[...auditsBefore,'unit_rule.created',writer.action]);
 });
 test(`${writer.name} that read the config before a consent change is a 409 and does not revert the consent mode`,async()=>{
  const f=setup();const c=f.readConfig();c.runtimeControls={...c.runtimeControls,consent:{mode:'contextual-test'}};f.writeConfig(c);
  const auditsBefore=audits(f);
  // Another tab sets consent back to the CMP while this request is between its read and its
  // write; the Supply-chain request still carries the contextual-test mode its form loaded.
  const injected=afterConfigRead(f,async()=>ok(await updateRuntimeIntegrations(request(schainBody('cmp'),'PUT'),f.env,SITE)));
  await refused(await writer.write(f,'contextual-test'),409,/saved at the same time/);injected();
  assert.equal(f.readConfig().runtimeControls.consent.mode,'cmp','the CMP choice saved in between stays');
  assert.equal(writer.own(f),false);assert.equal(f.readConfig().runtimeControls.schain.enabled,false);
  assert.deepEqual(audits(f),[...auditsBefore,'runtime_integrations.updated'],'only the consent save is audited');
  assert.equal(auditCount(f,writer.action),writer.action==='runtime_integrations.updated'?1:0);
 });
}
