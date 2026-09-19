import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createMeasurement} from '../../worker/runtime-variant/targeting.mjs';
import {reportingPlan,reportingCsv,assertUniqueValues} from '../../worker/experiments/reporting.mjs';
import {gamReportTemplate,previewGamReport} from '../../worker/experiments/gam-report.mjs';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
import {cacheSelectionFixture} from '../support/cache-selection-fixture.mjs';
import {readDraftRelease} from '../../worker/runtime/draft-release-store.mjs';
import {readReporting,storeReporting} from '../../worker/test-workspace/experiment-report-store.mjs';
import {deploymentStore} from '../support/deployment-store.mjs';
import {describeCandidate} from '../../worker/runtime/draft-release-store.mjs';

const release=runtimeReleaseHistory.find(r=>r.version==='3.14.0');
const runtime={runtimeId:release.id,runtimeVersion:release.version,runtimeSha256:release.codeSha256};
const pin={packageSha256:'b'.repeat(64),releaseId:'builtin-draft-'+'b'.repeat(64)};
const item={id:'experiment-variant',siteId:'test-site',version:1,trafficB:50,a:pin,b:pin};
const descriptor={siteId:item.siteId,packageSha256:pin.packageSha256,runtime};
const plan=()=>reportingPlan(item,'a'.repeat(64),[descriptor,descriptor]);
function measurement(patch={},status='loading') {
 const context={profile:'experiment-preview-v1',siteId:'test-site',runtimeVersion:'3.14.0',active:true,variant:'A',experimentId:item.id,revision:1,deliverySha256:'a'.repeat(64),packageSha256:pin.packageSha256,...patch};
 const window={__tesseraExperimentOwner:'test-site',__tesseraExperiments:{'test-site':{context,status}}};
 const apply=vm.runInNewContext('('+createMeasurement.toString()+')("test-site","3.14.0")',{window});
 const slot={targeting:{hb_bidder:'preserved',publisher:'preserved'},setConfig({targeting}){Object.assign(this.targeting,targeting);}};
 return {apply,slot,context,snapshot:()=>window.__tesseraGamMeasurement['test-site'].snapshot()};
}
test('public key is exactly Varijant=A/B, with no delivery ID or branded key in targeting',()=>{
 for(const variant of ['A','B']) {
  const f=measurement({variant});f.apply(f.slot);f.context.variant=variant==='A'?'B':'A';f.apply(f.slot);
  assert.deepEqual(f.slot.targeting,{hb_bidder:'preserved',publisher:'preserved',Varijant:variant});
  assert.equal(f.snapshot().key,'Varijant');assert.equal(f.snapshot().value,variant);assert.equal(f.snapshot().appliedSlots,1);
  assert.equal(f.snapshot().identity.deliverySha256,'a'.repeat(64));assert.equal(f.snapshot().identity.variant,variant);
 }
 for(const patch of [{active:false},{variant:'C'},{runtimeVersion:'3.13.0'},{siteId:'other'},{deliverySha256:'bad'}]) {
  const f=measurement(patch);f.apply(f.slot);assert.equal(f.slot.targeting.Varijant,undefined);
 }
 for(const status of ['conflict','load-error']){const f=measurement({},status);f.apply(f.slot);assert.equal(f.slot.targeting.Varijant,undefined);}
});
test('simple values can be reused while exact private mappings and legacy collision checks remain',async()=>{
 const p=plan(),next=reportingPlan({...item,id:'experiment-next'},'c'.repeat(64),[descriptor,descriptor]);
 assert.equal(p.key,'Varijant');assert.deepEqual(p.arms.map(a=>a.value),['A','B']);assert(p.labelsReady);
 assert(reportingCsv(p).includes('"Varijant","A"'));assert(reportingCsv(p).includes(p.deliverySha256));
 assert.doesNotThrow(()=>assertUniqueValues([p,next]));
 const f=deploymentStore();try {
  await storeReporting(f.env.BUILDS,p);await storeReporting(f.env.BUILDS,next);
  assert.deepEqual((await readReporting(f.env.BUILDS)).plans,[p,next]);
  await assert.rejects(storeReporting(f.env.BUILDS,{...p,deliverySha256:'d'.repeat(64)}),/changed/);
 }finally{f.close();}
 const old=runtimeReleaseHistory.find(r=>r.version==='3.13.0');
 const legacy={...descriptor,runtime:{runtimeId:old.id,runtimeVersion:old.version,runtimeSha256:old.codeSha256}};
 for(const descriptors of [[descriptor,legacy],[legacy,descriptor]]) {
  const mixed=reportingPlan(item,'a'.repeat(64),descriptors);assert.equal(mixed.labelsReady,false);
  assert.throws(()=>reportingCsv(mixed),/Both script/);
 }
});
test('GAM template and preview accept literal A/B without claiming experiment attribution',async()=>{
 const p=plan(),template=gamReportTemplate(p);assert(template.includes('YYYY-MM-DD,A,'));assert(template.includes('YYYY-MM-DD,B,'));
 const input={csv:template.replaceAll('YYYY-MM-DD','2026-09-17').replaceAll(',,,,,,',',100,1.5,200,100,100,50'),startDate:'2026-09-17',endDate:'2026-09-17',currency:'EUR',timeZone:'UTC',revenueBasis:'net',revenueMetric:'total'};
 const result=await previewGamReport(p,input,null,Date.parse('2026-09-18T12:00:00Z'));
 assert.equal(result.totals.A.revenue,'1.500000');assert.equal(result.revenueReady,false);assert.equal(result.winner,null);
 assert(result.blockers.some(x=>x.includes('A/B values do not identify a test')));
 await assert.rejects(previewGamReport(p,{...input,csv:input.csv.replace(',A,',',a,')}),/unsupported variant/);
});
test('private selection stores a complete 3.14 package with literal labels and preserves existing defaults',async()=>{
 const f=await cacheSelectionFixture();try {
  const state=await f.api('/test-api/runtime-selection');assert.equal(state.runtimes[0].version,'3.10.0-tessera.preview.1');
  const runtime=state.runtimes.find(r=>r.version==='3.14.0').pin;
  await f.api('/test-api/runtime-selection',{expectedRevision:state.revision,selection:{runtime,allowPreview:true,enablePrebid:true,prebidBuildId:state.prebidBuildId,bidCache:{mode:'auction-with-cache',maxAgeSeconds:60}}});
  const saved=await f.api('/test-api/runtime-selection');assert.equal(saved.selected.runtime.runtimeVersion,'3.14.0');
  const ready=await f.api('/test-api/site-packages');
  const created=await f.api('/test-api/site-packages',{action:'generate',revision:ready.revision,notes:'Simple variant targeting'},201);
  const stored=await readDraftRelease({isolation:'explicit-test-store',db:f.env.DB,bucket:f.env.BUILDS},{siteId:'test-site',releaseId:created.release.id});
  assert.equal((await describeCandidate('test-site',stored)).descriptor.runtime.runtimeVersion,'3.14.0');
  for(const name of ['ads.js','ads.min.js']){
   const source=new TextDecoder().decode(stored.files[name]);assert(source.includes('Varijant'));assert(!source.includes('tessera_ab'));
  }
 }finally{f.close();}
});
