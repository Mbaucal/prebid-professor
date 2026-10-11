import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {verifyPreparedDelivery,verifyPagesTools,preflight} from '../../scripts/builtin-pages-preflight.mjs';
import {metadata,zipBase64} from '../../.generated/tanjug-pilot.mjs';
import {unzipSync} from 'fflate';
import {dispatchInputs,DEPLOY_REF,DEPLOY_REPO} from '../../worker/test-workspace/deployment-contract.mjs';
import {selectDelivery,describeDelivery} from '../../worker/test-workspace/delivery-layout.mjs';
const repo=resolve(import.meta.dirname,'../..');
async function fixture(profile='publisher-scripts-v1'){
 const root=await mkdtemp(resolve(tmpdir(),'mba216-assets-'));const dir=resolve(root,'.generated/builtin-delivery');await mkdir(resolve(dir,'dist'),{recursive:true});
 await mkdir(resolve(root,'tools'),{recursive:true});await writeFile(resolve(root,'tools/historical-inputs.json'),await readFile(resolve(repo,'tools/historical-inputs.json')));await writeFile(resolve(root,'package-lock.json'),await readFile(resolve(repo,'package-lock.json')));
 const run={id:'builtin-test-12345678-1234-4123-8123-123456789abc',siteId:'tanjug-test',githubRunId:'123456',commit:'a'.repeat(40),target:{accountId:'1'.repeat(32),projectName:'tessera-fixture',previewBranch:'test',secretName:'CLOUDFLARE_API_TOKEN'},package:{descriptor:metadata.descriptor,zipSha256:metadata.zipSha256}};
 if(profile!=='archive-v1')run.delivery=await describeDelivery(metadata.descriptor,profile);
 const input=dispatchInputs(run),env={DEPLOY_INPUTS:JSON.stringify(input),GITHUB_REF:'refs/heads/'+DEPLOY_REF,GITHUB_REPOSITORY:DEPLOY_REPO,GITHUB_RUN_ID:run.githubRunId,GITHUB_SHA:run.commit};
 const selected=await selectDelivery(unzipSync(Buffer.from(zipBase64,'base64')),metadata.descriptor,run.delivery);
 const proof={input,runId:run.githubRunId,commit:run.commit,verified:{...metadata.descriptor,manifestSha256:input.manifest_sha256},zipSha256:run.package.zipSha256,project:{accountId:input.account_id,projectName:input.project_name,branch:input.branch,channel:'staging',productionBranch:'main'},...(run.delivery?{delivery:selected.delivery}:{})};
 for(const [name,bytes]of Object.entries(selected.files))await writeFile(resolve(dir,'dist',name),bytes);
 await writeFile(resolve(dir,'dist/_headers'),selected.headers);await writeFile(resolve(dir,'request.json'),JSON.stringify(run));await writeFile(resolve(dir,'verification.json'),JSON.stringify(proof));
 return{root,dir,env,proof,close:()=>rm(root,{recursive:true,force:true})};
}
for(const profile of ['archive-v1','publisher-scripts-v1'])test('accept exact original '+profile+' assets and headers',async()=>{const f=await fixture(profile);try{await verifyPreparedDelivery(f.root,f.env);}finally{await f.close();}});
for(const type of ['asset','headers','extra','symlink','run','commit','input','receipt','production','production-alias','missingclaim'])test('reject '+type+' before invoking action tools',async()=>{const f=await fixture();try{
 if(type==='asset')await writeFile(resolve(f.dir,'dist/ads.js'),'tampered');
 if(type==='headers')await writeFile(resolve(f.dir,'dist/_headers'),'tampered');
 if(type==='extra')await writeFile(resolve(f.dir,'dist/_worker.js'),'unexpected');
 if(type==='symlink'){await rm(resolve(f.dir,'dist/ads.js'));await symlink('/etc/hosts',resolve(f.dir,'dist/ads.js'));}
 if(type==='run')f.env.GITHUB_RUN_ID='777';
 if(type==='commit')f.env.GITHUB_SHA='b'.repeat(40);
 if(type==='input'){f.proof.input={...f.proof.input,correlation_id:'builtin-test-22345678-1234-4123-8123-123456789abc'};await writeFile(resolve(f.dir,'verification.json'),JSON.stringify(f.proof));}
 if(type==='production-alias'){f.proof.project.productionBranch=f.proof.input.branch;await writeFile(resolve(f.dir,'verification.json'),JSON.stringify(f.proof));}
 if(type==='receipt'){f.proof.verified.packageSha256='b'.repeat(64);await writeFile(resolve(f.dir,'verification.json'),JSON.stringify(f.proof));}
 if(type==='production')f.env.GITHUB_REF='refs/heads/main';
 if(type==='missingclaim')await rm(resolve(f.dir,'request.json'));
 let calls=0;await assert.rejects(preflight(f.root,f.env,()=>{calls++;}));assert.equal(calls,0);
 }finally{await f.close();}});
test('real no-install resolution uses locked tools Wrangler',async()=>assert.equal(await verifyPagesTools(repo),'4.131.0'));
test('failed or mismatched version cannot permit action fallback install',async()=>{for(const output of [{status:1,stdout:''},{status:0,stdout:'4.118.0\n'},{status:0,stdout:'wrangler 4.131.0-beta.1\n'},{status:0,stdout:'4.131.0\n4.118.0\n'}])await assert.rejects(verifyPagesTools(repo,(command,args,options)=>{assert.equal(command,'npx');assert.deepEqual(args,['--no-install','wrangler','--version']);assert.equal(options.cwd,resolve(repo,'tools'));assert.equal(options.shell,false);return output;}));});
test('unexpected tools Pages configuration or redirected configuration blocks action',async()=>{for(const name of ['wrangler.jsonc','.wrangler/deploy/config.json']){const path=resolve(repo,'tools',name);await mkdir(resolve(path,'..'),{recursive:true});try{await writeFile(path,'{}',{flag:'wx'});await assert.rejects(verifyPagesTools(repo),/configuration/);}finally{await rm(path);}}});
test('workflow retains pinned action, metadata and claim/verify/report separation',async()=>{
 const yaml=await readFile(resolve(repo,'.github/workflows/deploy-builtin-test.yml'),'utf8');
 assert.match(yaml,/wrangler-action@9acf94ace14e7dc412b076f2c5c20b8ce93c79cd/);assert.match(yaml,/workingDirectory: tools/);assert.match(yaml,/wranglerVersion: "4.131.0"/);assert.match(yaml,/packageManager: npm/);assert.match(yaml,/gitHubToken:.*GITHUB_TOKEN/);assert.match(yaml,/deployment_url:.*steps.deploy.outputs.deployment-url/);
 assert(yaml.indexOf('id: claim')<yaml.indexOf('builtin-pages-preflight.mjs'));assert(yaml.indexOf('builtin-pages-preflight.mjs')<yaml.indexOf('id: deploy'));assert.match(yaml,/pages deploy \.\.\/\.generated\/builtin-delivery\/dist/);assert.match(yaml,/--branch=/);assert.match(yaml,/--commit-message=/);
 for(const section of [yaml.slice(yaml.indexOf('\n  verify:')),await readFile(resolve(repo,'.github/workflows/verify-existing-builtin-test.yml'),'utf8')])assert.doesNotMatch(section,/wrangler-action|pages deploy|builtin-pages-preflight/);
});
