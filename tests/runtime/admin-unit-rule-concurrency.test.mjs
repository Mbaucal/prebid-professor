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
import {rebaseEdits,rebaseReview,rebasedBaseline} from '../../src/edit-rebase.ts';
import {FIELD_LABELS,FORM_GATES,dialogAfterRefusal,fieldText,formFromRule,ruleFromForm} from '../../src/unit-rule-form.ts';
import * as refreshTabForm from '../../src/refresh-form.ts';
import {intervalText,mergeRefresh,ruleChain,scheduledSeconds} from '../../worker/refresh-inheritance.ts';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {readPreviewSnapshot} from '../../worker/runtime/builtin-preview-service.mjs';
import {previewInput,runtimeCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';
import {createAdUnit,updateAdUnit,duplicateAdUnit,deleteAdUnit} from '../../worker/ad-units.ts';
import {generatedCmpTimeouts,generatedIntervals,legacyGeneratedRefresh} from '../support/generated-refresh.mjs';

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
 assert.deepEqual(body.unitTypes,{P1:'BTF'},'each position\'s group comes from the same read');
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

// The Refresh tab as AdvancedRefreshPanel runs it: one listing read, the scope's form
// (src/refresh-form.ts), optional edits through the same helper the inputs use, and Save.
async function refreshTabSave(f,key,edits={}){
 const body=await ok(await listAdvancedRules(f.env,SITE));
 const baseline=refreshTabForm.baselineFromListing(key,body);
 const form=Object.entries(edits).reduce((current,[field,value])=>refreshTabForm.withEdit(current,field,value),baseline.form);
 const sent={expectedUpdatedAt:baseline.updatedAt,expectedUnitRuleId:baseline.rowId,...refreshTabForm.requestBody(form,baseline)};
 return {baseline,sent,saved:await ok(await updateAdvancedRule(request(sent,'PUT'),f.env,SITE,key))};
}
// What a position resolves to from per-scope rules, as the generated getAdUnitRuntimeRule merges
// Default, its group and the position: the last scope that sets a timeout wins.
function resolvedFrom(rules,code,type='BTF'){
 const scopes=ruleChain(code,type).map(key=>rules[key]??{}),last=field=>scopes.map(scope=>scope[field]).filter(value=>value!=null).at(-1);
 return {timeout:last('timeout'),cmpTimeout:last('cmpTimeout'),interval:intervalText(mergeRefresh(...scopes.map(scope=>scope.refresh)))};
}
// The same from the stored rows and records (row, then Refresh record on top, like the preview).
// Used where per-slot lazy load keeps the preview from compiling.
const storedRules=f=>{const config=f.readConfig(),byKey=Object.fromEntries(rows(f).map(r=>[r.rule_key,JSON.parse(r.rule_json)]));
 return Object.fromEntries([...new Set([...Object.keys(byKey),...Object.keys(config.advancedUnitRules??{})])].map(key=>[key,mergeRefresh(byKey[key],config.advancedUnitRules?.[key])]));};

test('Refresh tab, unchanged save: a position whose Refresh record holds only lazy load keeps its Unit rules 1800 ms and 45 s',async()=>{
 const f=setup();
 await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:1800,refresh:refresh(45)}},'POST'),f.env,SITE),201);
 assert.equal(f.readConfig().advancedUnitRules?.P1,undefined);
 // An Ad positions save then stores P1's lazy load, as worker/site-runtime/service.mjs does:
 // `advancedUnitRules[code] ??= {}` and its `lazy`, so the Refresh record holds only lazy load.
 const config=f.readConfig();config.advancedUnitRules={...config.advancedUnitRules,P1:{lazy}};f.writeConfig(config);
 const before=resolvedFrom(storedRules(f),'P1');assert.deepEqual(before,{timeout:1800,cmpTimeout:undefined,interval:'45s'});
 const {baseline,sent}=await refreshTabSave(f,'P1');
 const {form}=baseline;
 assert.deepEqual([form.ownTimeout,form.timeout,form.ownCmpTimeout,form.cmpTimeout,form.ownRefresh,form.mode,form.fixedSeconds],[true,1800,false,1500,true,'fixed',45],'the tab shows what P1 stores');
 assert.equal(Object.hasOwn(sent,'cmpTimeout'),false,'the inherited CMP wait is not sent');
 assert.deepEqual(resolvedFrom(storedRules(f),'P1'),before,'an unchanged save keeps 1800 ms and 45 s');
 assert.deepEqual(f.readConfig().advancedUnitRules.P1.lazy,lazy);assertConsistent(f);
});

for(const via of ['a Unit rules save','an ad-unit group change']){
 test(`Refresh tab, unchanged save: a kept interval made by ${via} keeps the inherited 1800 ms and CMP 3000 ms in 3.16.1 and 3.16.2`,async()=>{
  const f=setup();
  // Default sets the timeouts; a group has its own schedule; P1 (BTF) has only an interval in Unit rules.
  await ok(await updateAdvancedRule(request({timeout:1800,cmpTimeout:3000},'PUT'),f.env,SITE,'__DEFAULT__'));
  if(via==='a Unit rules save'){
   await ok(await updateAdvancedRule(request({refresh:{enabled:true,schedule:SEQUENCE}},'PUT'),f.env,SITE,'__BTF__'));
   assert.deepEqual((await ok(await createUnitRule(request({ruleKey:'P1',rule:{refresh:{enabled:true,minSeconds:60}}},'POST'),f.env,SITE),201)).keptUnitRuleIntervals,['P1']);
  }else{
   await ok(await updateAdvancedRule(request({refresh:{enabled:true,schedule:SEQUENCE}},'PUT'),f.env,SITE,'__ATF__'));
   assert.deepEqual((await ok(await createUnitRule(request({ruleKey:'P1',rule:{refresh:{enabled:true,minSeconds:60}}},'POST'),f.env,SITE),201)).keptUnitRuleIntervals,[]);
   assert.deepEqual((await ok(await updateAdUnit(request({type:'ATF'}),f.env,SITE,'audit-unit'))).keptUnitRuleIntervals,['P1']);
  }
  const type=adUnitRow(f,'P1').type,record=f.readConfig().advancedUnitRules.P1,row=rows(f).find(r=>r.rule_key==='P1').rule_json;
  assert.deepEqual([Object.hasOwn(record,'timeout'),Object.hasOwn(record,'cmpTimeout'),record.refresh.schedule],[false,false,FIXED_SIXTY],'the kept interval owns only refresh');
  const generated=async()=>{const result=await generatedIntervals(f,['P1']),cmp=await generatedCmpTimeouts(f);
   return ['3.16.1','3.16.2'].map(version=>({...resolvedFrom(result['rules '+version],'P1',type),intervals:[result[version+' P1'],result[version+' P1 mobile']],
    summaryTimeout:result['summary '+version].units.find(unit=>unit.code==='P1').timeout,maxCmp:cmp[version].maxCmpTimeout}));};
  const before=await generated();
  for(const each of before)assert.deepEqual(each,{timeout:1800,cmpTimeout:3000,interval:'60s',intervals:[SIXTY,SIXTY],summaryTimeout:1800,maxCmp:3000});
  const {baseline,sent}=await refreshTabSave(f,'P1');
  const {form}=baseline;
  assert.deepEqual([form.ownTimeout,form.timeout,form.ownCmpTimeout,form.cmpTimeout,form.ownRefresh,form.fixedSeconds],[false,1800,false,3000,true,60],'the tab shows the inherited timeouts');
  assert.deepEqual(refreshTabForm.inheritedFrom('P1',type,(await ok(await listAdvancedRules(f.env,SITE))).advancedRules,{}).ownTimeout,'__DEFAULT__');
  assert.equal(Object.hasOwn(sent,'timeout')||Object.hasOwn(sent,'cmpTimeout'),false,'inherited timeouts are not sent');
  assert.deepEqual(await generated(),before,'an unchanged save keeps 1800 ms, CMP 3000 ms and 60 s');
  const after=f.readConfig().advancedUnitRules.P1;
  assert.deepEqual([Object.hasOwn(after,'timeout'),Object.hasOwn(after,'cmpTimeout')],[false,false]);assert.equal(rows(f).find(r=>r.rule_key==='P1').rule_json,row,'the Unit rules row is unchanged');
  // Entering a timeout here sets it for P1 only, and the CMP wait stays inherited.
  await refreshTabSave(f,'P1',{timeout:1200});
  const edited=await generated();for(const each of edited)assert.deepEqual([each.timeout,each.cmpTimeout,each.interval],[1200,3000,'60s']);
  assert.equal(JSON.parse(rows(f).find(r=>r.rule_key==='P1').rule_json).timeout,1200);assertConsistent(f);
 });
}

test('Refresh tab: a scope that stores nothing has nothing to save, and a save never writes an empty refresh into its Unit rules row',async()=>{
 const f=setup();
 await ok(await updateAdvancedRule(request({timeout:1800,cmpTimeout:3000,refresh:{enabled:true,schedule:SEQUENCE}},'PUT'),f.env,SITE,'__DEFAULT__'));
 const body=await ok(await listAdvancedRules(f.env,SITE));
 const p1Baseline=refreshTabForm.baselineFor('P1','BTF',body.advancedRules,body.unitRuleRows),p1=p1Baseline.form;
 assert.equal(refreshTabForm.storesNothing(p1),true);assert.deepEqual(refreshTabForm.requestBody(p1,p1Baseline),{});
 assert.deepEqual([p1.timeout,p1.cmpTimeout,p1.mode,p1.sequenceText],[1800,3000,'sequence','20, 40, 80'],'the inherited values are shown');
 // A timeout-only Unit rules rule: a CMP wait entered here leaves its row without a refresh section.
 await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:1200}},'POST'),f.env,SITE),201);
 await refreshTabSave(f,'P1',{cmpTimeout:2000});
 assert.deepEqual(JSON.parse(rows(f).find(r=>r.rule_key==='P1').rule_json),{timeout:1200});
 assert.deepEqual(f.readConfig().advancedUnitRules.P1,{timeout:1200,cmpTimeout:2000});assertConsistent(f);
});

test('Refresh tab after a 409: the other tab\'s removed refresh override is named as inherited, not as the form defaults, and is not put back',async()=>{
 const f=setup();
 // P1 has an interval and Enter at 70% in Unit rules and no Refresh record.
 await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:1800,refresh:{...refresh(45),minViewPct:70}}},'POST'),f.env,SITE),201);
 const opened=await ok(await listAdvancedRules(f.env,SITE));
 const loaded=refreshTabForm.baselineFor('P1','BTF',opened.advancedRules,opened.unitRuleRows);
 assert.deepEqual([loaded.form.fixedSeconds,loaded.form.minViewPct],[45,70]);
 // Unit rules removes the refresh override; this tab changes Enter at to 80% and is refused.
 const tab=await listed(f,'P1');
 await ok(await updateUnitRule(request({rule:{timeout:1800},expectedUpdatedAt:tab.updatedAt}),f.env,SITE,tab.id));
 const edited=refreshTabForm.withEdit(loaded.form,'minViewPct',80);
 await refused(await updateAdvancedRule(request({expectedUpdatedAt:loaded.updatedAt,expectedUnitRuleId:loaded.rowId,...refreshTabForm.requestBody(edited,loaded)},'PUT'),f.env,SITE,'P1'),409,/changed in another tab/);
 const latest=await ok(await listAdvancedRules(f.env,SITE));
 const current=refreshTabForm.baselineFor('P1','BTF',latest.advancedRules,latest.unitRuleRows);
 assert.equal(current.form.ownRefresh,false);
 const rebased=rebaseEdits(edited,loaded.form,current.form,refreshTabForm.FORM_GATES,{unstored:{loaded:loaded.unstored,saved:current.unstored}});
 const review=rebaseReview(rebased,current.form,key=>refreshTabForm.FIELD_LABELS[key],refreshTabForm.fieldText);
 assert.deepEqual(review,{conflicts:[{field:'Refresh settings',yours:'set for this scope',saved:'inherited'}],applied:['Enter at']});
 assert.doesNotMatch(JSON.stringify(review),/50%|30 sec/,'a form default is never shown as the other tab\'s value');
 assert.deepEqual(rebased.form,{...current.form,ownRefresh:true,minViewPct:80},
  'only the value entered here is applied: the interval the other tab removed shows what P1 inherits now');
 assert.notEqual(rebased.form.fixedSeconds,45);
});

// The Refresh tab after a 409, as AdvancedRefreshPanel runs it: a fresh listing read, then
// afterRefusal, which rebases on what each read stores and returns the next save's baseline.
async function refreshTabRebase(f,loaded,edited,key='P1'){
 const latest=await ok(await listAdvancedRules(f.env,SITE));
 const current=refreshTabForm.baselineFromListing(key,latest);
 const outcome=refreshTabForm.afterRefusal(edited,loaded,current);
 return {current,outcome,form:outcome.form,review:outcome.review,next:outcome.next};
}
const refreshTabPut=(baseline,form)=>request({expectedUpdatedAt:baseline.updatedAt,expectedUnitRuleId:baseline.rowId,...refreshTabForm.requestBody(form,baseline)},'PUT');

