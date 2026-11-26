import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parse} from 'acorn';
import * as current from '../../worker/experiments/ab-loader-1.2.0.mjs';
import * as legacy from '../../worker/experiments/ab-loader-1.1.1.mjs';
import {loaderMeasurementPage} from '../support/ab-measurement-page.mjs';
import {loader111Page} from '../support/ab-loader111-page.mjs';
import {syntheticDraft} from '../support/ab-synthetic-drafts.mjs';
import {abGamIdentity,composeAbBundle,checkAbCompatibility} from '../../worker/experiments/ab-bundle.mjs';
import {validateAbMemoryMeasurement} from '../../worker/experiments/ab-measurement.mjs';
import {reportingSetup,reportingOnlyPlan} from '../../shared/gam/reporting-catalog.mjs';
import {describeCandidate} from '../../worker/runtime/draft-release-store.mjs';

const registry=JSON.parse(readFileSync(new URL('../../worker/experiments/ab-loader-registry.json',import.meta.url),'utf8'));
const page=options=>loaderMeasurementPage({L:current,...options});
const race=options=>loader111Page(current,options);
const events=(p,type)=>p.measurement().events.filter(row=>row.type===type);
const plain=value=>JSON.parse(JSON.stringify(value));
function plan(p){
  const value=p.measurement();
  return {schemaVersion:1,kind:'tessera-ab-report-plan',id:'abm-'+'d'.repeat(64),site:value.site,experimentId:value.experimentId,
    testId:value.testId,recordSha256:'f'.repeat(64),zipSha256:'e'.repeat(64),loader:value.loader,trafficBPercent:value.trafficBPercent,
    arms:Object.fromEntries(['A','B'].map(side=>[side,{release:value.arms[side].release,runtimeVersion:'3.25.1',scriptSha256:value.arms[side].scriptSha256,runtimeSha256:'b'.repeat(64)}])),prebidSha256:null,
    report:{networkCode:'999',inventoryPath:'/999/memory-site/',startDate:'2026-11-22',endDate:'2026-11-24',currency:'EUR',timeZone:'Europe/Belgrade',revenueBasis:'net',revenueMetric:'total'},
    source:{savedPackageScopeVerified:true,gamReportSourceVerified:false},measurement:{collection:'disabled',coverage:'unknown',revenueReady:false},
    createdAt:'2026-11-25T01:00:00.000Z',createdBy:'qa@example.invalid'};
}

test('explicit1.2.0 is registered ES5, does not change released templates or add collection',()=>{
  parse(current.AB_LOADER_TEMPLATE,{ecmaVersion:5});
  assert.equal(createHash('sha256').update(current.AB_LOADER_TEMPLATE).digest('hex'),registry['1.2.0'].sha256);
  assert.equal(createHash('sha256').update(legacy.AB_LOADER_TEMPLATE).digest('hex'),'81a1e8eee06a26a97eb65c7c0199e21508b6721bac3d3adecddd49ff3e7dd113');
  for(const name of ['fetch','XMLHttpRequest','sendBeacon','localStorage','sessionStorage','cookie','__tcfapi','__gpp','__uspapi'])assert.equal(current.AB_LOADER_TEMPLATE.includes(name),false,name);
  assert.equal(current.AB_REPORTING_KEY,'VersionId');
});

test('measured initial and refresh dispatches carry VersionId and original Variant only',()=>{
  const p=race();assert.equal(p.load(),true);p.service.refresh([]);
  assert.equal(p.dispatches.length,2);
  for(const labels of p.dispatches){assert.deepEqual(labels.VersionId,['loader_qa']);assert.deepEqual(labels.Variant,['B']);assert.equal('TestId' in labels,false);}
  assert.equal(p.state().versionId,'loader_qa');assert.equal(p.state().reportingKey,'VersionId');
});

test('legacy publisher TestId remains unrelated targeting for a VersionId package',()=>{
  const keywords={TestId:'publisher_test',section:'news'},p=page({keywords,existing:{TestId:['publisher_test']}});
  assert.equal(p.state().status,'assigned');assert.equal(p.load(),true);p.service.setTargeting('TestId','publisher_update');p.service.refresh([]);
  assert.equal(p.state().variant,'B');assert.deepEqual(p.service.getTargeting('VersionId'),['loader_memory']);
  assert.deepEqual(p.service.getTargeting('TestId'),['publisher_update']);assert.deepEqual(keywords,{TestId:'publisher_test',section:'news'});
});

