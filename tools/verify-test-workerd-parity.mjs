/** Same reviewed receipt through old and modern compiled TEST Workers, local D1/R2 only. */
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,readdir,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Miniflare} from './test-miniflare.mjs';
import {unzipSync} from '../node_modules/fflate/esm/index.mjs';
const baselinePath=process.argv[2];
if(!baselinePath)throw Error('Pass the pristine 893bf83 old-toolchain compiled TEST Worker path');
const sha=b=>createHash('sha256').update(b).digest('hex');
const baseline=await readFile(baselinePath,'utf8');
assert.equal(sha(baseline),'1237490e7876c0c36ddbf592c960f24a2b006892505494bf026a8a9c67ecd289','Use reviewed 893bf83 + Wrangler 4.118.0 baseline bytes');
const compiled='.generated/test-workspace-active-dry-run';
const names=(await readdir(compiled)).filter(n=>/\.m?js$/.test(n));assert.equal(names.length,1);
const modern=await readFile(join(compiled,names[0]),'utf8');
const config=JSON.parse(await readFile('ops/runtime-test/wrangler.active.jsonc','utf8'));
assert.equal(config.name,'prebid-professor-test');assert.equal(config.vars.TEST_WORKSPACE_ENABLED,'true');
const origin=config.vars.TEST_PUBLIC_ORIGIN;
assert.equal(origin,'https://prebid-professor-test.mbaucal.workers.dev');
const directory=await mkdtemp(join(tmpdir(),'tessera-test-toolchain-'));
const password=randomBytes(24).toString('hex');
const bindings={...config.vars,TEST_ADMIN_EMAIL:'tester@example.invalid',TEST_ADMIN_PASSWORD:password,TEST_SESSION_SECRET:randomBytes(48).toString('hex')};
let external=0;const instances=[];const checks=[];
const checked=name=>checks.push({name,passed:true});
function start(name,script){
 const item={name,script,cookie:'',mf:null};
 item.restart=async()=>{
  await item.mf?.dispose();
  item.mf=new Miniflare({name:`local-${name}`,modules:true,script,compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,host:'127.0.0.1',port:0,cf:false,bindings,resourcePersistencePath:join(directory,name),d1Databases:{DB:`${name}-local`},r2Buckets:{BUILDS:`${name}-local`},outboundService:()=>{external++;return new Response('External requests forbidden',{status:503});}});
  await item.mf.ready;
 };
 item.call=(path,body,headers={})=>item.mf.dispatchFetch(origin+path,{method:body===undefined?'GET':'POST',redirect:'manual',headers:{cookie:item.cookie,...(body===undefined?{}:{origin,'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
 item.json=async(path,body,status=200)=>{const r=await item.call(path,body),data=await r.json();assert.equal(r.status,status,`${name} ${path}: ${JSON.stringify(data).slice(0,160)}`);return data;};
 item.zip=async id=>{const r=await item.call(`/test-api/releases/${id}/download`);assert.equal(r.status,200);return new Uint8Array(await r.arrayBuffer());};
 instances.push(item);return item;
}
const old=start('baseline',baseline),current=start('modern',modern);const artifacts=[];
try{
 for(const item of instances){
  await item.restart();
  await item.json('/test-api/status',undefined,401);
  const login=await item.mf.dispatchFetch(origin+'/api/auth/login',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:bindings.TEST_ADMIN_EMAIL,password}).toString()});
  assert.equal(login.status,303);item.cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await item.call('/test-api/setup',{confirm:'prepare-empty-test-database'},{origin:'https://foreign.invalid'})).status,403);
  await item.json('/test-api/setup',{confirm:'prepare-empty-test-database'});
 }
 checked('Both actual compiled Workers enforce authentication and foreign-Origin refusal');
 for(const version of ['3.14.0','3.15.0']){
  let expectedPin;
  for(const item of instances){
   const state=await item.json('/test-api/runtime-selection');
   assert.deepEqual(state.runtimes.map(r=>r.version),['3.10.0-tessera.preview.1','3.9.1-tessera.preview.2','3.11.0-tessera.preview.1','3.13.0','3.15.0','3.14.0']);
   const runtime=state.runtimes.find(r=>r.version===version);assert(runtime);
   expectedPin=runtime.pin;
   const request={expectedRevision:state.revision,selection:{runtime:runtime.pin,allowPreview:true,enablePrebid:false,prebidBuildId:null}};
   const selected=await item.json('/test-api/runtime-selection',request);assert.equal(selected.changed,true);
   await item.json('/test-api/runtime-selection',request,409);
  }
  checked(`${version}: explicit exact selection with stale-write protection; catalog unchanged`);
  const generated=await current.json('/test-api/generate',{acknowledge:true,takeOverEnabled:false});
  assert.equal(generated.descriptor.runtime.runtimeVersion,version);
  assert.equal(generated.descriptor.runtime.runtimeSha256,expectedPin.runtimeSha256);
  assert.equal(generated.publishable,false);
  const reviewed={receipt:generated.receipt,acknowledge:true,note:'Synthetic toolchain comparison'};
  const savedOld=await old.json('/test-api/save',reviewed),savedModern=await current.json('/test-api/save',reviewed);
  // Both handlers regenerate from the same signed timestamp/config and validate packageHash.
  assert.equal(savedOld.created,true);assert.equal(savedModern.created,true);
  assert.equal((await current.json('/test-api/save',reviewed)).created,false);
  const oldId=savedOld.draft.id,newId=savedModern.draft.id;
  const a=await old.zip(oldId),b=await current.zip(newId);assert.deepEqual(b,a);
  const files=unzipSync(b);assert.equal(new TextDecoder().decode(files['ads.js']),generated.adsJs);
  assert.equal('prebid.js' in files,false);
  for(const [item,id] of [[old,oldId],[current,newId]]){
   const reopened=await item.json(`/test-api/releases/${id}`);assert.equal(reopened.verified,true);assert.equal(reopened.draft.publishable,false);
  }
  const receiptPayload=JSON.parse(Buffer.from(generated.receipt.split('.')[0],'base64url').toString());
  artifacts.push({version,buildTimestamp:receiptPayload.buildTimestamp,runtimeSha256:expectedPin.runtimeSha256,zipSha256:sha(b),files:Object.fromEntries(Object.entries(files).map(([n,v])=>[n,sha(v)])),oldId,newId});
  checked(`${version}: modern Generate, both compiled Save regenerations, duplicate Save, reopen and exact ZIP agree`);
 }
 for(const item of instances){await item.restart();for(const a of artifacts){assert.equal(sha(await item.zip(item===old?a.oldId:a.newId)),a.zipSha256);}
  assert.equal((await item.json('/test-api/runtime-selection')).selected.runtime.runtimeVersion,'3.15.0');
 }
 checked('Both versions remain byte-identical after later selection and persistent workerd restart');
 assert.equal(external,0);checked('Zero outbound requests');
 for(const a of artifacts){delete a.oldId;delete a.newId;}
 const report={scope:'LOCAL compiled TEST Workers on tools-owned Miniflare; no hosted deployment or live ads. GAM-only 3.14/3.15.',base:'893bf83fbefc29dca966207574f57ce35575e9de',baselineWorkerSha256:sha(baseline),modernWorkerSha256:sha(modern),checks,artifacts,externalRequests:external,passed:checks.length};
 await mkdir('.generated/toolchain-test-evidence',{recursive:true});await writeFile('.generated/toolchain-test-evidence/parity.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{for(const item of instances)await item.mf?.dispose();await rm(directory,{recursive:true,force:true});}
