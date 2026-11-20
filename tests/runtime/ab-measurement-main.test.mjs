import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mainAbFixture} from '../support/ab-tests-main-fixture.mjs';

const base='/api/publishers/alpha-site/ab-tests';
const other='/api/publishers/beta-site/ab-tests';
const hash=value=>createHash('sha256').update(value).digest('hex');
const report={networkCode:'999',inventoryPath:'/999/alpha-site/',startDate:'2026-11-18',endDate:'2026-11-19',
  currency:'EUR',timeZone:'UTC',revenueBasis:'net',revenueMetric:'total'};
let h,experiment,path,originalFetch;
const sources=()=>new Map([...h.r2.objects].filter(([key])=>key.startsWith('publishers/')).map(([key,row])=>[key,hash(row.bytes)]));
const read=async(path,options)=>{
  const response=await h.request(path,options);
  return {response,value:await response.json()};
};
test.before(async()=>{
  originalFetch=globalThis.fetch;globalThis.fetch=()=>assert.fail('No outbound traffic in measurement checks');
  h=await mainAbFixture();
  const saved=await h.json(base,{method:'POST',body:{a:h.versions['alpha-site'][0],b:h.versions['alpha-site'][1],
    name:'Measurement boundary test',testId:'measurement_main',trafficBPercent:50}},201);
  experiment=saved.record;path=base+'/'+experiment.id+'/measurement/plans';
});
test.after(()=>{h?.close();globalThis.fetch=originalFetch;});

test('nested MAIN measurement routes authenticate and require explicit same-origin writes before storage access',async()=>{
  const state=h.persistent(),puts=h.r2.log.puts.length,gets=h.r2.log.gets.length;
  for(const method of ['GET','POST']){
    const {response}=await read(path,{method,auth:false,...method==='POST'?{body:report}:{}});
    assert.equal(response.status,401);
  }
  for(const origin of [null,'https://foreign.example.invalid']){
    assert.equal((await h.request(path,{method:'POST',body:report,origin})).status,403);
  }
  assert.equal(h.persistent(),state);assert.equal(h.r2.log.puts.length,puts);assert.equal(h.r2.log.gets.length,gets);
});

test('report plans bind the saved site inventory and cannot be prepared against another network or site',async()=>{
  const puts=h.r2.log.puts.length;
  assert.equal((await h.request(other+'/'+experiment.id+'/measurement/plans')).status,404);
  for(const change of [{networkCode:'998'},{inventoryPath:'/999/beta-site/'}]){
    const {response}=await read(path,{method:'POST',body:{...report,...change}});assert.equal(response.status,422);
  }
  assert.equal(h.r2.log.puts.length,puts);
});

test('immutable plan save and retry preserve every source byte, publisher setting and release channel',async()=>{
  const state=h.persistent(),before=sources();
  const {response:first,value:saved}=await read(path,{method:'POST',body:report});
  assert.equal(first.status,201);assert.equal(saved.created,true);assert.match(saved.plan.id,/^abm-[a-f0-9]{64}$/);
  const puts=h.r2.log.puts.length;
  const {response:retry,value:existing}=await read(path,{method:'POST',body:report});
  assert.equal(retry.status,200);assert.equal(existing.created,false);assert.deepEqual(existing.plan,saved.plan);
  assert.equal(existing.planSha256,saved.planSha256);assert.equal(h.r2.log.puts.length,puts);
  assert.equal(h.persistent(),state);assert.deepEqual(sources(),before);
  const detail=await h.json(path+'/'+saved.plan.id);assert.deepEqual(detail.plan,saved.plan);
  assert.equal(detail.planSha256,saved.planSha256);
  assert.equal((await h.request(other+'/'+experiment.id+'/measurement/plans/'+saved.plan.id)).status,404);
});

test('template and in-memory CSV preview cannot turn ad requests or impressions into assigned pageviews',async()=>{
  const saved=await h.json(path,{method:'POST',body:report});
  const endpoint=path+'/'+saved.plan.id,state=h.persistent(),before=sources(),puts=h.r2.log.puts.length;
  const template=await h.request(endpoint+'/template.csv');assert.equal(template.status,200);
  assert.match(template.headers.get('cache-control'),/no-store/);
  const csv=await template.text();assert.match(csv,/TestId/);assert.match(csv,/Variant/);
  const rows=['date,TestId,Variant,impressions,revenue,adRequests,responsesServed,measurableImpressions,viewableImpressions'];
  for(const date of ['2026-11-18','2026-11-19'])for(const side of ['A','B'])rows.push(`${date},${experiment.testId},${side},10,1.23,20,10,8,6`);
  const {response,value}=await read(endpoint+'/preview',{method:'POST',body:{csv:rows.join('\n')+'\n'}});
  assert.equal(response.status,200,JSON.stringify(value));
  assert.equal(value.revenueReady,false);assert.equal(value.winner,null);assert.equal(value.upliftPercent,null);
  for(const side of ['A','B']){
    assert.equal(value.totals[side].pageRpm,null);assert.equal(value.totals[side].receivedAssignments,null);
    assert.equal(value.totals[side].impressionsPerAssignedPage,null);
  }
  assert.equal(h.r2.log.puts.length,puts);assert.equal(h.persistent(),state);assert.deepEqual(sources(),before);
  assert.equal((await h.request(endpoint+'/preview',{method:'POST',body:{csv:'invalid'}})).status,422);
  assert.equal(h.r2.log.puts.length,puts);
});

test('plan endpoints reject unknown fields, methods, queries and cross-plan use without financial persistence',async()=>{
  const plan=(await h.json(path,{method:'POST',body:report})).plan;
  const endpoint=path+'/'+plan.id,puts=h.r2.log.puts.length;
  assert.equal((await h.request(path,{method:'POST',body:{...report,collectorEnabled:true}})).status,422);
  assert.equal((await h.request(endpoint,{method:'PUT',body:report})).status,405);
  assert.equal((await h.request(endpoint+'?site=beta-site')).status,400);
  assert.equal((await h.request(endpoint+'/preview',{method:'POST',body:{csv:'invalid',assignedPageviews:100}})).status,422);
  assert.equal(h.r2.log.puts.length,puts);
});
