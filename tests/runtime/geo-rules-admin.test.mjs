import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {createUnitRule,updateUnitRule,duplicateUnitRule,deleteUnitRule} from '../../worker/unit-rules.ts';

const request=(body,method='POST')=>new Request('https://test.invalid/api/unit-rules',{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const fixtures=[];
const fixture=()=>{const f=adminAuditStore();fixtures.push(f);return f;};
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
const condition=(operator='equals',value='rs')=>({id:'c',key:'geo_country',operator,value});
const mapping=patch=>({id:'m',name:'Country rule',enabled:true,priority:10000,match:'any',conditions:[condition('notEquals'),condition('notExists','')],sizeMapKey:null,slotAction:'disable',...patch});
const rule=patch=>({conditionalMappings:[mapping(patch)]});

test('country rules save canonical codes and a fallback scope without fake banner inventory',async()=>{
 const f=fixture();
 const r=await createUnitRule(request({ruleKey:'__INTERSTITIAL__',rule:rule()}),f.env,'audit-site');
 assert.equal(r.status,201,await r.clone().text());
 const saved=(await r.json()).unitRule;
 assert.deepEqual(saved.rule.conditionalMappings[0].conditions.map(c=>c.value),['RS','']);
 assert.equal(saved.rule.conditionalMappings[0].match,'any');
 assert.equal(saved.rule.conditionalMappings[0].slotAction,'disable');
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM ad_units WHERE code='__INTERSTITIAL__'").get().n,0);
 assert.deepEqual(f.readConfig().unitRules.__INTERSTITIAL__,saved.rule);
 const deleted=await deleteUnitRule(request({},'DELETE'),f.env,'audit-site',saved.id);
 assert.equal(deleted.status,200);assert.equal(f.readConfig().unitRules.__INTERSTITIAL__,undefined);
});

test('country code/operator mistakes fail before writing without changing ordinary page values',async()=>{
 const f=fixture();
 for(const c of [condition('equals','XX'),condition('equals','Serbia'),condition('contains','RS')]){
  const r=await createUnitRule(request({ruleKey:'P1',rule:rule({conditions:[c]})}),f.env,'audit-site');
  assert.equal(r.status,422,await r.clone().text());
 }
 assert.equal(f.log.batches,0);
 const c={...condition(),key:'category',value:'Naslovna'};
 const r=await createUnitRule(request({ruleKey:'P1',rule:rule({conditions:[c],sizeMapKey:'display'})}),f.env,'audit-site');
 assert.equal(r.status,201,await r.clone().text());
 assert.equal((await r.json()).unitRule.rule.conditionalMappings[0].conditions[0].value,'Naslovna');
});

test('fallback rejects size maps, refresh, timeout and lazy settings on save and copy',async()=>{
 const f=fixture();
 for(const invalid of [rule({sizeMapKey:'display'}),{...rule(),timeout:1500},{...rule(),lazy:{enabled:false}},{...rule(),refresh:{enabled:false}}]){
  const r=await createUnitRule(request({ruleKey:'__INTERSTITIAL__',rule:invalid}),f.env,'audit-site');
  assert.equal(r.status,422,await r.clone().text());
 }
 const created=await createUnitRule(request({ruleKey:'P1',rule:rule({sizeMapKey:'display'})}),f.env,'audit-site');
 assert.equal(created.status,201,await created.clone().text());
 const id=(await created.json()).unitRule.id,before=f.readConfig();
 const copied=await duplicateUnitRule(request({ruleKey:'__INTERSTITIAL__'}),f.env,'audit-site',id);
 assert.equal(copied.status,422,await copied.clone().text());assert.deepEqual(f.readConfig(),before);
});

test('mapping-only copy keeps country and stale fallback edits cannot replace a newer rule',async()=>{
 const f=fixture();
 const created=await createUnitRule(request({ruleKey:'P1',rule:rule()}),f.env,'audit-site');
 assert.equal(created.status,201,await created.clone().text());
 const source=(await created.json()).unitRule;
 const copied=await duplicateUnitRule(request({ruleKey:'__INTERSTITIAL__'}),f.env,'audit-site',source.id);
 assert.equal(copied.status,201,await copied.clone().text());
 const fallback=(await copied.json()).unitRule;assert.deepEqual(fallback.rule,source.rule);
 const updated=await updateUnitRule(request({expectedUpdatedAt:fallback.updatedAt,rule:rule({conditions:[condition('notEquals','de'),condition('notExists','')]})},'PATCH'),f.env,'audit-site',fallback.id);
 assert.equal(updated.status,200,await updated.clone().text());
 const before=f.readConfig();
 const stale=await updateUnitRule(request({expectedUpdatedAt:fallback.updatedAt,rule:rule()},'PATCH'),f.env,'audit-site',fallback.id);
 assert.equal(stale.status,409);assert.deepEqual(f.readConfig(),before);
 assert.equal(before.unitRules.__INTERSTITIAL__.conditionalMappings[0].conditions[0].value,'DE');
});
