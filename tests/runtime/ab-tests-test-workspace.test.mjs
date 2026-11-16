// TEST workspace: the shared A/B tests API (worker/experiments/ab-tests-api.mjs) mounted at /test-api/ab-tests in the real
// TEST Worker (worker.fetch), with saved versions generated through the TEST flow. Local SQLite and memory R2 only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
import {enableTestPrebid,selectTestRuntime} from '../support/test-bid-cache-site.mjs';
import {testAbMessage} from '../../worker/test-workspace/site-workspace.mjs';
import {composeAbBundle} from '../../worker/experiments/ab-bundle.mjs';
import {PAGES_HEADERS} from '../../shared/pages/headers.mjs';

const AB='/test-api/ab-tests',MODE='/api/publishers/test-site/prebid-mode',P='site-experiments/v1/test-site/';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fixtures=[];
test.before(()=>{globalThis.fetch=()=>assert.fail('No external request in the TEST A/B tests flow');});
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});

async function fixture({setup=true}={}){
 const f=workspaceStore({prebidFiles:true,abTests:true});fixtures.push(f);
 const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
 assert.equal(login.status,303);f.cookie=login.headers.get('set-cookie').split(';')[0];
 f.req=async(path,body,method=body===undefined?'GET':'POST',headers={})=>{
  const response=await worker.fetch(new Request(ORIGIN+path,{method,headers:{origin:ORIGIN,cookie:f.cookie,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)}),f.env);
  const bytes=new Uint8Array(await response.arrayBuffer());
  return {status:response.status,headers:response.headers,bytes,data:response.headers.get('content-type')?.includes('json')&&bytes.length?JSON.parse(new TextDecoder().decode(bytes)):null};
 };
 if(setup)assert.equal((await f.req('/test-api/setup',{confirm:'prepare-empty-test-database'})).status,200);
 return f;
}
async function generate(f,notes){
 const state=(await f.req('/test-api/site-packages')).data;
 assert.equal(state.ready,true,state.error);
 const created=await f.req('/test-api/site-packages',{action:'generate',revision:state.revision,notes});
 assert.equal(created.status,201,JSON.stringify(created.data));
 return created.data.release.id;
}
/** GAM-only, A (bid cache off) and B (bid cache on), all on 3.23.0, through the TEST Generate flow. */
async function seeded(){
 const f=await fixture(),ids={};
 await selectTestRuntime(f.req,'3.23.0',false);
 ids.gam=await generate(f,'GAM only');
 await enableTestPrebid(f.env,f.req);await selectTestRuntime(f.req,'3.23.0',true);
 ids.A=await generate(f,'Bid cache off');
 const mode=(await f.req(MODE)).data;
 assert.equal((await f.req(MODE,{enabled:true,revision:mode.revision,bidCache:{enabled:true,maxBidAgeSeconds:45}},'PUT')).status,200);
 ids.B=await generate(f,'Bid cache on');
 f.ids=ids;return f;
}
const request=(f,over={})=>({name:'Bid cache',testId:'test_site_1',a:f.ids.A,b:f.ids.B,trafficBPercent:50,...over});
const abKeys=f=>[...f.objects.keys()].filter(key=>key.startsWith('site-experiments/'));

