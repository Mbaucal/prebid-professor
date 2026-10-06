import assert from 'node:assert/strict';
import {readFile,readdir,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {verifyIsolation,sha} from './verify-toolchain-isolation.mjs';
import {validateRunnerInput,dispatchInputs} from '../worker/test-workspace/deployment-contract.mjs';
import {describeDelivery,deliveryHeaders} from '../worker/test-workspace/delivery-layout.mjs';
export const WRANGLER_VERSION='4.131.0';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function absent(path){try{await lstat(path);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}}
export async function verifyPreparedDelivery(repo,env){
 const input=validateRunnerInput(JSON.parse(env.DEPLOY_INPUTS||'null'),env.GITHUB_REF,env.GITHUB_REPOSITORY);
 assert(/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID)&&/^[a-f0-9]{40}$/.test(env.GITHUB_SHA),'Invalid workflow identity.');
 const dir=resolve(repo,'.generated/builtin-delivery');
 for(const name of ['request.json','verification.json','dist'])assert(!(await lstat(resolve(dir,name))).isSymbolicLink(),'Delivery inputs must not be symlinks.');
 const run=JSON.parse(await readFile(resolve(dir,'request.json'),'utf8'));
 const proof=JSON.parse(await readFile(resolve(dir,'verification.json'),'utf8'));
 assert.equal(run.githubRunId,env.GITHUB_RUN_ID);assert.equal(run.commit,env.GITHUB_SHA);
 assert.deepEqual(dispatchInputs(run),input,'Claim belongs to a different request.');
 assert.equal(proof.runId,env.GITHUB_RUN_ID);assert.equal(proof.commit,env.GITHUB_SHA);assert.deepEqual(proof.input,input);
 assert.deepEqual(proof.verified,{...run.package.descriptor,manifestSha256:input.manifest_sha256},'Prepared package differs from claimed original.');
 assert(/^[a-f0-9]{64}$/.test(run.package.zipSha256),'Claimed ZIP hash is missing.');assert.equal(proof.zipSha256,run.package.zipSha256);
 assert.equal(proof.project.accountId,input.account_id);assert.equal(proof.project.projectName,input.project_name);
 assert.equal(proof.project.branch,input.branch);assert.equal(proof.project.channel,'staging');
 assert(typeof proof.project.productionBranch==='string'&&proof.project.productionBranch.length>0&&proof.project.productionBranch!==input.branch,'TEST target must differ from actual production branch.');
 const delivery=await describeDelivery(run.package.descriptor,run.delivery?.profile??'archive-v1');
 if(run.delivery)assert.deepEqual(run.delivery,delivery);
 if(proof.delivery)assert.deepEqual(proof.delivery,delivery);
 const files=await readdir(resolve(dir,'dist'));
 assert.deepEqual(files.sort(),[...delivery.files.map(f=>f.name),'_headers'].sort(),'Prepared file set changed.');
 for(const f of [...delivery.files,{name:'_headers',sha256:delivery.headersSha256,byteSize:Buffer.byteLength(deliveryHeaders(delivery.profile))}]){
  const path=resolve(dir,'dist',f.name);const stat=await lstat(path);assert(stat.isFile()&&!stat.isSymbolicLink(),'Only original regular asset files may be published.');
  const bytes=await readFile(path);assert.equal(bytes.length,f.byteSize);assert.equal(sha(bytes),f.sha256,'Prepared asset/header changed: '+f.name);
 }
 return {input,delivery};
}
export async function verifyPagesTools(repo,execute=spawnSync){
 await verifyIsolation(repo,{profile:'test'});
 const cwd=resolve(repo,'tools');
 assert.equal(await realpath(resolve(cwd,'node_modules/.bin/wrangler')),resolve(cwd,'node_modules/wrangler/bin/wrangler.js'),'Wrangler resolution escaped locked tools.');
 // Pages discovers configuration/functions from cwd. Reject additional implicit inputs;
 // the existing parent Worker config has no Pages output directory and is ignored by Pages.
 for(const base of [repo,cwd])for(const name of ['functions','wrangler.toml','wrangler.json','.wrangler/deploy/config.json'])assert(await absent(resolve(base,name)),'Unexpected Pages configuration/functions.');
 assert(await absent(resolve(cwd,'wrangler.jsonc')),'Unexpected tools Pages configuration.');
 const workerConfig=await readFile(resolve(repo,'wrangler.jsonc'),'utf8');assert(!workerConfig.includes('pages_build_output_dir'),'Parent configuration became a Pages configuration.');
 const result=execute('npx',['--no-install','wrangler','--version'],{cwd,encoding:'utf8',shell:false,env:{...process.env,WRANGLER_SEND_METRICS:'false',CI:'true'}});
 assert.equal(result.status,0,'Locked Wrangler must execute before the action can run.');
 const versions=result.stdout?.match(/\d+\.\d+\.\d+[^\s]*/g)??[];
 assert.deepEqual(versions,[WRANGLER_VERSION],'Ambiguous or nonexact Wrangler version output.');
 const actual=versions[0];
 assert.equal(actual,WRANGLER_VERSION,'Action must reuse the exact installed Wrangler; no fallback installation.');
 return actual;
}
export async function preflight(repo,env,execute){await verifyPreparedDelivery(repo,env);return verifyPagesTools(repo,execute);}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert.equal(process.argv.length,2,'No arguments or command passthrough accepted.');
 preflight(root,process.env).then(version=>console.log('Verified original TEST assets and locked Wrangler '+version)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
