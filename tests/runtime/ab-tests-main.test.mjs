import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {createHash} from 'node:crypto';
import {mainAbFixture} from '../support/ab-tests-main-fixture.mjs';
import {build} from 'esbuild';
const alpha='/api/publishers/alpha-site/ab-tests',beta='/api/publishers/beta-site/ab-tests';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let h,originalFetch;
test.before(async()=>{originalFetch=globalThis.fetch;globalThis.fetch=()=>assert.fail('No outbound traffic');h=await mainAbFixture();});
test.after(()=>{h?.close();globalThis.fetch=originalFetch;});
const body=(testId)=>({a:h.versions['alpha-site'][0],b:h.versions['alpha-site'][1],trafficBPercent:50,testId,name:'MAIN experiment'});
const get=async(path,options)=>{const response=await h.request(path,options);return {status:response.status,value:await response.json(),headers:response.headers};};

test('MAIN lists only this site stored 3.25.1 releases and its production control without writes',async()=>{
 const before=h.persistent(),puts=h.r2.log.puts.length,{status,value,headers}=await get(alpha);
 assert.equal(status,200);assert.equal(value.testOnly,false);assert.equal(value.site,'alpha-site');assert.equal(value.current,h.versions['alpha-site'][0]);
 assert.deepEqual(new Set(value.versions.map(row=>row.id)),new Set(h.versions['alpha-site']));
 assert(value.versions.every(row=>row.runtimeVersion==='3.25.1'&&row.state==='stored'));assert.match(headers.get('cache-control'),/no-store/);
 assert.equal(h.persistent(),before);assert.equal(h.r2.log.puts.length,puts);
});
test('no production means manual control choice, not the newest draft',async()=>{
 const result=await get(beta);assert.equal(result.status,200);assert.equal(result.value.current,null);assert.equal(result.value.versions.length,2);
 assert(result.value.versions.every(row=>h.versions['beta-site'].includes(row.id)));
});
test('authentication and explicit same-origin mutation gates precede any storage write',async()=>{
 const before=h.persistent(),puts=h.r2.log.puts.length;assert.equal((await get(alpha,{auth:false})).status,401);
 for(const method of ['POST','PUT','DELETE'])for(const origin of [null,'https://foreign.example.invalid']){
  const path=method==='POST'?alpha:alpha+'/abx-'+'a'.repeat(64);
  assert.equal((await get(path,{method,origin,body:{}})).status,403);
 }
 assert.equal(h.persistent(),before);assert.equal(h.r2.log.puts.length,puts);
});
test('unknown sites, malformed nested paths and unsupported methods do not fall through or write',async()=>{
 const puts=h.r2.log.puts.length;
 assert.equal((await get('/api/publishers/missing-site/ab-tests')).status,404);
 for(const path of [alpha+'/not-an-id',alpha+'/check/extra',alpha+'/abx-'+'a'.repeat(64)+'/download/extra'])assert.equal((await get(path)).status,404);
 const response=await h.request(alpha,{method:'PATCH'});assert.equal(response.status,405);assert.match(response.headers.get('allow'),/GET/);
 assert.equal(h.r2.log.puts.length,puts);
});
test('Check reads full verified arm bytes and never changes config, audit, channels or R2',async()=>{
 const before=h.persistent(),puts=h.r2.log.puts.length,gets=h.r2.log.gets.length;
 const result=await get(alpha+'/check',{method:'POST',body:body('dry_run')});assert.equal(result.status,200);assert.equal(result.value.compatible,true);
 assert(result.value.configDiff.some(row=>row.field.startsWith('timeouts')));
 assert(h.r2.log.gets.slice(gets).some(key=>key.endsWith('/ads.min.js')));assert.equal(h.persistent(),before);assert.equal(h.r2.log.puts.length,puts);
});
test('foreign-site releases and TEST draft IDs cannot enter a MAIN experiment',async()=>{
 const before=h.persistent(),puts=h.r2.log.puts.length,foreign={...body('foreign'),b:h.versions['beta-site'][0]};
 const check=await get(alpha+'/check',{method:'POST',body:foreign});assert.equal(check.status,200);assert.equal(check.value.compatible,false);
 assert.equal((await get(alpha,{method:'POST',body:foreign})).status,422);
 assert.notEqual((await get(alpha,{method:'POST',body:{...body('draft'),a:'builtin-draft-'+'b'.repeat(64)}})).status,201);
 assert.equal(h.persistent(),before);assert.equal(h.r2.log.puts.length,puts);
});
test('a corrupt actual arm blocks both Check and Save before any experiment object is written',async()=>{
 const key=`publishers/alpha-site/releases/${h.versions['alpha-site'][0]}/ads.min.js`,stored=h.r2.objects.get(key),original=stored.bytes.slice(),puts=h.r2.log.puts.length;
 try{stored.bytes=new TextEncoder().encode('changed arm');for(const path of [alpha+'/check',alpha])assert([409,503].includes((await get(path,{method:'POST',body:body('corrupt')})).status));assert.equal(h.r2.log.puts.length,puts);}
 finally{stored.bytes=original;}
});
test('Save/retry is idempotent and preserves every source byte and all D1 application state',async()=>{
 const before=h.persistent(),sources=new Map([...h.r2.objects].filter(([key])=>key.startsWith('publishers/')).map(([key,row])=>[key,hash(row.bytes)]));
 const first=await get(alpha,{method:'POST',body:body('main_saved')});assert.equal(first.status,201);assert.equal(first.value.created,true);
 const retry=await get(alpha,{method:'POST',body:body('main_saved')});assert.equal(retry.status,200);assert.equal(retry.value.created,false);assert.deepEqual(retry.value.record,first.value.record);
 assert.equal(retry.value.recordSha256,first.value.recordSha256);assert.equal(h.persistent(),before);
 for(const[key,digest]of sources)assert.equal(hash(h.r2.objects.get(key).bytes),digest,key);
 const writes=h.r2.log.puts.filter(key=>key.startsWith('site-experiments/'));assert(writes.length);assert(writes.every(key=>key.startsWith('site-experiments/v1/alpha-site/')));
});
test('downloaded ZIP/record hashes and embedded immutable arm bytes match their saved records',async()=>{
 const item=(await get(alpha)).value.tests.find(row=>row.testId==='main_saved'),detail=(await get(alpha+'/'+item.id)).value;
 const response=await h.request(alpha+'/'+item.id+'/download'),bytes=new Uint8Array(await response.arrayBuffer());assert.equal(response.status,200);
 assert.equal(hash(bytes),item.zipSha256);assert.equal(hash(bytes),response.headers.get('x-package-sha256'));const files=unzipSync(bytes);
 for(const side of ['A','B']){const arm=detail.record.arms[side],saved=h.r2.objects.get(`publishers/alpha-site/releases/${arm.release}/ads.min.js`).bytes;assert.deepEqual(files[arm.path],saved);assert.equal(hash(files[arm.path]),arm.sha256);}
 const recordResponse=await h.request(alpha+'/'+item.id+'/record'),record=new Uint8Array(await recordResponse.arrayBuffer());assert.equal(hash(record),detail.recordSha256);assert.equal(hash(record),recordResponse.headers.get('x-record-sha256'));assert.deepEqual(JSON.parse(new TextDecoder().decode(record)),detail.record);
});
test('a known experiment ID grants no read/download/event/delete access through another site',async()=>{
 const item=(await get(alpha)).value.tests.find(row=>row.testId==='main_saved');
 for(const suffix of ['', '/download','/record'])assert.equal((await get(beta+'/'+item.id+suffix)).status,404);
 assert.equal((await get(beta+'/'+item.id+'/events',{method:'POST',body:{type:'marked-live'}})).status,404);
 assert.equal((await get(beta+'/'+item.id,{method:'DELETE',body:{confirmId:item.id,sha256:item.zipSha256}})).status,404);
 assert.equal((await get(beta)).value.tests.length,0);
});
test('mark live/stopped and trash/restore are audit-only and cannot activate or change delivery',async()=>{
 const item=(await get(alpha)).value.tests.find(row=>row.testId==='main_saved'),before=h.persistent();
 for(const type of ['marked-live','marked-stopped'])assert.equal((await get(alpha+'/'+item.id+'/events',{method:'POST',body:{type}})).status,201);
 const confirm={confirmId:item.id,sha256:item.zipSha256};assert.equal((await get(alpha+'/'+item.id,{method:'DELETE',body:confirm})).status,200);
 assert((await get(alpha)).value.deleted.some(row=>row.id===item.id));assert.equal((await h.request(alpha+'/'+item.id+'/download')).status,200);
 assert.equal((await get(alpha+'/'+item.id,{method:'PUT',body:confirm})).status,200);assert.equal(h.persistent(),before);
});
test('ambiguous production state fails instead of guessing control A',async()=>{
 const id=h.versions['alpha-site'][1];h.f.sqlite.prepare("UPDATE releases SET status='production' WHERE id=?").run(id);
 try{assert.equal((await get(alpha)).status,409);}finally{h.f.sqlite.prepare("UPDATE releases SET status='draft' WHERE id=?").run(id);}
});