test('the A/B routes keep sign-in, same-origin, method, query and schema boundaries',async()=>{
 const f=await fixture({setup:false});
 const item=AB+'/abx-'+'a'.repeat(64);
 // Signed in, but TEST data is not prepared yet.
 for(const [path,body,method] of [[AB],[AB+'/check',{a:'x',b:'y'}],[item]]){
  const result=await f.req(path,body,method);
  assert.equal(result.status,409,path);assert.equal(result.data.error,'Prepare TEST data first.');
 }
 assert.equal((await f.req('/test-api/setup',{confirm:'prepare-empty-test-database'})).status,200);
 const signedOut={cookie:''};
 for(const [path,body,method] of [[AB],[AB+'/check',{a:'x',b:'y'}],[item+'/download'],[item,{confirmId:'x',sha256:'y'},'DELETE']]){
  const result=await f.req(path,body,method,signedOut);
  assert.equal(result.status,401,path);assert.equal(result.data.error,'Test sign-in required.');
 }
 const before=f.log.puts.length;
 for(const [path,method] of [[AB,'POST'],[AB+'/check','POST'],[item,'PUT'],[item,'DELETE'],[item+'/events','POST']]){
  for(const headers of [{origin:'https://other.invalid'},{'sec-fetch-site':'cross-site'}]){
   const result=await f.req(path,{confirmId:'x',sha256:'y'},method,headers);
   assert.equal(result.status,403,`${method} ${path} ${JSON.stringify(headers)}`);assert.equal(result.data.error,'Same-origin request required.');
  }
 }
 assert.equal(f.log.puts.length,before,'a refused request writes nothing');
 // PATCH is not allowed anywhere here, and PUT and DELETE only on one saved test.
 for(const [path,method] of [[item,'PATCH'],[AB,'PUT'],[AB,'DELETE'],[AB+'/check','PUT'],[item+'/download','DELETE'],[item+'/events','PUT']]){
  const result=await f.req(path,{},method);assert.equal(result.status,405,`${method} ${path}`);assert.equal(result.data.error,'Method not allowed.');
 }
 // A method the TEST Worker allows but the route does not: the API's own 405.
 assert.equal((await f.req(AB+'/check')).status,405);
 assert.equal((await f.req(item+'/download',{})).status,405);
 for(const path of [AB+'?site=politika',AB+'?cursor=a&cursor=b',item+'?x=1']){
  const result=await f.req(path);assert.equal(result.status,400,path);assert.equal(result.data.error,'Unknown query.');
 }
 for(const path of [AB+'/',AB+'x',AB+'/abx-123',item+'/other',AB+'/check/x','/api/publishers/test-site/ab-tests']){
  const result=await f.req(path);assert.equal(result.status,404,path);
 }
 assert.equal((await f.req(item)).status,404);
 assert.deepEqual(abKeys(f),[]);
});

