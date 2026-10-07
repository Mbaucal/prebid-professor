import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp,symlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pagesProfile,verifyPagesTools} from '../../scripts/pages-toolchain.mjs';
import {verifyPreparedPages,preflight} from '../../scripts/pages-release-preflight.mjs';
import {verifyPackage,scriptsDelivery,PAGES_HEADERS,assertPreparedEvidence} from '../../scripts/pages-release-verification.mjs';
const repo=resolve(import.meta.dirname,'../..'),sha=x=>createHash('sha256').update(x).digest('hex'),bytes=x=>Buffer.from(typeof x==='string'?x:JSON.stringify(x));
async function fixture({profile='test',compact=false,channel='staging'}={}){
 const root=await mkdtemp(resolve(tmpdir(),'mba217-'));await mkdir(resolve(root,'tools'));
 await cp(resolve(repo,'tools/historical-inputs.json'),resolve(root,'tools/historical-inputs.json'));
 if(profile==='test'){const marker={profile:'test',baselineCommit:'893bf83fbefc29dca966207574f57ce35575e9de'};await writeFile(resolve(root,'tools/test-historical-inputs.json'),JSON.stringify({baselineCommit:marker.baselineCommit}));await writeFile(resolve(root,'tools/target-profile.json'),JSON.stringify(marker));}
 const input={site_id:'fixture',release_id:'11111111-1111-4111-8111-111111111111',release_version:'20260914_010000',correlation_id:'22222222-2222-4222-8222-222222222222',account_id:'a'.repeat(32),project_name:'test-pages',branch:channel==='production'?'main':'staging',channel,github_environment:'CLOUDFLARE_API_TOKEN_FIXTURE',callback_url:'https://prebid-professor.mbaucal.workers.dev/api/deployments/callback',release_base_url:'https://prebid-professor.mbaucal.workers.dev/cdn/fixture/releases/20260914_010000'};
 const config={site:{id:'fixture'},version:input.release_version,enablePrebid:false,demandMode:'gam-adx-only',prebidBuild:null};
 const files={'ads.js':bytes('original ads'),'ads.min.js':bytes('original min'),'prebid.js':bytes('/* Prebid disabled for this release. Google Ad Manager / AdX only. */\n'),'config.json':bytes(config),'min-height.css':bytes('css'),'div-export.csv':bytes('csv'),'implementation.html':bytes('html')};
 const manifest={schemaVersion:1,siteId:input.site_id,releaseId:input.release_id,version:input.release_version,configHash:sha(files['config.json']),prebidBuild:null,prebidEnabled:false,demandMode:'gam-adx-only',files:Object.fromEntries(Object.entries(files).map(([n,b])=>[n,{size:b.length,sha256:sha(b)}]))};
 if(compact){manifest.kind='builtin-runtime-release';manifest.completeRelease=true;delete files['prebid.js'];delete manifest.files['prebid.js'];}
 files['manifest.json']=bytes(manifest);input.manifest_sha256=sha(files['manifest.json']);let verified=await verifyPackage(files,input);if(compact)verified=scriptsDelivery(verified);
 const env={DEPLOY_INPUTS:JSON.stringify(input),GITHUB_REF:profile==='main'?'refs/heads/main':'refs/heads/feature/isolated-runtime-workspace-v1',GITHUB_REPOSITORY:'Mbaucal/prebid-professor',GITHUB_RUN_ID:'123456',GITHUB_SHA:'a'.repeat(40)};
 const proof={input,runId:env.GITHUB_RUN_ID,commit:env.GITHUB_SHA,verified,project:{accountId:input.account_id,projectName:input.project_name,productionBranch:'main',branch:input.branch,channel}};
 const dir=resolve(root,'.generated/pages-release');await mkdir(resolve(dir,'dist'),{recursive:true});
 for(const f of verified.files)await writeFile(resolve(dir,'dist',f.name),files[f.name]);await writeFile(resolve(dir,'dist/_headers'),PAGES_HEADERS);await writeFile(resolve(dir,'verification.json'),JSON.stringify(proof));
 return{root,dir,env,input,proof,files,close:()=>rm(root,{recursive:true,force:true})};
}
for(const spec of [{profile:'test'},{profile:'main'},{profile:'main',channel:'production'},{profile:'test',compact:true}])test('exact prepared package accepted '+JSON.stringify(spec),async()=>{const f=await fixture(spec);try{assert.equal(await verifyPreparedPages(f.root,f.env),spec.profile);}finally{await f.close();}});
test('legitimate staging feature refs retain source profile',async()=>{const f=await fixture();try{f.env.GITHUB_REF='refs/heads/feature/review-stage';assert.equal(await pagesProfile(f.root,f.env),'test');}finally{await f.close();}});
for(const change of ['wrong-marker','missing-test-marker','production-test','wrong-ref','wrong-repo','wrong-baseline'])test('profile refuses '+change,async()=>{const f=await fixture();try{
 if(change==='wrong-marker')await writeFile(resolve(f.root,'tools/target-profile.json'),JSON.stringify({profile:'main',baselineCommit:'685d90b6974133e19e96f7ceb28e60a58b7ce402'}));
 if(change==='missing-test-marker')await rm(resolve(f.root,'tools/target-profile.json'));
 if(change==='production-test'){f.input.channel='production';f.env.DEPLOY_INPUTS=JSON.stringify(f.input);f.env.GITHUB_REF='refs/heads/main';}
 if(change==='wrong-ref'){f.input.channel='production';f.env.DEPLOY_INPUTS=JSON.stringify(f.input);}
 if(change==='wrong-repo')f.env.GITHUB_REPOSITORY='other/repo';
 if(change==='wrong-baseline')await writeFile(resolve(f.root,'tools/test-historical-inputs.json'),JSON.stringify({baselineCommit:'a'.repeat(40)}));
 await assert.rejects(pagesProfile(f.root,f.env));
 }finally{await f.close();}});