test('early reserved keywords and pre-existing GPT labels preserve publisher ownership',()=>{
  for(const options of [{keywords:{VersionId:'foreign',section:'news'}},{keywords:{Variant:'foreign'}},{existing:{VersionId:['foreign'],section:['news']}},{existing:{Variant:['foreign'],section:['news']}}]){
    const before=plain(options),p=page(options);
    if(options.keywords)assert.equal(p.measurement().assignment,null);
    else {assert.equal(p.measurement().assignment.variant,'B');assert.equal(events(p,'exclusion').at(-1).phase,'after-assignment');}
    assert.equal(p.state().keyConflict,true);assert.equal(p.load(),true);assert.equal(p.state().executionArm,'A');
    if(options.existing?.VersionId)assert.deepEqual(p.service.getTargeting('VersionId'),['foreign']);
    if(options.existing?.Variant)assert.deepEqual(p.service.getTargeting('Variant'),['foreign']);
    if(options.keywords)assert.deepEqual(options.keywords,before.keywords);
  }
});

test('late VersionId setters remove owned labels without forwarding forged reserved values',()=>{
  const p=page({existing:{TestId:['publisher'],section:['news']}});p.load();p.service.setTargeting('VersionId','forged');
  assert.equal(p.state().variant,null);assert.deepEqual(p.service.getTargeting('VersionId'),[]);assert.deepEqual(p.service.getTargeting('Variant'),[]);
  assert.deepEqual(p.service.getTargeting('TestId'),['publisher']);assert.deepEqual(p.service.getTargeting('section'),['news']);
  assert.equal(events(p,'exclusion').at(-1).phase,'after-assignment');
});

test('clear VersionId and clear-all revoke measurement before later dispatch',()=>{
  for(const all of [false,true]){
    const p=page({existing:{section:['news']}});p.load();if(all)p.service.clearTargeting();else p.service.clearTargeting('VersionId');p.service.refresh([]);
    assert.equal(p.state().variant,null);assert.deepEqual(p.service.getTargeting('VersionId'),[]);assert.deepEqual(p.service.getTargeting('Variant'),[]);
    assert.deepEqual(p.service.getTargeting('section'),all?[]:['news']);
  }
});

test('setConfig conflict filters only reserved fields and leaves caller input intact',()=>{
  const p=page();p.load();const input={targeting:{VersionId:['forged'],Variant:'forged',TestId:'publisher',section:'sport'},centering:true},before=plain(input);
  p.sandbox.googletag.setConfig(input);assert.deepEqual(input,before);
  assert.deepEqual(p.service.getTargeting('VersionId'),[]);assert.deepEqual(p.service.getTargeting('Variant'),[]);
  assert.deepEqual(p.service.getTargeting('TestId'),['publisher']);assert.deepEqual(p.service.getTargeting('section'),['sport']);
});

test('VersionId slot overrides exclude labels before GPT display/refresh without changing foreign slot data',()=>{
  for(const reserved of ['VersionId','Variant'])for(const method of ['refresh','display']){
    const values={[reserved]:['foreign'],slot_section:['sport']},slot={getTargeting(key){return values[key]??[];}},p=page({slots:[slot]});
    p.load();if(method==='refresh')p.service.refresh([slot]);else p.sandbox.googletag.display('slot');
    assert.equal(p.state().variant,null);assert.deepEqual(p.service.getTargeting('VersionId'),[]);assert.deepEqual(p.service.getTargeting('Variant'),[]);
    assert.deepEqual(values,{[reserved]:['foreign'],slot_section:['sport']});
  }
});

test('a failing VersionId setter rolls back earlier Variant and executes unmeasured control',()=>{
  const p=page({failSet:'VersionId',existing:{TestId:['publisher']}});
  assert.equal(p.measurement().assignment.variant,'B');assert.equal(p.state().variant,null);
  assert.deepEqual(p.service.getTargeting('Variant'),[]);assert.deepEqual(p.service.getTargeting('VersionId'),[]);
  assert.deepEqual(p.service.getTargeting('TestId'),['publisher']);assert.equal(p.load(),true);assert.equal(p.state().executionArm,'A');
});

test('soft deadline keeps original B eligible and admits at most one native runtime',()=>{
  const p=race(),b=p.scripts[0];p.advance(16000);const a=p.scripts[1];assert.equal(p.scripts.length,2);assert.equal(p.timers.size,0);
  assert.equal(p.load(b),true);assert.equal(p.runtime(a),false);assert.equal(p.starts.length,1);assert.equal(p.dispatches.length,1);
  assert.deepEqual(p.dispatches[0].VersionId,['loader_qa']);assert.deepEqual(p.dispatches[0].Variant,['B']);assert.equal(p.state().fallback,false);
});

test('executed A fallback retains original assigned B and modern ledger compatibility',()=>{
  const p=race(),b=p.scripts[0];p.advance(8000);assert.equal(p.load(),true);assert.equal(p.runtime(b),false);
  assert.equal(p.state().executionArm,'A');assert.equal(p.state().originalVariant,'B');assert.equal(p.state().fallback,true);
  assert.deepEqual(p.dispatches[0].Variant,['B']);assert.deepEqual(p.dispatches[0].VersionId,['loader_qa']);
  assert.equal(events(p,'fallback').length,1);assert.equal(validateAbMemoryMeasurement(plan(p),p.measurement()).schemaVersion,2);
  const downgraded=p.measurement();downgraded.schemaVersion=1;assert.throws(()=>validateAbMemoryMeasurement(plan(p),downgraded),/schema/);
});

