import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {abGamIdentity} from '../../worker/experiments/ab-bundle.mjs';
import {mainAbFixture} from '../support/ab-tests-main-fixture.mjs';

const base='/api/publishers/alpha-site/ab-tests';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let h,fetchBefore;
test.before(async()=>{fetchBefore=globalThis.fetch;globalThis.fetch=()=>assert.fail('No external traffic');h=await mainAbFixture();});
test.after(()=>{h?.close();globalThis.fetch=fetchBefore;});
const input=id=>({a:h.versions['alpha-site'][0],b:h.versions['alpha-site'][1],name:'Published package',testId:id,trafficBPercent:50});

test('legacy API requests keep their loader and GAM identity',async()=>{
  const value=await h.json(base,{method:'POST',body:input('legacy_package')},201);
  assert.equal(value.record.loader.version,'1.1.1');
  assert.deepEqual(abGamIdentity(value.record),{key:'TestId',value:'legacy_package',label:'Version ID'});
});

test('explicit VersionId passes actual MAIN check/save/retry without changing source packages or application state',async()=>{
  const body={...input('published_version'),reportingKey:'VersionId'},state=h.persistent();
  const sources=new Map([...h.r2.objects].filter(([key])=>key.startsWith('publishers/')).map(([key,row])=>[key,hash(row.bytes)]));
  const puts=h.r2.log.puts.length,check=await h.json(base+'/check',{method:'POST',body});
  assert.equal(check.compatible,true);assert.equal(h.r2.log.puts.length,puts);
  const saved=await h.json(base,{method:'POST',body},201);
  assert.equal(saved.record.loader.version,'1.2.0');
  assert.deepEqual(abGamIdentity(saved.record),{key:'VersionId',value:'published_version',label:'Version ID'});
  const after=h.r2.log.puts.length,retry=await h.json(base,{method:'POST',body});
  assert.equal(retry.created,false);assert.deepEqual(retry.record,saved.record);
  assert.equal(retry.recordSha256,saved.recordSha256);assert.equal(h.r2.log.puts.length,after);
  assert.equal(h.persistent(),state);
  for(const [key,digest] of sources)assert.equal(hash(h.r2.objects.get(key).bytes),digest,key);
});

test('requesting the new key cannot rewrite an existing legacy package or its reserved ID',async()=>{
  const before=await h.json(base),legacy=before.tests.find(row=>row.testId==='legacy_package');
  const detail=await h.json(base+'/'+legacy.id),puts=h.r2.log.puts.length;
  const result=await h.json(base,{method:'POST',body:{...input('legacy_package'),reportingKey:'VersionId'}});
  assert.equal(result.created,false);assert.deepEqual(result.record,detail.record);
  assert.deepEqual(abGamIdentity(result.record),{key:'TestId',value:'legacy_package',label:'Version ID'});
  assert.equal(h.r2.log.puts.length,puts);
});

test('unsupported GAM identity keys and untrusted origins refuse before writing any package',async()=>{
  const state=h.persistent(),puts=h.r2.log.puts.length;
  for(const endpoint of [base,base+'/check']){
    const r=await h.request(endpoint,{method:'POST',body:{...input('invalid_key'),reportingKey:'versionid'}});
    assert.equal(r.status,400);assert.match((await r.json()).error,/identity|reporting|VersionId/i);
  }
  const foreign=await h.request(base,{method:'POST',origin:'https://foreign.example.invalid',body:{...input('foreign_key'),reportingKey:'VersionId'}});
  assert.equal(foreign.status,403);assert.equal(h.r2.log.puts.length,puts);assert.equal(h.persistent(),state);
});