test('Refresh tab: a refresh section filled from a Default changed since it loaded is refused, the rebase names the change, and a reviewed save applies',async()=>{
 const f=setup();
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:15,schedule:SEQUENCE}},'PUT'),f.env,SITE,'__DEFAULT__'));
 const opened=await ok(await listAdvancedRules(f.env,SITE));
 const loaded=refreshTabForm.baselineFor('P1','BTF',opened.advancedRules,opened.unitRuleRows);
 assert.deepEqual([loaded.form.ownRefresh,loaded.form.refreshEnabled,loaded.form.maxRefreshes],[false,true,15]);
 // Another tab turns Default refresh off; this tab sets Maximum refreshes for P1, which saves
 // the whole refresh section with the values it shows from Default.
 await ok(await updateAdvancedRule(request({refresh:{enabled:false,maxRefreshes:15,schedule:SEQUENCE}},'PUT'),f.env,SITE,'__DEFAULT__'));
 const edited=refreshTabForm.withEdit(loaded.form,'maxRefreshes',5);
 const before=f.readConfig(),beforeRows=rows(f),saves=auditCount(f,'unit_rule.advanced_updated');
 await refused(await updateAdvancedRule(refreshTabPut(loaded,edited),f.env,SITE,'P1'),409,/changed in another tab/);
 assert.deepEqual(f.readConfig(),before,'nothing was written');assert.deepEqual(rows(f),beforeRows);
 assert.equal(auditCount(f,'unit_rule.advanced_updated'),saves,'a refused save records no audit row');
 const {current,outcome,form,review,next}=await refreshTabRebase(f,loaded,edited);
 assert.equal(current.form.refreshEnabled,false,'the reloaded form shows Default refresh off');
 assert.deepEqual([outcome.kind,outcome.cause],['rebased','parents'],'only the settings P1 inherits changed');
 assert.deepEqual(review,{conflicts:[{field:'Refresh enabled',yours:'on',saved:'off'}],applied:['Refresh settings','Maximum refreshes']});
 // Saving after the review is this tab's choice, checked against the parents it reloaded.
 const reviewed=refreshTabForm.requestBody(form,next);
 assert.deepEqual([Object.hasOwn(reviewed,'timeout'),Object.hasOwn(reviewed,'cmpTimeout')],[false,false],'a refresh edit leaves the inherited timeouts out');
 await ok(await updateAdvancedRule(refreshTabPut(next,form),f.env,SITE,'P1'));
 const p1=f.readConfig().advancedUnitRules.P1.refresh;
 assert.deepEqual([p1.enabled,p1.maxRefreshes,p1.schedule.sequenceSeconds],[true,5,[20,40,80]]);assertConsistent(f);
 assert.deepEqual(['timeout','cmpTimeout'].filter(key=>Object.hasOwn(f.readConfig().advancedUnitRules.P1,key)),[],'P1 stores no timeout of its own');
 assert.equal(Object.hasOwn(JSON.parse(rows(f).find(r=>r.rule_key==='P1').rule_json),'timeout'),false);
 // P1 now stores its whole refresh section: its save sends no parents' settings, so a Default
 // change does not refuse it.
 const own=await ok(await listAdvancedRules(f.env,SITE));
 const stored=refreshTabForm.baselineFor('P1','BTF',own.advancedRules,own.unitRuleRows);
 assert.deepEqual(stored.unstored,[]);
 const body=refreshTabForm.requestBody(refreshTabForm.withEdit(stored.form,'maxRefreshes',7),stored);
 assert.equal(Object.hasOwn(body,'expectedInheritedRefresh'),false);
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:15,schedule:SEQUENCE}},'PUT'),f.env,SITE,'__DEFAULT__'));
 await ok(await updateAdvancedRule(refreshTabPut(stored,refreshTabForm.withEdit(stored.form,'maxRefreshes',7)),f.env,SITE,'P1'));
 assert.equal(f.readConfig().advancedUnitRules.P1.refresh.maxRefreshes,7);assertConsistent(f);
});

for(const withDefault of [false,true]){
 test(`Refresh tab after a 409: values the other tab's Unit rules refresh override does not store are not its changes (${withDefault?'with':'without'} a Default record)`,async()=>{
  const f=setup();
  if(withDefault)await ok(await updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:15,schedule:SEQUENCE}},'PUT'),f.env,SITE,'__DEFAULT__'));
  await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:1800}},'POST'),f.env,SITE),201);
  const opened=await ok(await listAdvancedRules(f.env,SITE));
  const loaded=refreshTabForm.baselineFor('P1','BTF',opened.advancedRules,opened.unitRuleRows);
  assert.equal(loaded.form.ownRefresh,false);
  // The other tab turns P1's refresh override on in Unit rules (45 s). Its row stores neither
  // Maximum refreshes nor the dwell values, so those stay inherited there.
  const tab=await listed(f,'P1');
  await ok(await updateUnitRule(request({rule:{timeout:1800,refresh:refresh(45)},expectedUpdatedAt:tab.updatedAt}),f.env,SITE,tab.id));
  const inherited=withDefault?15:20;
  for(const [field,value,conflicts] of [['maxRefreshes',5,[]],['refreshEnabled',false,['Refresh enabled']]]){
   const edited=refreshTabForm.withEdit(loaded.form,field,value);
   await refused(await updateAdvancedRule(refreshTabPut(loaded,edited),f.env,SITE,'P1'),409,/changed in another tab/);
   const {current,form:rebased,review}=await refreshTabRebase(f,loaded,edited);
   assert.deepEqual([current.form.ownRefresh,current.form.maxRefreshes,current.unstored.includes('maxRefreshes')],[true,inherited,true]);
   assert.deepEqual(review.conflicts.map(conflict=>conflict.field),conflicts,`${field}: ${JSON.stringify(review)}`);
   assert.doesNotMatch(JSON.stringify(review),/Maximum refreshes: /,'an inherited value is never named as the other tab\'s');
   if(field==='maxRefreshes'){
    assert.deepEqual(review.applied,['Refresh settings','Maximum refreshes']);
    assert.deepEqual([rebased.maxRefreshes,rebased.fixedSeconds],[5,45],'this tab\'s value and the other tab\'s interval');
   }else{
    assert.deepEqual(review.conflicts[0].yours,'off');assert.match(review.conflicts[0].saved,/^on \(.*Every refresh: 45 sec/);
   }
  }
 });
}

test('Refresh tab refused twice: the values entered here stay, and the other tabs\' changes, a removed override among them, are not undone',async()=>{
 const f=setup();
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:15}},'PUT'),f.env,SITE,'__DEFAULT__'));
 await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:1800,refresh:{...refresh(45),minViewPct:70,checkEveryMs:2000}}},'POST'),f.env,SITE),201);
 const opened=await ok(await listAdvancedRules(f.env,SITE));
 const loaded=refreshTabForm.baselineFor('P1','BTF',opened.advancedRules,opened.unitRuleRows);
 assert.deepEqual([loaded.form.fixedSeconds,loaded.form.minViewPct,loaded.form.checkEveryMs],[45,70,2000]);
 // Unit rules removes P1's refresh override; this tab sets Exit at 5% and is refused.
 const tab=await listed(f,'P1');
 await ok(await updateUnitRule(request({rule:{timeout:1800},expectedUpdatedAt:tab.updatedAt}),f.env,SITE,tab.id));
 const edited=refreshTabForm.withEdit(loaded.form,'exitViewPct',5);
 await refused(await updateAdvancedRule(refreshTabPut(loaded,edited),f.env,SITE,'P1'),409,/changed in another tab/);
 const round1=await refreshTabRebase(f,loaded,edited);
 assert.deepEqual(round1.review.conflicts.map(conflict=>conflict.field),['Refresh settings']);
 assert.deepEqual(round1.form,{...round1.current.form,ownRefresh:true,exitViewPct:5},'what P1 inherits now, with the entry made here');
 // A third tab changes Default's Maximum refreshes, so the reviewed save is refused again.
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:25}},'PUT'),f.env,SITE,'__DEFAULT__'));
 const saves=auditCount(f,'unit_rule.advanced_updated');
 await refused(await updateAdvancedRule(refreshTabPut(round1.next,round1.form),f.env,SITE,'P1'),409,/changed in another tab/);
 assert.equal(auditCount(f,'unit_rule.advanced_updated'),saves);
 const round2=await refreshTabRebase(f,round1.next,round1.form);
 assert.deepEqual([round2.outcome.kind,round2.outcome.cause],['rebased','parents']);
 assert.deepEqual(round2.review,{conflicts:[],applied:['Refresh settings','Exit at']});
 assert.deepEqual(round2.form,{...round2.current.form,ownRefresh:true,exitViewPct:5},'the entry stays; the third tab\'s Default value shows');
 assert.equal(round2.form.maxRefreshes,25);
 await ok(await updateAdvancedRule(refreshTabPut(round2.next,round2.form),f.env,SITE,'P1'));
 const p1=f.readConfig().advancedUnitRules.P1.refresh,inherits=round2.current.form;
 assert.deepEqual([p1.schedule.fixedSeconds,p1.minViewPct,p1.checkEveryMs,p1.exitViewPct,p1.maxRefreshes],[inherits.fixedSeconds,inherits.minViewPct,inherits.checkEveryMs,5,25]);
 assert.notDeepEqual([p1.schedule.fixedSeconds,p1.minViewPct,p1.checkEveryMs],[45,70,2000],'the removed override is not saved back');assertConsistent(f);
});

test('Refresh tab refused twice: a value entered here stays this tab\'s even when it equals the inherited value another tab saved',async()=>{
 const f=setup();
 const setDefault=n=>updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:n}},'PUT'),f.env,SITE,'__DEFAULT__');
 await ok(await setDefault(15));
 const opened=await ok(await listAdvancedRules(f.env,SITE));
 const loaded=refreshTabForm.baselineFor('P1','BTF',opened.advancedRules,opened.unitRuleRows);
 await ok(await setDefault(25));
 const edited=refreshTabForm.withEdit(loaded.form,'maxRefreshes',25);
 await refused(await updateAdvancedRule(refreshTabPut(loaded,edited),f.env,SITE,'P1'),409,/changed in another tab/);
 const round1=await refreshTabRebase(f,loaded,edited);
 assert.deepEqual(round1.review,{conflicts:[],applied:['Refresh settings','Maximum refreshes']});
 await ok(await setDefault(30));
 await refused(await updateAdvancedRule(refreshTabPut(round1.next,round1.form),f.env,SITE,'P1'),409,/changed in another tab/);
 const round2=await refreshTabRebase(f,round1.next,round1.form);
 assert.deepEqual(round2.review,{conflicts:[],applied:['Refresh settings','Maximum refreshes']});
 assert.equal(round2.form.maxRefreshes,25,'the entry stays, not Default\'s newer 30');
 await ok(await updateAdvancedRule(refreshTabPut(round2.next,round2.form),f.env,SITE,'P1'));
 assert.equal(f.readConfig().advancedUnitRules.P1.refresh.maxRefreshes,25);assertConsistent(f);
});

test('Refresh tab: a value typed and put back sends nothing, and only refresh values a save sends are checked',async()=>{
 const f=setup();
 await ok(await updateAdvancedRule(request({timeout:1800,refresh:{enabled:true,maxRefreshes:15,schedule:SEQUENCE}},'PUT'),f.env,SITE,'__DEFAULT__'));
 let body=await ok(await listAdvancedRules(f.env,SITE));
 const inherits=refreshTabForm.baselineFor('P1','BTF',body.advancedRules,body.unitRuleRows);
 const edit=(form,pairs)=>pairs.reduce((current,[field,value])=>refreshTabForm.withEdit(current,field,value),form);
 const reverted=edit(inherits.form,[['maxRefreshes',155],['maxRefreshes',15],['accumulateViewTime',false],['accumulateViewTime',true],['timeout',1900],['timeout',1800]]);
 assert.equal(refreshTabForm.storesNothing(reverted),false,'the switches are on');
 assert.deepEqual(refreshTabForm.requestBody(reverted,inherits),{},'no value differs from what the tab loaded');
 assert.deepEqual(refreshTabForm.requestBody(edit(inherits.form,[['maxRefreshes',16]]),inherits).refresh.maxRefreshes,16);
 // As the panel runs each edit (afterEdit), a section whose values are all put back shows as inherited again.
 const typed=(form,pairs,loaded)=>pairs.reduce((current,[field,value])=>refreshTabForm.afterEdit(refreshTabForm.withEdit(current,field,value),loaded),form);
 const putBack=typed(inherits.form,[['maxRefreshes',155],['maxRefreshes',15],['accumulateViewTime',false],['accumulateViewTime',true],['timeout',1900],['timeout',1800]],inherits);
 assert.deepEqual(putBack,inherits.form);assert.equal(refreshTabForm.storesNothing(putBack),true);
 assert.deepEqual([typed(inherits.form,[['maxRefreshes',16]],inherits).ownRefresh,typed(inherits.form,[['timeout',1900]],inherits).ownTimeout],[true,true]);
 // A strategy tried and put back, or the intervals retyped with other spacing, is no edit either: only what the form shows counts,
 // and intervals that save the same keep the text typed.
 for(const [pairs,shows] of [[[['mode','fixed'],['fixedSeconds',40],['mode','sequence']],inherits.form],[[['sequenceText','20,40,80']],{...inherits.form,sequenceText:'20,40,80'}]]){
  const back=typed(inherits.form,pairs,inherits);
  assert.deepEqual(back,shows,JSON.stringify(pairs));assert.deepEqual(refreshTabForm.requestBody(back,inherits),{});assert.equal(refreshTabForm.storesNothing(back),true);
 }
 // Typed key by key, as the input sends it, a separator on the way to the next interval stays.
 const keyed=[...', 160'].reduce((current,key)=>refreshTabForm.afterEdit(refreshTabForm.withEdit(current,'sequenceText',current.sequenceText+key),inherits),inherits.form);
 assert.equal(keyed.sequenceText,'20, 40, 80, 160');
 assert.deepEqual(refreshTabForm.requestBody(keyed,inherits).refresh.schedule.sequenceSeconds,[20,40,80,160]);
 // P1 stores 1800 ms and a 5% Enter at in Unit rules; Exit at (10%) is inherited from the script.
 await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:1800,refresh:{...refresh(45),minViewPct:5}}},'POST'),f.env,SITE),201);
 body=await ok(await listAdvancedRules(f.env,SITE));
 const p1=refreshTabForm.baselineFor('P1','BTF',body.advancedRules,body.unitRuleRows);
 assert.deepEqual([p1.form.minViewPct,p1.form.exitViewPct],[5,10]);
 assert.equal(typed(p1.form,[['timeout',1900],['timeout',1800]],p1).ownTimeout,true,'a section the scope stores stays its own');
 const cmpOnly=edit(p1.form,[['cmpTimeout',3000]]);
 assert.deepEqual(refreshTabForm.requestBody(cmpOnly,p1),{timeout:1800,cmpTimeout:3000},'the timeout P1 stores and the CMP wait entered here');
 assert.equal(refreshTabForm.formError(cmpOnly,p1),null,'the unchanged refresh section is not sent, so it is not checked');
 assert.equal(refreshTabForm.formError(edit(p1.form,[['maxRefreshes',9]]),p1),'Exit view % should be lower than or equal to entry view %.');
 await ok(await updateAdvancedRule(refreshTabPut(p1,cmpOnly),f.env,SITE,'P1'));
 assert.deepEqual(f.readConfig().advancedUnitRules.P1.cmpTimeout,3000);
 assert.equal(JSON.parse(rows(f).find(r=>r.rule_key==='P1').rule_json).refresh.minViewPct,5,'the row keeps its refresh values');assertConsistent(f);
});