for(const change of ['asset','headers','extra','symlink','run','commit','input','manifest','project','production-branch','missing-proof','unsafe-name','duplicate'])test('reject '+change+' before action tools',async()=>{const f=await fixture();try{
 if(change==='asset')await writeFile(resolve(f.dir,'dist/ads.js'),'changed');
 if(change==='headers')await writeFile(resolve(f.dir,'dist/_headers'),'changed');
 if(change==='extra')await writeFile(resolve(f.dir,'dist/_worker.js'),'unexpected');
 if(change==='symlink'){await rm(resolve(f.dir,'dist/ads.js'));await symlink('/etc/hosts',resolve(f.dir,'dist/ads.js'));}
 if(change==='run')f.env.GITHUB_RUN_ID='777';
 if(change==='commit')f.env.GITHUB_SHA='b'.repeat(40);
 if(change==='input')f.proof.input.correlation_id='33333333-3333-4333-8333-333333333333';
 if(change==='manifest')f.proof.verified.manifestSha256='b'.repeat(64);
 if(change==='project')f.proof.project.projectName='other';
 if(change==='production-branch')f.proof.project.productionBranch='staging';
 if(change==='unsafe-name')f.proof.verified.files[0].name='../elsewhere';
 if(change==='duplicate')f.proof.verified.files.push(f.proof.verified.files[0]);
 await writeFile(resolve(f.dir,'verification.json'),JSON.stringify(f.proof));if(change==='missing-proof')await rm(resolve(f.dir,'verification.json'));
 let calls=0;await assert.rejects(preflight(f.root,f.env,()=>{calls++;}));assert.equal(calls,0);
 }finally{await f.close();}});
