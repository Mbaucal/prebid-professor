import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {mainAbFixture} from '../support/ab-tests-main-fixture.mjs';
import {memoryR2} from '../support/memory-r2.mjs';
import {ORIGINAL_SOURCES,originalId} from '../../worker/experiments/original-source-catalog.mjs';
import {saveOriginalSources,readOriginalSource,listOriginalSources} from '../../worker/site-runtime/original-sources.mjs';
import {checkAbCompatibility,composeAbBundle,abGamIdentity} from '../../worker/experiments/ab-bundle.mjs';

const bytes=Object.fromEntries(ORIGINAL_SOURCES.map(s=>[s.url,new Uint8Array(readFileSync(`tests/fixtures/politika-originals/${s.side}.js`))]));
const A=originalId(ORIGINAL_SOURCES[0]),B=originalId(ORIGINAL_SOURCES[1]),base='/api/publishers/politika/ab-tests';
const digest=b=>createHash('sha256').update(b).digest('hex');
let h,oldFetch,fetches=[],badSource=false;
test.before(async()=>{
  oldFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>{
    assert(Object.hasOwn(bytes,url),'Only the two pinned public URLs may be read');assert.equal(options.redirect,'manual');assert(options.signal);
    assert.equal(options.headers.authorization,undefined);fetches.push(url);
    return new Response(badSource?new TextEncoder().encode('different script'):bytes[url]);
  };
  h=await mainAbFixture({seed:false});await h.addSite('politika');await h.addSite('other-site');
});
test.after(()=>{h?.close();globalThis.fetch=oldFetch;});
test('source provenance matches both real files and distinguishes build A from runtime B',()=>{
  for(const s of ORIGINAL_SOURCES){assert.equal(bytes[s.url].length,s.bytes);assert.equal(digest(bytes[s.url]),s.sha256);}
  assert.equal(ORIGINAL_SOURCES[0].runtimeVersion,null);assert.equal(ORIGINAL_SOURCES[1].runtimeVersion,'3.25.0');
});
test('GET does not fetch or save originals; authentication, origin, site and bounded no-input gates precede writes',async()=>{
  const before=h.persistent(),puts=h.r2.log.puts.length;
  const list=await h.json(base);assert.equal(list.versions.length,2);assert.equal(fetches.length,0);
  const path=base+'/original-sources';
  for(const [options,status] of [[{method:'POST',auth:false},401],[{method:'POST',origin:null},403],[{method:'POST',origin:'https://evil.invalid'},403],[{method:'GET'},405],[{method:'POST',body:{url:'http://localhost'}},400]])assert.equal((await h.request(path,options)).status,status);
  assert.equal((await h.request(path+'?url=http://localhost',{method:'POST'})).status,400);
  assert.equal((await h.request('/api/publishers/missing/ab-tests/original-sources',{method:'POST'})).status,404);
  assert.equal((await h.request('/api/publishers/other-site/ab-tests/original-sources',{method:'POST'})).status,404);
  assert.equal(h.persistent(),before);assert.equal(h.r2.log.puts.length,puts);assert.equal(fetches.length,0);
});
test('a changed public file is rejected before any source or publisher write',async()=>{
  const puts=h.r2.log.puts.length;badSource=true;
  try{assert.equal((await h.request(base+'/original-sources',{method:'POST'})).status,409);assert.equal(h.r2.log.puts.length,puts);}finally{badSource=false;}
});
test('saving exact originals adds named A/B choices, preserves all publisher state and safely retries',async()=>{
  const before=h.persistent(),saved=await h.json(base+'/original-sources',{method:'POST'});
  assert.deepEqual(saved.versions.map(v=>v.id),[A,B]);assert(saved.versions.every(v=>v.sourceKind==='original-script'&&v.state==='stored'));
  assert.equal(saved.versions[0].runtimeVersion,'build 20260813_125447');assert.equal(saved.versions[1].runtimeVersion,'3.25.0');
  const objects=new Map([...h.r2.objects].map(([k,v])=>[k,digest(v.bytes)])),count=fetches.length;
  await h.json(base+'/original-sources',{method:'POST'});assert.equal(fetches.length,count);
  for(const[k,sha]of objects)assert.equal(digest(h.r2.objects.get(k).bytes),sha);
  const list=await h.json(base);assert.equal(list.current,null);assert.equal(list.versions.length,4);assert.equal(list.tests.length,0);
  assert.equal(h.persistent(),before);assert.equal(h.r2.log.deletes.length,0);
});
test('dry check is explicit about unknown settings and forbids mixing generated/original/foreign sources',async()=>{
  const body={a:A,b:B,name:'Original scripts',testId:'politika_original_1',trafficBPercent:50,reportingKey:'VersionId'},before=h.r2.log.puts.length;
  const check=await h.json(base+'/check',{method:'POST',body});assert.equal(check.compatible,true);
  assert(check.warnings.some(w=>/full Config snapshots are unavailable/.test(w.message)));assert(!check.checks.some(c=>c.check==='consent'));
  assert.equal(check.arms.A.runtimeVersion,'build 20260813_125447');assert.equal(h.r2.log.puts.length,before);
  const mixed=await h.json(base+'/check',{method:'POST',body:{...body,b:h.versions.politika[0]}});assert.equal(mixed.compatible,false);assert.equal(mixed.refusal.code,'source-types-differ');
  assert.equal((await h.request('/api/publishers/other-site/ab-tests',{method:'POST',body})).status,422);
  assert.equal((await checkAbCompatibility({site:'other-site',a:await readOriginalSource(h.r2.bucket,'politika',A),b:await readOriginalSource(h.r2.bucket,'politika',B)})).compatible,false);
});
test('new test saves, retries, downloads exact originals and correctly exposes VersionId, without publishing',async()=>{
  const before=h.persistent(),body={a:A,b:B,name:'Original scripts',testId:'politika_original_1',trafficBPercent:50,reportingKey:'VersionId'};
  const saved=await h.json(base,{method:'POST',body},201),retry=await h.json(base,{method:'POST',body});assert.equal(saved.record.id,retry.record.id);assert.equal(retry.created,false);
  assert.equal(saved.record.loader.version,'1.3.0');assert.deepEqual(abGamIdentity(saved.record),{key:'VersionId',value:body.testId,label:'Version ID'});
  const response=await h.request(base+'/'+saved.record.id+'/download'),archive=new Uint8Array(await response.arrayBuffer()),files=unzipSync(archive);
  assert.equal(digest(archive),saved.record.bundle.zipSha256);
  for(const side of ['A','B'])assert.deepEqual(files[saved.record.arms[side].path],bytes[ORIGINAL_SOURCES.find(s=>s.side===side).url]);
  assert.match(new TextDecoder().decode(files['README.txt']),/Keep the existing CMP, GPT, Prebid.js/);assert.equal(files['prebid.js'],undefined);
  assert.equal(h.persistent(),before);
});
test('same-source A/A is allowed, but modified stored bytes fail check/save and appear unavailable',async()=>{
  const a=await readOriginalSource(h.r2.bucket,'politika',A),bundle=await composeAbBundle({site:'politika',a,b:a,name:'A/A',testId:'politika_aa',trafficBPercent:50});
  assert.equal(Object.keys(bundle.files).filter(k=>k.endsWith('/ads.js')).length,1);
  const key=`original-script-sources/v1/politika/${A}/ads.js`,row=h.r2.objects.get(key),old=row.bytes;
  row.bytes=new Uint8Array(old);row.bytes[0]^=1;
  try{
    assert.equal((await listOriginalSources(h.r2.bucket,'politika'))[0].state,'unavailable');
    const body={a:A,b:B,name:'Tampered',testId:'tampered',trafficBPercent:50};
    for(const path of [base+'/check',base])assert.equal((await h.request(path,{method:'POST',body})).status,503);
  }finally{row.bytes=old;}
});
test('concurrent and interrupted saves preserve the first manifest and recover missing records',async()=>{
  const r=memoryR2({prefix:''});let once=true;
  r.faults.beforePut=key=>{if(once&&key.endsWith('/manifest.json')){once=false;throw Error('storage offline');}};
  await assert.rejects(saveOriginalSources(r.bucket,'politika','first@example.invalid'));
  r.faults.beforePut=null;
  await Promise.all([saveOriginalSources(r.bucket,'politika','one@example.invalid'),saveOriginalSources(r.bucket,'politika','two@example.invalid')]);
  assert.equal((await listOriginalSources(r.bucket,'politika')).length,2);assert.equal(r.objects.size,4);
  const before=[...r.objects].map(([k,v])=>[k,digest(v.bytes)]);
  await saveOriginalSources(r.bucket,'politika','third@example.invalid');for(const[k,sha]of before)assert.equal(digest(r.objects.get(k).bytes),sha);
});