test('Refresh tab after a 409: a timeout, CMP wait or refresh value typed and put back is no edit, so the reviewed save leaves it inherited',async()=>{
 const f=setup();
 const setDefault=(timeout,cmpTimeout,maxRefreshes)=>updateAdvancedRule(request({timeout,cmpTimeout,refresh:{enabled:true,maxRefreshes,schedule:SEQUENCE}},'PUT'),f.env,SITE,'__DEFAULT__');
 const edit=(form,pairs)=>pairs.reduce((current,[field,value])=>refreshTabForm.withEdit(current,field,value),form);
 await ok(await setDefault(1800,3000,15));
 // This tab types a timeout and a CMP wait and puts them back, and sets Maximum refreshes; Default changes all three meanwhile.
 const loaded=refreshTabForm.baselineFromListing('P1',await ok(await listAdvancedRules(f.env,SITE)));
 const edited=edit(loaded.form,[['timeout',1900],['timeout',1800],['cmpTimeout',3100],['cmpTimeout',3000],['maxRefreshes',5]]);
 assert.deepEqual(Object.keys(refreshTabForm.requestBody(edited,loaded)),['expectedInheritedRefresh','refresh']);
 await ok(await setDefault(2000,3500,25));
 await refused(await updateAdvancedRule(refreshTabPut(loaded,edited),f.env,SITE,'P1'),409,/changed in another tab/);
 const round=await refreshTabRebase(f,loaded,edited);
 assert.deepEqual(round.review,{conflicts:[],applied:['Refresh settings','Maximum refreshes']},'the put-back timeouts are not listed as changes');
 assert.deepEqual([round.form.ownTimeout,round.form.timeout,round.form.ownCmpTimeout,round.form.cmpTimeout,round.form.maxRefreshes],[false,2000,false,3500,5],
  'the timeouts show Default\'s new values, inherited');
 // The entry put back to the inherited value after the review is no longer sent either.
 assert.deepEqual(refreshTabForm.requestBody(edit(round.form,[['maxRefreshes',25]]),round.next),{});
 const body=refreshTabForm.requestBody(round.form,round.next);
 assert.deepEqual([Object.hasOwn(body,'timeout'),Object.hasOwn(body,'cmpTimeout'),body.refresh.maxRefreshes],[false,false,5]);
 await ok(await updateAdvancedRule(refreshTabPut(round.next,round.form),f.env,SITE,'P1'));
 const p1=f.readConfig().advancedUnitRules.P1;
 assert.deepEqual([Object.hasOwn(p1,'timeout'),Object.hasOwn(p1,'cmpTimeout'),p1.refresh.maxRefreshes],[false,false,5]);
 assert.equal(Object.hasOwn(JSON.parse(rows(f).find(r=>r.rule_key==='P1').rule_json),'timeout'),false,'its row stores no timeout either');assertConsistent(f);
 // A refresh checkbox unticked and ticked again, with a real timeout change, refused because another
 // tab saved the BTF group's CMP wait: the reviewed save sends the timeout, not a copy of Default's refresh.
 const group=refreshTabForm.baselineFromListing('__BTF__',await ok(await listAdvancedRules(f.env,SITE)));
 const toggled=edit(group.form,[['accumulateViewTime',false],['accumulateViewTime',true],['timeout',2200]]);
 assert.deepEqual(refreshTabForm.requestBody(toggled,group),{timeout:2200});
 await ok(await updateAdvancedRule(request({cmpTimeout:3600},'PUT'),f.env,SITE,'__BTF__'));
 await refused(await updateAdvancedRule(refreshTabPut(group,toggled),f.env,SITE,'__BTF__'),409,/changed in another tab/);
 const again=await refreshTabRebase(f,group,toggled,'__BTF__');
 assert.deepEqual([again.outcome.cause,again.review],['changed',{conflicts:[],applied:['Prebid auction timeout']}]);
 assert.deepEqual(refreshTabForm.requestBody(again.form,again.next),{timeout:2200,cmpTimeout:3600});
 await ok(await updateAdvancedRule(refreshTabPut(again.next,again.form),f.env,SITE,'__BTF__'));
 assert.deepEqual(f.readConfig().advancedUnitRules.__BTF__,{timeout:2200,cmpTimeout:3600},'the group still inherits refresh');assertConsistent(f);
});

test('Refresh tab after a 409: the ATF group\'s shown 2200 ms typed and put back is not saved over the script\'s timeout',async()=>{
 const f=setup();
 const setDefault=n=>updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:n}},'PUT'),f.env,SITE,'__DEFAULT__');
 await ok(await setDefault(15));
 const loaded=refreshTabForm.baselineFromListing('__ATF__',await ok(await listAdvancedRules(f.env,SITE)));
 assert.deepEqual([loaded.form.ownTimeout,loaded.form.timeout],[false,2200]);
 const edited=[['timeout',2300],['timeout',2200],['maxRefreshes',7]].reduce((form,[field,value])=>refreshTabForm.withEdit(form,field,value),loaded.form);
 await ok(await setDefault(25));
 await refused(await updateAdvancedRule(refreshTabPut(loaded,edited),f.env,SITE,'__ATF__'),409,/changed in another tab/);
 const {form,next,review}=await refreshTabRebase(f,loaded,edited,'__ATF__');
 assert.deepEqual(review,{conflicts:[],applied:['Refresh settings','Maximum refreshes']});
 assert.equal(Object.hasOwn(refreshTabForm.requestBody(form,next),'timeout'),false);
 await ok(await updateAdvancedRule(refreshTabPut(next,form),f.env,SITE,'__ATF__'));
 assert.equal(Object.hasOwn(f.readConfig().advancedUnitRules.__ATF__,'timeout'),false);assertConsistent(f);
});

test('Refresh tab after a 409 for a deleted rule: only the values changed here are applied, onto what the scope inherits now',async()=>{
 const f=setup();
 const setDefault=n=>updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:n,schedule:SEQUENCE}},'PUT'),f.env,SITE,'__DEFAULT__');
 await ok(await setDefault(15));
 // P1 stores only a 2000 ms timeout. This tab changes it to 2500 ms, what P1 would otherwise inherit,
 // while Unit rules deletes the rule: the change is still this tab's, and the reviewed save stores it.
 await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:2000}},'POST'),f.env,SITE),201);
 let loaded=refreshTabForm.baselineFromListing('P1',await ok(await listAdvancedRules(f.env,SITE)));
 let edited=refreshTabForm.withEdit(loaded.form,'timeout',2500);
 await ok(await deleteUnitRule(request({},'DELETE'),f.env,SITE,(await listed(f,'P1')).id));
 await refused(await updateAdvancedRule(refreshTabPut(loaded,edited),f.env,SITE,'P1'),409,/changed in another tab/);
 let round=await refreshTabRebase(f,loaded,edited);
 assert.deepEqual([round.outcome.cause,round.outcome.changed],['deleted',true]);
 assert.deepEqual(round.review,{conflicts:[{field:'Prebid auction timeout',yours:'set for this scope',saved:'inherited'}],applied:[]});
 assert.deepEqual(refreshTabForm.requestBody(round.form,round.next),{timeout:2500});
 await ok(await updateAdvancedRule(refreshTabPut(round.next,round.form),f.env,SITE,'P1'));
 assert.deepEqual(JSON.parse(rows(f).find(r=>r.rule_key==='P1').rule_json),{timeout:2500});assertConsistent(f);
 // P1 stores 2000 ms and a 45 s interval; Maximum refreshes is inherited from Default. This tab sets
 // the CMP wait and Exit at, while Unit rules deletes the rule and Default's Maximum refreshes becomes 25.
 await ok(await deleteUnitRule(request({},'DELETE'),f.env,SITE,(await listed(f,'P1')).id));
 await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:2000,refresh:refresh(45)}},'POST'),f.env,SITE),201);
 loaded=refreshTabForm.baselineFromListing('P1',await ok(await listAdvancedRules(f.env,SITE)));
 assert.deepEqual([loaded.form.fixedSeconds,loaded.form.maxRefreshes],[45,15]);
 edited=[['cmpTimeout',1200],['exitViewPct',5]].reduce((form,[field,value])=>refreshTabForm.withEdit(form,field,value),loaded.form);
 await ok(await deleteUnitRule(request({},'DELETE'),f.env,SITE,(await listed(f,'P1')).id));
 await ok(await setDefault(25));
 await refused(await updateAdvancedRule(refreshTabPut(loaded,edited),f.env,SITE,'P1'),409,/changed in another tab/);
 round=await refreshTabRebase(f,loaded,edited);
 assert.deepEqual([round.outcome.cause,round.review],['deleted',{conflicts:[{field:'Refresh settings',yours:'set for this scope',saved:'inherited'}],applied:['CMP wait timeout','Exit at']}]);
 assert.deepEqual(round.form,{...round.current.form,ownCmpTimeout:true,cmpTimeout:1200,ownRefresh:true,exitViewPct:5},
  'the deleted timeout and 45 s interval are inherited now; only the CMP wait and Exit at entered here apply, with Default\'s new Maximum refreshes');
 assert.deepEqual([round.form.ownTimeout,round.form.timeout,round.form.mode,round.form.maxRefreshes],[false,2500,'sequence',25]);
 // Exit at put back to what P1 inherits: the section shows as inherited again and only the CMP wait is sent.
 assert.deepEqual(round.next.form,round.current.form,'the next save is compared with what P1 inherits now');
 const putBack=refreshTabForm.afterEdit(refreshTabForm.withEdit(round.form,'exitViewPct',round.current.form.exitViewPct),round.next);
 assert.deepEqual(putBack,{...round.current.form,ownCmpTimeout:true,cmpTimeout:1200});
 assert.deepEqual(refreshTabForm.requestBody(putBack,round.next),{cmpTimeout:1200});
 const body=refreshTabForm.requestBody(round.form,round.next);
 assert.deepEqual([Object.hasOwn(body,'timeout'),body.cmpTimeout,body.refresh.maxRefreshes,body.expectedInheritedRefresh.maxRefreshes],[false,1200,25,25]);
 assert.deepEqual([body.refresh.schedule.mode,body.refresh.schedule.sequenceSeconds],['sequence',[20,40,80]],'the deleted interval is not sent');
 await ok(await updateAdvancedRule(refreshTabPut(round.next,round.form),f.env,SITE,'P1'));
 const p1=f.readConfig().advancedUnitRules.P1;
 assert.deepEqual([Object.hasOwn(p1,'timeout'),p1.cmpTimeout,p1.refresh.exitViewPct,p1.refresh.maxRefreshes,p1.refresh.schedule.mode],[false,1200,5,25,'sequence']);assertConsistent(f);
});

test('Refresh tab after a 409 from a parent change P1 does not show: nothing to review, and saving again applies',async()=>{
 const f=setup();
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:15,minViewPct:50}},'PUT'),f.env,SITE,'__DEFAULT__'));
 await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:1800,refresh:{...refresh(45),minViewPct:70}}},'POST'),f.env,SITE),201);
 const loaded=refreshTabForm.baselineFromListing('P1',await ok(await listAdvancedRules(f.env,SITE)));
 const edited=refreshTabForm.withEdit(loaded.form,'maxRefreshes',7);
 // Default changes Enter at and Require previous, both of which P1 stores itself.
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:15,minViewPct:60,requirePreviousViewable:true}},'PUT'),f.env,SITE,'__DEFAULT__'));
 await refused(await updateAdvancedRule(refreshTabPut(loaded,edited),f.env,SITE,'P1'),409,/changed in another tab/);
 const {outcome,form,next}=await refreshTabRebase(f,loaded,edited);
 assert.deepEqual([outcome.cause,outcome.changed,outcome.unchanged,outcome.invalid],['parents',true,true,null]);
 assert.deepEqual(form,edited,'the form is exactly as submitted');
 await ok(await updateAdvancedRule(refreshTabPut(next,form),f.env,SITE,'P1'));
 assert.equal(f.readConfig().advancedUnitRules.P1.refresh.maxRefreshes,7);assertConsistent(f);
});

test('Refresh tab refused twice: the other tab\'s value typed after the review is no entry, so a third tab\'s removed override shows inherited and is not sent',async()=>{
 const f=setup();
 await ok(await updateAdvancedRule(request({timeout:1800,refresh:{enabled:true,maxRefreshes:15}},'PUT'),f.env,SITE,'__DEFAULT__'));
 const loaded=refreshTabForm.baselineFromListing('P1',await ok(await listAdvancedRules(f.env,SITE)));
 assert.deepEqual([loaded.form.ownTimeout,loaded.form.timeout],[false,1800]);
 // Unit rules gives P1 a 2200 ms timeout while this tab enters 2000 ms.
 const edited=refreshTabForm.withEdit(loaded.form,'timeout',2000);
 await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:2200}},'POST'),f.env,SITE),201);
 await refused(await updateAdvancedRule(refreshTabPut(loaded,edited),f.env,SITE,'P1'),409,/changed in another tab/);
 const round1=await refreshTabRebase(f,loaded,edited);
 assert.deepEqual(round1.review.conflicts,[{field:'Prebid auction timeout',yours:'2000 ms',saved:'2200 ms'}]);
 assert.deepEqual(round1.next.carried,{timeout:2000},'a section switch is never carried on its own');
 // This tab takes the other tab's 2200 ms and sets Maximum refreshes, as the panel runs each edit;
 // a third tab then removes P1's timeout override in Unit rules.
 const accepted=[['timeout',2200],['maxRefreshes',5]].reduce((form,[field,value])=>
  refreshTabForm.afterEdit(refreshTabForm.withEdit(form,field,value),round1.next),round1.form);
 const tab=await listed(f,'P1');
 await ok(await updateUnitRule(request({rule:{lazy:{enabled:false,fetchMarginPx:500,renderMarginPx:200}},expectedUpdatedAt:tab.updatedAt}),f.env,SITE,tab.id));
 await refused(await updateAdvancedRule(refreshTabPut(round1.next,accepted),f.env,SITE,'P1'),409,/changed in another tab/);
 const round2=await refreshTabRebase(f,round1.next,accepted);
 assert.deepEqual(round2.review,{conflicts:[],applied:['Refresh settings','Maximum refreshes']},'no timeout is named as this tab\'s');
 assert.deepEqual([round2.form.ownTimeout,round2.form.timeout,round2.form.maxRefreshes],[false,1800,5],'the timeout shows inherited, as P1 will run');
 const body=refreshTabForm.requestBody(round2.form,round2.next);
 assert.deepEqual([Object.hasOwn(body,'timeout'),body.refresh.maxRefreshes],[false,5]);
 await ok(await updateAdvancedRule(refreshTabPut(round2.next,round2.form),f.env,SITE,'P1'));
 const p1=f.readConfig().advancedUnitRules.P1;
 assert.deepEqual([Object.hasOwn(p1,'timeout'),p1.refresh.maxRefreshes],[false,5]);assertConsistent(f);
});