test('the compiled MAIN Worker preserves authenticated API, exact saved bytes and mutation isolation',async()=>{
 const built=await build({entryPoints:['worker/app-builtin-runtime-preview.ts'],bundle:true,write:false,format:'esm',platform:'node',minify:true});
 const compiled=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
 const f=await mainAbFixture({workerOverride:compiled.default});
 try{
  const before=f.persistent(),state=await f.json(alpha);
  assert.equal(state.current,f.versions['alpha-site'][0]);assert.equal(state.versions.length,2);
  const values={name:'Compiled MAIN test',testId:'compiled_main',trafficBPercent:50,a:f.versions['alpha-site'][0],b:f.versions['alpha-site'][1]};
  const checked=await f.json(alpha+'/check',{method:'POST',body:values});assert.equal(checked.compatible,true);
  const created=await f.json(alpha,{method:'POST',body:values},201);
  const response=await f.request(alpha+'/'+created.record.id+'/download');assert.equal(response.status,200);
  const archive=new Uint8Array(await response.arrayBuffer());assert.equal(hash(archive),created.record.bundle.zipSha256);
  const files=unzipSync(archive);
  for(const arm of Object.values(created.record.arms))assert.deepEqual(files[arm.path],f.r2.objects.get(`publishers/alpha-site/releases/${arm.release}/ads.min.js`).bytes);
  assert.equal((await f.request(alpha,{auth:false})).status,401);
  assert.equal((await f.request(alpha,{method:'POST',origin:'https://foreign.example.invalid',body:values})).status,403);
  assert.equal((await f.request(beta+'/'+created.record.id+'/download')).status,404);
  assert.equal(f.persistent(),before);
 }finally{f.close();}
});
