import test from 'node:test';
import assert from 'node:assert/strict';
import { previewGamReport, gamReportTemplate, GAM_COLUMNS, GAM_CSV_LIMIT } from '../../worker/experiments/gam-report.mjs';
import { reportingPlan } from '../../worker/experiments/reporting.mjs';
import { runtimeReleaseHistory } from '../../worker/runtime/runtime-release-history.mjs';
import { summarizeAssignments } from '../../worker/experiments/assignments.mjs';
import { deploymentStore } from '../support/deployment-store.mjs';
import { storeReporting } from '../../worker/test-workspace/experiment-report-store.mjs';
import worker from '../../worker/test-workspace/index.mjs';
const release=runtimeReleaseHistory.find(r=>r.version==='3.12.0-tessera.preview.1');
const pin={packageSha256:'b'.repeat(64),releaseId:'builtin-draft-'+'b'.repeat(64)};
const descriptor={siteId:'test-site',packageSha256:pin.packageSha256,runtime:{runtimeId:release.id,runtimeVersion:release.version,runtimeSha256:release.codeSha256}};
const item={id:'experiment-00000000-0000-4000-8000-000000000000',siteId:'test-site',version:1,trafficB:50,a:pin,b:pin,deliveryProfile:'experiment-collected-preview-v1'};
const plan=reportingPlan(item,'a'.repeat(64),[descriptor,descriptor]);
const now=Date.parse('2026-09-17T12:00:00Z');
const row=(variant,day='2026-09-15',metrics=['100','0.1','200','150','80','60'])=>[day,plan.arms[variant==='A'?0:1].value,...metrics];
const csv=rows=>GAM_COLUMNS.join(',')+'\n'+rows.map(r=>r.join(',')).join('\n')+'\n';
const input=(rows=[row('A'),row('B')],patch={})=>({csv:csv(rows),startDate:'2026-09-15',endDate:'2026-09-15',currency:'EUR',timeZone:'UTC',revenueBasis:'net',revenueMetric:'total',...patch});
const event=(id,variant,date='2026-09-15')=>({assignmentId:id.toString(16).padStart(32,'0'),variant,assignedAt:date+'T12:00:00.000Z',packageSha256:pin.packageSha256,deliverySha256:plan.deliverySha256,type:'assigned'});
const assignments=()=>summarizeAssignments(plan,[event(1,'A'),{...event(1,'A'),type:'load-error'},event(2,'B'),event(3,'B','2026-09-16')]);

