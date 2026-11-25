import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {syntheticDraft} from '../support/ab-synthetic-drafts.mjs';
import {memoryR2} from '../support/memory-r2.mjs';
import {describeCandidate} from '../../worker/runtime/draft-release-store.mjs';
import {createAbTest} from '../../worker/experiments/ab-store.mjs';
import {createGamReportV2Plan,readGamReportV2Plan,listGamReportV2Plans,normalizeGamReportV2Input} from '../../worker/experiments/gam-report-v2-plan.mjs';
import {gamReportV2Template,previewGamReportV2} from '../../worker/experiments/gam-report-v2.mjs';
import {gamReportV2Columns} from '../../worker/experiments/gam-report-v2-contracts.mjs';
import {abTestsResponse} from '../../worker/experiments/ab-tests-api.mjs';

const SITE='gam-v2-test',ACTOR={email:'reporter@example.invalid'},NOW=new Date('2026-11-25T12:00:00.000Z');
const encode=new TextEncoder(),decode=new TextDecoder(),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let sources;
test.before(async()=>{
  sources=await Promise.all(['A','B'].map(async(side,index)=>{
    const pkg=await syntheticDraft({siteId:SITE,runtimeVersion:'9.0.'+index,note:side,script:'window.arm='+JSON.stringify(side)+';'});
    const config=JSON.parse(decode.decode(pkg.files['config.json']));config.core={gamPath:'/123/inventory/'};
    pkg.files['config.json']=encode.encode(JSON.stringify(config));
    const manifest=JSON.parse(decode.decode(pkg.files['manifest.json']));manifest.configHash=hash(pkg.files['config.json']);
    manifest.files['config.json']={byteSize:pkg.files['config.json'].length,sha256:manifest.configHash};
    pkg.files['manifest.json']=encode.encode(JSON.stringify(manifest));pkg.release.id=(await describeCandidate(SITE,{files:pkg.files})).descriptor.releaseId;return pkg;
  }));
});
const report=(patch={})=>({networkCode:'123',inventoryPath:'/123/inventory/',startDate:'2026-11-22',endDate:'2026-11-24',currency:'EUR',timeZone:'Europe/Belgrade',revenueBasis:'net',revenueMetric:'total',
  purpose:'overall',metricFamily:'total',scope:{orderIds:[],lineItemIds:[]},dimensions:['adUnit','deviceCategory'],metrics:['impressions','revenue','clicks','eligibleImpressions','measurableImpressions','viewableImpressions'],sourceColumns:{},compatibilityMode:'off',...patch});
