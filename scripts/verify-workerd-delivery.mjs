// LOCAL compiled Worker + real Miniflare R2 CAS. All external requests are mocked.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { TARGET } from '../tests/support/deployment-store.mjs';
import { metadata } from '../.generated/tanjug-pilot.mjs';
const origin='https://prebid-professor-test.mbaucal.workers.dev';
const directory=await mkdtemp(join(tmpdir(),'tessera-delivery-workerd-'));
const compiled='.generated/test-workspace-active-dry-run';
const files=(await readdir(compiled)).filter(n=>/\.m?js$/.test(n));assert.equal(files.length,1);
const script=await readFile(join(compiled,files[0]),'utf8');
const config=JSON.parse(await readFile('ops/runtime-test/wrangler.jsonc','utf8'));
const password=randomBytes(24).toString('hex'),secret=randomBytes(48).toString('hex');
const bindings={...config.vars,TEST_WORKSPACE_ENABLED:'true',TEST_PUBLIC_ORIGIN:origin,TEST_ADMIN_EMAIL:'tester@example.invalid',TEST_ADMIN_PASSWORD:password,
  TEST_SESSION_SECRET:randomBytes(48).toString('hex'),TEST_DEPLOY_SECRET:secret,TEST_GITHUB_ACTIONS_TOKEN:randomBytes(32).toString('hex')};
let mf,cookie='',dispatches=[];const checks=[];
const check=(name,ok)=>{assert(ok,name);checks.push({name,passed:true});};
const start=()=>new Miniflare({name:'local-delivery-test',modules:true,script,compatibilityDate:config.compatibility_date,
  host:'127.0.0.1',port:0,cf:false,bindings,resourcePersistencePath:directory,
  d1Databases:{DB:'local-delivery-d1'},r2Buckets:{BUILDS:'local-delivery-r2'},outboundService:async request=>{
    assert.equal(request.url,'https://api.github.com/repos/Mbaucal/prebid-professor/actions/workflows/deploy-pages-release.yml/dispatches');
    dispatches.push(await request.json());return new Response(null,{status:204});
  }});
async function call(path,body,runner=false){return mf.dispatchFetch(origin+path,{method:body===undefined?'GET':'POST',redirect:'manual',
  headers:runner?{authorization:'Bearer '+secret,'content-type':'application/json'}:{cookie,...(body===undefined?{}:{origin,'content-type':'application/json'})},
  body:body===undefined?undefined:JSON.stringify(body)});}
async function json(path,body,status=200,runner=false){const response=await call(path,body,runner),data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;}
try {
  mf=start();await mf.ready;
  const logged=await mf.dispatchFetch(origin+'/api/auth/login',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:bindings.TEST_ADMIN_EMAIL,password}).toString()});
  assert.equal(logged.status,303);cookie=logged.headers.get('set-cookie').split(';')[0];
  const initial=await json('/test-api/deployments');check('Empty delivery ledger reads without schema initialization',initial.revision===0&&initial.sources.length===1);
  const targetBody={expectedRevision:0,siteId:'tanjug-test',target:TARGET};
  const targetRace=await Promise.all([call('/test-api/deployments/target',targetBody),call('/test-api/deployments/target',targetBody)]);
  check('Real R2 If-None-Match makes exactly one first setup succeed',targetRace.filter(r=>r.status===200).length===1&&targetRace.filter(r=>r.status===409).length===1);
  const state=await json('/test-api/deployments');
  const input={expectedRevision:state.revision,siteId:'tanjug-test',action:'publish',releaseId:metadata.descriptor.releaseId,acknowledge:true};
  const publishRace=await Promise.all([call('/test-api/deployments/request',input),call('/test-api/deployments/request',input)]);
  check('Real R2 If-Match serializes simultaneous publish requests',publishRace.filter(r=>r.status===202).length===1&&publishRace.filter(r=>r.status===409).length===1&&dispatches.length===1);
  let history=await json('/test-api/deployments');const run=history.runs[0],path='/test-api/deployment-runner/'+run.id;
  const runnerIdentity={runId:'123456',commit:'a'.repeat(40)};
  await json(path+'/claim',{...runnerIdentity,inputs:dispatches[0].inputs},200,true);
  await json(path+'/claim',{...runnerIdentity,inputs:dispatches[0].inputs},409,true);
  check('Compiled runner can claim a private package only once',true);
  const download=await mf.dispatchFetch(origin+path+'/package',{headers:{authorization:'Bearer '+secret,'x-tessera-run-id':'123456'}});
  assert.equal(download.status,200);check('Immutable delivery cache retains exact original ZIP bytes',createHash('sha256').update(new Uint8Array(await download.arrayBuffer())).digest('hex')===metadata.zipSha256);
  await json(path+'/report',{...runnerIdentity,status:'success',deliverySha256:run.delivery.sha256,deploymentUrl:'https://1234abcd.tessera-fixture.pages.dev/',productionBranch:'main'},200,true);
  history=await json('/test-api/deployments');
  check('Compiled callback records success and normalizes immutable URL',history.runs[0].status==='success'&&history.runs[0].deploymentUrl==='https://1234abcd.tessera-fixture.pages.dev');
  const db=await mf.getD1Database('DB'),tables=await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE '_cf_%'").all();
  check('Deployment uses no new or reset D1 tables',tables.results.length===0);
  await mf.dispose();mf=null;mf=start();await mf.ready;
  const restarted=await json('/test-api/deployments');check('Target and deployment history survive Worker restart',JSON.stringify(history)===JSON.stringify(restarted));
  await mkdir('.generated/delivery-evidence',{recursive:true});
  const report={scope:'LOCAL compiled workerd + Miniflare R2/D1, mocked GitHub; no hosted deployment',compiledSha256:createHash('sha256').update(script).digest('hex'),checks,passed:checks.length,failed:0,dispatches:dispatches.length};
  await writeFile('.generated/delivery-evidence/workerd.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {if(mf)await mf.dispose();await rm(directory,{recursive:true,force:true});}