test('Refresh tab after a 409 with refresh switched off: a value both tabs changed is still a conflict, and one changed only here is applied',async()=>{
 const f=setup();
 await ok(await updateAdvancedRule(request({refresh:{enabled:false,maxRefreshes:15,minViewPct:50,schedule:SEQUENCE}},'PUT'),f.env,SITE,'P1'));
 let listing=await ok(await listAdvancedRules(f.env,SITE));
 let tabA=refreshTabForm.baselineFromListing('P1',listing),tabB=refreshTabForm.baselineFromListing('P1',listing);
 assert.deepEqual([tabA.form.ownRefresh,tabA.form.refreshEnabled],[true,false]);
 // The form keeps every refresh value editable and saved while refresh is off.
 await ok(await updateAdvancedRule(refreshTabPut(tabB,refreshTabForm.withEdit(tabB.form,'maxRefreshes',10)),f.env,SITE,'P1'));
 let edited=refreshTabForm.withEdit(tabA.form,'maxRefreshes',5);
 await refused(await updateAdvancedRule(refreshTabPut(tabA,edited),f.env,SITE,'P1'),409,/changed in another tab/);
 let round=await refreshTabRebase(f,tabA,edited);
 assert.deepEqual(round.review,{conflicts:[{field:'Maximum refreshes',yours:'5',saved:'10'}],applied:[]});
 assert.equal(round.outcome.unchanged,false,'the conflict is shown before this tab can save over 10');
 // Here Maximum refreshes, there Enter at: both apply, and the review lists this tab's change.
 listing=await ok(await listAdvancedRules(f.env,SITE));
 tabA=refreshTabForm.baselineFromListing('P1',listing);tabB=refreshTabForm.baselineFromListing('P1',listing);
 await ok(await updateAdvancedRule(refreshTabPut(tabB,refreshTabForm.withEdit(tabB.form,'minViewPct',60)),f.env,SITE,'P1'));
 edited=refreshTabForm.withEdit(tabA.form,'maxRefreshes',5);
 await refused(await updateAdvancedRule(refreshTabPut(tabA,edited),f.env,SITE,'P1'),409,/changed in another tab/);
 round=await refreshTabRebase(f,tabA,edited);
 assert.deepEqual(round.review,{conflicts:[],applied:['Maximum refreshes']});
 assert.deepEqual([round.form.maxRefreshes,round.form.minViewPct,round.form.refreshEnabled],[5,60,false]);
 await ok(await updateAdvancedRule(refreshTabPut(round.next,round.form),f.env,SITE,'P1'));
 const p1=f.readConfig().advancedUnitRules.P1.refresh;
 assert.deepEqual([p1.enabled,p1.maxRefreshes,p1.minViewPct],[false,5,60]);assertConsistent(f);
 // This tab switches refresh off and changes a value the other tab changed: the switch and the value are both conflicts.
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:20,schedule:SEQUENCE}},'PUT'),f.env,SITE,'P1'));
 listing=await ok(await listAdvancedRules(f.env,SITE));
 tabA=refreshTabForm.baselineFromListing('P1',listing);tabB=refreshTabForm.baselineFromListing('P1',listing);
 await ok(await updateAdvancedRule(refreshTabPut(tabB,refreshTabForm.withEdit(tabB.form,'maxRefreshes',10)),f.env,SITE,'P1'));
 edited=refreshTabForm.withEdit(refreshTabForm.withEdit(tabA.form,'refreshEnabled',false),'maxRefreshes',5);
 await refused(await updateAdvancedRule(refreshTabPut(tabA,edited),f.env,SITE,'P1'),409,/changed in another tab/);
 round=await refreshTabRebase(f,tabA,edited);
 assert.deepEqual(round.review,{conflicts:[{field:'Refresh enabled',yours:'off',saved:'on (Maximum refreshes: 10)'},
  {field:'Maximum refreshes',yours:'5',saved:'10'}],applied:[]});
 assert.equal(f.readConfig().advancedUnitRules.P1.refresh.maxRefreshes,10,'nothing of this tab was saved');
 // Under the switch, only values that took effect in the other save are named: a Unit rules save writes Minimum time into
 // every fixed interval, but First refresh, hidden under its Same every time, is only a conflict of its own.
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:20,schedule:{mode:'fixed',fixedSeconds:30,firstSeconds:20,nextSeconds:30}}},'PUT'),f.env,SITE,'P1'));
 tabA=refreshTabForm.baselineFromListing('P1',await ok(await listAdvancedRules(f.env,SITE)));
 const row=await listed(f,'P1');
 await ok(await updateUnitRule(request({rule:ruleFromForm({...opened(row.rule),minSeconds:45}),expectedUpdatedAt:row.updatedAt}),f.env,SITE,row.id));
 edited=[['refreshEnabled',false],['mode','firstThenFixed'],['firstSeconds',25]].reduce((form,[field,value])=>refreshTabForm.withEdit(form,field,value),tabA.form);
 await refused(await updateAdvancedRule(refreshTabPut(tabA,edited),f.env,SITE,'P1'),409,/changed in another tab/);
 round=await refreshTabRebase(f,tabA,edited);
 assert.deepEqual(round.review,{conflicts:[{field:'Refresh enabled',yours:'off',saved:'on (Every refresh: 45 sec)'},
  {field:'First refresh',yours:'25 sec',saved:'45 sec'}],applied:['Interval strategy']});
});

test('Refresh tab after a 409: intervals of a strategy given up, or retyped with other spacing, are no entry and never replace the other tab\'s',async()=>{
 const f=setup();
 const start={enabled:true,maxRefreshes:20,schedule:{mode:'fixed',fixedSeconds:30,sequenceSeconds:[20,40,80]}};
 const typed=(form,loaded,pairs)=>pairs.reduce((current,[field,value])=>refreshTabForm.afterEdit(refreshTabForm.withEdit(current,field,value),loaded),form);
 // P1 stores `stored`; tab B saves `other`, then tab A, opened before, saves `mine` and is refused.
 async function stale(stored,other,mine){
  await ok(await updateAdvancedRule(request({refresh:stored},'PUT'),f.env,SITE,'P1'));
  const listing=await ok(await listAdvancedRules(f.env,SITE));
  const tabA=refreshTabForm.baselineFromListing('P1',listing),tabB=refreshTabForm.baselineFromListing('P1',listing);
  await ok(await updateAdvancedRule(refreshTabPut(tabB,typed(tabB.form,tabB,other)),f.env,SITE,'P1'));
  const edited=typed(tabA.form,tabA,mine);
  await refused(await updateAdvancedRule(refreshTabPut(tabA,edited),f.env,SITE,'P1'),409,/changed in another tab/);
  return refreshTabRebase(f,tabA,edited);
 }
 const saved=()=>{const {maxRefreshes,minViewPct,schedule:{mode,fixedSeconds,sequenceSeconds}}=f.readConfig().advancedUnitRules.P1.refresh;
  return {maxRefreshes,minViewPct,mode,fixedSeconds,sequenceSeconds};};
 // Every refresh typed, then a sequence chosen: the strategy is the conflict, and taking the other tab's shows its 50 s, not the 40 given up.
 let round=await stale(start,[['fixedSeconds',50]],[['fixedSeconds',40],['mode','sequence'],['sequenceText','30, 60']]);
 assert.deepEqual(round.review,{conflicts:[{field:'Interval strategy',yours:'Explicit sequence',saved:'Same every time (Every refresh: 50 sec)'}],
  applied:['Intervals, in seconds']});
 let form=typed(round.form,round.next,[['mode','fixed'],['maxRefreshes',7]]);
 assert.equal(form.fixedSeconds,50);
 // Refused again, by a third tab's Enter at: the intervals given up are not carried, and are not saved.
 const third=refreshTabForm.baselineFromListing('P1',await ok(await listAdvancedRules(f.env,SITE)));
 await ok(await updateAdvancedRule(refreshTabPut(third,typed(third.form,third,[['minViewPct',60]])),f.env,SITE,'P1'));
 await refused(await updateAdvancedRule(refreshTabPut(round.next,form),f.env,SITE,'P1'),409,/changed in another tab/);
 const again=await refreshTabRebase(f,round.next,form);
 assert.deepEqual(again.review,{conflicts:[],applied:['Maximum refreshes']});
 assert.deepEqual(again.next.carried,{maxRefreshes:7});
 await ok(await updateAdvancedRule(refreshTabPut(again.next,again.form),f.env,SITE,'P1'));
 assert.deepEqual(saved(),{maxRefreshes:7,minViewPct:60,mode:'fixed',fixedSeconds:50,sequenceSeconds:[20,40,80]});
 // A sequence tried and given up, while the other tab chose a sequence: no conflict, and the other tab's sequence stays.
 round=await stale(start,[['mode','sequence'],['sequenceText','10, 20']],[['mode','sequence'],['sequenceText','30, 60'],['mode','fixed'],['maxRefreshes',5]]);
 assert.deepEqual(round.review,{conflicts:[],applied:['Maximum refreshes']});
 assert.deepEqual([round.form.mode,round.form.sequenceText],['sequence','10, 20']);
 await ok(await updateAdvancedRule(refreshTabPut(round.next,round.form),f.env,SITE,'P1'));
 assert.deepEqual(saved(),{maxRefreshes:5,minViewPct:60,mode:'sequence',fixedSeconds:30,sequenceSeconds:[10,20]});
 // Intervals retyped with other spacing and sent with another change: no conflict with the other tab's intervals, which stay.
 const sequence={...start,schedule:{...start.schedule,mode:'sequence'}};
 round=await stale(sequence,[['sequenceText','10, 20']],[['sequenceText','20,40,80'],['maxRefreshes',5]]);
 assert.deepEqual(round.review,{conflicts:[],applied:['Maximum refreshes']});
 await ok(await updateAdvancedRule(refreshTabPut(round.next,round.form),f.env,SITE,'P1'));
 assert.deepEqual(saved().sequenceSeconds,[10,20]);
 // Both tabs set the same intervals, spaced differently: no conflict, and nothing shown here changed.
 round=await stale(sequence,[['sequenceText','20, 40, 80, 160']],[['sequenceText','20,40,80,160']]);
 assert.deepEqual([round.review,round.outcome.unchanged],[{conflicts:[],applied:['Intervals, in seconds']},true]);
 // Refused because the other tab saved the same values again: an interval typed under a strategy given up is no difference either.
 await ok(await updateAdvancedRule(request({refresh:sequence},'PUT'),f.env,SITE,'P1'));
 const before=refreshTabForm.baselineFromListing('P1',await ok(await listAdvancedRules(f.env,SITE)));
 await ok(await updateAdvancedRule(request({refresh:sequence},'PUT'),f.env,SITE,'P1'));
 const hiddenTyped=typed(before.form,before,[['mode','fixed'],['fixedSeconds',40],['mode','sequence'],['maxRefreshes',5]]);
 await refused(await updateAdvancedRule(refreshTabPut(before,hiddenTyped),f.env,SITE,'P1'),409,/changed in another tab/);
 round=await refreshTabRebase(f,before,hiddenTyped);
 assert.deepEqual([round.review,round.outcome.unchanged],[{conflicts:[],applied:['Maximum refreshes']},true]);
 // Refused because a Unit rules save rewrote only intervals this form hides (First and Second refresh of a fixed schedule): nothing
 // shown here changed, and the reviewed save keeps the intervals that save wrote.
 await ok(await updateAdvancedRule(request({refresh:{...start,schedule:{...start.schedule,firstSeconds:20,nextSeconds:35}}},'PUT'),f.env,SITE,'P1'));
 const fixed=refreshTabForm.baselineFromListing('P1',await ok(await listAdvancedRules(f.env,SITE)));
 const row=await listed(f,'P1');
 await ok(await updateUnitRule(request({rule:{...row.rule,lazy},expectedUpdatedAt:row.updatedAt}),f.env,SITE,row.id));
 assert.deepEqual([saved().mode,f.readConfig().advancedUnitRules.P1.refresh.schedule.firstSeconds],['fixed',30],'the Unit rules save wrote the hidden First refresh');
 const maxOnly=typed(fixed.form,fixed,[['maxRefreshes',5]]);
 await refused(await updateAdvancedRule(refreshTabPut(fixed,maxOnly),f.env,SITE,'P1'),409,/changed in another tab/);
 round=await refreshTabRebase(f,fixed,maxOnly);
 assert.deepEqual([round.review,round.outcome.unchanged],[{conflicts:[],applied:['Maximum refreshes']},true]);
 await ok(await updateAdvancedRule(refreshTabPut(round.next,round.form),f.env,SITE,'P1'));
 assert.equal(f.readConfig().advancedUnitRules.P1.refresh.schedule.firstSeconds,30);
 await ok(await updateAdvancedRule(request({refresh:sequence},'PUT'),f.env,SITE,'P1'));
 // Without a 409 too, a save sends the intervals of a strategy the form does not show as loaded.
 const listing=await ok(await listAdvancedRules(f.env,SITE));const loaded=refreshTabForm.baselineFromListing('P1',listing);
 const body=refreshTabForm.requestBody(typed(loaded.form,loaded,[['mode','fixed'],['fixedSeconds',40],['mode','sequence'],['maxRefreshes',6]]),loaded);
 assert.deepEqual([body.refresh.schedule.fixedSeconds,body.refresh.schedule.sequenceSeconds],[30,[20,40,80]]);assertConsistent(f);
});

test('Refresh tab refused again: an entry carried as typed, with other spacing, stays this tab\'s while it holds the same intervals',async()=>{
 const f=setup();
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:15,schedule:{mode:'sequence',sequenceSeconds:[20,40]}}},'PUT'),f.env,SITE,'P1'));
 const loaded=refreshTabForm.baselineFromListing('P1',await ok(await listAdvancedRules(f.env,SITE)));
 assert.equal(loaded.form.sequenceText,'20, 40');
 // An earlier review carried intervals typed as "20,40", and the settings saved since hold the same intervals. Another tab then changes them.
 const reviewed={...loaded,carried:{sequenceText:'20,40'}},edited={...loaded.form,sequenceText:'20,40'};
 await ok(await updateAdvancedRule(refreshTabPut(loaded,refreshTabForm.withEdit(loaded.form,'sequenceText','10, 20')),f.env,SITE,'P1'));
 const {review,form}=await refreshTabRebase(f,reviewed,edited);
 assert.deepEqual(review,{conflicts:[{field:'Intervals, in seconds',yours:'20,40',saved:'10, 20'}],applied:[]});
 assert.equal(form.sequenceText,'20,40');
});