async function fixture(input=report()){
  const r2=memoryR2({prefix:'site-experiments/'}),versions=new Map(sources.map(pkg=>[pkg.release.id,pkg]));
  const readVersion=async id=>{const pkg=versions.get(id);if(!pkg)throw Object.assign(Error('Missing source'),{status:404});return pkg;};
  const saved=await createAbTest(r2.bucket,{site:SITE,actor:ACTOR,a:sources[0],b:sources[1],name:'Detailed GAM report',testId:'gam_v2_example',trafficBPercent:50});
  const options={site:SITE,id:saved.record.id,actor:ACTOR,readVersion,now:NOW};
  const prepared=await createGamReportV2Plan(r2.bucket,{...options,report:input});
  return {r2,versions,readVersion,saved,options,prepared,plan:prepared.plan};
}
const row=(side,patch={})=>({date:'2026-11-22',VersionId:'gam_v2_example',Variant:side,adUnit:'top',deviceCategory:'Desktop',impressions:'10',revenue:'0.15',clicks:'1',eligibleImpressions:'9',measurableImpressions:'8',viewableImpressions:'6',...patch});
function csv(plan,rows,{reverse=false}={}){const columns=gamReportV2Columns(plan.report);if(reverse)columns.reverse();const quote=value=>/[",]/.test(value)?'"'+value.replace(/"/g,'""')+'"':value;
  return [columns.map(key=>quote(plan.report.sourceColumns[key])).join(','),...rows.map(raw=>columns.map(key=>quote(raw[key]??'')).join(','))].join('\r\n')+'\r\n';}

test('v2 plans preserve source pins and v1 namespace, and retry after source cleanup without another write',async()=>{
  const f=await fixture(),puts=f.r2.log.puts.length,identities=sources.map(pkg=>Object.fromEntries(Object.entries(pkg.files).map(([name,bytes])=>[name,hash(bytes)])));
  assert.match(f.plan.id,/^abr-[a-f0-9]{64}$/);assert.equal(f.plan.identityKey,'TestId');assert.equal(f.plan.versionId,f.saved.record.testId);
  assert.equal(f.plan.recordSha256,f.saved.recordSha256);assert.equal(f.plan.zipSha256,f.saved.record.bundle.zipSha256);
  assert.equal(f.plan.source.gamReportSourceVerified,false);assert.equal(f.plan.source.scopeDeclaration,'operator');
  assert(![...f.r2.objects.keys()].some(key=>key.includes('measurement-v1/')));
  f.versions.clear();const listed=await listGamReportV2Plans(f.r2.bucket,f.options);assert(listed.sourceError);assert.equal(listed.plans.length,1);
  const retried=await createGamReportV2Plan(f.r2.bucket,{...f.options,report:report()});assert.equal(retried.created,false);assert.deepEqual(retried.plan,f.plan);
  assert.deepEqual((await readGamReportV2Plan(f.r2.bucket,{...f.options,planId:f.plan.id})).plan,f.plan);assert.equal(f.r2.log.puts.length,puts);
  assert.deepEqual(sources.map(pkg=>Object.fromEntries(Object.entries(pkg.files).map(([name,bytes])=>[name,hash(bytes)]))),identities);
});

test('multiple daily dimension rows aggregate weighted raw metrics and retain a complete-grain duplicate boundary',async()=>{
  const {plan}=await fixture();const result=await previewGamReportV2(plan,{csv:csv(plan,[row('A'),row('A',{deviceCategory:'Mobile',impressions:'30',revenue:'0.75',clicks:'2',eligibleImpressions:'27',measurableImpressions:'24',viewableImpressions:'12'}),row('B')])},NOW.valueOf());
  assert.equal(result.totals.A.rowCount,2);assert.equal(result.totals.A.impressions,40);assert.equal(result.totals.A.revenue,'0.900000');
  assert.equal(result.totals.A.revenuePerThousandImpressions,22.5);assert.equal(result.totals.A.clickThroughRatePercent,7.5);assert.equal(result.totals.A.viewabilityPercent,56.25);
  const device=result.breakdowns.find(item=>item.dimension==='deviceCategory');assert.equal(device.groupCount,2);assert.equal(device.groups.find(item=>item.value==='Mobile').A.impressions,30);
  assert.equal(result.dataComplete,false);assert.equal(result.coverage,'unknown');assert.equal(result.winner,null);assert.equal(result.totals.A.pageRpm,null);
  await assert.rejects(previewGamReportV2(plan,{csv:csv(plan,[row('A'),row('A')])}),/Duplicate full report grain/);
});

test('explicit GAM headers can arrive in different order; undeclared headers and raw Key-values cannot be guessed',async()=>{
  const normalized=normalizeGamReportV2Input(report());const columns=gamReportV2Columns(normalized);
  const mapping=Object.fromEntries(columns.map(key=>[key,key==='VersionId'?'TestId':key==='impressions'?'Total impressions':key==='revenue'?'Total revenue':'custom '+key]));
  const {plan}=await fixture(report({sourceColumns:mapping}));const result=await previewGamReportV2(plan,{csv:csv(plan,[row('A'),row('B')],{reverse:true})},NOW.valueOf());assert.equal(result.totals.A.impressions,10);
  await assert.rejects(previewGamReportV2(plan,{csv:csv(plan,[row('A')]).replace('Total impressions','Ad server impressions')}),/exact mapped source headers/);
  assert.throws(()=>normalizeGamReportV2Input(report({sourceColumns:{...mapping,impressions:'Ad server impressions'}})),/metric family/);
  assert.throws(()=>normalizeGamReportV2Input(report({sourceColumns:{...mapping,VersionId:'Key-values'}})),/Key-values/);
  assert.throws(()=>normalizeGamReportV2Input(report({sourceColumns:{...mapping,revenue:'Total CPM and CPC revenue'}})),/selected revenue metric/);
  assert.throws(()=>normalizeGamReportV2Input(report({revenueMetric:'cpm-cpc',sourceColumns:mapping})),/selected revenue metric/);
  const cpm=normalizeGamReportV2Input(report({revenueMetric:'cpm-cpc',sourceColumns:{...mapping,revenue:'Total CPM and CPC revenue'}}));assert.equal(cpm.revenueMetric,'cpm-cpc');
});

test('blank selected metrics invalidate only their aggregate and rates, with per-metric coverage',async()=>{
  const {plan}=await fixture();const result=await previewGamReportV2(plan,{csv:csv(plan,[row('A'),row('A',{adUnit:'bottom',revenue:'',clicks:''}),row('B')])},NOW.valueOf());
  assert.equal(result.totals.A.impressions,20);assert.equal(result.totals.A.revenue,null);assert.equal(result.totals.A.revenuePerThousandImpressions,null);assert.equal(result.totals.A.clicks,null);
  assert.deepEqual(result.totals.A.metricCoverage.revenue,{provided:1,missing:1});assert.equal(result.totals.A.viewabilityPercent,75);
  assert.equal(result.breakdowns[0].groups.find(item=>item.value==='top').A.revenue,'0.150000');
});

test('Prebid reports enforce both declared numeric filters and never acquire request denominators',async()=>{
  const input=report({purpose:'prebid',metricFamily:'ad-server',scope:{orderIds:['9001'],lineItemIds:['9002']},dimensions:['orderId','lineItemId','aq_bid_origin'],metrics:['impressions','revenue']});
  const {plan}=await fixture(input),data=row('A',{orderId:'9001',lineItemId:'9002',aq_bid_origin:'cached'});
  const result=await previewGamReportV2(plan,{csv:csv(plan,[data])},NOW.valueOf());assert.equal(result.totals.A.impressions,10);assert(result.notes.some(value=>value.includes('delivery subset')));
  for(const patch of [{orderId:'9003'},{lineItemId:'9003'}])await assert.rejects(previewGamReportV2(plan,{csv:csv(plan,[{...data,...patch}])}),/outside the declared scope/);
  assert.throws(()=>normalizeGamReportV2Input({...input,metrics:['adRequests','responsesServed']}),/cannot use delivery/);
});

test('purpose and request population guards keep each report meaningful',()=>{
  assert.throws(()=>normalizeGamReportV2Input(report({purpose:'refresh'})),/refresh dimension/);
  assert.throws(()=>normalizeGamReportV2Input(report({purpose:'startup'})),/CMP wait dimension/);
  assert.throws(()=>normalizeGamReportV2Input(report({purpose:'inventory'})),/unfilled count/);
  assert.throws(()=>normalizeGamReportV2Input(report({purpose:'inventory',dimensions:['creativeSize'],metrics:['unfilledImpressions']})),/requested ad sizes/);
  const normalized=normalizeGamReportV2Input(report({purpose:'inventory',dimensions:['requestedAdSizes'],metrics:['unfilledImpressions']}));assert.equal(normalized.metrics[0],'unfilledImpressions');
});

test('template contains the selected exact mapped grain, not nine fixed v1 fields',async()=>{
  const {plan}=await fixture();const result=gamReportV2Template(plan);const lines=result.trimEnd().split('\r\n');assert.equal(lines.length,7);
  assert.equal(lines[0],gamReportV2Columns(plan.report).join(','));assert.match(lines[1],/2026-11-22,gam_v2_example,A/);assert(!lines[0].includes('adRequests'));
});

test('detail route dispatch precedes v1 handler; previews persist no financial bytes and reject unknown query/body fields',async()=>{
  const f=await fixture(),base='/api/publishers/'+SITE+'/ab-tests',endpoint=base+'/'+f.saved.record.id+'/measurement/v2/plans';
  const options={...f.options,bucket:f.r2.bucket,base,headers:{},listVersions:async()=>[]};
  const call=(path,body)=>abTestsResponse(new Request('https://tessera.example.invalid'+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})}),options);
  const listing=await call(endpoint);assert.equal(listing.status,200);assert.equal((await listing.json()).plans[0].id,f.plan.id);
  const puts=f.r2.log.puts.length;const preview=await call(endpoint+'/'+f.plan.id+'/preview',{csv:csv(f.plan,[row('A'),row('B')])});assert.equal(preview.status,200);assert.equal((await preview.json()).versionId,'gam_v2_example');assert.equal(f.r2.log.puts.length,puts);
  assert.equal((await call(endpoint+'?source=elsewhere')).status,400);
  assert.equal((await call(endpoint+'/'+f.plan.id+'/preview',{csv:'invalid',winner:'B'})).status,422);
  assert.equal((await call(endpoint+'/'+f.plan.id+'/template.csv')).headers.get('content-type'),'text/csv; charset=utf-8');
});