test('a saved A/B test of two TEST versions is listed, downloaded, trashed, restored and marked live',async()=>{
 const f=await seeded();
 const list=await f.req(AB);
 assert.equal(list.status,200,JSON.stringify(list.data));
 assert.equal(list.headers.get('cache-control'),'private, no-store');assert.equal(list.headers.get('x-robots-tag'),'noindex, nofollow, noarchive');
 assert.deepEqual({site:list.data.site,testOnly:list.data.testOnly,current:list.data.current,proposed:list.data.proposedTestId,defaults:list.data.defaults,tests:list.data.tests},
  {site:'test-site',testOnly:true,current:null,proposed:'test_site_1',defaults:{trafficBPercent:50},tests:[]});
 assert.deepEqual(list.data.versions.map(v=>[v.id,v.name,v.runtimeVersion,v.prebidVersion]).sort(),
  [[f.ids.gam,'GAM only','3.23.0',null],[f.ids.A,'Bid cache off','3.23.0','11.34.0'],[f.ids.B,'Bid cache on','3.23.0','11.34.0']].sort());
 // Dry runs: GAM-only against Prebid is refused (still 200), A and B differ only in bid caching.
 const refused=await f.req(AB+'/check',{a:f.ids.gam,b:f.ids.A});
 assert.equal(refused.status,200);assert.equal(refused.data.compatible,false);assert.equal(refused.data.refusal.code,'prebid-differs');
 const check=await f.req(AB+'/check',request(f));
 assert.equal(check.status,200);assert.equal(check.data.compatible,true,JSON.stringify(check.data.refusal));
 assert(check.data.configDiff.some(row=>/bidCache/.test(JSON.stringify(row))),JSON.stringify(check.data.configDiff));
 assert.deepEqual(check.data.arms.A,{id:f.ids.A,name:'Bid cache off',runtimeVersion:'3.23.0'});
 // Create, then the same request again: the saved test is returned with no write.
 const created=await f.req(AB,request(f));
 assert.equal(created.status,201,JSON.stringify(created.data));
 const record=created.data.record,id=record.id;
 assert.match(id,/^abx-[a-f0-9]{64}$/);assert.equal(record.createdBy,TEST_EMAIL);
 const puts=f.log.puts.length;
 const again=await f.req(AB,request(f));
 assert.equal(again.status,200);assert.equal(again.data.created,false);assert.equal(again.data.record.id,id);assert.equal(f.log.puts.length,puts);
 const taken=await f.req(AB,request(f,{name:'Another name'}));
 assert.equal(taken.status,409);assert.equal(taken.data.code,'testid-taken');
 // The ZIP from the Worker is the stored bundle, with its sha256 in the header.
 const download=await f.req(AB+'/'+id+'/download');
 assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'application/zip');
 assert.equal(download.headers.get('content-disposition'),`attachment; filename="ab-test_site_1-${id.slice(-8)}.zip"`);
 assert.equal(download.headers.get('x-package-sha256'),sha(download.bytes));assert.equal(sha(download.bytes),record.bundle.zipSha256);
 const files=unzipSync(download.bytes);
 assert.deepEqual(Object.keys(files).sort(),['_headers','ads.js','prebid.js',`r/${f.ids.A}/ads.js`,`r/${f.ids.B}/ads.js`].sort());
 assert.equal(new TextDecoder().decode(files._headers),PAGES_HEADERS);
 const recordFile=await f.req(AB+'/'+id+'/record');
 assert.equal(recordFile.status,200);assert.equal(recordFile.headers.get('x-record-sha256'),sha(recordFile.bytes));assert.equal(recordFile.headers.get('x-record-sha256'),created.data.recordSha256);
 // Same bytes as composing the two saved versions directly.
 const direct=await composeAbBundle({site:'test-site',a:await read(f,f.ids.A),b:await read(f,f.ids.B),trafficBPercent:50,testId:'test_site_1',name:'Bid cache'});
 assert.equal(direct.id,id);assert.equal(direct.zipSha256,record.bundle.zipSha256);
 // Trash (DELETE) and restore (PUT) pass the TEST method gate and need the exact confirmation.
 const confirmation={confirmId:id,sha256:record.bundle.zipSha256};
 assert.equal((await f.req(AB+'/'+id,{confirmId:id,sha256:'0'.repeat(64)},'DELETE')).status,422);
 const trashed=await f.req(AB+'/'+id,confirmation,'DELETE');
 assert.equal(trashed.status,200,JSON.stringify(trashed.data));assert.deepEqual(trashed.data,{ok:true,id,deleted:true});
 assert.deepEqual((await f.req(AB)).data.deleted.map(t=>t.id),[id]);
 assert.equal((await f.req(AB+'/'+id+'/events',{type:'marked-live'})).status,409);
 const restored=await f.req(AB+'/'+id,confirmation,'PUT');
 assert.equal(restored.status,200,JSON.stringify(restored.data));assert.deepEqual(restored.data,{ok:true,id,deleted:false});
 assert.deepEqual((await f.req(AB)).data.tests.map(t=>t.id),[id]);
 const live=await f.req(AB+'/'+id+'/events',{type:'marked-live'});
 assert.equal(live.status,201,JSON.stringify(live.data));assert.equal(live.data.event.by,TEST_EMAIL);
 assert.equal((await f.req(AB+'/'+id+'/events',{type:'marked-live'})).status,409);
 const detail=await f.req(AB+'/'+id);
 assert.equal(detail.status,200);assert.deepEqual(detail.data.events.map(e=>e.type),['marked-live']);assert.equal(detail.data.deletedAt,null);
 // Every A/B object is inside the TEST site's A/B prefix; only the trash marker was ever deleted.
 assert(abKeys(f).length>0);assert(abKeys(f).every(key=>key.startsWith(P)),abKeys(f).join(', '));
 assert.deepEqual(f.log.deletes,[P+'deleted/'+id+'.json']);
});

async function read(f,id){
 const {readPackage}=await import('../../worker/site-runtime/releases.mjs');
 return readPackage(f.env,'test-site',id,{testOnly:true});
}

test('the A/B panel offers only fully stored versions, never an interrupted upload',async()=>{
 const f=await seeded();
 // An upload that never reached 'stored' (interrupted, or left behind by cleanup) is still a builtin_draft_uploads row.
 f.sqlite.prepare("UPDATE builtin_draft_uploads SET state='uploading' WHERE release_id=?").run(f.ids.gam);
 assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM builtin_draft_uploads WHERE release_id=?').get(f.ids.gam).n,1);
 const listed=await f.req(AB);
 assert.equal(listed.status,200);
 assert.deepEqual(listed.data.versions.map(v=>v.id).sort(),[f.ids.A,f.ids.B].sort());
});

