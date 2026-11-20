/** Independent adversarial QA: synthetic immutable packages/R2 only, no GAM or collector. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {syntheticDraft} from '../support/ab-synthetic-drafts.mjs';
import {memoryR2} from '../support/memory-r2.mjs';
import {describeCandidate} from '../../worker/runtime/draft-release-store.mjs';
import {createAbTest} from '../../worker/experiments/ab-store.mjs';
import {createMeasurementPlan,readMeasurementPlan,listMeasurementPlans} from '../../worker/experiments/ab-report-plan.mjs';
import {previewAbGamReport,abGamReportTemplate} from '../../worker/experiments/ab-gam-report.mjs';
import {abMeasurementResponse} from '../../worker/experiments/ab-measurement-api.mjs';
import {AB_GAM_COLUMNS} from '../../worker/experiments/ab-measurement-contracts.mjs';

const SITE='measurement-qa',ACTOR={email:'qa@example.invalid'},TEST_ID='adversarial_qa';
const NOW=Date.parse('2026-11-20T12:00:00.000Z'),encode=new TextEncoder(),decode=new TextDecoder();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const report=(over={})=>({networkCode:'123',inventoryPath:'/123/inventory/',startDate:'2026-11-18',endDate:'2026-11-19',currency:'EUR',timeZone:'UTC',revenueBasis:'net',revenueMetric:'total',...over});
let sources;
test.before(async()=>{
  sources=await Promise.all(['A','B'].map(async(side,index)=>{
    const pkg=await syntheticDraft({siteId:SITE,runtimeVersion:'9.0.'+index,note:side,script:'window.arm='+JSON.stringify(side)+';'});
    const config=JSON.parse(decode.decode(pkg.files['config.json']));config.core={gamPath:'/123/inventory/'};
    pkg.files['config.json']=encode.encode(JSON.stringify(config));
    const manifest=JSON.parse(decode.decode(pkg.files['manifest.json']));
    manifest.configHash=hash(pkg.files['config.json']);
    manifest.files['config.json']={byteSize:pkg.files['config.json'].length,sha256:manifest.configHash};
    pkg.files['manifest.json']=encode.encode(JSON.stringify(manifest));
    pkg.release.id=(await describeCandidate(SITE,{files:pkg.files})).descriptor.releaseId;
    return pkg;
  }));
});
async function fixture(){
  const r2=memoryR2({prefix:'site-experiments/'}),versions=new Map(sources.map(pkg=>[pkg.release.id,pkg]));
  const readVersion=async id=>{const pkg=versions.get(id);if(!pkg)throw Object.assign(Error('Missing synthetic source'),{status:404});return pkg;};
  const saved=await createAbTest(r2.bucket,{site:SITE,actor:ACTOR,a:sources[0],b:sources[1],name:'Adversarial QA',testId:TEST_ID,trafficBPercent:50});
  const options={site:SITE,id:saved.record.id,actor:ACTOR,readVersion};
  const prepared=await createMeasurementPlan(r2.bucket,{...options,report:report(),now:new Date(NOW)});
  return {r2,versions,options,readVersion,saved,prepared,plan:prepared.plan,
    create:input=>createMeasurementPlan(r2.bucket,{...options,report:input,now:new Date(NOW+1)})};
}
const row=(variant,date='2026-11-18',metrics=['2','0.000001','3','1','2','1'])=>[date,TEST_ID,variant,...metrics];
const csv=rows=>AB_GAM_COLUMNS.join(',')+'\n'+rows.map(cells=>cells.join(',')).join('\n')+'\n';
const allRows=()=>[row('A'),row('A','2026-11-19',['8','-0.000002','7','6','8','3']),row('B','2026-11-18',['0','0','0','0','0','0']),row('B','2026-11-19',['0','0','0','0','0','0'])];
const snapshot=r2=>[...r2.objects].map(([key,value])=>[key,hash(value.bytes),value.etag]);
async function refused(promise,status=422,pattern){
  await assert.rejects(promise,error=>error.status===status&&(!pattern||pattern.test(error.message)));
}
const planKey=f=>`site-experiments/measurement-v1/${SITE}/${f.options.id}/plans/${f.plan.id}.json`;

test('report pins bind exact immutable sources and operator metadata; retries return the first record without writes',async()=>{
  const f=await fixture(),before=snapshot(f.r2),puts=f.r2.log.puts.length;
  const again=await f.create(report());
  assert.equal(again.created,false);assert.deepEqual(again.plan,f.plan);assert.equal(again.planSha256,f.prepared.planSha256);
  assert.equal(f.plan.recordSha256,f.saved.recordSha256);assert.equal(f.plan.zipSha256,f.saved.record.bundle.zipSha256);
  assert.equal(f.plan.arms.A.scriptSha256,hash(sources[0].files['ads.min.js']));
  assert.deepEqual(snapshot(f.r2),before);assert.equal(f.r2.log.puts.length,puts);
  const ids=new Set([f.plan.id]);
  for(const patch of [{currency:'USD'},{timeZone:'Europe/Belgrade'},{revenueBasis:'gross'},{revenueMetric:'cpm-cpc'},{startDate:'2026-11-19'}]){
    const next=await f.create(report(patch));assert(!ids.has(next.plan.id));ids.add(next.plan.id);
    assert.equal(next.plan.source.gamReportSourceVerified,false);assert.equal(next.plan.measurement.collection,'disabled');
  }
});

test('saved source scope overrides mutable/operator declarations and rejects forged coverage flags before writes',async()=>{
  const f=await fixture(),before=snapshot(f.r2);
  for(const input of [report({networkCode:'999',inventoryPath:'/999/inventory/'}),report({inventoryPath:'/123/different/'}),{...report(),coverage:'verified'},{...report(),recordSha256:'a'.repeat(64)}])await refused(f.create(input));
  assert.deepEqual(snapshot(f.r2),before);
});

test('stored plan identity detects tampering even when a writer recomputes R2 checksum metadata',async()=>{
  const f=await fixture(),object=f.r2.objects.get(planKey(f)),bytes=object.bytes.slice(),meta={...object.customMetadata};
  for(const mutate of [p=>{p.testId='foreign_test';},p=>{p.report.currency='USD';},p=>{p.arms.A.runtimeSha256='f'.repeat(64);},p=>{p.loader.sha256='f'.repeat(64);},p=>{p.trafficBPercent=25;}]){
    const altered=structuredClone(f.plan);mutate(altered);object.bytes=encode.encode(JSON.stringify(altered));object.customMetadata={...meta,sha256:hash(object.bytes)};
    await refused(readMeasurementPlan(f.r2.bucket,{...f.options,planId:f.plan.id}),409,/immutable identity/);
  }
  object.bytes=bytes;object.customMetadata=meta;
  assert.deepEqual((await readMeasurementPlan(f.r2.bucket,{...f.options,planId:f.plan.id})).plan,f.plan);
});

test('a committed report plan remains readable and a lost-response retry succeeds after source cleanup',async()=>{
  const f=await fixture(),before=snapshot(f.r2),puts=f.r2.log.puts.length;f.versions.clear();
  const listed=await listMeasurementPlans(f.r2.bucket,f.options);
  assert.equal(listed.plans[0].id,f.plan.id);assert(listed.sourceError);
  assert.deepEqual((await readMeasurementPlan(f.r2.bucket,{...f.options,planId:f.plan.id})).plan,f.plan);
  const retry=await f.create(report());assert.equal(retry.created,false);assert.deepEqual(retry.plan,f.plan);
  assert.deepEqual(snapshot(f.r2),before);assert.equal(f.r2.log.puts.length,puts);
  await refused(f.create(report({currency:'USD'})),422,/Source version/);
});

test('concurrent identical plan saves retain one immutable actor/time winner and the same readback',{timeout:5000},async()=>{
  const f=await fixture();let entrants=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  f.r2.faults.beforePut=async key=>{
    if(!key.startsWith(`site-experiments/measurement-v1/${SITE}/${f.options.id}/plans/`))return;
    if(++entrants===2)release();await gate;
  };
  const choices=[{email:'first@example.invalid',at:'2026-11-20T13:00:00.000Z'},{email:'second@example.invalid',at:'2026-11-20T14:00:00.000Z'}];
  const outcomes=await Promise.all(choices.map(choice=>createMeasurementPlan(f.r2.bucket,{...f.options,actor:{email:choice.email},report:report({currency:'USD'}),now:new Date(choice.at)})));
  f.r2.faults.beforePut=null;
  assert.equal(entrants,2);assert.equal(outcomes.filter(row=>row.created).length,1);
  assert.deepEqual(outcomes[0].plan,outcomes[1].plan);assert.equal(outcomes[0].planSha256,outcomes[1].planSha256);
  const winner=outcomes[0].plan,choice=choices.find(row=>row.email===winner.createdBy);
  assert(choice);assert.equal(winner.createdAt,choice.at);
  const saved=await readMeasurementPlan(f.r2.bucket,{...f.options,planId:winner.id});assert.deepEqual(saved.plan,winner);
  const matching=[...f.r2.objects.keys()].filter(key=>key.endsWith('/'+winner.id+'.json'));assert.equal(matching.length,1);
});

test('integer micros, negative adjustments and weighted denominators never become page RPM',async()=>{
  const f=await fixture(),before=snapshot(f.r2),result=await previewAbGamReport(f.plan,{csv:csv(allRows())},NOW);
  assert.equal(result.totals.A.revenueMicros,-1);assert.equal(result.totals.A.revenue,'-0.000001');
  assert.equal(result.totals.A.impressions,10);assert.equal(result.totals.A.responseRatePercent,70);assert.equal(result.totals.A.viewabilityPercent,40);
  assert.equal(result.totals.B.impressions,0);assert.equal(result.totals.B.revenue,'0.000000');assert.equal(result.totals.B.revenuePerThousandImpressions,null);
  for(const side of ['A','B']){assert.equal(result.totals[side].pageRpm,null);assert.equal(result.totals[side].receivedAssignments,null);assert.equal(result.totals[side].impressionsPerAssignedPage,null);}
  assert.equal(result.dataComplete,true);assert.equal(result.revenueReady,false);assert.equal(result.coverage,'unknown');assert.equal(result.winner,null);assert.equal(result.upliftPercent,null);
  assert(result.blockers.some(s=>/midnight/.test(s)));assert(result.blockers.some(s=>/unlabelled revenue/.test(s)));
  assert.deepEqual(snapshot(f.r2),before);
});

test('missing arms/days and missing optional pairs remain null while verified explicit zeros remain zero',async()=>{
  const f=await fixture(),rows=[row('A'),row('A','2026-11-19',['0','0','','','',''])];
  const result=await previewAbGamReport(f.plan,{csv:csv(rows)},NOW);
  assert.deepEqual(result.missingRows,[{date:'2026-11-18',variant:'B'},{date:'2026-11-19',variant:'B'}]);
  assert.equal(result.totals.B.impressions,null);assert.equal(result.totals.B.revenue,null);assert.equal(result.totals.B.rowCount,0);
  assert.equal(result.totals.A.adRequests,null);assert.equal(result.totals.A.responseRatePercent,null);assert.equal(result.totals.A.viewabilityPercent,null);assert.equal(result.dataComplete,false);
  await refused(previewAbGamReport(f.plan,{csv:csv([row('A','2026-11-18',['0','0','','1','',''])])},NOW),422,/Provide both/);
});

test('joint TestId and Variant matching rejects foreign tests, lowercased arms, duplicates and out-of-period rows',async()=>{
  const f=await fixture();
  const foreign=row('A');foreign[1]='another_test';
  for(const rows of [[foreign],[row('a')],[row('A'),row('A')],[row('A','2026-11-17')]])await refused(previewAbGamReport(f.plan,{csv:csv(rows)},NOW));
  for(const input of [{csv:csv(allRows()),coverage:'verified'},{csv:csv(allRows()),currency:'USD'},{csv:csv(allRows()),assignedPages:1000}])await refused(previewAbGamReport(f.plan,input,NOW));
});

test('BOM/quoted CRLF uses identical arithmetic; templates contain blanks, never fabricated zero outcomes',async()=>{
  const f=await fixture(),plain=await previewAbGamReport(f.plan,{csv:csv(allRows())},NOW);
  const quoted='\uFEFF'+[AB_GAM_COLUMNS,...allRows()].map(cells=>cells.map(cell=>'"'+cell+'"').join(',')).join('\r\n')+'\r\n';
  const parsed=await previewAbGamReport(f.plan,{csv:quoted},NOW);assert.deepEqual(parsed.totals,plain.totals);assert.notEqual(parsed.source.csvSha256,plain.source.csvSha256);
  const template=abGamReportTemplate(f.plan);assert(template.includes('2026-11-18,'+TEST_ID+',A,,,,,,'));
  await refused(previewAbGamReport(f.plan,{csv:template},NOW),422,/Counts/);
});

test('malformed/localized scalar values and aggregate overflow are rejected, not rounded or silently added',async()=>{
  const f=await fixture();
  for(const metrics of [['1e3','1','2','1','1','1'],['1','1,20','2','1','1','1'],['1','=1+2','2','1','1','1'],['1','0.1234567','2','1','1','1'],['1','0','2','3','1','1'],['1','0','2','1','1','2']])await refused(previewAbGamReport(f.plan,{csv:csv([row('A','2026-11-18',metrics)])},NOW));
  await refused(previewAbGamReport(f.plan,{csv:csv([row('A','2026-11-18',['9007199254740991','0','','','','']),row('A','2026-11-19',['1','0','','','',''])])},NOW),422,/precision/);
  await refused(previewAbGamReport(f.plan,{csv:csv([row('A','2026-11-18',['1','9007199254.740991','','','','']),row('A','2026-11-19',['1','0.000001','','','',''])])},NOW),422,/precision/);
});

test('unfinished-day checks use the saved report timezone; matching timezone never removes cross-midnight blockers',async()=>{
  const f=await fixture(),la=(await f.create(report({timeZone:'America/Los_Angeles'}))).plan;
  const now=Date.parse('2026-11-20T00:30:00Z');
  const utc=await previewAbGamReport(f.plan,{csv:csv(allRows())},now),shifted=await previewAbGamReport(la,{csv:csv(allRows())},now);
  assert.equal(utc.dataComplete,true);assert.equal(shifted.dataComplete,false);assert(shifted.blockers.some(s=>/unfinished/.test(s)));
  for(const result of [utc,shifted]){assert.equal(result.revenueReady,false);assert(result.blockers.some(s=>/midnight/.test(s)));}
});

test('measurement intake rejects malformed UTF8, oversized actual body and coverage spoofing without persisting CSV',async()=>{
  const f=await fixture(),base='/api/publishers/'+SITE+'/ab-tests',path=base+'/'+f.options.id+'/measurement/plans/'+f.plan.id+'/preview';
  const options={bucket:f.r2.bucket,site:SITE,actor:ACTOR,base,headers:{},readVersion:f.readVersion},before=snapshot(f.r2);
  const request=(body,headers={})=>new Request('https://qa.example.invalid'+path,{method:'POST',headers:{'content-type':'application/json',...headers},body});
  const invalid=new Uint8Array([...encode.encode('{"csv":"'),0xc3,0x28,...encode.encode('"}')]);
  const bad=await abMeasurementResponse(request(invalid),options);assert.equal(bad.status,400);assert.match((await bad.json()).error,/UTF-8/);
  const huge=await abMeasurementResponse(request(new Uint8Array(160*1024+1),{'content-length':'1'}),options);assert.equal(huge.status,413);
  const csvTooLarge='é'.repeat(65537),csvBody=JSON.stringify({csv:csvTooLarge});
  assert(encode.encode(csvTooLarge).length>128*1024);assert(encode.encode(csvBody).length<160*1024);
  const csvCap=await abMeasurementResponse(request(csvBody),options);assert.equal(csvCap.status,422);assert.match((await csvCap.json()).error,/128 KB/);
  const forged=await abMeasurementResponse(request(JSON.stringify({csv:csv(allRows()),coverage:'verified'})),options);assert.equal(forged.status,422);
  const valid=await abMeasurementResponse(request(JSON.stringify({csv:csv(allRows())})),options);assert.equal(valid.status,200);assert.equal((await valid.json()).revenueReady,false);
  assert.deepEqual(snapshot(f.r2),before);
});