test('Refresh tab refused twice: an interval retyped under the strategy this tab chose stays its entry, even when it equals the value stored hidden',async()=>{
 const f=setup();
 const typed=(form,loaded,pairs)=>pairs.reduce((current,[field,value])=>refreshTabForm.afterEdit(refreshTabForm.withEdit(current,field,value),loaded),form);
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:15,schedule:{...SEQUENCE,fixedSeconds:30}}},'PUT'),f.env,SITE,'P1'));
 const listing=await ok(await listAdvancedRules(f.env,SITE));
 const tabA=refreshTabForm.baselineFromListing('P1',listing),tabB=refreshTabForm.baselineFromListing('P1',listing);
 assert.deepEqual([tabA.form.mode,tabA.form.fixedSeconds],['sequence',30]);
 await ok(await updateAdvancedRule(refreshTabPut(tabB,typed(tabB.form,tabB,[['maxRefreshes',10]])),f.env,SITE,'P1'));
 const first=typed(tabA.form,tabA,[['mode','fixed'],['fixedSeconds',45]]);
 await refused(await updateAdvancedRule(refreshTabPut(tabA,first),f.env,SITE,'P1'),409,/changed in another tab/);
 const round=await refreshTabRebase(f,tabA,first);
 assert.deepEqual(round.review,{conflicts:[],applied:['Interval strategy','Every refresh']});
 // The 30 s P1 stores under its sequence strategy was hidden, so typing it is an entry, not a value put back.
 const second=typed(round.form,round.next,[['fixedSeconds',30]]);
 const tabC=refreshTabForm.baselineFromListing('P1',await ok(await listAdvancedRules(f.env,SITE)));
 await ok(await updateAdvancedRule(refreshTabPut(tabC,typed(tabC.form,tabC,[['mode','fixed'],['fixedSeconds',60]])),f.env,SITE,'P1'));
 await refused(await updateAdvancedRule(refreshTabPut(round.next,second),f.env,SITE,'P1'),409,/changed in another tab/);
 const again=await refreshTabRebase(f,round.next,second);
 assert.deepEqual(again.review,{conflicts:[{field:'Every refresh',yours:'30 sec',saved:'60 sec'}],applied:['Interval strategy']});
 assert.equal(again.form.fixedSeconds,30);
 assert.equal(f.readConfig().advancedUnitRules.P1.refresh.schedule.fixedSeconds,60,'nothing of this tab was saved');
});

test('Refresh tab after a 409: a value both tabs changed is a conflict to review, even when the rebased form is exactly as submitted',async()=>{
 const f=setup();
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:15,schedule:SEQUENCE}},'PUT'),f.env,SITE,'P1'));
 const listing=await ok(await listAdvancedRules(f.env,SITE));
 const tabA=refreshTabForm.baselineFromListing('P1',listing),tabB=refreshTabForm.baselineFromListing('P1',listing);
 assert.deepEqual([tabA.form.ownRefresh,tabA.unstored],[true,[]]);
 await ok(await updateAdvancedRule(refreshTabPut(tabB,refreshTabForm.withEdit(tabB.form,'maxRefreshes',9)),f.env,SITE,'P1'));
 const edited=refreshTabForm.withEdit(tabA.form,'maxRefreshes',7);
 await refused(await updateAdvancedRule(refreshTabPut(tabA,edited),f.env,SITE,'P1'),409,/changed in another tab/);
 const {outcome,form,review}=await refreshTabRebase(f,tabA,edited);
 assert.deepEqual(form,edited,'the form is exactly as submitted');
 assert.deepEqual(review,{conflicts:[{field:'Maximum refreshes',yours:'7',saved:'9'}],applied:[]});
 assert.deepEqual([outcome.cause,outcome.changed,outcome.unchanged],['changed',true,false],'the panel shows the conflict before this tab can save over 9');
 assert.equal(f.readConfig().advancedUnitRules.P1.refresh.maxRefreshes,9);
});

test('Refresh tab after a 409: an entry that no longer fits a value changed in the other tab is reported, and the corrected save applies',async()=>{
 const f=setup();
 const setDefault=minViewPct=>updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:15,minViewPct,exitViewPct:10}},'PUT'),f.env,SITE,'__DEFAULT__');
 await ok(await setDefault(50));
 const loaded=refreshTabForm.baselineFromListing('P1',await ok(await listAdvancedRules(f.env,SITE)));
 const edited=refreshTabForm.withEdit(loaded.form,'exitViewPct',40);
 assert.equal(refreshTabForm.formError(edited,loaded),null,'40% fits the 50% Enter at this tab loaded');
 await ok(await setDefault(30));
 await refused(await updateAdvancedRule(refreshTabPut(loaded,edited),f.env,SITE,'P1'),409,/changed in another tab/);
 const {outcome,form,next}=await refreshTabRebase(f,loaded,edited);
 assert.deepEqual([outcome.cause,form.minViewPct,form.exitViewPct],['parents',30,40]);
 assert.equal(outcome.invalid,'Exit view % should be lower than or equal to entry view %.');
 const corrected=refreshTabForm.withEdit(form,'exitViewPct',25);
 assert.equal(refreshTabForm.formError(corrected,next),null);
 await ok(await updateAdvancedRule(refreshTabPut(next,corrected),f.env,SITE,'P1'));
 assert.deepEqual([f.readConfig().advancedUnitRules.P1.refresh.minViewPct,f.readConfig().advancedUnitRules.P1.refresh.exitViewPct],[30,25]);assertConsistent(f);
});

test('Refresh tab after its own save while another tab changed Default: a value put back shows what this tab saved against, and only entries made here are carried',async()=>{
 const f=setup();
 const setDefault=(timeout,minViewPct,maxRefreshes)=>updateAdvancedRule(request({timeout,refresh:{enabled:true,maxRefreshes,minViewPct}},'PUT'),f.env,SITE,'__DEFAULT__');
 await ok(await setDefault(1800,50,15));
 const opened=await ok(await listAdvancedRules(f.env,SITE));
 const first=refreshTabForm.baselineFromListing('P1',opened);
 await ok(await setDefault(2000,60,25));
 // This tab saves only P1's CMP wait, which is not checked against Default, so it applies.
 const saved=await ok(await updateAdvancedRule(refreshTabPut(first,refreshTabForm.withEdit(first.form,'cmpTimeout',3000)),f.env,SITE,'P1'));
 // As the panel does after a save: the scope as stored, from the response, on the listing it had.
 const loaded=refreshTabForm.baselineFromListing('P1',refreshTabForm.listingAfterSave(opened,'P1',saved));
 const typed=(form,pairs)=>pairs.reduce((current,[field,value])=>refreshTabForm.afterEdit(refreshTabForm.withEdit(current,field,value),loaded),form);
 const putBack=typed(loaded.form,[['timeout',1801],['timeout',1800],['accumulateViewTime',false],['accumulateViewTime',true]]);
 assert.deepEqual(putBack,loaded.form,'the sections show the values this tab\'s saves are compared with, not a newer read');
 assert.deepEqual(refreshTabForm.requestBody(putBack,loaded),{cmpTimeout:3000});
 // Exit at entered: refused, because Default changed since this tab read it, and only Exit at is carried.
 const exit=typed(loaded.form,[['exitViewPct',5]]);
 await refused(await updateAdvancedRule(refreshTabPut(loaded,exit),f.env,SITE,'P1'),409,/changed in another tab/);
 const round=await refreshTabRebase(f,loaded,exit);
 assert.deepEqual(round.review,{conflicts:[],applied:['Refresh settings','Exit at']});
 assert.deepEqual(round.next.carried,{exitViewPct:5});
 assert.deepEqual([round.form.minViewPct,round.form.maxRefreshes,round.form.ownTimeout,round.form.timeout,round.form.cmpTimeout],[60,25,false,2000,3000]);
 await ok(await updateAdvancedRule(refreshTabPut(round.next,round.form),f.env,SITE,'P1'));
 const p1=f.readConfig().advancedUnitRules.P1;
 assert.deepEqual([Object.hasOwn(p1,'timeout'),p1.cmpTimeout,p1.refresh.minViewPct,p1.refresh.maxRefreshes,p1.refresh.exitViewPct],[false,3000,60,25,5]);assertConsistent(f);
});

test('Refresh tab after a Default save that kept a position\'s Unit rules interval: the position, selected from the saved state, keeps it',async()=>{
 const f=setup();
 await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:1800,refresh:refresh(45)}},'POST'),f.env,SITE),201);
 const opened=await ok(await listAdvancedRules(f.env,SITE));
 const def=refreshTabForm.baselineFromListing('__DEFAULT__',opened);
 const sequence=['mode','sequence','sequenceText','20, 40, 80'];
 const form=refreshTabForm.withEdit(refreshTabForm.withEdit(def.form,sequence[0],sequence[1]),sequence[2],sequence[3]);
 const saved=await ok(await updateAdvancedRule(refreshTabPut(def,form),f.env,SITE,'__DEFAULT__'));
 assert.deepEqual(saved.keptUnitRuleIntervals,['P1']);
 assert.deepEqual(saved.keptAdvancedRules.P1,f.readConfig().advancedUnitRules.P1,'the response carries the record the save wrote');
 // As the panel does after the save, before its follow-up read lands (or when that read fails).
 const p1=refreshTabForm.baselineFromListing('P1',refreshTabForm.listingAfterSave(opened,'__DEFAULT__',saved));
 assert.deepEqual([p1.form.mode,p1.form.fixedSeconds],['fixed',45]);
 await ok(await updateAdvancedRule(refreshTabPut(p1,refreshTabForm.withEdit(p1.form,'maxRefreshes',7)),f.env,SITE,'P1'));
 const schedule=f.readConfig().advancedUnitRules.P1.refresh;
 assert.deepEqual([schedule.schedule.mode,schedule.schedule.fixedSeconds,schedule.maxRefreshes],['fixed',45,7],'the kept 45 s interval is not replaced by Default\'s sequence');assertConsistent(f);
});

test('Refresh tab after a group change elsewhere: the refused save is rebased on the new group, not refused again and again',async()=>{
 const f=setup();
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:10,schedule:{mode:'fixed',fixedSeconds:40}}},'PUT'),f.env,SITE,'__ATF__'));
 await ok(await updateAdvancedRule(request({refresh:{enabled:true,maxRefreshes:15,schedule:{mode:'fixed',fixedSeconds:60}}},'PUT'),f.env,SITE,'__BTF__'));
 const opened=await ok(await listAdvancedRules(f.env,SITE));
 const loaded=refreshTabForm.baselineFor('P1',opened.unitTypes.P1,opened.advancedRules,opened.unitRuleRows);
 assert.deepEqual([opened.unitTypes.P1,loaded.form.fixedSeconds],['BTF',60]);
 // Ad units moves P1 to ATF; this tab sets Maximum refreshes, built on the BTF group's values.
 await ok(await updateAdUnit(request({type:'ATF'}),f.env,SITE,'audit-unit'));
 const edited=refreshTabForm.withEdit(loaded.form,'maxRefreshes',7);
 await refused(await updateAdvancedRule(refreshTabPut(loaded,edited),f.env,SITE,'P1'),409,/changed in another tab/);
 const {current,outcome,form,next}=await refreshTabRebase(f,loaded,edited);
 assert.deepEqual([outcome.kind,outcome.cause,current.form.fixedSeconds],['rebased','parents',40],'the form now inherits from the ATF group');
 assert.deepEqual([form.maxRefreshes,form.fixedSeconds],[7,40]);
 await ok(await updateAdvancedRule(refreshTabPut(next,form),f.env,SITE,'P1'));
 const p1=f.readConfig().advancedUnitRules.P1.refresh;assert.deepEqual([p1.maxRefreshes,p1.schedule.fixedSeconds],[7,40]);assertConsistent(f);
});

// ATF-only sites: Default stores no refresh settings and the ATF group does. Every built-in
// script then reads its global refresh values from the ATF group's refresh (worker/releases.ts),
// so a BTF position with no refresh of its own runs at the ATF interval, Exit at and Maximum
// refreshes, and its dwell timer enters at the ATF percentage (which 3.16.2 also checks when a
// refresh is due). Real Worker handlers and the real generated scheduler of each version.
const VERSIONS=['3.16.0','3.16.1','3.16.2'];
const atfRefresh=(seconds,pct,extra={})=>({enabled:true,minViewPct:pct,exitViewPct:10,accumulateViewTime:true,minGapSeconds:0,maxRefreshes:20,requirePreviousViewable:false,checkEveryMs:5000,
 schedule:{mode:'fixed',fixedSeconds:seconds,firstSeconds:seconds,nextSeconds:seconds,growthPercent:20,maxSeconds:120,sequenceSeconds:[seconds]},...extra});
async function atfOnlySite(seconds=45,pct=60,extra){
 const f=setup();
 await ok(await createAdUnit(request({code:'Billboard',type:'ATF',sizeMapKey:'display'},'POST'),f.env,SITE),201);
 await ok(await updateAdvancedRule(request({refresh:atfRefresh(seconds,pct,extra)},'PUT'),f.env,SITE,'__ATF__'));
 return f;
}
// The site's selected script, as the Script setup save stores it (none: no selection yet).
function selectRuntime(f,version){
 const config=f.readConfig();
 if(version)config.builtinRuntimeSelection={runtime:pinRuntime(runtimeCatalog.find(r=>r.version===version),{allowPreview:true})};else delete config.builtinRuntimeSelection;
 f.writeConfig(config);
}
// A site without a selected script generates through the legacy path; its profile is put on the
// advanced-refresh engine, under which Refresh schedules take effect there.
function legacySite(f){
 selectRuntime(f,null);
 const key='generator-profiles/audit-profile/manifest.json',profile=JSON.parse(new TextDecoder().decode(f.objects.get(key)));
 f.objects.set(key,new TextEncoder().encode(JSON.stringify({...profile,engine:'legacy-advanced-refresh-v1'})));
}
// What a version's generated script (`legacy`: the legacy Generate path) runs for `code` on desktop
// or mobile: the interval after 0..3 refreshes and the rule values before the first, its global
// refresh settings, and the effective-behavior label the admin shows.
async function generated(f,code,versions=VERSIONS){
 const builtin=versions.filter(version=>version!=='legacy');
 const g={...(builtin.length?await generatedIntervals(f,[code],builtin):{}),...(versions.includes('legacy')?await legacyGeneratedRefresh(f,[code]):{})};
 return {
  run:(version,device='')=>({intervals:g[`${version} ${code}${device}`],...g[`rule ${version} ${code}${device}`]}),
  label:version=>g['summary '+version].units.find(unit=>unit.code===code).label,
  global:version=>g['global '+version],
 };
}
const BOTH=['',' mobile'];

