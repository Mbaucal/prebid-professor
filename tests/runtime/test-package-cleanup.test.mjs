import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
import {initializeTestSchema,inspectTestSchema} from '../../worker/test-workspace/schema.mjs';
import {cleanupState,clearPackages} from '../../worker/test-workspace/package-cleanup.mjs';
import {saveDraftRelease} from '../../worker/runtime/draft-release-store.mjs';
import {buildArtifactCandidate} from '../../worker/runtime/artifact-candidate.mjs';
import {fixture,configure,pin,TS,takeOver} from './artifact-fixture.mjs';
import {sha256} from '../../worker/runtime/prebid-artifact-check.mjs';
const snapshot=configure(fixture(),c=>{c.enablePrebid=false;});
const base=await buildArtifactCandidate({snapshot,pin:pin(),prebid:null,takeOver:takeOver(),buildTimestamp:TS});
async function candidate(n){const c=structuredClone(base),encode=new TextEncoder();c.files['README.txt']=encode.encode('Synthetic cleanup package '+n);
 const m=JSON.parse(new TextDecoder().decode(c.files['manifest.json']));m.files['README.txt']={byteSize:c.files['README.txt'].length,sha256:await sha256(c.files['README.txt'])};c.files['manifest.json']=encode.encode(JSON.stringify(m));return c;}
async function setup(t){const f=workspaceStore();t.after(()=>f.close());await initializeTestSchema(f.env.DB,TEST_EMAIL);
 f.env.BUILDS.delete=async keys=>{for(const key of keys)f.objects.delete(key);};f.env.BUILDS.head=async key=>f.objects.has(key)?{key}:null;
 f.save=async(n)=>saveDraftRelease({isolation:'explicit-test-store',db:f.env.DB,bucket:f.env.BUILDS},{siteId:'test-site',candidate:await candidate(n),actor:TEST_EMAIL});
 f.clear=async()=>clearPackages(f.env,TEST_EMAIL,{revision:(await cleanupState(f.env)).revision,acknowledge:true});return f;}
test('20-package limit is freed and a new package saves; settings, Prebid and deployment copies survive',async t=>{
 const f=await setup(t);for(let n=0;n<20;n++)await f.save(n);
 await assert.rejects(f.save(20),/TEST_DRAFT_QUOTA/);
 const before=f.sqlite.prepare('SELECT * FROM publisher_configs').all();const publishers=f.sqlite.prepare('SELECT * FROM publishers').all();
 f.objects.set('test-deployments/v1/packages/preserved.zip',new Uint8Array([7]));f.objects.set('publishers/test-site/prebid-builds/preserved/prebid.js',new Uint8Array([8]));
 const r=await f.clear();assert.equal(r.deleted,20);assert.equal(r.count,0);assert.equal(r.pending,0);assert.equal(f.objects.size,2);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM publisher_configs').all(),before);assert.deepEqual(f.sqlite.prepare('SELECT * FROM publishers').all(),publishers);
 assert.equal((await inspectTestSchema(f.env.DB)).ready,true);await f.save(21);assert.equal((await cleanupState(f.env)).count,1);
});
test('stale preview and missing acknowledgement cannot delete any packages',async t=>{
 const f=await setup(t);await f.save(1);const s=await cleanupState(f.env);await f.save(2);
 await assert.rejects(clearPackages(f.env,TEST_EMAIL,{revision:s.revision,acknowledge:true}),/list changed/);
 await assert.rejects(clearPackages(f.env,TEST_EMAIL,{revision:(await cleanupState(f.env)).revision}),/Confirm/);assert.equal((await cleanupState(f.env)).count,2);
});
test('storage failure frees quota with persistent retry, then exact file cleanup succeeds',async t=>{
 const f=await setup(t);await f.save(1);const remove=f.env.BUILDS.delete;f.env.BUILDS.delete=async()=>{throw Error('R2 unavailable');};
 let r=await f.clear();assert.equal(r.count,0);assert.equal(r.pending,1);assert(f.objects.size>0);
 f.env.BUILDS.delete=remove;r=await f.clear();assert.equal(r.deleted,0);assert.equal(r.pending,0);assert.equal(f.objects.size,0);
});
test('failed SQL transaction leaves both data and files intact',async t=>{
 const f=await setup(t);await f.save(1);const bytes=f.objects.size;f.faults.batchAt=3;
 await assert.rejects(f.clear(),/injected schema failure/);assert.equal(f.objects.size,bytes);assert.equal((await cleanupState(f.env)).count,1);assert.equal((await cleanupState(f.env)).pending,0);
});
test('old Save retries cannot recreate a deleted package or write its files',async t=>{
 const f=await setup(t);await f.save(1);await f.clear();const writes=f.log.puts.length;
 await assert.rejects(f.save(1),/reservation/);assert.equal(f.log.puts.length,writes);assert.equal((await cleanupState(f.env)).count,0);
});
test('a Save already waiting to register cannot resurrect a concurrently deleted package',async t=>{
 const f=await setup(t);await f.save(1);const batch=f.env.DB.batch;let race=true;
 f.env.DB.batch=async statements=>{if(race&&statements.some(s=>s.sql.startsWith('INSERT INTO releases'))){race=false;await f.clear();}return batch(statements);};
 await assert.rejects(f.save(1));assert.equal((await cleanupState(f.env)).count,0);assert.equal(f.objects.size,0);
});
test('a forged descriptor cannot expand deletion outside the saved package',async t=>{
 const f=await setup(t);await f.save(1);const row=f.sqlite.prepare('SELECT descriptor_json FROM builtin_draft_uploads').get();
 const d=JSON.parse(row.descriptor_json);d.files[0].name='../../prebid.js';f.sqlite.prepare('UPDATE builtin_draft_uploads SET descriptor_json=?').run(JSON.stringify(d));
 await assert.rejects(f.clear(),/file inventory/);assert(f.objects.size>0);
});
test('incomplete upload is retained while stored packages can be cleared',async t=>{
 const f=await setup(t);await f.save(1);f.faults.putName='ads.js';await assert.rejects(f.save(2));f.faults.putName='';
 const r=await f.clear();assert.equal(r.deleted,1);assert.equal(r.protectedCount,1);assert.equal(r.count,1);
});
test('an active release reference prevents deletion',async t=>{
 const f=await setup(t);const saved=await f.save(1);f.sqlite.prepare('UPDATE publishers SET current_release_id=?').run(saved.draft.id);
 await assert.rejects(f.clear(),/active package/);assert(f.objects.size>0);
});
test('cleanup endpoint requires existing TEST login, same origin and exact scope',async t=>{
 const f=await setup(t);await f.save(1);
 const post=(headers={},body={})=>new Request(ORIGIN+'/test-api/package-cleanup',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await worker.fetch(post(),f.env)).status,401);
 const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal((await worker.fetch(post({cookie,origin:'https://foreign.invalid'}),f.env)).status,403);
 let response=await worker.fetch(new Request(ORIGIN+'/test-api/package-cleanup',{headers:{cookie}}),f.env);assert.equal(response.status,200);const s=await response.json();
 assert.equal((await worker.fetch(post({cookie},{revision:s.revision,acknowledge:true,siteId:'politika'}),f.env)).status,422);
 response=await worker.fetch(post({cookie},{revision:s.revision,acknowledge:true}),f.env);assert.equal(response.status,200);assert.equal((await response.json()).count,0);
});
