import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { handleArtifactBundle } from '../../worker/runtime/artifact-bundle-service.mjs';
import { runtimeDescriptor } from '../../worker/runtime/builtin-preview-service.mjs';
import { digest } from '../../worker/runtime/preview-snapshot.mjs';
import { fixture, configure, checkedFixture, takeOver } from './artifact-fixture.mjs';
const base='https://preview.example.invalid/api/publishers/test-site/builtin-runtime-bundle';
async function setup(prebidEnabled = true) {
  const snapshot=configure(fixture(),(c)=>{c.enablePrebid=prebidEnabled;});
  const prebid=await checkedFixture(snapshot);const builds=prebid?[prebid.build]:[];let reads=0,storageReads=0;
  const env={ DB:{ prepare(sql){assert.match(sql,/^SELECT /);assert.doesNotMatch(sql,/UPDATE|INSERT|DELETE|CREATE|ALTER/i);return{bind(id){assert.equal(id,'test-site');return{sql};}};},
    async batch(statements){reads++;assert.equal(statements.length,8);return structuredClone([[snapshot.site],[snapshot.config],snapshot.units,snapshot.bidders,snapshot.overrides,snapshot.maps,snapshot.rules,builds].map(results=>({success:true,results})));}},
    get BUILDS(){if(!prebidEnabled)assert.fail('GPT-only cannot read R2');return bucket;}
  };
  const bucket={async get(key){storageReads++;assert.equal(key,builds[0].file_key);return prebid.object;},put(){assert.fail('No writes');},delete(){assert.fail('No deletions');}};
  const body={reviewHash:await digest(snapshot),runtimeVersion:runtimeDescriptor.version,runtimeSha256:runtimeDescriptor.codeSha256,allowPreview:true,takeOver:takeOver()};
  const req=(changes={})=>new Request(base,{method:'POST',headers:{'content-type':'application/json',origin:'https://preview.example.invalid'},body:JSON.stringify({...body,...changes})});
  return{env,snapshot,prebid,builds,bucket,body,req,reads:()=>reads,storageReads:()=>storageReads,run:(changes={})=>handleArtifactBundle(req(changes),env,'test-site')};
}
test('bundle returns a real ZIP and does not save any release or send requests',async()=>{
  const f=await setup();const originalFetch=globalThis.fetch;globalThis.fetch=()=>assert.fail('No external network');
  try{const res=await f.run();assert.equal(res.status,200,await res.clone().text());assert.equal(f.reads(),2);assert.equal(f.storageReads(),1);
    assert.equal(res.headers.get('x-tessera-site-id'),'test-site');assert.match(res.headers.get('cache-control'),/no-store/);
    const files=unzipSync(new Uint8Array(await res.arrayBuffer()));assert(files['prebid.js']);const manifest=JSON.parse(new TextDecoder().decode(files['manifest.json']));assert.equal(manifest.completeRelease,false);assert.equal(manifest.prebidBuild.sha256,f.prebid.report.build.sha256);
  }finally{globalThis.fetch=originalFetch;}
});
test('GPT-only bundle never reads a Prebid artifact',async()=>{
  const f=await setup(false);const res=await f.run();assert.equal(res.status,200);assert.equal(f.storageReads(),0);const files=unzipSync(new Uint8Array(await res.arrayBuffer()));assert(!files['prebid.js']);
});
test('malformed and unacknowledged requests cause no datastore reads',async()=>{
  const f=await setup();assert.equal((await f.run({allowPreview:false})).status,422);assert.equal(f.reads(),0);
  assert.equal((await f.run({source:'browser supplied'})).status,422);assert.equal(f.reads(),0);
});
test('unknown runtime hash is rejected before storage',async()=>{
  const f=await setup();assert.equal((await f.run({runtimeSha256:'0'.repeat(64)})).status,409);assert.equal(f.reads(),0);
});
test('a second tab changing settings refuses the old preview',async()=>{
  const f=await setup();f.snapshot.site.name='Changed';assert.equal((await f.run()).status,409);assert.equal(f.storageReads(),0);
});
test('changed current build during read is rejected after generation',async()=>{
  const f=await setup();const get=f.bucket.get;f.bucket.get=async(key)=>{const value=await get(key);f.builds[0].version='11.12.0';return value;};
  assert.equal((await f.run()).status,409);
});
test('Prebid byte corruption blocks bundle output',async()=>{
  const f=await setup();new Uint8Array(f.prebid.bytes)[0]=0;assert.equal((await f.run()).status,422);
});
test('an oversized artifact is not read into memory',async()=>{
  const f=await setup();f.prebid.object.size=8*1024*1024+1;f.prebid.object.arrayBuffer=()=>assert.fail('Must not load body');assert.equal((await f.run()).status,422);
});
test('missing current Prebid build has an explicit action-needed error',async()=>{
  const f=await setup();f.builds.splice(0);const res=await f.run();assert.equal(res.status,422);assert.match((await res.json()).error,/Check Prebid file/);
});
test('body over 24 KB is refused without reads',async()=>{
  const f=await setup();const res=await handleArtifactBundle(new Request(base,{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(24001)}),f.env,'test-site');assert.equal(res.status,400);assert.equal(f.reads(),0);
});
test('GET and wrong content type do not generate a candidate',async()=>{
  const f=await setup();assert.equal((await handleArtifactBundle(new Request(base),f.env,'test-site')).status,405);
  assert.equal((await handleArtifactBundle(new Request(base,{method:'POST',body:'x'}),f.env,'test-site')).status,415);assert.equal(f.reads(),0);
});
test('unsupported size-map height is not silently omitted from bundle',async()=>{
  const f=await setup();f.snapshot.maps[0].map_json='[{"minViewPort":[0,200],"sizes":[[300,250]]}]';f.body.reviewHash=await digest(f.snapshot);assert.equal((await f.run()).status,422);
});
