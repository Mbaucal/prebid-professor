import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,writeFile,symlink,rm,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const repo=resolve(import.meta.dirname,'../..');
const closure=['scripts/reverify-builtin-test.mjs','scripts/builtin-test-delivery.mjs','scripts/pages-release-verification.mjs','scripts/publisher-delivery-verification.mjs','worker/test-workspace/deployment-contract.mjs','worker/test-workspace/delivery-layout.mjs','worker/runtime/draft-release-store.mjs','worker/runtime/prebid-artifact-check.mjs'];

test('clean reverify CLI needs locked production fflate; report retry only waits and confirms existing receipt',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'mba236-'));
 try{
  const request=JSON.parse(await readFile(resolve(repo,'ops/runtime-test/verify-existing.json'),'utf8'));
  for(const path of [...closure,'ops/runtime-test/verify-existing.json',request.sourcePath]){
   await mkdir(resolve(root,path,'..'),{recursive:true});await cp(resolve(repo,path),resolve(root,path));
  }
  const env={PATH:process.env.PATH,TZ:'UTC',GITHUB_REF:'refs/heads/feature/isolated-runtime-workspace-v1',GITHUB_REPOSITORY:'Mbaucal/prebid-professor',GITHUB_RUN_ID:'7777777',GITHUB_SHA:'b'.repeat(40)};
  const invoke=(mode,extra={})=>spawnSync(process.execPath,[...(mode==='report'?['--import',resolve(root,'synthetic-network.mjs')]:[]),'scripts/reverify-builtin-test.mjs',mode],{cwd:root,env:{...env,...extra},encoding:'utf8',timeout:15000});
  const missing=invoke('validate');assert.notEqual(missing.status,0);assert.match(missing.stderr,/Cannot find package 'fflate'/);
  await mkdir(resolve(root,'node_modules'));
  await symlink(resolve(repo,'node_modules/fflate'),resolve(root,'node_modules/fflate'),'dir');
  assert.equal(await realpath(resolve(root,'node_modules/fflate')),resolve(repo,'node_modules/fflate'));
  const lock=JSON.parse(await readFile(resolve(repo,'package-lock.json'),'utf8'));
  assert.equal(JSON.parse(await readFile(resolve(root,'node_modules/fflate/package.json'),'utf8')).version,lock.packages['node_modules/fflate'].version);
  const validated=invoke('validate');assert.equal(validated.status,0,validated.stderr);assert.match(validated.stdout,/source evidence validated/);
  const source=JSON.parse(await readFile(resolve(root,request.sourcePath),'utf8'));
  const receipt={verified:true,runId:source.runId,commit:source.commit,verificationRunId:env.GITHUB_RUN_ID,verificationCommit:env.GITHUB_SHA,deploymentUrl:request.deploymentUrl,sourceSha256:request.sourceSha256,zipSha256:source.zipSha256,packageSha256:source.verified.packageSha256,manifestSha256:source.input.manifest_sha256,fileCount:source.verified.files.length,files:source.verified.files,project:source.project};
  const receiptPath=resolve(root,'.generated/builtin-reverification/receipt.json');await mkdir(resolve(receiptPath,'..'),{recursive:true});await writeFile(receiptPath,JSON.stringify(receipt));
  const original=await readFile(receiptPath);
  await writeFile(resolve(root,'synthetic-network.mjs'),`
import assert from 'node:assert/strict';import{appendFileSync}from'node:fs';
const checks='https://api.github.com/repos/Mbaucal/prebid-professor/commits/'+process.env.GITHUB_SHA+'/check-runs?per_page=100';
const callback=${JSON.stringify(source.input.callback_url)};let polls=0;
const timer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>timer(fn,ms===5000?0:ms,...args);
globalThis.fetch=async(url,options)=>{
 appendFileSync('requests.jsonl',JSON.stringify({url,method:options.method})+'\\n');
 assert.equal(options.redirect,'error');
 if(url===checks){assert.equal(options.method,'GET');polls++;return Response.json({check_runs:polls===1?[]:[{name:'Workers Builds: prebid-professor-test',head_sha:process.env.GITHUB_SHA,status:'completed',conclusion:process.env.BUILD_FAIL?'failure':'success'}]});}
 assert.equal(url,callback,'No claim, package read, dispatch or deploy is allowed during report');assert.equal(options.method,'POST');
 if(process.env.REPORT_FAIL)return new Response('synthetic unavailable',{status:503});
 const body=JSON.parse(options.body);return Response.json({run:{...body,githubRunId:body.runId}});
};`);
  const runReport=async(extra)=>{await writeFile(resolve(root,'requests.jsonl'),'');const r=invoke('report',{GH_READ_TOKEN:'synthetic-read',TEST_TRANSFER_SECRET:'s'.repeat(32),...extra});const calls=(await readFile(resolve(root,'requests.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);assert.deepEqual(await readFile(receiptPath),original);return{r,calls};};
  const failedBuild=await runReport({BUILD_FAIL:'1'});assert.notEqual(failedBuild.r.status,0);assert.match(failedBuild.r.stderr,/TEST Worker build failed/);assert.deepEqual(failedBuild.calls.map(c=>c.method),['GET','GET']);
  const failedReport=await runReport({REPORT_FAIL:'1'});assert.notEqual(failedReport.r.status,0);assert.match(failedReport.r.stderr,/503/);assert.deepEqual(failedReport.calls.map(c=>c.method),['GET','GET','POST']);
  const retried=await runReport({});assert.equal(retried.r.status,0,retried.r.stderr);assert.deepEqual(retried.calls,failedReport.calls);assert.match(retried.r.stdout,/No deployment was made/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('reverify workflow preserves TEST recipe trigger, receipt artifacts and separate report-only retry',async()=>{
 const workflow=await readFile(resolve(repo,'.github/workflows/verify-existing-builtin-test.yml'),'utf8');
 assert.match(workflow,/branches: \[feature\/isolated-runtime-workspace-v1\]\n    paths: \[ops\/runtime-test\/verify-existing.json\]/);
 assert.equal((workflow.match(/node-version: 22\.23\.3/g)||[]).length,2);
 assert.equal((workflow.match(/run: node scripts\/builtin-toolchain.mjs bootstrap\n/g)||[]).length,2);
 assert.doesNotMatch(workflow,/npm ci|--profile|workflow_dispatch|wrangler|scripts\/builtin-test-delivery.mjs/);
 const report=workflow.split('\n  report:\n')[1];assert.match(report,/needs: verify/);assert.match(report,/name: \$\{\{ needs.verify.outputs.receipt_artifact \}\}/);assert.match(report,/reverify-builtin-test.mjs report/);assert.doesNotMatch(report,/reverify-builtin-test.mjs verify/);
 assert.match(workflow,/path: .generated\/builtin-reverification\/receipt.json/);assert.match(workflow,/retention-days: 90/);
});