test('after Delete all generated packages the saved test still downloads, and a new check says the version is missing',async()=>{
 const f=await seeded();
 const created=await f.req(AB,request(f));assert.equal(created.status,201);
 const id=created.data.record.id,zipSha256=created.data.record.bundle.zipSha256;
 // Package cleanup removes the drafts from D1 (the fake R2 keeps their bytes, as after a failed delete).
 const state=(await f.req('/test-api/package-cleanup')).data;
 const cleanup=await f.req('/test-api/package-cleanup',{revision:state.revision,acknowledge:true});
 assert.equal(cleanup.status,200,JSON.stringify(cleanup.data));assert.equal(cleanup.data.deleted,3);
 const download=await f.req(AB+'/'+id+'/download');
 assert.equal(download.status,200);assert.equal(sha(download.bytes),zipSha256);
 const list=(await f.req(AB)).data;
 assert.deepEqual(list.versions,[]);assert.deepEqual(list.tests.map(t=>t.id),[id]);
 const message='Version A is no longer in Saved versions. Choose another saved version. Saved A/B tests keep their own copies.';
 const check=await f.req(AB+'/check',request(f));
 assert.equal(check.status,200);assert.equal(check.data.compatible,false);
 assert.deepEqual(check.data.refusal,{code:'package-missing',check:'packages',message});
 const create=await f.req(AB,request(f,{testId:'test_site_2'}));
 assert.equal(create.status,422);assert.deepEqual(create.data,{error:message,code:'package-missing',check:'packages'});
});

test('saved A/B tests stay readable while the TEST settings are mid-edit',async()=>{
 const f=await seeded();
 const created=await f.req(AB,request(f));assert.equal(created.status,201);
 const id=created.data.record.id;
 // The condition assertWorkspaceSiteScope refuses: Prebid on without the TEST Prebid editor marker.
 const row=f.sqlite.prepare("SELECT config_json FROM publisher_configs WHERE publisher_id='test-site'").get();
 const config=JSON.parse(row.config_json);delete config.testPrebidDraft;
 f.sqlite.prepare("UPDATE publisher_configs SET config_json=? WHERE publisher_id='test-site'").run(JSON.stringify(config));
 const packages=await f.req('/test-api/site-packages');
 assert.equal(packages.status,409);assert.equal(packages.data.error,'Save Prebid settings through the TEST editor first.');
 const list=await f.req(AB);
 assert.equal(list.status,200,JSON.stringify(list.data));assert.deepEqual(list.data.tests.map(t=>t.id),[id]);
 assert.equal((await f.req(AB+'/'+id+'/download')).status,200);
 // The composer reads only the saved bytes, so a new test can still be checked and saved.
 assert.equal((await f.req(AB+'/check',request(f,{b:f.ids.A}))).data.compatible,true);
 assert.equal((await f.req(AB,request(f,{b:f.ids.A,testId:'test_site_2',name:'A/A'}))).status,201);
});

test('the composer refusals name Generate and releases on TEST, and other messages pass unchanged',async()=>{
 const refusal=async a=>{try{await composeAbBundle({site:'test-site',a,b:a,trafficBPercent:50,testId:'test_site_1',name:'x'});}catch(error){return error.message;}assert.fail('expected a refusal');};
 const notSaved=await refusal({files:{},release:null}),notBuiltIn=await refusal({files:{},release:{id:'other'}});
 assert.equal(notSaved,'Version A is not a saved package. Choose a saved version under Releases.');
 assert.equal(testAbMessage(notSaved),'Version A is not a saved package. Choose a saved version under Generate and releases.');
 assert.equal(testAbMessage(notBuiltIn),'Version A is not a saved built-in version. Choose a version saved under Generate and releases.');
 for(const message of ['Version A is no longer in Saved versions. Choose another saved version. Saved A/B tests keep their own copies.','Releases are listed below.',undefined])
  assert.equal(testAbMessage(message),message);
});