test('two definite errors are terminal and never permit late bodies or retries',()=>{
  const p=race(),b=p.scripts[0];p.error(b);const a=p.scripts[1];p.error(a);p.advance(120000);
  assert.equal(p.runtime(b),false);assert.equal(p.runtime(a),false);assert.equal(p.starts.length,0);assert.equal(p.scripts.length,2);assert.equal(p.timers.size,0);
  assert.equal(events(p,'terminal-failure').length,1);
});

test('saved identity rejects malformed and inherited loader metadata instead of coercing it',()=>{
  const good={loader:{version:'1.2.0',sha256:registry['1.2.0'].sha256},testId:'version_1'};
  assert.deepEqual(abGamIdentity(good),{key:'VersionId',value:'version_1',label:'Version ID'});
  assert.deepEqual(abGamIdentity({...good,loader:{version:'1.1.1',sha256:registry['1.1.1'].sha256}}),{key:'TestId',value:'version_1',label:'Version ID'});
  for(const value of [null,{}, {...good,testId:undefined},{...good,testId:null},{...good,testId:5},{...good,testId:'UPPER'},
    {...good,loader:{version:'toString'}},{...good,loader:{version:'__proto__'}},{...good,loader:{version:'9.9.9',sha256:registry['1.2.0'].sha256}},
    {...good,loader:{version:'1.2.0',sha256:'a'.repeat(64)}}])assert.throws(()=>abGamIdentity(value),/verified GAM identity/);
});

test('new VersionId compositions are explicit while default and historical arm bytes stay unchanged',async()=>{
  const a=await syntheticDraft(),b=await syntheticDraft({runtimeVersion:'9.0.1',script:'window.arm="B";'}),input={site:'test-site',a,b,testId:'version_1',name:'Version package',trafficBPercent:50};
  const old=await composeAbBundle(input),now=await composeAbBundle({...input,loaderVersion:'1.2.0'});
  assert.equal(old.record.loader.version,'1.1.1');assert.equal(now.record.loader.version,'1.2.0');
  assert.equal(abGamIdentity(old.record).key,'TestId');assert.equal(abGamIdentity(now.record).key,'VersionId');assert.notEqual(old.id,now.id);
  for(const side of ['A','B'])assert.deepEqual(now.files[now.record.arms[side].path],old.files[old.record.arms[side].path]);
  assert.equal(new TextDecoder().decode(now.files['ads.js']).includes("p.setTargeting('VersionId', config.testId)"),true);
});

test('new loader retains mandatory built-in startup guard compatibility',async()=>{
  const a=await syntheticDraft({script:'window.unprotected=true;'});
  const files={...a.files,'ads.min.js':new TextEncoder().encode('/* if(window.__TESSERA_RUNTIME_STARTED)return; */window.unprotected=true;')};
  const manifest=JSON.parse(new TextDecoder().decode(files['manifest.json']));
  manifest.files['ads.min.js']={byteSize:files['ads.min.js'].length,sha256:createHash('sha256').update(files['ads.min.js']).digest('hex')};
  files['manifest.json']=new TextEncoder().encode(JSON.stringify(manifest));
  const {descriptor}=await describeCandidate('test-site',{files});
  const changed={files,release:{...a.release,id:descriptor.releaseId}};
  const result=await checkAbCompatibility({site:'test-site',a:changed,b:changed,loaderVersion:'1.2.0'});
  assert.equal(result.compatible,false);assert.equal(result.refusal.code,'startup-guard-missing');
  await assert.rejects(composeAbBundle({site:'test-site',a:changed,b:changed,loaderVersion:'1.2.0',testId:'guard_1',name:'Guard proof',trafficBPercent:50}),error=>error.code==='startup-guard-missing');
});

test('GAM catalog adds VersionId without dropping TestId or changing add-only policy',()=>{
  const catalog=reportingSetup();assert(catalog.keys.some(row=>row.key==='TestId'&&row.valueInput==='test-id'));
  assert(catalog.keys.some(row=>row.key==='VersionId'&&row.valueInput==='version-id'));
  const selected=reportingSetup(undefined,[{key:'VersionId',values:['site_1','site_2','site_1']},{key:'Variant',values:['A','B']}]);
  assert.deepEqual(selected.keys.find(row=>row.key==='VersionId').values,['site_1','site_2']);
  assert.equal(selected.keys.some(row=>row.key==='TestId'),false);
  const job=reportingOnlyPlan('999',undefined,[{key:'VersionId',values:['site_1']}]);assert.equal(job.reporting.writePolicy,'add_only');
  assert.throws(()=>reportingSetup(undefined,[{key:'VersionId',values:['Site-1']}]),/VersionId/);
});
