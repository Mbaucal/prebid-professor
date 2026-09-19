import test from 'node:test';
import assert from 'node:assert/strict';
import { reportingPlan, reportingCsv, assertUniqueValues } from '../../worker/experiments/reporting.mjs';
import { summarizeAssignments } from '../../worker/experiments/assignments.mjs';
import { runtimeReleaseHistory } from '../../worker/runtime/runtime-release-history.mjs';
import { deploymentStore } from '../support/deployment-store.mjs';
import { readReporting,storeReporting,REPORT_KEY } from '../../worker/test-workspace/experiment-report-store.mjs';
const release=runtimeReleaseHistory.find(r=>r.version==='3.12.0-tessera.preview.1');
const runtime={runtimeId:release.id,runtimeVersion:release.version,runtimeSha256:release.codeSha256};
const pin={packageSha256:'b'.repeat(64),releaseId:'builtin-draft-'+'b'.repeat(64)};
const item={id:'experiment-00000000-0000-4000-8000-000000000000',siteId:'test-site',version:1,trafficB:50,a:pin,b:pin};
const descriptor={siteId:item.siteId,packageSha256:pin.packageSha256,runtime};
const plan=()=>reportingPlan(item,'a'.repeat(64),[descriptor,descriptor]);
const event=(id,type='assigned',patch={})=>({assignmentId:id.toString(16).padStart(32,'0'),type,assignedAt:'2026-09-17T12:00:00.000Z',deliverySha256:'a'.repeat(64),variant:'A',packageSha256:pin.packageSha256,...patch});
test('verified runtime pins produce two export values bound to the full delivery identity',()=>{
 const p=plan();assert(p.labelsReady);assert.equal(p.revenueReady,false);assert.equal(p.comparison,'A/A');
 assert.equal(p.arms[0].value,'d'+'a'.repeat(32)+'_a');assert.equal(p.arms[1].value,'d'+'a'.repeat(32)+'_b');
 const csv=reportingCsv(p);assert(csv.includes(p.deliverySha256));assert(csv.includes('tessera_ab'));assert.equal(csv.split('\r\n').length,4);
 for(const runtimePatch of [{runtimeSha256:'f'.repeat(64)},{runtimeVersion:'3.11.0-tessera.preview.1'}]){
  const legacy=reportingPlan(item,'a'.repeat(64),[descriptor,{...descriptor,runtime:{...runtime,...runtimePatch}}]);
  assert.equal(legacy.labelsReady,false);assert.equal(legacy.arms[1].value,null);assert.throws(()=>reportingCsv(legacy),/Both script/);
 }
});
test('compact label collisions are rejected, identical mappings can be reread',async()=>{
 const p=plan(),other=reportingPlan({...item,id:item.id.replace('00000000-','11111111-')},'a'.repeat(32)+'c'.repeat(32),[descriptor,descriptor]);
 assert.throws(()=>assertUniqueValues([p,other]),/collision/);
 const f=deploymentStore();try{
  await Promise.all([storeReporting(f.env.BUILDS,p),storeReporting(f.env.BUILDS,p)]);
  assert.deepEqual((await readReporting(f.env.BUILDS)).plans,[p]);
  await assert.rejects(storeReporting(f.env.BUILDS,other),/collision/);
  await assert.rejects(storeReporting(f.env.BUILDS,{...p,deliverySha256:'d'.repeat(64)}),/changed/);
  assert(f.deliveryPuts.every(k=>k===REPORT_KEY));
 }finally{f.close();}
});
test('all assigned pages count once, including errors/conflicts/pending; outcomes may arrive first',()=>{
 const events=[event(1,'load-error'),event(1),event(1),event(2),event(2,'conflict'),event(3),event(4,'script-loaded',{variant:'B'}),event(4,'assigned',{variant:'B'}),event(5,'script-loaded')];
 const s=summarizeAssignments(plan(),events);
 assert.deepEqual(s.totals.A,{assigned:3,scriptLoaded:0,loadError:1,conflict:1,pending:1,ambiguous:0});
 assert.equal(s.totals.B.assigned,1);assert.equal(s.duplicatesIgnored,1);assert.equal(s.orphanAssignments,1);
 assert.equal(s.allocation.observedBPercent,25);assert.equal(s.coverage,'unknown');assert.equal(s.revenueReady,false);
 assert.equal(JSON.stringify(s).includes('assignmentId'),false);
});
test('conflicting outcomes remain in denominator with an explicit ambiguous result',()=>{
 const s=summarizeAssignments(plan(),[event(1),event(1,'load-error'),event(1,'script-loaded'),event(2,'assigned',{assignedAt:'2026-09-18T00:00:00.000Z'})]);
 assert.equal(s.totals.A.assigned,2);assert.equal(s.totals.A.ambiguous,1);assert.equal(s.daily.length,2);
});
test('identity changes, mixed revisions, wrong packages, unexpected fields and invalid timestamps fail analysis',()=>{
 for(const patch of [{variant:'C'},{deliverySha256:'c'.repeat(64)},{packageSha256:'c'.repeat(64)},{assignedAt:'2026-02-30T12:00:00.000Z'},{ip:'private'},{type:'impression'},{assignmentId:'user-id'}])assert.throws(()=>summarizeAssignments(plan(),[event(1,'assigned',patch)]));
 assert.throws(()=>summarizeAssignments(plan(),[event(1),event(1,'script-loaded',{variant:'B'})]),/Conflicting identity/);
 assert.equal(summarizeAssignments(plan(),[]).allocation.observedBPercent,null);
});
