import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mainAbFixture} from '../support/ab-tests-main-fixture.mjs';
import {gamReportV2Columns} from '../../worker/experiments/gam-report-v2-contracts.mjs';

const BASE='/api/publishers/alpha-site/ab-tests',OTHER='/api/publishers/beta-site/ab-tests';
const report={networkCode:'999',inventoryPath:'/999/alpha-site/',startDate:'2026-11-18',endDate:'2026-11-19',currency:'EUR',timeZone:'UTC',revenueBasis:'net',revenueMetric:'total',
  purpose:'overall',metricFamily:'total',scope:{orderIds:[],lineItemIds:[]},dimensions:['adUnit','deviceCategory'],metrics:['impressions','revenue','clicks'],sourceColumns:{},compatibilityMode:'off'};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let h,experiment,endpoint,originalFetch;
const sourceSnapshot=()=>new Map([...h.r2.objects].filter(([key])=>key.startsWith('publishers/')).map(([key,item])=>[key,hash(item.bytes)]));
async function save(body=report){const response=await h.request(endpoint,{method:'POST',body}),value=await response.json();assert([200,201].includes(response.status),JSON.stringify(value));return value;}
test.before(async()=>{
  originalFetch=globalThis.fetch;globalThis.fetch=()=>assert.fail('No external traffic in detailed report MAIN tests');
  h=await mainAbFixture();const result=await h.json(BASE,{method:'POST',body:{a:h.versions['alpha-site'][0],b:h.versions['alpha-site'][1],name:'Detailed report boundaries',testId:'gam_v2_main',trafficBPercent:50}},201);
  experiment=result.record;endpoint=BASE+'/'+experiment.id+'/measurement/v2/plans';
});
test.after(()=>{h?.close();globalThis.fetch=originalFetch;});

test('MAIN v2 routes authenticate and reject missing/foreign origins before any storage access',async()=>{
  const persistent=h.persistent(),puts=h.r2.log.puts.length,gets=h.r2.log.gets.length;
  for(const method of ['GET','POST'])assert.equal((await h.request(endpoint,{method,auth:false,...(method==='POST'?{body:report}:{})})).status,401);
  for(const origin of [null,'https://foreign.example.invalid'])assert.equal((await h.request(endpoint,{method:'POST',origin,body:report})).status,403);
  assert.equal(h.persistent(),persistent);assert.equal(h.r2.log.puts.length,puts);assert.equal(h.r2.log.gets.length,gets);
});

test('MAIN v2 plan save is site-scoped, immutable and separate from source configuration',async()=>{
  const before=sourceSnapshot(),persistent=h.persistent(),first=await save();assert.equal(first.created,true);assert.equal(first.plan.identityKey,'TestId');assert.equal(first.plan.versionId,experiment.testId);
  const puts=h.r2.log.puts.length,repeated=await save();assert.equal(repeated.created,false);assert.deepEqual(repeated.plan,first.plan);assert.equal(h.r2.log.puts.length,puts);
  const detail=await h.json(endpoint+'/'+first.plan.id);assert.deepEqual(detail.plan,first.plan);assert.equal(detail.planSha256,first.planSha256);
  assert.equal((await h.request(OTHER+'/'+experiment.id+'/measurement/v2/plans/'+first.plan.id)).status,404);
  assert.equal((await h.request(endpoint,{method:'POST',body:{...report,networkCode:'998',inventoryPath:'/998/alpha-site/'}})).status,422);
  assert.equal((await h.request(endpoint,{method:'POST',body:{...report,purpose:'prebid',metricFamily:'ad-server'}})).status,422);
  assert.equal(h.persistent(),persistent);assert.deepEqual(sourceSnapshot(),before);
});

test('MAIN v2 downloaded template and CSV preview preserve sparse dimensional grain and never persist financial input',async()=>{
  const saved=await save(),path=endpoint+'/'+saved.plan.id,puts=h.r2.log.puts.length,persistent=h.persistent(),before=sourceSnapshot();
  const template=await h.request(path+'/template.csv');assert.equal(template.status,200);assert.match(template.headers.get('cache-control'),/no-store/);
  const text=await template.text();assert.equal(text.split('\r\n')[0],gamReportV2Columns(saved.plan.report).join(','));assert.match(text,/VersionId/);
  const rows=['date,VersionId,Variant,adUnit,deviceCategory,impressions,revenue,clicks','2026-11-18,gam_v2_main,A,top,Desktop,10,1.25,1','2026-11-18,gam_v2_main,A,top,Mobile,30,2.75,2','2026-11-18,gam_v2_main,B,top,Desktop,20,2.25,1'];
  const value=await h.json(path+'/preview',{method:'POST',body:{csv:rows.join('\n')+'\n'}});assert.equal(value.providedRows,3);assert.equal(value.totals.A.impressions,40);assert.equal(value.totals.A.revenue,'4.000000');assert.equal(value.totals.A.revenuePerThousandImpressions,100);
  assert.equal(value.breakdowns.find(item=>item.dimension==='deviceCategory').groupCount,2);assert.equal(value.coverage,'unknown');assert.equal(value.dataComplete,false);assert.equal(value.winner,null);assert.equal(value.revenueReady,false);
  assert.equal((await h.request(path+'/preview',{method:'POST',body:{csv:rows.join('\n'),coverage:'complete'}})).status,422);
  assert.equal((await h.request(path+'?scope=all')).status,400);assert.equal((await h.request(path,{method:'PUT',body:report})).status,405);
  assert.equal(h.r2.log.puts.length,puts);assert.equal(h.persistent(),persistent);assert.deepEqual(sourceSnapshot(),before);
});
