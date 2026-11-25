/** Independent adversarial QA. Synthetic immutable packages and in-memory R2 only.
 * TESSERA_GAM_V2_QA_ROOT can target the integration checkout without installing or
 * linking another dependency tree; all imports then resolve inside that source root. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const ROOT=resolve(process.env.TESSERA_GAM_V2_QA_ROOT??fileURLToPath(new URL('../..',import.meta.url)));
const source=path=>import(pathToFileURL(resolve(ROOT,path)).href);
const {syntheticDraft}=await source('tests/support/ab-synthetic-drafts.mjs');
const {memoryR2}=await source('tests/support/memory-r2.mjs');
const {describeCandidate}=await source('worker/runtime/draft-release-store.mjs');
const {createAbTest}=await source('worker/experiments/ab-store.mjs');
const {createGamReportV2Plan,readGamReportV2Plan,listGamReportV2Plans}=await source('worker/experiments/gam-report-v2-plan.mjs');
const {gamReportV2Template,previewGamReportV2}=await source('worker/experiments/gam-report-v2.mjs');
const {gamReportV2Columns}=await source('worker/experiments/gam-report-v2-contracts.mjs');
const {createMeasurementPlan}=await source('worker/experiments/ab-report-plan.mjs');
const {previewAbGamReport}=await source('worker/experiments/ab-gam-report.mjs');

const SITE='gam-v2-independent-qa',ACTOR={email:'qa@example.invalid'},VERSION_ID='gam_v2_independent';
const NOW=Date.parse('2026-11-25T12:00:00.000Z'),encode=new TextEncoder(),decode=new TextDecoder();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const context=()=>({networkCode:'123',inventoryPath:'/123/inventory/',startDate:'2026-11-22',endDate:'2026-11-23',currency:'EUR',timeZone:'UTC',revenueBasis:'net',revenueMetric:'total'});
function report(patch={}){
  const input={...context(),purpose:'overall',metricFamily:'total',scope:{orderIds:[],lineItemIds:[]},dimensions:['adUnit','deviceCategory'],metrics:['impressions','revenue','clicks','eligibleImpressions','measurableImpressions','viewableImpressions'],compatibilityMode:'off',...patch};
  input.sourceColumns=patch.sourceColumns??Object.fromEntries(gamReportV2Columns(input).map(key=>[key,key]));return input;
}
const row=(patch={})=>({date:'2026-11-22',VersionId:VERSION_ID,Variant:'A',adUnit:'top',deviceCategory:'Desktop',impressions:'10',revenue:'1.000000',clicks:'1',eligibleImpressions:'10',measurableImpressions:'8',viewableImpressions:'4',...patch});
const cell=value=>'"'+String(value??'').replaceAll('"','""')+'"';
function csv(input,rows,order=gamReportV2Columns(input)){
  return order.map(key=>cell(input.sourceColumns[key])).join(',')+'\r\n'+rows.map(record=>order.map(key=>cell(record[key])).join(',')).join('\r\n')+'\r\n';
}
const snapshot=r2=>[...r2.objects].map(([key,value])=>[key,hash(value.bytes),value.etag]);
async function refused(promise,pattern){await assert.rejects(promise,error=>error.status===422&&(!pattern||pattern.test(error.message)));}
function noWinner(preview){
  assert.equal(preview.dataComplete,false);assert.equal(preview.revenueReady,false);assert.equal(preview.coverage,'unknown');assert.equal(preview.winner,null);assert.equal(preview.upliftPercent,null);
  for(const side of ['A','B']){assert.equal(preview.totals[side].pageRpm,null);assert.equal(preview.totals[side].receivedAssignments,null);assert.equal(preview.totals[side].impressionsPerAssignedPage,null);}
}
let packages,originalFetch;
test.before(async()=>{
  originalFetch=globalThis.fetch;globalThis.fetch=()=>assert.fail('Independent report QA must not issue network traffic');
  packages=await Promise.all(['A','B'].map(async(side,index)=>{
    const pkg=await syntheticDraft({siteId:SITE,runtimeVersion:'9.7.'+index,note:side,script:'window.arm='+JSON.stringify(side)+';'});
    const config=JSON.parse(decode.decode(pkg.files['config.json']));config.core={gamPath:'/123/inventory/'};pkg.files['config.json']=encode.encode(JSON.stringify(config));
    const manifest=JSON.parse(decode.decode(pkg.files['manifest.json']));manifest.configHash=hash(pkg.files['config.json']);manifest.files['config.json']={byteSize:pkg.files['config.json'].length,sha256:manifest.configHash};pkg.files['manifest.json']=encode.encode(JSON.stringify(manifest));
    pkg.release.id=(await describeCandidate(SITE,{files:pkg.files})).descriptor.releaseId;return pkg;
  }));
});
test.after(()=>{globalThis.fetch=originalFetch;});
async function fixture(input=report(),identity={}){
  const r2=memoryR2({prefix:'site-experiments/'}),versions=new Map(packages.map(pkg=>[pkg.release.id,pkg]));
  const readVersion=async id=>{const pkg=versions.get(id);if(!pkg)throw Object.assign(Error('Missing synthetic source'),{status:404});return pkg;};
  const saved=await createAbTest(r2.bucket,{site:SITE,actor:ACTOR,a:packages[0],b:packages[1],name:'Independent GAM v2 QA',testId:VERSION_ID,trafficBPercent:50,...identity,now:new Date(NOW)});
  const options={site:SITE,id:saved.record.id,actor:ACTOR,readVersion},prepared=await createGamReportV2Plan(r2.bucket,{...options,report:input,now:new Date(NOW)});
  return {r2,versions,saved,options,input,prepared,plan:prepared.plan,create:next=>createGamReportV2Plan(r2.bucket,{...options,report:next,now:new Date(NOW+1)}),preview:rows=>previewGamReportV2(prepared.plan,{csv:csv(input,rows)},NOW)};
}

// These probes use independent business expectations; they deliberately exercise
// asymmetrical row populations, null cells and filters instead of copying loops.

test('saved scope and Version ID bind immutable packages; changed report context creates a different plan',async()=>{
  const f=await fixture(),before=snapshot(f.r2),puts=f.r2.log.puts.length;
  assert.equal(f.plan.versionId,VERSION_ID);assert.equal(f.plan.identityKey,'TestId');assert.equal(f.plan.recordSha256,f.saved.recordSha256);assert.equal(f.plan.zipSha256,f.saved.record.bundle.zipSha256);
  assert.deepEqual(f.plan.source,{savedPackageScopeVerified:true,gamReportSourceVerified:false,scopeDeclaration:'operator'});
  const retry=await f.create(report());assert.equal(retry.created,false);assert.deepEqual(retry.plan,f.plan);assert.deepEqual(snapshot(f.r2),before);assert.equal(f.r2.log.puts.length,puts);
  for(const patch of [{networkCode:'999',inventoryPath:'/999/inventory/'},{inventoryPath:'/123/foreign/'},{coverage:'verified'},{gamReportSourceVerified:true},{assignedPages:1000}])await refused(f.create(report(patch)));
  assert.deepEqual(snapshot(f.r2),before);
  const other=await f.create(report({currency:'USD'}));assert.notEqual(other.plan.id,f.plan.id);assert.equal(other.plan.source.gamReportSourceVerified,false);
});

test('overall data cannot be declared as a Prebid subset or mixed metric family',async()=>{
  const f=await fixture(),before=snapshot(f.r2);
  for(const patch of [{scope:{orderIds:['7001'],lineItemIds:[]}},{scope:{orderIds:[],lineItemIds:['8001']}},{metricFamily:'ad-server'}])await refused(f.create(report(patch)));
  assert.deepEqual(snapshot(f.r2),before);
});

test('Prebid scope requires explicit positive IDs and matching delivery metric family',async()=>{
  const f=await fixture(),before=snapshot(f.r2);
  const prebid=patch=>report({purpose:'prebid',metricFamily:'ad-server',dimensions:['orderId','lineItemId','aq_bid_origin'],metrics:['impressions','revenue'],scope:{orderIds:['7001'],lineItemIds:['8001']},...patch});
  for(const input of [prebid({scope:{orderIds:[],lineItemIds:[]}}),prebid({metricFamily:'total'}),prebid({scope:{orderIds:['7001'],lineItemIds:['not-an-id']}}),prebid({scope:{orderIds:['7001'],lineItemIds:['8001'],operator:'OR'}})])await refused(f.create(input));
  assert.deepEqual(snapshot(f.r2),before);
  const input=prebid({}),plan=(await f.create(input)).plan;
  const accepted=await previewGamReportV2(plan,{csv:csv(input,[row({orderId:'7001',lineItemId:'8001',aq_bid_origin:'cached'})])},NOW);
  assert.equal(accepted.totals.A.impressions,10);assert.equal(accepted.source.purpose,'prebid');assert.equal(accepted.source.metricFamily,'ad-server');assert.deepEqual(accepted.source.scope,input.scope);noWinner(accepted);
  for(const ids of [{orderId:'7002',lineItemId:'8001'},{orderId:'7001',lineItemId:'8002'},{orderId:'',lineItemId:'8001'}])await refused(previewGamReportV2(plan,{csv:csv(input,[row({...ids,aq_bid_origin:'fresh'})])},NOW));
});

test('valid multidimensional rows share a day; only exact dimension tuples are duplicates',async()=>{
  const f=await fixture(),rows=[row({impressions:'1',revenue:'1',eligibleImpressions:'1',measurableImpressions:'1',viewableImpressions:'1'}),row({adUnit:'side',impressions:'99',revenue:'0',eligibleImpressions:'99',measurableImpressions:'99',viewableImpressions:'0'})];
  const result=await f.preview(rows);assert.equal(result.providedRows,2);assert.equal(result.totals.A.impressions,100);assert.equal(result.totals.A.revenue,'1.000000');assert.equal(result.totals.A.viewabilityPercent,1);assert.equal(result.totals.A.revenuePerThousandImpressions,10);
  const units=result.breakdowns.find(group=>group.dimension==='adUnit');assert(units);assert.equal(units.groupCount,2);assert.deepEqual(new Set(units.groups.map(group=>group.value)),new Set(['top','side']));
  for(const record of [rows[0],{...rows[0],impressions:'7',revenue:'50'}])await refused(f.preview([...rows,record]));
  noWinner(result);
});

test('weighted totals include signed micro-revenue and zero denominators remain unavailable',async()=>{
  const f=await fixture(),rows=[row({impressions:'1',revenue:'0.000001',eligibleImpressions:'2',measurableImpressions:'1',viewableImpressions:'1'}),row({adUnit:'side',impressions:'9',revenue:'-0.000002',eligibleImpressions:'18',measurableImpressions:'9',viewableImpressions:'3'}),row({Variant:'B',impressions:'0',revenue:'0',clicks:'0',eligibleImpressions:'0',measurableImpressions:'0',viewableImpressions:'0'})];
  const before=snapshot(f.r2),result=await f.preview(rows);
  assert.equal(result.totals.A.revenueMicros,-1);assert.equal(result.totals.A.revenue,'-0.000001');assert.equal(result.totals.A.viewabilityPercent,40);assert.equal(result.totals.A.measurabilityPercent,50);assert.equal(result.totals.A.clickThroughRatePercent,20);
  assert.equal(result.totals.B.revenuePerThousandImpressions,null);assert.equal(result.totals.B.clickThroughRatePercent,null);assert.equal(result.totals.B.viewabilityPercent,null);assert.equal(result.totals.B.measurabilityPercent,null);assert.deepEqual(snapshot(f.r2),before);noWinner(result);
});

test('missing optional cells and missing cohort days are unknown, never synthesized zero outcomes',async()=>{
  const f=await fixture(),result=await f.preview([row(),row({adUnit:'side',clicks:'',eligibleImpressions:'',measurableImpressions:'',viewableImpressions:''})]);
  assert.equal(result.totals.A.clicks,null);assert.equal(result.totals.A.viewabilityPercent,null);assert.deepEqual(result.totals.A.metricCoverage.clicks,{provided:1,missing:1});
  assert.equal(result.totals.B.rowCount,0);assert.equal(result.totals.B.impressions,null);assert.equal(result.totals.B.revenue,null);
  assert.deepEqual(result.missingDays,[{date:'2026-11-22',variant:'B'},{date:'2026-11-23',variant:'A'},{date:'2026-11-23',variant:'B'}]);
  const units=result.breakdowns.find(group=>group.dimension==='adUnit');assert.equal(units.groups.find(group=>group.value==='side').B.impressions,null);noWinner(result);
});

test('request metrics preserve their own population and are not manufactured for delivery-only reports',async()=>{
  const input=report({purpose:'inventory',dimensions:['adUnit','requestedAdSizes'],metrics:['impressions','adRequests','responsesServed','unfilledImpressions']}),f=await fixture(input);
  const result=await f.preview([row({requestedAdSizes:'300x250',adRequests:'100',responsesServed:'75',unfilledImpressions:'25'}),row({adUnit:'side',requestedAdSizes:'300x600',adRequests:'300',responsesServed:'75',unfilledImpressions:'225'})]);
  assert.equal(result.totals.A.adRequests,400);assert.equal(result.totals.A.responsesServed,150);assert.equal(result.totals.A.unfilledImpressions,250);assert.equal(result.totals.A.responseRatePercent,37.5);assert.equal(result.totals.A.revenue,null);
  const partial=await f.preview([row({requestedAdSizes:'300x250',adRequests:'',responsesServed:'',unfilledImpressions:''})]);assert.equal(partial.totals.A.adRequests,null);assert.equal(partial.totals.A.responseRatePercent,null);
  await refused(f.preview([row({requestedAdSizes:'300x250',adRequests:'0',responsesServed:'1',unfilledImpressions:'0'})]));
  const regular=await fixture(),delivery=await regular.preview([row()]);assert.equal(delivery.totals.A.adRequests,null);assert.equal(delivery.totals.A.responseRatePercent,null);noWinner(result);
  const onlyUnfilled=report({purpose:'inventory',dimensions:['adUnit','requestedAdSizes'],metrics:['unfilledImpressions']}),uf=await fixture(onlyUnfilled),unfilled=await uf.preview([row({requestedAdSizes:'300x250',unfilledImpressions:'5'})]);assert.equal(unfilled.totals.A.unfilledImpressions,5);assert.equal(unfilled.totals.A.responseRatePercent,null);assert.equal(unfilled.totals.A.revenue,null);noWinner(unfilled);
});

test('exact explicit source header mapping supports reordered localized headers without guessing extra identity columns',async()=>{
  const basic=report(),mapping={...basic.sourceColumns,date:'Datum',VersionId:'TestId',Variant:'Kraka',impressions:'Ukupne impresije',revenue:'Ukupan prihod'},input=report({sourceColumns:mapping}),f=await fixture(input),rows=[row()];
  const canonical=await f.preview(rows),reordered=await previewGamReportV2(f.plan,{csv:csv(input,rows,gamReportV2Columns(input).toReversed())},NOW);assert.deepEqual(reordered.totals,canonical.totals);assert.equal(reordered.versionId,VERSION_ID);assert.equal(reordered.identityKey,'TestId');
  const body=csv(input,rows),bom=await previewGamReportV2(f.plan,{csv:'\uFEFF'+body},NOW);assert.deepEqual(bom.totals,canonical.totals);const lines=body.split('\r\n');
  lines[0]+=',"VersionId"';lines[1]+=',"foreign_id"';await refused(previewGamReportV2(f.plan,{csv:lines.join('\r\n')},NOW));
  for(const sourceColumns of [{...mapping,revenue:mapping.impressions},{...mapping,VersionId:'Key-values'},{...mapping,rawKeyValues:'Key-values'}])await refused(f.create(report({sourceColumns})));
  for(const patch of [{VersionId:'foreign_id'},{Variant:'a'},{Variant:''},{date:'2026-11-21'}])await refused(f.preview([row(patch)]));
});

test('mapped metric names never authorize mixed Total and Ad server inputs or raw overlap dimensions',async()=>{
  const f=await fixture(),input=report();
  for(const sourceColumns of [{...input.sourceColumns,impressions:'Ad server impressions'},{...input.sourceColumns,revenue:'Ad server CPM and CPC revenue'},{...input.sourceColumns,measurableImpressions:'Ad server Active View measurable impressions'}])await refused(f.create(report({sourceColumns})));
  for(const dimensions of [['Key-values'],['Placement'],['adUnit','adUnit']])await refused(f.create(report({dimensions})));
});

test('primary-bid labels and serving identifiers remain separate, and missing labels are not reclassified as none',async()=>{
  const input=report({purpose:'prebid',metricFamily:'ad-server',scope:{orderIds:['7001'],lineItemIds:['8001']},dimensions:['orderId','lineItemId','aq_bid_origin','hb_bidder'],metrics:['impressions','revenue']}),f=await fixture(input);
  const result=await f.preview([row({orderId:'7001',lineItemId:'8001',aq_bid_origin:'cached',hb_bidder:'top_targeted_bidder'})]);
  assert(result.notes.concat(result.blockers).some(note=>/primary|labels describe bids sent to GAM|targeted (bid|bidder)|serving (bid|creative)|GAM (winner|win)/i.test(note)));noWinner(result);
  const unknown=await f.preview([row({orderId:'7001',lineItemId:'8001',aq_bid_origin:'',hb_bidder:''})]);
  const origins=unknown.breakdowns.find(group=>group.dimension==='aq_bid_origin');assert(origins);assert(!origins.groups.some(group=>group.value==='none'));
  for(const aq_bid_origin of ['cache','CACHED','0'])await refused(f.preview([row({orderId:'7001',lineItemId:'8001',aq_bid_origin,hb_bidder:'bidder'})]));
});

test('malformed money/counts and inconsistent Active View pairs fail rather than being rounded or repaired',async()=>{
  const f=await fixture();
  for(const patch of [{impressions:'1e3'},{impressions:'-1'},{impressions:' 10'},{revenue:'0.1234567'},{revenue:'1,20'},{revenue:'=1+2'},{viewableImpressions:'9',measurableImpressions:'8'},{viewableImpressions:'4',measurableImpressions:''},{impressions:'9007199254740992'}])await refused(f.preview([row(patch)]));
  await refused(f.preview([row({impressions:'9007199254740991'}),row({adUnit:'side',impressions:'1'})]));
  await refused(f.preview([row({revenue:'9007199254.740991'}),row({adUnit:'side',revenue:'0.000001'})]));
  const permitted=await f.preview([row({impressions:'0',revenue:'1',clicks:'12',eligibleImpressions:'0',measurableImpressions:'0',viewableImpressions:'0'})]);assert.equal(permitted.totals.A.revenue,'1.000000');assert.equal(permitted.totals.A.clicks,12);assert.equal(permitted.totals.A.revenuePerThousandImpressions,null);
});

test('preview cannot accept caller-supplied financial readiness, coverage, currency or alternate Version ID metadata',async()=>{
  const f=await fixture(),before=snapshot(f.r2),body=csv(f.input,[row()]);
  for(const extra of [{coverage:'verified'},{winner:'B'},{assignedPages:1000},{currency:'USD'},{versionId:'foreign'},{gamReportSourceVerified:true}])await refused(previewGamReportV2(f.plan,{csv:body,...extra},NOW));
  assert.deepEqual(snapshot(f.r2),before);
});

test('templates contain unknown outcomes and source context remains user-declared even with complete daily rows',async()=>{
  const f=await fixture(),template=gamReportV2Template(f.plan);assert(template.includes('VersionId'));assert(!template.includes('assignedPages'));
  const rows=[];for(const date of ['2026-11-22','2026-11-23'])for(const Variant of ['A','B'])rows.push(row({date,Variant}));
  const result=await f.preview(rows);assert.equal(result.missingDays.length,0);assert.equal(result.source.gamReportSourceVerified,false);assert.equal(result.source.scopeDeclaration,'operator');noWinner(result);
  assert(result.blockers.some(note=>/source|verify|declared|GAM/i.test(note)));assert(result.blockers.some(note=>/assigned|page|denominator/i.test(note)));
});

test('v1 plans and their exact TestId CSV survive v2 plan creation without source rewrites or financial persistence',async()=>{
  const f=await fixture(),legacy=await createMeasurementPlan(f.r2.bucket,{...f.options,report:context(),now:new Date(NOW)});
  const stored=snapshot(f.r2),puts=f.r2.log.puts.length;
  const old='date,TestId,Variant,impressions,revenue,adRequests,responsesServed,measurableImpressions,viewableImpressions\n2026-11-22,'+VERSION_ID+',A,10,1,,,,\n';
  const oldResult=await previewAbGamReport(legacy.plan,{csv:old},NOW);assert.equal(oldResult.schemaVersion,1);assert.equal(oldResult.testId,VERSION_ID);assert.equal(oldResult.totals.A.revenue,'1.000000');assert.equal(oldResult.winner,null);
  await f.preview([row()]);assert.equal(f.r2.log.puts.length,puts);assert.deepEqual(snapshot(f.r2),stored);
  const detail=await readGamReportV2Plan(f.r2.bucket,{...f.options,planId:f.plan.id});assert.deepEqual(detail.plan,f.plan);
  const listing=await listGamReportV2Plans(f.r2.bucket,f.options);assert(listing.plans.some(plan=>plan.id===f.plan.id));
});

test('report purposes require their diagnostic grain and preserve comparable startup/refresh bucket semantics',async()=>{
  const f=await fixture();
  for(const input of [report({purpose:'refresh'}),report({purpose:'startup'}),report({purpose:'inventory',metrics:['impressions','revenue']}),report({purpose:'prebid',metricFamily:'ad-server',scope:{orderIds:['7001'],lineItemIds:['8001']},dimensions:['aq_bid_origin']})])await refused(f.create(input));
  const refresh=report({purpose:'refresh',dimensions:['refresh_bucket','refresh_count','refresh_policy'],metrics:['impressions','revenue']}),rf=await fixture(refresh);
  const accepted=await rf.preview([row({refresh_bucket:'r1_3',refresh_count:'2',refresh_policy:'fresh_auction'})]);assert.equal(accepted.totals.A.impressions,10);noWinner(accepted);
  for(const patch of [{refresh_bucket:'r1_3',refresh_count:'-1',refresh_policy:'fresh_auction'},{refresh_bucket:'later',refresh_count:'2',refresh_policy:'fresh_auction'},{refresh_bucket:'r1_3',refresh_count:'2',refresh_policy:'cache'}])await refused(rf.preview([row(patch)]));
  const startup=report({purpose:'startup',dimensions:['aq_first_request','aq_consent_wait'],metrics:['impressions','revenue']}),sf=await fixture(startup);
  const timeout=await sf.preview([row({aq_first_request:'3000_plus',aq_consent_wait:'timeout'})]);assert.equal(timeout.totals.A.impressions,10);noWinner(timeout);
  for(const patch of [{aq_first_request:'3000',aq_consent_wait:'timeout'},{aq_first_request:'3000_plus',aq_consent_wait:'consent_allowed'}])await refused(sf.preview([row(patch)]));
});

test('bounded breakdown keeps the rest of the population in Other rather than dropping it',async()=>{
  const input=report({dimensions:['adUnit'],metrics:['impressions','revenue']}),f=await fixture(input),rows=Array.from({length:75},(_,i)=>row({adUnit:'position_'+i,impressions:'1',revenue:'0.010000'}));
  const result=await f.preview(rows),breakdown=result.breakdowns.find(group=>group.dimension==='adUnit');
  assert.equal(result.totals.A.impressions,75);assert.equal(result.totals.A.revenue,'0.750000');assert.equal(breakdown.groupCount,75);assert.equal(breakdown.groups.length,50);assert.equal(breakdown.other.groupCount,25);
  assert.equal(breakdown.groups.reduce((n,g)=>n+g.A.impressions,0)+breakdown.other.A.impressions,75);assert.equal(breakdown.groups.reduce((n,g)=>n+g.A.revenueMicros,0)+breakdown.other.A.revenueMicros,750000);assert.equal(breakdown.other.B.impressions,null);noWinner(result);
});

test('mapping rejects missing/extra headers and UTF8 byte/row limits before silently narrowing the report',async()=>{
  const f=await fixture(),body=csv(f.input,[row()]),lines=body.split('\r\n');
  for(const transform of [header=>header.replace('"revenue",',''),header=>header+',"unexpected"',header=>header.replace('"revenue"','"Revenue"')]){
    const changed=[...lines];changed[0]=transform(changed[0]);await refused(previewGamReportV2(f.plan,{csv:changed.join('\r\n')},NOW));
  }
  await refused(previewGamReportV2(f.plan,{csv:'é'.repeat(524289)},NOW),/Mi?B|byte|size|large/i);
  const input=report({dimensions:[],metrics:['impressions','revenue']}),small=await fixture(input),tooMany=csv(input,Array.from({length:10001},()=>row()));
  assert(encode.encode(tooMany).length<1024*1024);await refused(previewGamReportV2(small.plan,{csv:tooMany},NOW),/rows|10.?000/i);
});

test('immutable v2 identity rejects recomputed-checksum tampering and an already saved plan survives source cleanup',async()=>{
  const f=await fixture(),key=[...f.r2.objects.keys()].find(key=>key.endsWith('/'+f.plan.id+'.json')),object=f.r2.objects.get(key),bytes=object.bytes.slice(),metadata={...object.customMetadata};assert(object);
  for(const mutate of [plan=>{plan.versionId='foreign';},plan=>{plan.identityKey='VersionId';},plan=>{plan.report.currency='USD';},plan=>{plan.source.gamReportSourceVerified=true;},plan=>{plan.report.metricFamily='ad-server';}]){
    const changed=structuredClone(f.plan);mutate(changed);object.bytes=encode.encode(JSON.stringify(changed));object.customMetadata={...metadata,sha256:hash(object.bytes)};
    await assert.rejects(readGamReportV2Plan(f.r2.bucket,{...f.options,planId:f.plan.id}),error=>error.status===409);
  }
  object.bytes=bytes;object.customMetadata=metadata;const before=snapshot(f.r2),puts=f.r2.log.puts.length;f.versions.clear();
  const detail=await readGamReportV2Plan(f.r2.bucket,{...f.options,planId:f.plan.id});assert.deepEqual(detail.plan,f.plan);
  const retry=await f.create(report());assert.equal(retry.created,false);assert.deepEqual(retry.plan,f.plan);assert.equal(f.r2.log.puts.length,puts);assert.deepEqual(snapshot(f.r2),before);
  await refused(f.create(report({currency:'USD'})));
});

test('concurrent identical v2 saves retain one actor/time winner and only one created result',{timeout:5000},async()=>{
  const f=await fixture(),input=report({currency:'USD'});let entered=0,release;const gate=new Promise(resolve=>{release=resolve;});
  f.r2.faults.beforePut=async key=>{if(!key.includes('/measurement-v2/'))return;if(++entered===2)release();await gate;};
  const choices=[{email:'first@example.invalid',time:'2026-11-25T12:01:00.000Z'},{email:'second@example.invalid',time:'2026-11-25T12:02:00.000Z'}];
  const results=await Promise.all(choices.map(choice=>createGamReportV2Plan(f.r2.bucket,{...f.options,actor:{email:choice.email},report:input,now:new Date(choice.time)})));f.r2.faults.beforePut=null;
  assert.equal(entered,2);assert.equal(results.filter(result=>result.created).length,1);assert.deepEqual(results[0].plan,results[1].plan);assert.equal(results[0].planSha256,results[1].planSha256);
  const winner=choices.find(choice=>choice.email===results[0].plan.createdBy);assert(winner);assert.equal(results[0].plan.createdAt,winner.time);
  assert.equal([...f.r2.objects.keys()].filter(key=>key.endsWith('/'+results[0].plan.id+'.json')).length,1);
});


test('new VersionId-emitting packages retain their actual identity key without reinterpreting legacy package plans',async()=>{
  const legacy=await fixture(),current=await fixture(report(),{reportingKey:'VersionId'});
  assert.equal(legacy.plan.identityKey,'TestId');assert.equal(current.plan.identityKey,'VersionId');assert.equal(current.plan.versionId,VERSION_ID);assert.equal(current.plan.loader.version,'1.2.0');assert.notEqual(current.plan.zipSha256,legacy.plan.zipSha256);
  const result=await current.preview([row()]);assert.equal(result.identityKey,'VersionId');assert.equal(result.versionId,VERSION_ID);noWinner(result);
  const before=snapshot(current.r2);await refused(previewGamReportV2(current.plan,{csv:csv(current.input,[row()]),identityKey:'TestId'},NOW));assert.deepEqual(snapshot(current.r2),before);
});

test('recognized revenue source headers must agree with the saved total versus CPM/CPC selection',async()=>{
  const f=await fixture();
  for(const [purpose,metricFamily,revenueMetric,header] of [
    ['overall','total','total','Total revenue'],
    ['overall','total','cpm-cpc','Total CPM and CPC revenue'],
    ['prebid','ad-server','total','Ad server total revenue'],
    ['prebid','ad-server','cpm-cpc','Ad server CPM and CPC revenue'],
  ]){
    const input=report({purpose,metricFamily,revenueMetric,...(purpose==='prebid'?{scope:{orderIds:['7001'],lineItemIds:['8001']},dimensions:['orderId','lineItemId']}:{}),metrics:['impressions','revenue']});input.sourceColumns.revenue=header;
    const valid=await f.create(input);assert.equal(valid.plan.report.revenueMetric,revenueMetric);
    await refused(f.create({...input,revenueMetric:revenueMetric==='total'?'cpm-cpc':'total'}));
  }
});
