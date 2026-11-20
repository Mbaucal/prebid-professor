import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {memoryR2} from '../support/memory-r2.mjs';
import {syntheticDraft} from '../support/ab-synthetic-drafts.mjs';
import {composeAbBundle} from '../../worker/experiments/ab-bundle.mjs';
import {abPrefix,abSummary,createAbTest,readAbZip,changeAbTestDeletion} from '../../worker/experiments/ab-store.mjs';

const site='test-site',prefix=abPrefix(site),actor={email:'tester@example.invalid'};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const encode=new TextEncoder();
let a,b;
test.before(async()=>{
  a=await syntheticDraft({runtimeVersion:'9.0.0',script:'window.arm="A";',note:'Control'});
  b=await syntheticDraft({runtimeVersion:'9.0.1',script:'window.arm="B";',note:'Candidate'});
});
const input=()=>({site,actor,a,b,name:'Upgrade retry',testId:'upgrade_retry',trafficBPercent:50});
async function oldSave(){
  const r2=memoryR2(),bundle=await composeAbBundle({...input(),loaderVersion:'1.0.1'});
  const record={...bundle.record,createdBy:actor.email,createdAt:'2026-11-18T00:00:00.000Z'};
  async function put(key,bytes,kind,metadata={}){
    const sha256=hash(bytes);
    await r2.bucket.put(prefix+key,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),sha256,
      httpMetadata:{cacheControl:'private, no-store'},customMetadata:{kind,sha256,...metadata}});
  }
  await put(`test-ids/${record.testId}.json`,encode.encode(JSON.stringify({schemaVersion:1,site,testId:record.testId,id:record.id})),'ab-test-id');
  for(const [path,bytes]of Object.entries(bundle.files))await put(`files/${record.id}/${path}`,bytes,'ab-bundle-file');
  await put(`zips/${record.id}.zip`,bundle.zip,'ab-bundle-zip',{zipByteSize:String(bundle.zip.length)});
  await put(`records/${record.id}.json`,encode.encode(JSON.stringify(record)),'ab-test-record',{summary:JSON.stringify(abSummary(record))});
  return {r2,bundle,record};
}
const snapshot=r2=>[...r2.objects].map(([key,value])=>[key,hash(value.bytes),value.etag]);
async function refuses(promise,code){
  await assert.rejects(promise,error=>error.status===409&&error.code===code);
}

test('a lost Save reply followed by a loader upgrade returns the exact committed old test without any write',async()=>{
  const {r2,bundle,record}=await oldSave(),before=snapshot(r2),puts=r2.log.puts.length;
  const current=await composeAbBundle(input());assert.notEqual(current.id,record.id);assert.notEqual(current.record.loader.version,record.loader.version);
  r2.faults.list=()=>{throw Error('A completed retry must not need quota admission');};
  const result=await createAbTest(r2.bucket,input());
  assert.equal(result.created,false);assert.deepEqual(result.record,record);assert.equal(result.deletedAt,null);
  assert.equal(r2.log.puts.length,puts);assert.deepEqual(snapshot(r2),before);
  assert.deepEqual((await readAbZip(r2.bucket,site,record.id)).bytes,bundle.zip);
});

test('cross-version recovery preserves trash state and never restores or rewrites a saved ZIP',async()=>{
  const {r2,record}=await oldSave();
  await changeAbTestDeletion(r2.bucket,site,record.id,actor,{confirmId:record.id,sha256:record.bundle.zipSha256},true);
  const before=snapshot(r2),puts=r2.log.puts.length,deletes=r2.log.deletes.length;
  const result=await createAbTest(r2.bucket,input());
  assert.equal(result.created,false);assert(result.deletedAt);assert.deepEqual(result.record,record);
  assert.equal(r2.log.puts.length,puts);assert.equal(r2.log.deletes.length,deletes);assert.deepEqual(snapshot(r2),before);
});

test('changed operator choices retain their TestId conflict and cannot be mistaken for loader upgrade recovery',async()=>{
  const {r2}=await oldSave(),before=snapshot(r2),puts=r2.log.puts.length;
  for(const changes of [{name:'Different test'},{trafficBPercent:25},{a:b,b:a},{b:a}]){
    await refuses(createAbTest(r2.bucket,{...input(),...changes}),'testid-taken');
  }
  assert.equal(r2.log.puts.length,puts);assert.deepEqual(snapshot(r2),before);
});

test('an incomplete older save remains reserved and a corrupt older ZIP cannot be reported as recovered',async()=>{
  const first=await oldSave();first.r2.objects.delete(prefix+'records/'+first.record.id+'.json');
  const puts=first.r2.log.puts.length;
  await refuses(createAbTest(first.r2.bucket,input()),'testid-taken');assert.equal(first.r2.log.puts.length,puts);
  const second=await oldSave(),zip=second.r2.objects.get(prefix+'zips/'+second.record.id+'.zip');zip.bytes[zip.bytes.length-1]^=1;
  const before=snapshot(second.r2),secondPuts=second.r2.log.puts.length;
  await refuses(createAbTest(second.r2.bucket,input()),'zip-unverified');
  assert.equal(second.r2.log.puts.length,secondPuts);assert.deepEqual(snapshot(second.r2),before);
});
