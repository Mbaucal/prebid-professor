// R2-02: unit-rule and advanced-rule saves racing each other must never leave
// publisher_configs.config_json (unitRules mirror and advancedUnitRules overrides)
// out of step with unit_rules rows. Interleavings are injected at the two windows a
// request has: after its first row read, and after its snapshot reads but before its
// D1 batch. Local SQLite only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {createUnitRule,updateUnitRule,deleteUnitRule,duplicateUnitRule,listUnitRules} from '../../worker/unit-rules.ts';
import {updateAdvancedRule} from '../../worker/advanced-rules.ts';
import {readPreviewSnapshot} from '../../worker/runtime/builtin-preview-service.mjs';
import {previewInput,runtimeCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';

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