test('Refresh tab on an ATF-only site: BTF scopes show the 45 s and 60% the scripts use, and changing only Maximum refreshes keeps them',async()=>{
 for(const key of ['P1','__BTF__','__DEFAULT__']){
  const f=await atfOnlySite();
  const before=await generated(f,'P1');
  // 3.16.0 and 3.16.1 check 0% when a refresh is due (R3-01); their dwell timer enters at the ATF 60%.
  for(const version of VERSIONS)for(const device of BOTH)assert.deepEqual(before.run(version,device),
   {intervals:[45,45,45,45],enabled:true,minViewPct:version==='3.16.2'?60:0,exitViewPct:10,maxRefreshes:20},`${version}${device} before`);
  assert.deepEqual(VERSIONS.map(before.label),['45s · 50%','45s · 50%','45s · 60%'],'the effective behavior shows the interval the scripts use');
  const {baseline,sent}=await refreshTabSave(f,key,{maxRefreshes:12});
  const {form}=baseline;
  assert.deepEqual([form.ownRefresh,form.refreshEnabled,form.mode,form.fixedSeconds,form.minViewPct,form.exitViewPct,form.maxRefreshes],
   [false,true,'fixed',45,60,10,20],`${key} shows what P1 runs with`);
  assert.deepEqual(sent.expectedInheritedRefresh,{...(key==='__DEFAULT__'?{enabled:true}:{}),minSeconds:45,minViewPct:60,exitViewPct:10,maxRefreshes:20},
   'the save carries the ATF values it was built from');
  const stored=f.readConfig().advancedUnitRules[key].refresh;
  assert.deepEqual([stored.enabled,stored.minSeconds,stored.schedule.mode,stored.schedule.fixedSeconds,stored.minViewPct,stored.exitViewPct,stored.maxRefreshes],[true,45,'fixed',45,60,10,12]);
  const after=await generated(f,'P1');
  // The 60% is now saved, so 3.16.0 and 3.16.1 check it too.
  for(const version of VERSIONS)for(const device of BOTH)assert.deepEqual(after.run(version,device),
   {intervals:[45,45,45,45],enabled:true,minViewPct:60,exitViewPct:10,maxRefreshes:12},`${key}: ${version}${device} after`);
  assert.deepEqual(VERSIONS.map(after.label),['45s · 60%','45s · 60%','45s · 60%']);
  assert(VERSIONS.every(version=>after.global(version).enabled!==false),'refresh stays on');
  // The ATF position keeps the ATF group's own values.
  const billboard=await generated(f,'Billboard');
  for(const version of VERSIONS)for(const device of BOTH)assert.deepEqual(billboard.run(version,device),
   {intervals:[45,45,45,45],enabled:true,minViewPct:60,exitViewPct:10,maxRefreshes:20},`${key}: Billboard ${version}${device}`);
  assertConsistent(f);
 }
});

test('Refresh tab on an ATF-only site: a save built on the ATF values is refused with 409 when the ATF refresh changed since, and nothing is written',async()=>{
 for(const key of ['P1','__BTF__','__DEFAULT__']){
  const f=await atfOnlySite();
  const loaded=refreshTabForm.baselineFromListing(key,await ok(await listAdvancedRules(f.env,SITE)));
  assert.deepEqual([loaded.form.fixedSeconds,loaded.form.minViewPct,loaded.form.maxRefreshes],[45,60,20]);
  // Another tab changes the ATF group to 75 s and 70%; this tab then changes only Maximum refreshes.
  const atf=(await ok(await listAdvancedRules(f.env,SITE))).unitRuleRows.__ATF__;
  await ok(await updateAdvancedRule(request({expectedUpdatedAt:atf.updatedAt,expectedUnitRuleId:atf.id,refresh:atfRefresh(75,70)},'PUT'),f.env,SITE,'__ATF__'));
  const edited=refreshTabForm.withEdit(loaded.form,'maxRefreshes',12);
  const before=f.readConfig(),beforeRows=rows(f),saves=auditCount(f,'unit_rule.advanced_updated');
  await refused(await updateAdvancedRule(refreshTabPut(loaded,edited),f.env,SITE,key),409,/changed in another tab/);
  assert.deepEqual(f.readConfig(),before,`${key}: nothing was written`);assert.deepEqual(rows(f),beforeRows);
  assert.equal(auditCount(f,'unit_rule.advanced_updated'),saves,'a refused save records no audit row');
  const runs=await generated(f,'P1');
  for(const version of VERSIONS)for(const device of BOTH)assert.deepEqual(runs.run(version,device).intervals,[75,75,75,75],`${key}: P1 follows the new ATF interval in ${version}${device}`);
  assert.equal(runs.run('3.16.2').minViewPct,70);
  // The rebase shows the new ATF values with this tab's entry, and the reviewed save applies them.
  const {outcome,form,review,next}=await refreshTabRebase(f,loaded,edited,key);
  assert.deepEqual([outcome.kind,outcome.cause,form.fixedSeconds,form.minViewPct,form.maxRefreshes],['rebased','parents',75,70,12],key);
  assert.deepEqual(review,{conflicts:[],applied:['Refresh settings','Maximum refreshes']});
  await ok(await updateAdvancedRule(refreshTabPut(next,form),f.env,SITE,key));
  const after=await generated(f,'P1');
  for(const version of VERSIONS)for(const device of BOTH)assert.deepEqual(after.run(version,device),
   {intervals:[75,75,75,75],enabled:true,minViewPct:70,exitViewPct:10,maxRefreshes:12},`${key}: ${version}${device} after the reviewed save`);
  assertConsistent(f);
 }
});

test('Refresh tab on an ATF-only site follows the selected script: 3.16.0 and the legacy path run a BTF position at the ATF minimum wall-clock gap',async()=>{
 const f=await atfOnlySite(45,60,{minGapSeconds:15});
 legacySite(f);
 const runs=await generated(f,'P1',[...VERSIONS,'legacy']);
 for(const device of BOTH)assert.deepEqual([...VERSIONS,'legacy'].map(version=>runs.run(version,device).intervals),[[15,15,15,15],[45,45,45,45],[45,45,45,45],[15,15,15,15]],`P1${device}`);
 assert.deepEqual(VERSIONS.map(runs.label),['15s · 50%','45s · 50%','45s · 60%']);
 for(const [version,seconds] of [['3.16.0',15],['3.16.1',45],['3.16.2',45],[null,15]]){
  selectRuntime(f,version);
  const listing=await ok(await listAdvancedRules(f.env,SITE)),pin=f.readConfig().builtinRuntimeSelection?.runtime;
  assert.deepEqual(listing.runtime,pin?{runtimeId:pin.runtimeId,runtimeVersion:pin.runtimeVersion,capabilities:pin.capabilities}:null);
  assert.equal(refreshTabForm.baselineFromListing('P1',listing).form.fixedSeconds,seconds,`${version??'no selection'}: P1 shows the interval its script runs`);
 }
 // Built for 3.16.0, refused once another tab selected 3.16.2, which runs P1 at 45 s.
 selectRuntime(f,'3.16.0');
 const loaded=refreshTabForm.baselineFromListing('P1',await ok(await listAdvancedRules(f.env,SITE)));
 selectRuntime(f,'3.16.2');const before=f.readConfig(),beforeRows=rows(f);
 await refused(await updateAdvancedRule(refreshTabPut(loaded,refreshTabForm.withEdit(loaded.form,'maxRefreshes',12)),f.env,SITE,'P1'),409,/changed in another tab/);
 assert.deepEqual(f.readConfig(),before,'nothing was written');assert.deepEqual(rows(f),beforeRows);
 // On 3.16.0, changing only Maximum refreshes keeps the 15 s.
 selectRuntime(f,'3.16.0');
 await refreshTabSave(f,'P1',{maxRefreshes:12});
 const after=await generated(f,'P1',['3.16.0']);
 for(const device of BOTH)assert.deepEqual(after.run('3.16.0',device),{intervals:[15,15,15,15],enabled:true,minViewPct:60,exitViewPct:10,maxRefreshes:12});
});

test('Refresh tab on an ATF-only site: the bottom Sticky shows the interval its timer uses, and changing only Maximum refreshes keeps it',async()=>{
 // 3.16.0 times the bottom Sticky every 30 s unless its own settings give it a minimum time, and the legacy template
 // always uses 30 s; 3.16.1 and 3.16.2 time it like any position, from the ATF interval here.
 const timer=(g,version)=>version==='3.16.0'||version==='legacy'?g[`sticky ${version}`]:g[`${version} Sticky`][0];
 async function stickySite(version,type='BTF'){
  const f=await atfOnlySite();
  await ok(await createAdUnit(request({code:'Sticky',type,sizeMapKey:'display'},'POST'),f.env,SITE),201);
  const config=f.readConfig();config.runtimeControls={...config.runtimeControls,sticky:{bottomAdUnitId:'Sticky'}};f.writeConfig(config);
  if(version==='legacy')legacySite(f);else selectRuntime(f,version);
  return f;
 }
 for(const [version,seconds] of [['3.16.0',30],['3.16.1',45],['3.16.2',45],['legacy',30]]){
  const f=await stickySite(version);
  const runs=()=>version==='legacy'?legacyGeneratedRefresh(f,['Sticky']):generatedIntervals(f,['Sticky'],[version]);
  assert.equal(timer(await runs(),version),seconds,`${version}: the Sticky timer`);
  const listing=await ok(await listAdvancedRules(f.env,SITE));
  assert.equal(listing.stickyAdUnit,'Sticky');
  const atfNote=refreshTabForm.atfIsGlobalSource('__ATF__',listing.advancedRules,listing.unitRuleRows,listing.unitTypes,refreshTabForm.listingScript(listing));
  assert.equal(atfNote.stickyApart,seconds===30,`${version}: the ATF group note names the Sticky timer`);
  assert.deepEqual(refreshTabForm.atfGlobalRefresh('Sticky','BTF',listing.advancedRules,listing.unitRuleRows,refreshTabForm.listingScript(listing)),
   [...(seconds===45?['the interval']:[]),'Enter at','Exit at','Maximum refreshes'],`${version}: the values the note says come from the ATF group`);
  const {baseline}=await refreshTabSave(f,'Sticky',{maxRefreshes:12});
  assert.equal(baseline.form.fixedSeconds,seconds,`${version}: the Sticky form shows the interval its timer uses`);
  assert.equal(timer(await runs(),version),seconds,`${version}: the Sticky timer after a Maximum refreshes save`);
  assert.equal(f.readConfig().advancedUnitRules.Sticky.refresh.maxRefreshes,12);
 }
 // A bottom Sticky saved as none (null): a selected script then has none, so the Sticky position runs like any other (3.16.0:
 // the ATF 45 s), while the legacy Generate path reads only a saved text and still times 'Sticky' separately at 30 s.
 // An empty text means none for both. With no bottom Sticky saved at all, both time the 'Sticky' unit separately.
 for(const [version,saved,target,seconds] of [['3.16.0',null,null,45],['legacy',null,'Sticky',30],['3.16.0','',null,45],['legacy','',null,45],
  ['3.16.0',undefined,'Sticky',30],['legacy',undefined,'Sticky',30]]){
  const g=await stickySite(version),c=g.readConfig(),label=`${version}, ${saved===undefined?'none saved':`saved as ${JSON.stringify(saved)}`}`;
  c.runtimeControls.sticky=saved===undefined?{}:{bottomAdUnitId:saved};g.writeConfig(c);
  const runs=version==='legacy'?await legacyGeneratedRefresh(g,['Sticky']):await generatedIntervals(g,['Sticky'],[version]);
  assert.equal(runs[`sticky target ${version}`]||null,target,`${label}: the script's bottom Sticky`);
  assert.equal(target?runs[`sticky ${version}`]:runs[`${version} Sticky`][0],seconds,`${label}: the Sticky position's interval`);
  const listing=await ok(await listAdvancedRules(g.env,SITE));
  assert.equal(listing.stickyAdUnit,target,label);
  assert.equal(refreshTabForm.baselineFromListing('Sticky',listing).form.fixedSeconds,seconds,`${label}: the Sticky form`);
 }
 // An ATF bottom Sticky inherits from the ATF group like any ATF position, so the ATF group note leaves its timer out.
 {
  const g=await stickySite('3.16.0','ATF'),listing=await ok(await listAdvancedRules(g.env,SITE));
  assert.equal(refreshTabForm.atfIsGlobalSource('__ATF__',listing.advancedRules,listing.unitRuleRows,listing.unitTypes,refreshTabForm.listingScript(listing)).stickyApart,false,'3.16.0, ATF bottom Sticky');
 }
 // A 3.16.0 Sticky save built before another tab chose another bottom Sticky is refused: the position now runs at the ATF 45 s.
 const f=await stickySite('3.16.0');
 const loaded=refreshTabForm.baselineFromListing('Sticky',await ok(await listAdvancedRules(f.env,SITE)));
 const config=f.readConfig();config.runtimeControls.sticky={bottomAdUnitId:''};f.writeConfig(config);
 const before=f.readConfig(),beforeRows=rows(f);
 await refused(await updateAdvancedRule(refreshTabPut(loaded,refreshTabForm.withEdit(loaded.form,'maxRefreshes',12)),f.env,SITE,'Sticky'),409,/changed in another tab/);
 assert.deepEqual(f.readConfig(),before,'nothing was written');assert.deepEqual(rows(f),beforeRows);
 assert.equal(refreshTabForm.baselineFromListing('Sticky',await ok(await listAdvancedRules(f.env,SITE))).form.fixedSeconds,45);
});

