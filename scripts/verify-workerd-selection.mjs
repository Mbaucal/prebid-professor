/** LOCAL compiled-workerd coverage for the new settings writer. No hosted
 * API, bindings or credentials. Temporary D1/R2 are removed only locally.
 */
import assert from 'node:assert/strict';
import { createHash,randomBytes } from 'node:crypto';
import { mkdtemp,readdir,readFile,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
const origin='https://prebid-professor-test.mbaucal.workers.dev';
const directory=await mkdtemp(join(tmpdir(),'tessera-selection-workerd-'));
const compiled='.generated/test-workspace-active-dry-run';
const files=(await readdir(compiled)).filter((name)=>/\.m?js$/.test(name));
assert.equal(files.length,1);
const script=await readFile(join(compiled,files[0]),'utf8');
const config=JSON.parse(await readFile('ops/runtime-test/wrangler.jsonc','utf8'));
assert.equal(config.name,'prebid-professor-test');assert.equal(config.vars.TEST_WORKSPACE_ENABLED,'false');
const password=randomBytes(24).toString('hex');
const bindings={...config.vars,TEST_WORKSPACE_ENABLED:'true',TEST_PUBLIC_ORIGIN:origin,TEST_ADMIN_EMAIL:'tester@example.invalid',TEST_ADMIN_PASSWORD:password,TEST_SESSION_SECRET:randomBytes(48).toString('hex')};
let mf,cookie='',outbound=0;const checks=[];
const check=(name,ok)=>{assert(ok,name);checks.push({name,passed:true});};
const start=()=>new Miniflare({name:'local-selection-test',modules:true,script,compatibilityDate:config.compatibility_date,
  host:'127.0.0.1',port:0,cf:false,bindings,resourcePersistencePath:directory,
  d1Databases:{DB:'local-selection-d1'},r2Buckets:{BUILDS:'local-selection-r2'},
  outboundService:()=>{outbound++;return new Response('No outbound requests in this test',{status:503});}});
async function call(path,body){return mf.dispatchFetch(origin+path,{method:body===undefined?'GET':'POST',redirect:'manual',headers:{cookie,...(body===undefined?{}:{origin,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});}
async function json(path,body,status=200){const r=await call(path,body),data=await r.json();assert.equal(r.status,status,`${path}: unexpected status ${r.status}`);return data;}
const selection=(state)=>({expectedRevision:state.revision,selection:{runtime:state.runtimes[0].pin,allowPreview:true,enablePrebid:false,prebidBuildId:null}});
const sha=(bytes)=>createHash('sha256').update(bytes).digest('hex');
try{
  mf=start();await mf.ready;
  const logged=await mf.dispatchFetch(origin+'/api/auth/login',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:bindings.TEST_ADMIN_EMAIL,password}).toString()});
  assert.equal(logged.status,303);cookie=logged.headers.get('set-cookie').split(';')[0];
  await json('/test-api/setup',{confirm:'prepare-empty-test-database'});
  const state=await json('/test-api/runtime-selection');
  check('Compiled settings GET returns three real runtimes and no implicit saved selection',state.selected===null&&state.runtimes.length===3);
  const input=selection(state);input.selection.allowPreview=false;
  await json('/test-api/runtime-selection',input,422);
  check('Compiled settings writer requires Preview opt-in',true);
  input.selection.allowPreview=true;
  const saved=await json('/test-api/runtime-selection',input);
  check('Atomic JSON snapshot assertion and selection write work on Miniflare D1',saved.persisted===true&&saved.changed===true);
  await json('/test-api/runtime-selection',input,409);
  check('A stale reviewed revision is rejected by compiled settings API',true);
  const fresh=await json('/test-api/runtime-selection');
  const repeated=await json('/test-api/runtime-selection',selection(fresh));
  check('Fresh repeated selection is a no-op',repeated.changed===false);
  const db=await mf.getD1Database('DB');
  const count=await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='test_workspace.runtime_selected'").first();
  check('One successful choice has exactly one audit entry',count.n===1);
  const leftover=await db.prepare('SELECT COUNT(*) AS n FROM builtin_draft_assertions').first();
  check('Transaction leaves no assertion rows behind',leftover.n===0);
  const generated=await json('/test-api/generate',{acknowledge:true,takeOverEnabled:false});
  check('Compiled Generate uses the exact saved pin',generated.descriptor.runtime.runtimeSha256===fresh.selected.runtime.runtimeSha256);
  const release=await json('/test-api/save',{receipt:generated.receipt,acknowledge:true,note:'Local compiled selection'});
  const path='/test-api/releases/'+release.draft.id+'/download';
  const first=await call(path);assert.equal(first.status,200);const hash=sha(new Uint8Array(await first.arrayBuffer()));
  await mf.dispose();mf=null;mf=start();await mf.ready;
  const restarted=await json('/test-api/runtime-selection');
  check('Exact persisted runtime selection survives workerd restart',JSON.stringify(restarted.selected)===JSON.stringify(fresh.selected));
  const second=await call(path);assert.equal(second.status,200);
  check('Stored package remains byte-identical after selection and restart',sha(new Uint8Array(await second.arrayBuffer()))===hash);
  check('No outbound fetch was attempted',outbound===0);
  const report={scope:'LOCAL compiled workerd + Miniflare D1/R2; NOT hosted Cloudflare',compiledSha256:sha(script),checks,passed:checks.length,failed:0,outbound,hostedTest:false};
  await mkdir('.generated/test-workspace-evidence',{recursive:true});
  await writeFile('.generated/test-workspace-evidence/selection-workerd.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}catch(error){console.error(JSON.stringify({scope:'LOCAL compiled settings verification',failed:1,error:String(error?.message||'Verification failed').slice(0,300),checks,outbound}));process.exitCode=1;}
finally{if(mf)await mf.dispose();await rm(directory,{recursive:true,force:true});}