test('exact revenue totals and weighted rates remain separate from an unverified page denominator',async()=>{
  const r=await previewGamReport(plan,input([row('A'),row('A','2026-09-16',['300','0.2','800','400','120','60']),row('B'),row('B','2026-09-16')],{endDate:'2026-09-16'}),assignments(),now);
  assert.equal(r.totals.A.revenue,'0.300000');assert.equal(r.totals.A.revenueMicros,300000);
  assert.equal(r.totals.A.responseRatePercent,55);assert.equal(r.totals.A.viewabilityPercent,60);
  assert.equal(r.totals.A.revenuePerThousandImpressions,0.75);
  assert.equal(r.totals.A.receivedAssignments,1);assert.equal(r.totals.B.receivedAssignments,2);
  assert.equal(r.dataComplete,true);assert.equal(r.coverage,'unknown');assert.equal(r.revenueReady,false);
  assert.equal(r.totals.A.pageRpm,null);assert.equal(r.winner,null);assert.equal(r.upliftPercent,null);
  assert(!JSON.stringify(r).includes('assignmentId'));assert.equal(r.source.csvSha256.length,64);
  const period=await previewGamReport(plan,input(),assignments(),now);assert.equal(period.totals.B.receivedAssignments,1);
});
test('missing days/arms are not zero-filled; absent metrics and zero denominators stay unavailable',async()=>{
  const r=await previewGamReport(plan,input([row('A','2026-09-15',['0','-0.000001','','','',''])],{endDate:'2026-09-16'}),null,now);
  assert.equal(r.missingRows.length,3);assert.equal(r.totals.B.revenue,null);assert.equal(r.totals.B.impressions,null);
  assert.equal(r.totals.A.revenue,'-0.000001');assert.equal(r.totals.A.revenuePerThousandImpressions,null);
  assert.equal(r.totals.A.responseRatePercent,null);assert.equal(r.totals.A.receivedAssignments,null);assert.equal(r.dataComplete,false);
  const partial=await previewGamReport(plan,input([row('A'),row('A','2026-09-16',['0','0','','','','']),row('B'),row('B','2026-09-16')],{endDate:'2026-09-16'}),null,now);
  assert.equal(partial.totals.A.adRequests,null);assert.equal(partial.totals.A.viewabilityPercent,null);
});
test('timezone, unfinished period, unknown basis, zero allocation and capacity remain visible blockers',async()=>{
  const shifted=await previewGamReport(plan,input(undefined,{timeZone:'Europe/Belgrade'}),assignments(),now);
  assert.equal(shifted.totals.A.receivedAssignments,null);assert(shifted.blockers.some(x=>x.includes('time zones')));
  const today=await previewGamReport(plan,input([row('A','2026-09-17'),row('B','2026-09-17')],{startDate:'2026-09-17',endDate:'2026-09-17',revenueBasis:'unknown'}),{...assignments(),atCapacity:true},now);
  assert.equal(today.dataComplete,false);assert(today.blockers.some(x=>x.includes('unfinished')));assert(today.blockers.some(x=>x.includes('basis')));assert(today.blockers.some(x=>x.includes('limit')));
  const zero=await previewGamReport({...plan,arms:plan.arms.map((a,i)=>({...a,trafficPercent:i?100:0}))},input(),assignments(),now);
  assert(zero.blockers.some(x=>x.includes('Both variants')));
});
test('foreign attribution, duplicate rows, localized numbers, invalid dates and unsupported CSV shapes are rejected',async()=>{
  const bad=[
    input([row('A'),row('A')]),input([row('A').map((s,i)=>i===1?'d'+'f'.repeat(32)+'_a':s)]),
    input([row('A','2026-02-30')]),input([row('A','2026-09-14')]),
    input([row('A','2026-09-15',['1e3','1','2','1','1','1'])]),input([row('A','2026-09-15',['100','1,20','2','1','1','1'])]),
    input([row('A','2026-09-15',['100','=1+2','2','1','1','1'])]),input([row('A','2026-09-15',['100','0.1234567','2','1','1','1'])]),
    input([row('A','2026-09-15',['100','1','2','3','1','1'])]),input([row('A','2026-09-15',['100','1','','1','1','1'])]),
    input([row('A','2026-09-15',['100','1','2','1','1','2'])]),input([row('A','2026-09-15',['9007199254740992','1','2','1','1','1'])]),
    input(undefined,{csv:csv([row('A')])+'\n'}),input(undefined,{csv:csv([row('A')]).replace('date,value','date,currency,value')}),
    input(undefined,{timeZone:'invented/zone'}),input(undefined,{startDate:'2025-01-01'}),input(undefined,{currency:'€'}),
    input(undefined,{csv:'x'.repeat(GAM_CSV_LIMIT+1)}),{...input(),coverage:'verified'},
  ];
  for(const value of bad)await assert.rejects(previewGamReport(plan,value,null,now));
  await assert.rejects(previewGamReport(plan,input(),{...assignments(),deliverySha256:'c'.repeat(64)},now),/different delivery/);
  await assert.rejects(previewGamReport({...plan,labelsReady:false},input(),null,now),/Both script/);
  await assert.rejects(previewGamReport(plan,input([row('A','2026-09-15',['9007199254740991','1','','','','']),row('A','2026-09-16',['1','1','','','',''])],{endDate:'2026-09-16'}),null,now),/precision/);
});
test('quoted CRLF/BOM input has the same arithmetic and templates never invent zero outcomes',async()=>{
  const plain=await previewGamReport(plan,input(),null,now);
  const quoted='\uFEFF'+[GAM_COLUMNS,row('A'),row('B')].map(r=>r.map(s=>'"'+s+'"').join(',')).join('\r\n')+'\r\n';
  const parsed=await previewGamReport(plan,input(undefined,{csv:quoted}),null,now);
  assert.deepEqual(parsed.totals,plain.totals);assert.notEqual(parsed.source.csvSha256,plain.source.csvSha256);
  assert(gamReportTemplate(plan).includes('YYYY-MM-DD,'+plan.arms[0].value+',,,,,,'));
  await assert.rejects(previewGamReport(plan,input(undefined,{csv:gamReportTemplate(plan)}),null,now),/YYYY-MM-DD/);
});
test('authenticated report preview is read-only, scoped and bounded at the actual Worker routes',async()=>{
  const f=deploymentStore();try{
    await storeReporting(f.env.BUILDS,plan);const puts=f.deliveryPuts.length;
    const origin='https://prebid-professor-test.mbaucal.workers.dev';
    const login=await worker.fetch(new Request(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:'tester@example.invalid',password:'Local-fixture-only-password-927!'})}),f.env);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const call=(path,body,extra={})=>worker.fetch(new Request(origin+path,{method:body?'POST':'GET',headers:{cookie,...(body?{origin,'content-type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined}),f.env);
    const path='/test-api/experiments/reporting/analyze',body={experimentId:plan.experimentId,...input()};
    const r=await call(path,body);assert.equal(r.status,200);assert(r.headers.get('cache-control').includes('no-store'));
    const result=await r.json();assert.equal(result.revenueReady,false);assert.equal(result.totals.A.receivedAssignments,0);
    assert.equal((await call(path,body,{origin:'https://other.invalid'})).status,403);
    assert.equal((await call(path,body,{cookie:''})).status,401);
    assert.equal((await call(path,{...body,csv:'x'.repeat(262144)})).status,413);
    assert.equal((await call(path,{...body,csv:csv([row('A'),row('A')])})).status,422);
    assert.equal((await call(path,{...body,coverage:'verified'})).status,422);
    assert.equal((await call(path,{...body,experimentId:'unknown'})).status,409);
    const page=await call('/experiments/report/'+plan.experimentId);assert.equal(page.status,200);assert((await page.text()).includes('Preview report'));
    assert.equal((await call('/experiment-report.js')).status,200);
    const template=await call('/test-api/experiments/reporting/'+plan.experimentId+'/template.csv');assert.equal(template.status,200);assert((await template.text()).includes(plan.arms[1].value));
    assert.equal(f.deliveryPuts.length,puts); // importing cannot save, Start, or mutate any archive
  }finally{f.close();}
});