test('Refresh tab: where no scope saves a refresh value, the form shows what the selected script runs, and changing another value keeps it',async()=>{
 const CASES={
  'nothing saved':{},
  'ATF refresh only':{advanced:{__ATF__:atfRefresh(45,60)}},
  'ATF refresh only in Unit rules':{basic:{__ATF__:{refresh:{...refresh(40),minViewPct:65}}}},
  'ATF growing interval':{advanced:{__ATF__:{...atfRefresh(20,55),schedule:{mode:'percentage',firstSeconds:20,growthPercent:50,maxSeconds:200}}}},
  'ATF refresh, BTF group stores some values in Unit rules':{advanced:{__ATF__:atfRefresh(45,60,{exitViewPct:5,maxRefreshes:8})},basic:{__BTF__:{refresh:refresh(40)}}},
  'Default and ATF refresh':{advanced:{__DEFAULT__:atfRefresh(50,55,{maxRefreshes:9}),__ATF__:atfRefresh(45,60)}},
  'ATF minimum wall-clock gap':{advanced:{__ATF__:atfRefresh(45,60,{minGapSeconds:15})}},
  'ATF refresh off':{advanced:{__ATF__:atfRefresh(45,60,{enabled:false})}},
 };
 // The intervals a form's schedule gives after 0..3 refreshes, the way the script reads a saved schedule.
 const formIntervals=form=>[0,1,2,3].map(completed=>scheduledSeconds({minSeconds:form.fixedSeconds,schedule:{mode:form.mode,fixedSeconds:form.fixedSeconds,firstSeconds:form.firstSeconds,
  nextSeconds:form.nextSeconds,growthPercent:form.growthPercent,maxSeconds:form.maxSeconds,sequenceSeconds:refreshTabForm.parseSequence(form.sequenceText)}},completed));
 // Enter at is where the dwell timer starts counting: a saved percentage above 0, else the compiled REFRESH_IN_VIEW_PCT (getEntryPct).
 const entered=(run,global)=>run.minViewPct>0?run.minViewPct:Number(global.minViewPct??50);
 for(const [name,{advanced={},basic={}}] of Object.entries(CASES))for(const version of [...VERSIONS,'legacy']){
  const f=setup();
  for(const [key,rule] of Object.entries(basic))await ok(await createUnitRule(request({ruleKey:key,rule},'POST'),f.env,SITE),201);
  for(const [key,value] of Object.entries(advanced))await ok(await updateAdvancedRule(request({refresh:value},'PUT'),f.env,SITE,key));
  if(version==='legacy')legacySite(f);else selectRuntime(f,version);
  const listing=await ok(await listAdvancedRules(f.env,SITE)),stores=key=>Boolean(refreshTabForm.ownRecord(key,listing.advancedRules,listing.unitRuleRows).refresh);
  const runs=await generated(f,'P1',[version]),global=runs.global(version);
  // A scope's form describes P1 when no scope between it and P1 stores refresh settings.
  const scopes=['P1','__BTF__','__DEFAULT__'].filter((key,index,all)=>all.slice(0,index).every(below=>!stores(below)));
  for(const key of scopes)for(const device of BOTH){
   const {form}=refreshTabForm.baselineFromListing(key,listing),run=runs.run(version,device),label=`${name}, ${version}${device}, ${key}`;
   assert.deepEqual(formIntervals(form),run.intervals,`${label}: interval`);
   assert.equal(form.minViewPct,entered(run,global),`${label}: Enter at`);
   assert.deepEqual([form.exitViewPct,form.maxRefreshes],[run.exitViewPct,run.maxRefreshes],`${label}: Exit at and Maximum refreshes`);
   // Before 3.16.1 a Default save becomes the global switch; otherwise a save sets the scope's own rule.
   assert.equal(form.refreshEnabled,key==='__DEFAULT__'&&version!=='3.16.1'&&version!=='3.16.2'?global.enabled!==false:run.enabled,`${label}: Refresh enabled`);
  }
  // Changing only Maximum refreshes for P1 keeps everything else the script runs.
  await refreshTabSave(f,'P1',{maxRefreshes:13});
  const after=await generated(f,'P1',[version]);
  for(const device of BOTH){
   const was=runs.run(version,device),now=after.run(version,device);
   assert.deepEqual([now.intervals,now.enabled,entered(now,after.global(version)),now.exitViewPct,now.maxRefreshes],
    [was.intervals,was.enabled,entered(was,global),was.exitViewPct,13],`${name}, ${version}${device}: after a Maximum refreshes save`);
  }
  assert.equal(after.global(version).enabled!==false,global.enabled!==false,`${name}, ${version}: the global switch is unchanged`);
  // Before 3.16.1 an ATF group save is also the global switch while Default has none: its form shows the switch as it is,
  // and changing only Maximum refreshes there keeps it.
  const atf=refreshTabForm.baselineFromListing('__ATF__',await ok(await listAdvancedRules(f.env,SITE))).form;
  if(version!=='3.16.1'&&version!=='3.16.2'&&!stores('__DEFAULT__'))assert.equal(atf.refreshEnabled,global.enabled!==false,`${name}, ${version}: the ATF group shows the global switch`);
  await refreshTabSave(f,'__ATF__',{maxRefreshes:14});
  assert.equal((await generated(f,'P1',[version])).global(version).enabled!==false,global.enabled!==false,`${name}, ${version}: an ATF group save keeps the global switch`);
  f.close();fixtures.splice(fixtures.indexOf(f),1);
 }
});

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
  applied:['timeout','minViewPct'],
 });
 const labels={timeout:'Timeout',minSeconds:'Minimum time',minViewPct:'Minimum in view',conditionalMappings:'Key-value mappings'};
 const text=(key,value)=>key==='conditionalMappings'?`${value.length} mapping`:`${value}${key==='minSeconds'?' sec':key==='timeout'?' ms':'%'}`;
 assert.deepEqual(rebaseReview(result,saved,key=>labels[key],text),{conflicts:[{field:'Minimum time',yours:'90 sec',saved:'75 sec'}],applied:['Timeout','Minimum in view']});
 // Mappings are compared as a whole field; values that read the same are still told apart.
 const mappings=rebaseEdits({...loaded,conditionalMappings:[{id:'m',priority:3}]},loaded,saved);
 assert.deepEqual(mappings.conflicts,['conditionalMappings']);assert.deepEqual(mappings.form.conditionalMappings,[{id:'m',priority:3}]);
 assert.deepEqual(rebaseReview(mappings,saved,key=>labels[key],text).conflicts,[{field:'Key-value mappings',yours:'your version',saved:'a different version'}]);
 assert.deepEqual(rebaseEdits(loaded,loaded,saved),{form:saved,changed:[],conflicts:[],applied:[]},'nothing changed here: the saved values as they are');
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
 assert.deepEqual(result,{form:{...loaded,minSeconds:20},changed:['overrideRefresh','minSeconds'],conflicts:['overrideRefresh'],applied:['minSeconds'],
  kept:['refreshEnabled','minViewPct','requirePreviousViewable','checkEveryMs']},'the values this tab showed are kept, not the placeholders');
 const labels={overrideRefresh:'Override inherited refresh',refreshEnabled:'Refresh enabled',minSeconds:'Minimum time',timeout:'Timeout'};
 const text=(key,value)=>typeof value==='boolean'?(value?'on':key.startsWith('override')?'off (inherited)':'off'):`${value}`;
 const review=rebaseReview(result,overrideOff,key=>labels[key],text);
 assert.deepEqual(review,{conflicts:[{field:'Override inherited refresh',yours:'on',saved:'off (inherited)'}],applied:['Minimum time']});
 assert.doesNotMatch(JSON.stringify(review),/30/,'a form default is never shown as the other tab\'s value');
 // A field this tab left alone follows the other tab: the override stays off, no conflict.
 assert.deepEqual(rebaseEdits({...loaded,timeout:1200},loaded,overrideOff,unitGates),{form:{...overrideOff,timeout:1200},changed:['timeout'],conflicts:[],applied:['timeout']});
 // The other tab turned refresh off but kept the override: the stored values are real, so untouched ones follow it.
 const disabled={...loaded,refreshEnabled:false,minViewPct:80};
 assert.deepEqual(rebaseEdits({...loaded,minSeconds:20},loaded,disabled,unitGates),{form:{...disabled,refreshEnabled:true,minSeconds:20},changed:['refreshEnabled','minSeconds'],conflicts:['refreshEnabled'],applied:['minSeconds']});
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
 assert.deepEqual(sequence,{form:{...switched,mode:'sequence',sequenceText:'25, 50'},changed:['mode','sequenceText'],conflicts:['mode'],applied:['sequenceText'],switchedOff:{mode:['fixedSeconds']}});
 const modeText=(key,value)=>({fixed:'Same every time',sequence:'Explicit sequence',percentage:'Percentage increase'})[value]??(typeof value==='boolean'?(value?'on':'off'):key==='fixedSeconds'?`${value} sec`:`${value}`);
 const refreshLabels={refreshEnabled:'Refresh enabled',mode:'Interval strategy',fixedSeconds:'Every refresh',sequenceText:'Intervals, in seconds',maxRefreshes:'Maximum refreshes',maxSeconds:'Maximum interval'};
 assert.deepEqual(rebaseReview(sequence,switched,key=>refreshLabels[key],modeText),
  {conflicts:[{field:'Interval strategy',yours:'Explicit sequence',saved:'Same every time (Every refresh: 40 sec)'}],applied:['Intervals, in seconds']});
 // A field both strategies use keeps working under the other tab's strategy: no strategy conflict.
 const first={...schedule,mode:'firstThenFixed'};
 assert.deepEqual(rebaseEdits({...first,firstSeconds:25},first,{...first,mode:'percentage'},refreshGates),{form:{...first,mode:'percentage',firstSeconds:25},changed:['firstSeconds'],conflicts:[],applied:['firstSeconds']});
 // The other tab disabled refresh while this tab changed an interval: refresh enabled is the conflict.
 assert.deepEqual(rebaseEdits({...schedule,sequenceText:'25, 50'},schedule,{...schedule,refreshEnabled:false,maxRefreshes:9},refreshGates),
  {form:{...schedule,maxRefreshes:9,sequenceText:'25, 50'},changed:['refreshEnabled','sequenceText'],conflicts:['refreshEnabled'],applied:['sequenceText']});
 // This tab changed the strategy itself and the other tab chose a different one: one conflict, on the strategy.
 assert.deepEqual(rebaseEdits({...schedule,mode:'percentage',maxSeconds:90},schedule,switched,refreshGates),
  {form:{...switched,mode:'percentage',maxSeconds:90},changed:['mode','maxSeconds'],conflicts:['mode'],applied:['maxSeconds'],switchedOff:{mode:['fixedSeconds']}});
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
 assert.deepEqual(off,{form:{...other,overrideRefresh:false},changed:['overrideRefresh'],conflicts:['overrideRefresh'],applied:[],switchedOff:{overrideRefresh:['minSeconds','minViewPct']}});
 assert.deepEqual(rebaseReview(off,other,key=>labels[key],text),
  {conflicts:[{field:'Override inherited refresh',yours:'off (inherited)',saved:'on (Minimum time: 45 sec; Minimum in view: 60%)'}],applied:[]});
 // Turning refresh off under a kept override: the inner switch is the conflict.
 const disabled=rebaseEdits({...loaded,refreshEnabled:false,timeout:1200},loaded,{...loaded,minSeconds:45},unitGates);
 assert.deepEqual(disabled,{form:{...loaded,refreshEnabled:false,timeout:1200,minSeconds:45},changed:['timeout','refreshEnabled'],conflicts:['refreshEnabled'],applied:['timeout'],switchedOff:{refreshEnabled:['minSeconds']}});
 assert.deepEqual(rebaseReview(disabled,{...loaded,minSeconds:45},key=>labels[key],text),
  {conflicts:[{field:'Refresh enabled',yours:'off',saved:'on (Minimum time: 45 sec)'}],applied:['Timeout']});
 // The other tab changed a value this tab's switch leaves in effect, or a form default it never saved: no conflict.
 assert.deepEqual(rebaseEdits({...loaded,overrideTimeout:false},loaded,other,unitGates),{form:{...other,overrideTimeout:false},changed:['overrideTimeout'],conflicts:[],applied:['overrideTimeout']});
 const inherited={...loaded,overrideRefresh:false,minSeconds:30,minViewPct:50};
 assert.deepEqual(rebaseEdits({...loaded,refreshEnabled:false},loaded,inherited,unitGates).switchedOff,undefined,'placeholders under the other tab\'s inherited section are not its values');
 // Both tabs switched the section off: nothing of the other tab's is lost.
 assert.deepEqual(rebaseEdits({...loaded,overrideRefresh:false},loaded,inherited,unitGates),{form:inherited,changed:['overrideRefresh'],conflicts:[],applied:['overrideRefresh']});

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
 assert.deepEqual(toFixed,{form:{...longer,mode:'fixed',fixedSeconds:45},changed:['mode','fixedSeconds'],conflicts:['mode'],applied:['fixedSeconds'],switchedOff:{mode:['sequenceText']}});
 assert.deepEqual(rebaseReview(toFixed,longer,key=>refreshLabels[key],refreshText),
  {conflicts:[{field:'Interval strategy',yours:'Same every time',saved:'Explicit sequence (Intervals, in seconds: 25, 50)'}],applied:['Every refresh']});
 // Refresh turned off here: every value of the other tab's that refresh used is named once, under the outer switch.
 const stopped=rebaseEdits({...schedule,refreshEnabled:false,mode:'fixed'},schedule,longer,refreshGates);
 assert.deepEqual(stopped.conflicts,['refreshEnabled']);assert.deepEqual(stopped.switchedOff,{refreshEnabled:['sequenceText','maxRefreshes']});
 assert.deepEqual(rebaseReview(stopped,longer,key=>refreshLabels[key],refreshText).conflicts,
  [{field:'Refresh enabled',yours:'off',saved:'on (Intervals, in seconds: 25, 50; Maximum refreshes: 12)'}]);
});

// The Unit rules dialog after a 409, exactly as UnitRulesPanel runs it: the form it opened
// with, the rule as saved now, and the note it shows.
// It runs dialogAfterRefusal, and after an earlier rebase compares with the state that rebase
// left (`state`), as the dialog keeps it.
function dialogRebase(source,latest,form,state={form:formFromRule(source.ruleKey??'P1',source.rule),carried:{}}){
 const {rebased,review,next}=dialogAfterRefusal(form,state,formFromRule(latest.ruleKey??'P1',latest.rule));
 return {rebased,review,next:ruleFromForm(rebased.form),state:next};
}
const opened=rule=>formFromRule('P1',rule);
const placeholderRefresh={enabled:true,minSeconds:30,minViewPct:50,requirePreviousViewable:false,checkEveryMs:5000};