test('public verification proof refuses a different run without network',async()=>{const f=await fixture();try{assertPreparedEvidence(f.input,f.proof,f.env);assert.throws(()=>assertPreparedEvidence(f.input,f.proof,{...f.env,GITHUB_RUN_ID:'999'}));}finally{await f.close();}});
test('clean checkout validate has no install dependency (original hypothesis disproved)',async()=>{
 const f=await fixture();try{
 for(const path of ['scripts/pages-release-verification.mjs','worker/runtime/draft-release-store.mjs','worker/runtime/prebid-artifact-check.mjs']){await mkdir(resolve(f.root,path,'..'),{recursive:true});await cp(resolve(repo,path),resolve(f.root,path));}
 const r=spawnSync(process.execPath,['scripts/pages-release-verification.mjs','validate'],{cwd:f.root,env:f.env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/identity.*validated/);
 }finally{await f.close();}
});
for(const spec of [{profile:'test'},{profile:'test',compact:true},{profile:'main',channel:'production'}])test('actual prepare and public verification keep bound original bytes '+JSON.stringify(spec),async()=>{
 const f=await fixture(spec);try{
  await rm(f.dir,{recursive:true});
  const map={};for(const [name,b]of Object.entries(f.files))map[f.input.release_base_url+'/'+name]=Buffer.from(b).toString('base64');
  const publicUrl='https://1234abcd.test-pages.pages.dev';
  for(const [name,b]of Object.entries(f.files))map[publicUrl+'/'+name]=Buffer.from(b).toString('base64');
  const dataPath=resolve(f.root,'responses.json'),logPath=resolve(f.root,'requests.log'),mockPath=resolve(f.root,'fetch.mjs');
  await writeFile(dataPath,JSON.stringify(map));await writeFile(logPath,'');
  await writeFile(mockPath,`import {readFileSync,appendFileSync} from 'node:fs';
const responses=JSON.parse(readFileSync(process.env.RESPONSES,'utf8'));
globalThis.fetch=async(url,options)=>{appendFileSync(process.env.REQUEST_LOG,url+'\\n');if(url==='https://api.cloudflare.com/client/v4/accounts/${f.input.account_id}/pages/projects/test-pages')return Response.json({success:true,result:{name:'test-pages',production_branch:'main'}});if(!responses[url])throw Error('Unexpected network '+url);const extension=new URL(url).pathname.split('.').at(-1);const type={js:'application/javascript',json:'application/json',css:'text/css',html:'text/html',csv:'text/csv',txt:'text/plain'}[extension];return new Response(Buffer.from(responses[url],'base64'),{headers:{'content-type':type,'access-control-allow-origin':'*','x-content-type-options':'nosniff','cache-control':'no-store'}});};`);
  const env={...f.env,CLOUDFLARE_API_TOKEN:'synthetic-only',RESPONSES:dataPath,REQUEST_LOG:logPath,PAGES_DEPLOYMENT_URL:publicUrl};
  const script=resolve(repo,'scripts/pages-release-verification.mjs');
  for(const mode of ['prepare','verify-public']){const r=spawnSync(process.execPath,['--import',mockPath,script,mode],{cwd:f.root,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
  assert.equal(await verifyPreparedPages(f.root,f.env),spec.profile);
  const evidence=JSON.parse(await readFile(resolve(f.dir,'public-verification.json'),'utf8'));assert.equal(evidence.verified,true);
  const before=await readFile(logPath,'utf8');const refused=spawnSync(process.execPath,['--import',mockPath,script,'verify-public'],{cwd:f.root,env:{...env,GITHUB_RUN_ID:'999'},encoding:'utf8'});assert.notEqual(refused.status,0);assert.equal(await readFile(logPath,'utf8'),before);
 }finally{await f.close();}
});
for(const profile of ['test','main'])test('MAIN CLI accepts main and refuses foreign profile: '+profile,async()=>{
 const f=await fixture({profile});try{
  for(const path of ['scripts/pages-toolchain.mjs','scripts/verify-toolchain-isolation.mjs','scripts/pages-release-verification.mjs','worker/runtime/draft-release-store.mjs','worker/runtime/prebid-artifact-check.mjs']){await mkdir(resolve(f.root,path,'..'),{recursive:true});await cp(resolve(repo,path),resolve(f.root,path));}
  await writeFile(resolve(f.root,'scripts/bootstrap-toolchain.mjs'),"import{writeFileSync}from'node:fs';writeFileSync('bootstrap-args.json',JSON.stringify(process.argv.slice(2)));\n");
  const check=spawnSync(process.execPath,['scripts/pages-toolchain.mjs','check'],{cwd:f.root,env:f.env,encoding:'utf8'});if(profile==='test'){assert.notEqual(check.status,0);assert.match(check.stderr,/only the MAIN bootstrap/);const boot=spawnSync(process.execPath,['scripts/pages-toolchain.mjs','bootstrap'],{cwd:f.root,env:f.env,encoding:'utf8'});assert.notEqual(boot.status,0);await assert.rejects(readFile(resolve(f.root,'bootstrap-args.json')),/ENOENT/);return;}assert.equal(check.status,0,check.stderr);
  const boot=spawnSync(process.execPath,['scripts/pages-toolchain.mjs','bootstrap'],{cwd:f.root,env:f.env,encoding:'utf8'});assert.equal(boot.status,0,boot.stderr);
  assert.deepEqual(JSON.parse(await readFile(resolve(f.root,'bootstrap-args.json'),'utf8')),profile==='test'?['--profile','test']:[]);
  const rejected=spawnSync(process.execPath,['scripts/pages-toolchain.mjs','bootstrap','--profile','main'],{cwd:f.root,env:f.env,encoding:'utf8'});assert.notEqual(rejected.status,0);
 }finally{await f.close();}
});
test('workflow uses locked tools only for deploy, preserves outputs and validation before credentials',async()=>{
 const yaml=await readFile(resolve(repo,'.github/workflows/deploy-pages-release.yml'),'utf8');
 assert.equal((yaml.match(/pages-toolchain.mjs bootstrap/g)||[]).length,1);assert(yaml.indexOf('id: identity')<yaml.indexOf('pages-toolchain.mjs bootstrap'));assert(yaml.indexOf('pages-toolchain.mjs bootstrap')<yaml.indexOf('CLOUDFLARE_API_TOKEN:'));
 assert.match(yaml,/workingDirectory: tools/);assert.match(yaml,/wranglerVersion: "4.131.0"/);assert.match(yaml,/pages deploy \.\.\/\.generated\/pages-release\/dist/);assert.match(yaml,/steps.deploy.outputs.deployment-url/);assert.match(yaml,/steps.deploy.outputs.pages-deployment-alias-url/);assert.match(yaml,/gitHubToken:.*GITHUB_TOKEN/);
 const after=yaml.slice(yaml.indexOf('\n  verify:'));assert.doesNotMatch(after,/bootstrap|npm ci|wrangler-action|pages deploy/);assert.equal((after.match(/pages-toolchain.mjs check/g)||[]).length,2);
});

// Unlike marker-only fixtures above, this uses the actual installed MAIN tree,
// unmodified isolation guard, real tools resolution and real Wrangler --version.
test('actual installed MAIN preflight succeeds and wrong profile never reaches tools',async()=>{
 const f=await fixture({profile:'main'}),prepared=resolve(repo,'.generated/pages-release');let copied=false;
 try{
  let calls=0;await assert.rejects(verifyPagesTools(repo,()=>{calls++;},'test'),/cannot execute a TEST/);assert.equal(calls,0);
  assert.equal(await pagesProfile(repo,f.env),'main');
  await assert.rejects(readFile(resolve(repo,'tools/target-profile.json')),/ENOENT/);
  await mkdir(prepared);copied=true;await cp(f.dir,prepared,{recursive:true});
  assert.equal(await preflight(repo,f.env),'4.131.0');
 }finally{if(copied)await rm(prepared,{recursive:true,force:true});await f.close();}
});
