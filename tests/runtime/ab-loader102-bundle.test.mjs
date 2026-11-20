import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {syntheticDraft} from '../support/ab-synthetic-drafts.mjs';
import {memoryR2} from '../support/memory-r2.mjs';
import {describeCandidate} from '../../worker/runtime/draft-release-store.mjs';
import {checkAbCompatibility,composeAbBundle} from '../../worker/experiments/ab-bundle.mjs';
import {abPrefix,abSummary,readAbTest,readAbZip} from '../../worker/experiments/ab-store.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),encode=new TextEncoder();
const input=async()=>({site:'guard-site',a:await syntheticDraft({siteId:'guard-site'}),b:await syntheticDraft({siteId:'guard-site',runtimeVersion:'9.0.1',script:'window.arm="B";'}),name:'Startup guard',testId:'guard_1',trafficBPercent:50});

test('new bundle identity explicitly selects 1.0.2 while legacy 1.0.1 keeps its own identity',async()=>{
  const value=await input(),current=await composeAbBundle(value),legacy=await composeAbBundle({...value,loaderVersion:'1.0.1'});
  assert.equal(current.record.loader.version,'1.0.2');assert.equal(legacy.record.loader.version,'1.0.1');
  assert.notEqual(current.id,legacy.id);assert.notEqual(current.zipSha256,legacy.zipSha256);
  assert.deepEqual(current.files[current.record.arms.A.path],legacy.files[legacy.record.arms.A.path]);
  await assert.rejects(composeAbBundle({...value,loaderVersion:'unknown'}),error=>error.status===400&&error.code==='invalid-request');
});

test('1.0.2 refuses an unrecognized native startup program; explicit legacy composition is preserved',async()=>{
  const value=await input(),files={...value.b.files,'ads.min.js':encode.encode('/* if(window.__TESSERA_RUNTIME_STARTED)return; */window.arm="B";')};
  const manifest=JSON.parse(new TextDecoder().decode(files['manifest.json']));
  manifest.files['ads.min.js']={byteSize:files['ads.min.js'].length,sha256:hash(files['ads.min.js'])};
  files['manifest.json']=encode.encode(JSON.stringify(manifest));
  const {descriptor}=await describeCandidate(value.site,{files});
  value.b={files,release:{...value.b.release,id:descriptor.releaseId}};
  const checked=await checkAbCompatibility(value);
  assert.equal(checked.compatible,false);assert.equal(checked.refusal.code,'startup-guard-missing');assert.equal(checked.refusal.check,'startup');
  await assert.rejects(composeAbBundle(value),error=>error.code==='startup-guard-missing');
  assert.equal((await composeAbBundle({...value,loaderVersion:'1.0.1'})).record.loader.version,'1.0.1');
});

test('existing saved 1.0.1 records and exact ZIP bytes remain readable after the default changes',async()=>{
  const value=await input(),bundle=await composeAbBundle({...value,loaderVersion:'1.0.1'}),record={...bundle.record,createdBy:'tester@example.invalid',createdAt:'2026-11-15T12:00:00.000Z'};
  const r2=memoryR2(),prefix=abPrefix(value.site);
  const put=(key,bytes,kind,extra={})=>r2.bucket.put(prefix+key,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{cacheControl:'private, no-store'},customMetadata:{kind,sha256:hash(bytes),...extra}});
  await put(`zips/${record.id}.zip`,bundle.zip,'ab-bundle-zip',{zipByteSize:String(bundle.zip.length)});
  // Use the same on-disk formats and metadata as the released store, without regenerating anything on read.
  await put(`records/${record.id}.json`,encode.encode(JSON.stringify(record)),'ab-test-record',{summary:JSON.stringify(abSummary(record))});
  assert.equal((await readAbTest(r2.bucket,value.site,record.id)).record.loader.version,'1.0.1');
  assert.deepEqual((await readAbZip(r2.bucket,value.site,record.id)).bytes,bundle.zip);
});