test('Unit rules dialog after a 409: a section both tabs switched on is compared by what the other tab stored, even when it equals the form default',()=>{
 // P1 inherits timeout and lazy load; both tabs turn the same override on.
 const source={rule:{refresh:refresh(60)}};
 // The other tab kept the prefilled 2500 ms; this tab entered 1800 ms.
 const timeout=dialogRebase(source,{rule:{refresh:refresh(60),timeout:2500}},{...opened(source.rule),overrideTimeout:true,timeout:1800});
 assert.deepEqual(timeout.review,{conflicts:[{field:'Timeout',yours:'1800 ms',saved:'2500 ms'}],applied:['Override inherited timeout']});
 // The other tab turned lazy load off for P1 (prefilled 500/200 px); this tab turned it on at 300 px.
 const lazyOff={enabled:false,fetchMarginPx:500,renderMarginPx:200};
 const lazyCase=dialogRebase(source,{rule:{refresh:refresh(60),lazy:lazyOff}},{...opened(source.rule),overrideLazy:true,lazyEnabled:true,fetchMarginPx:300});
 assert.deepEqual(lazyCase.review,{conflicts:[{field:'Lazy auction enabled',yours:'on',saved:'off'}],applied:['Override inherited lazy load','Start auction within']});
 // P1 inherits refresh; the other tab pinned the prefilled 30 s, this tab entered 45 s. Fields
 // this tab never typed take the other tab's stored values and are not listed as applied.
 const inherits={rule:{timeout:1800}};
 const pinned={rule:{timeout:1800,refresh:placeholderRefresh}};
 const round1=dialogRebase(inherits,pinned,{...opened(inherits.rule),overrideRefresh:true,minSeconds:45});
 assert.deepEqual(round1.review,{conflicts:[{field:'Minimum time',yours:'45 sec',saved:'30 sec'}],applied:['Override inherited refresh']});
 // Refused again: a third tab changed Minimum in view. The dialog now compares against the rule
 // it reloaded, so only the override and Minimum time are this tab's, and the third tab's 70% stays.
 const round2=dialogRebase(pinned,{rule:{timeout:1800,refresh:{...placeholderRefresh,minViewPct:70}}},round1.rebased.form,round1.state);
 assert.deepEqual(round2.review,{conflicts:[],applied:['Override inherited refresh','Minimum time']});
 assert.deepEqual(round2.next,{timeout:1800,refresh:{...placeholderRefresh,minSeconds:45,minViewPct:70}});
});

test('Unit rules dialog after a 409: a value typed before this tab switched its section off is never compared with a form default',()=>{
 // (a) Typed 1800 ms, then removed the timeout override; the other tab removed it too and stored nothing.
 const timed={rule:{timeout:1500,refresh:refresh(60)}};
 const both=dialogRebase(timed,{rule:{refresh:refresh(60)}},{...opened(timed.rule),timeout:1800,overrideTimeout:false});
 assert.deepEqual(both.review,{conflicts:[],applied:['Override inherited timeout']});
 assert.doesNotMatch(JSON.stringify(both.review),/2500/,'a form default is never shown as the other tab\'s value');
 assert.deepEqual(both.next,{refresh:refresh(60)});
 // (b) Typed 20 s, then removed the refresh override; the other tab saved 45 s under it.
 const fast={rule:{timeout:2500,refresh:refresh(15)}};
 const other={rule:{timeout:2500,refresh:refresh(45)}};
 const off=dialogRebase(fast,other,{...opened(fast.rule),minSeconds:20,overrideRefresh:false});
 assert.deepEqual(off.review,{conflicts:[{field:'Override inherited refresh',yours:'off (inherited)',saved:'on (Minimum time: 45 sec)'}],applied:[]});
 assert.deepEqual(off.rebased.switchedOff,{overrideRefresh:['minSeconds']});
 // The 20 s stayed hidden under the switched-off override, so it is not carried: turning the
 // override back on shows and saves the other tab's 45 s.
 assert.equal(off.rebased.form.minSeconds,45);assert.deepEqual(off.rebased.changed,['overrideRefresh']);
 assert.equal(ruleFromForm({...off.rebased.form,overrideRefresh:true}).refresh.minSeconds,45);
 // (c) The same with the inner switch: typed 20 s, then turned refresh off under the kept override.
 const disabled=dialogRebase(fast,other,{...opened(fast.rule),minSeconds:20,refreshEnabled:false});
 assert.deepEqual(disabled.review,{conflicts:[{field:'Refresh enabled',yours:'off',saved:'on (Minimum time: 45 sec)'}],applied:[]});
});

test('Unit rules dialog refused twice: values the first rebase kept from what the form showed are not taken for this tab\'s entries',()=>{
 // P1 refreshes at 60 s, Minimum in view 70% and a 2000 ms check. The other tab removes the
 // override while this tab changes Minimum time to 45 s.
 const source={rule:{timeout:1800,refresh:{...refresh(60),minViewPct:70,checkEveryMs:2000}}};
 const removed={rule:{timeout:1800}};
 const round1=dialogRebase(source,removed,{...opened(source.rule),minSeconds:45});
 assert.deepEqual(round1.review.conflicts.map(conflict=>conflict.field),['Override inherited refresh']);
 assert.deepEqual([round1.rebased.form.minSeconds,round1.rebased.form.minViewPct,round1.rebased.form.checkEveryMs],[45,70,2000],'the form keeps what it showed');
 const {state}=round1;
 assert.deepEqual([state.form.overrideRefresh,state.form.minSeconds,state.form.minViewPct,state.form.checkEveryMs],[false,30,70,2000],
  'the baseline takes back only this tab\'s changes');
 assert.deepEqual(state.carried,{overrideRefresh:true,minSeconds:45},'the values this tab entered, as the review showed them');
 // Saved again with the override kept, and refused: a third tab turned it on at 60%. Only
 // Minimum time is this tab's; Minimum in view and Check interval take the third tab's values.
 const third={rule:{timeout:1800,refresh:{...placeholderRefresh,minViewPct:60}}};
 const round2=dialogRebase(removed,third,round1.rebased.form,state);
 assert.deepEqual(round2.review,{conflicts:[{field:'Minimum time',yours:'45 sec',saved:'30 sec'}],applied:['Override inherited refresh']});
 assert.deepEqual(round2.next,{timeout:1800,refresh:{...placeholderRefresh,minSeconds:45,minViewPct:60}});
 // 30 s typed after the review equals the dialog's placeholder under the override the other tab
 // removed, which this tab never saw: it is this tab's entry, and the third tab's 50 s is a conflict.
 const typed=dialogRebase(removed,{rule:{timeout:1800,refresh:{...placeholderRefresh,minSeconds:50}}},{...round1.rebased.form,minSeconds:30},state);
 assert.deepEqual(typed.review,{conflicts:[{field:'Minimum time',yours:'30 sec',saved:'50 sec'}],applied:['Override inherited refresh']});
 assert.equal(typed.next.refresh.minSeconds,30);
 // Refused again because a third tab changed only the timeout: the override is still off there,
 // so the form keeps the 70% and 2000 ms it showed, not the dialog's placeholders.
 const timeoutOnly=dialogRebase(removed,{rule:{timeout:2000}},round1.rebased.form,state);
 assert.deepEqual(timeoutOnly.review,{conflicts:[],applied:['Override inherited refresh','Minimum time']});
 assert.deepEqual(timeoutOnly.next,{timeout:2000,refresh:{...refresh(45),minViewPct:70,checkEveryMs:2000}});
 assert.deepEqual(timeoutOnly.rebased.kept,['refreshEnabled','minViewPct','requirePreviousViewable','checkEveryMs']);
 // A value entered here stays this tab's in the next round even where the other tab saved the
 // same value: a third tab's change to it is a conflict, not taken over silently.
 const agreed=dialogRebase(source,{rule:{...source.rule,timeout:2000}},{...opened(source.rule),timeout:2000});
 assert.deepEqual(agreed.review,{conflicts:[],applied:['Timeout']});
 const again=dialogRebase({rule:{...source.rule,timeout:2000}},{rule:{...source.rule,timeout:2500}},agreed.rebased.form,agreed.state);
 assert.deepEqual(again.review,{conflicts:[{field:'Timeout',yours:'2000 ms',saved:'2500 ms'}],applied:[]});
 assert.equal(again.next.timeout,2000);
 // An entry put back after the review to the value the form showed is no longer this tab's:
 // refused again, the dialog takes the third tab's Minimum time without a conflict.
 const timedOther={rule:{...source.rule,timeout:2000}};
 const changed=dialogRebase(source,timedOther,{...opened(source.rule),minSeconds:45});
 assert.deepEqual(changed.review,{conflicts:[],applied:['Minimum time']});
 assert.deepEqual(changed.state.carried,{minSeconds:45});
 const putBack=dialogRebase(timedOther,{rule:{...timedOther.rule,refresh:{...timedOther.rule.refresh,minSeconds:50}}},{...changed.rebased.form,minSeconds:60},changed.state);
 assert.deepEqual(putBack.review,{conflicts:[],applied:[]});
 assert.equal(putBack.next.refresh.minSeconds,50);
});

test('Unit rules dialog after a real 409: the other tab\'s lazy-off override is shown as a conflict before this tab can save over it',async()=>{
 const f=setup();await ok(await createUnitRule(request({ruleKey:'P1',rule:{refresh:refresh(60)}},'POST'),f.env,SITE),201);
 const tabA=await listed(f,'P1'),tabB=await listed(f,'P1');
 const lazyOff={enabled:false,fetchMarginPx:500,renderMarginPx:200};
 await ok(await updateUnitRule(request({rule:ruleFromForm({...opened(tabB.rule),overrideLazy:true}),expectedUpdatedAt:tabB.updatedAt}),f.env,SITE,tabB.id));
 assert.deepEqual(JSON.parse(rows(f)[0].rule_json),{lazy:lazyOff,refresh:refresh(60)});
 const form={...opened(tabA.rule),overrideLazy:true,lazyEnabled:true,fetchMarginPx:300};
 await refused(await updateUnitRule(request({rule:ruleFromForm(form),expectedUpdatedAt:tabA.updatedAt}),f.env,SITE,tabA.id),409,/changed in another tab/);
 const latest=await listed(f,'P1');
 const {review,next}=dialogRebase(tabA,latest,form);
 assert.deepEqual(review.conflicts,[{field:'Lazy auction enabled',yours:'on',saved:'off'}]);
 assert.deepEqual(JSON.parse(rows(f)[0].rule_json).lazy,lazyOff,'nothing of this tab was saved');
 // Saving after the review is this tab's choice, checked against the version it reloaded.
 await ok(await updateUnitRule(request({rule:next,expectedUpdatedAt:latest.updatedAt}),f.env,SITE,latest.id));
 assert.deepEqual(JSON.parse(rows(f)[0].rule_json).lazy,{enabled:true,fetchMarginPx:300,renderMarginPx:200});assertConsistent(f);
});

test('Unit rules dialog after a real 409: a value the Refresh tab saved while refresh was off is a conflict when this dialog puts its own into effect',async()=>{
 for(const enabled of [false,true,null]){
  const f=setup();
  // null: the rule inherits refresh, and the dialog switches its override on.
  await ok(await createUnitRule(request({ruleKey:'P1',rule:enabled===null?{timeout:1800}:{refresh:{...refresh(30),enabled}}},'POST'),f.env,SITE),201);
  const tabA=await listed(f,'P1');
  // Refresh schedules keeps refresh values editable while refresh is off, and mirrors them into the row.
  const tab=refreshTabForm.baselineFromListing('P1',await ok(await listAdvancedRules(f.env,SITE)));
  const edits=[...(enabled!==false?[['refreshEnabled',false]]:[]),['minViewPct',60]];
  await ok(await updateAdvancedRule(refreshTabPut(tab,edits.reduce((form,[field,value])=>refreshTabForm.withEdit(form,field,value),tab.form)),f.env,SITE,'P1'));
  assert.deepEqual([JSON.parse(rows(f)[0].rule_json).refresh.enabled,JSON.parse(rows(f)[0].rule_json).refresh.minViewPct],[false,60]);
  const form={...opened(tabA.rule),overrideRefresh:true,refreshEnabled:true,minViewPct:70};
  await refused(await updateUnitRule(request({rule:ruleFromForm(form),expectedUpdatedAt:tabA.updatedAt}),f.env,SITE,tabA.id),409,/changed in another tab/);
  const {review}=dialogRebase(tabA,await listed(f,'P1'),form);
  assert.deepEqual(review,enabled===false
   ? {conflicts:[{field:'Minimum in view',yours:'70%',saved:'60%'}],applied:['Refresh enabled']}
   : {conflicts:[{field:'Refresh enabled',yours:'on',saved:'off'},{field:'Minimum in view',yours:'70%',saved:'60%'}],
    applied:enabled===null?['Override inherited refresh']:[]},`enabled ${enabled}`);
  assert.equal(JSON.parse(rows(f)[0].rule_json).refresh.minViewPct,60,'nothing of this tab was saved');
 }
 // The Refresh tab only switched refresh off, with no parent setting Minimum in view: the value it saved is the form value the
 // dialog showed, so it is no conflict. (With a parent value the dialog compares with its form values; see the Z5 residual.)
 const f=setup();
 await ok(await createUnitRule(request({ruleKey:'P1',rule:{timeout:1800}},'POST'),f.env,SITE),201);
 const tabA=await listed(f,'P1'),tab=refreshTabForm.baselineFromListing('P1',await ok(await listAdvancedRules(f.env,SITE)));
 await ok(await updateAdvancedRule(refreshTabPut(tab,refreshTabForm.withEdit(tab.form,'refreshEnabled',false)),f.env,SITE,'P1'));
 const form={...opened(tabA.rule),overrideRefresh:true,refreshEnabled:true,minViewPct:70};
 await refused(await updateUnitRule(request({rule:ruleFromForm(form),expectedUpdatedAt:tabA.updatedAt}),f.env,SITE,tabA.id),409,/changed in another tab/);
 assert.deepEqual(dialogRebase(tabA,await listed(f,'P1'),form).review,
  {conflicts:[{field:'Refresh enabled',yours:'on',saved:'off'}],applied:['Override inherited refresh','Minimum in view']});
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
