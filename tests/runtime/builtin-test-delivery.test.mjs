import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import worker from '../../worker/test-workspace/index.mjs';
import { metadata, zipBase64 } from '../../.generated/tanjug-pilot.mjs';
import { sha256 } from '../../worker/runtime/prebid-artifact-check.mjs';
import { describeCandidate } from '../../worker/runtime/draft-release-store.mjs';
import { deploymentState, saveTarget, requestDeployment, runnerResponse } from '../../worker/test-workspace/deployments.mjs';
import { STATE_KEY, readLedger, changeLedger, cacheDeliveryZip, readDeliveryZip } from '../../worker/test-workspace/deployment-store.mjs';
import { DEPLOY_ORIGIN, DEPLOY_REPO, DEPLOY_REF, dispatchInputs, validateRunnerInput, verifyDeliveryZip } from '../../worker/test-workspace/deployment-contract.mjs';
import { prepareDelivery, privateCall, runnerOutcome } from '../../scripts/builtin-test-delivery.mjs';
import { describeDelivery } from '../../worker/test-workspace/delivery-layout.mjs';
import { verifyPublicPackage } from '../../scripts/pages-release-verification.mjs';
import { deploymentStore, TARGET, TRANSFER_SECRET } from '../support/deployment-store.mjs';
import { TEST_EMAIL, TEST_PASSWORD } from '../support/test-workspace-store.mjs';

const actor={email:TEST_EMAIL}, commit='a'.repeat(40), runId='123456', url='https://1234abcd.tessera-fixture.pages.dev';
const zip=new Uint8Array(Buffer.from(zipBase64,'base64'));
const post=(path,body,headers={})=>new Request(DEPLOY_ORIGIN+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
async function setup(f) {return saveTarget(f.env,{expectedRevision:0,siteId:'tanjug-test',target:TARGET});}
async function publish(f, fetcher=async()=>new Response(null,{status:204})) {
  const {state}=await readLedger(f.env.BUILDS);
  return requestDeployment(f.env,actor,{expectedRevision:state.revision,siteId:'tanjug-test',action:'publish',releaseId:metadata.descriptor.releaseId,acknowledge:true},fetcher);
}
async function runner(f,run,operation,body,headers={}) {
  return runnerResponse(post(`/test-api/deployment-runner/${run.id}/${operation}`,body,{authorization:'Bearer '+TRANSFER_SECRET,...headers}),f.env,{});
}
async function claim(f,run,extra={}) {return (await runner(f,run,'claim',{inputs:dispatchInputs(run),runId,commit,...extra})).json();}
async function report(f,run,status,extra={}) {return (await runner(f,run,'report',{runId,commit,status,deploymentUrl:status==='success'?url:'',productionBranch:status==='success'?'main':'',...(status==='success'?{deliverySha256:run.delivery?.sha256}:{}),...extra})).json();}

test('setup is nonsecret, read-only until saved, preserves TEST DB and supports stale-tab protection',async()=>{
  const f=deploymentStore();try {
    delete f.env.TEST_GITHUB_ACTIONS_TOKEN;
    const initial=await deploymentState(f.env);
    assert.equal(initial.connection.githubConfigured,false);assert.equal(initial.sources[0].releaseId,metadata.descriptor.releaseId);
    assert.equal(f.deliveryPuts.length,0);
    await setup(f);
    await assert.rejects(publish(f),/još nije podešena/);
    await assert.rejects(saveTarget(f.env,{expectedRevision:0,siteId:'tanjug-test',target:{...TARGET,projectName:'other'}}),/promenjena/);
    for(const patch of [{previewBranch:'main'},{accountId:'bad'},{secretName:'actual-token'},{projectName:'x;echo'}])await assert.rejects(saveTarget(f.env,{expectedRevision:1,siteId:'tanjug-test',target:{...TARGET,...patch}}));
    const state=(await readLedger(f.env.BUILDS)).state;
    assert.deepEqual(state.targets['tanjug-test'],TARGET);assert.equal(state.runs.length,0);
    assert(!JSON.stringify(state).includes(TRANSFER_SECRET));assert.equal(f.log.puts.length,0);
    assert(!f.log.sql.some(sql=>/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(sql)));
  }finally{f.close();}
});
test('shared Cloudflare secret preserves each publisher destination from save through dispatch',async()=>{
  const shared='CLOUDFLARE_API_TOKEN';
  for(const destination of [TARGET,{...TARGET,accountId:'2'.repeat(32),projectName:'other-publisher',previewBranch:'publisher-test'}]) {
    const f=deploymentStore();try {
      const target={...destination,secretName:shared};
      await saveTarget(f.env,{expectedRevision:0,siteId:'tanjug-test',target});
      for(const secretName of ['GITHUB_TOKEN','TEST_DEPLOY_SECRET','CLOUDFLARE_API_TOKEN_','CLOUDFLARE_API_TOKEN;echo'])
        await assert.rejects(saveTarget(f.env,{expectedRevision:1,siteId:'tanjug-test',target:{...target,secretName}}));
      assert.deepEqual((await deploymentState(f.env)).targets['tanjug-test'],target);
      const calls=[];
      const {run}=await publish(f,async(u,o)=>{calls.push(JSON.parse(o.body));return new Response(null,{status:204});});
      assert.equal(calls.length,1);
      const input=calls[0].inputs;
      assert.equal(input.github_environment,shared);
      assert.equal(input.account_id,target.accountId);assert.equal(input.project_name,target.projectName);assert.equal(input.branch,target.previewBranch);
      assert.deepEqual(validateRunnerInput(input,'refs/heads/'+DEPLOY_REF,DEPLOY_REPO),dispatchInputs(run));
      assert.deepEqual(run.target,target);
    }finally{f.close();}
  }
});
test('concurrent publish requests dispatch only one exact pinned TEST package',async()=>{
  const f=deploymentStore();try {
    await setup(f);const calls=[];const fetcher=async(u,o)=>{calls.push({u,o});return new Response(null,{status:204});};
    const results=await Promise.allSettled([publish(f,fetcher),publish(f,fetcher)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls.length,1);
    const sent=JSON.parse(calls[0].o.body),run=(await readLedger(f.env.BUILDS)).state.runs[0];
    assert.equal(sent.ref,DEPLOY_REF);assert.deepEqual(sent.inputs,dispatchInputs(run));
    assert.equal(validateRunnerInput(sent.inputs,'refs/heads/'+DEPLOY_REF,DEPLOY_REPO),sent.inputs);
    assert.equal(sent.inputs.channel,'staging');assert.match(calls[0].u,/\/deploy-pages-release.yml\/dispatches$/);
    assert.equal(calls[0].o.redirect,'manual');assert.deepEqual(await readDeliveryZip(f.env.BUILDS,run.package),zip);
    assert.equal(run.package.descriptor.completeRelease,false);assert.equal(f.log.puts.length,0);
    await assert.rejects(saveTarget(f.env,{expectedRevision:(await readLedger(f.env.BUILDS)).state.revision,siteId:'tanjug-test',target:TARGET}),/prethodne objave/);
  }finally{f.close();}
});
test('ambiguous dispatch remains locked; rejected dispatch is distinct and a fast claim is not overwritten',async()=>{
  for(const mode of ['lost','rejected','fast']) {
    const f=deploymentStore();try{
      await setup(f);const result=await publish(f,async(u,o)=>{
        if(mode==='lost')throw Error('response lost');
        if(mode==='fast')await claim(f,(await readLedger(f.env.BUILDS)).state.runs[0]);
        return new Response(null,{status:mode==='rejected'?403:204});
      });
      assert.equal(result.run.status,{lost:'dispatch_unknown',rejected:'failed',fast:'running'}[mode]);
      if(mode!=='rejected')await assert.rejects(publish(f),/prethodnu objavu/);
    }finally{f.close();}
  }
});
test('runner claims once, authenticates bytes and binds results to the exact run and target',async()=>{
  const f=deploymentStore();try {
    await setup(f);const {run}=await publish(f);
    await assert.rejects(runner(f,run,'claim',{inputs:dispatchInputs(run),runId,commit},{authorization:'Bearer wrong'}),/authorization/);
    await assert.rejects(claim(f,run,{inputs:{...dispatchInputs(run),account_id:'2'.repeat(32)}}),/differ/);
    await claim(f,run);await assert.rejects(claim(f,run),/already been claimed/);
    const request=new Request(`${DEPLOY_ORIGIN}/test-api/deployment-runner/${run.id}/package`,{headers:{authorization:'Bearer '+TRANSFER_SECRET,'x-tessera-run-id':runId}});
    assert.deepEqual(new Uint8Array(await (await runnerResponse(request,f.env,{})).arrayBuffer()),zip);
    await assert.rejects(report(f,run,'success',{runId:'98765'}),/another workflow/);
    await assert.rejects(report(f,run,'success',{deploymentUrl:'https://tessera-fixture.pages.dev'}),/immutable URL/);
    await assert.rejects(report(f,run,'success',{productionBranch:'tessera-test'}),/Production branch proof/);
    await report(f,run,'unverified',{deploymentUrl:url});
    await assert.rejects(report(f,run,'failed'),/Inspect the existing/);
    await report(f,run,'success');
    const before=(await readLedger(f.env.BUILDS)).state;
    await report(f,run,'success');assert.equal((await readLedger(f.env.BUILDS)).state.revision,before.revision);
    await assert.rejects(report(f,run,'unverified',{deploymentUrl:url}),/final result/);
    await assert.rejects(publish(f),/već poslednja/);
  }finally{f.close();}
});
test('independent verification confirms an uncertain deployment while preserving original identity and immutable audit',async()=>{
  const f=deploymentStore();try {
    await setup(f);const {run}=await publish(f);await claim(f,run);await report(f,run,'unverified',{deploymentUrl:url});
    const audit={verificationRunId:'777777',verificationCommit:'b'.repeat(40)};
    for(const patch of [{verificationRunId:runId},{verificationCommit:'bad'},{verificationRunId:undefined},{status:'failed'}])
      await assert.rejects(report(f,run,'success',{...audit,...patch}),/verification identity/);
    await assert.rejects(report(f,run,'success',{...audit,runId:'777777'}),/another workflow/);
    const before=(await readLedger(f.env.BUILDS)).state.runs[0];
    const confirmed=(await report(f,run,'success',audit)).run;
    assert.equal(confirmed.status,'success');assert.equal(confirmed.githubRunId,runId);assert.equal(confirmed.commit,commit);
    assert.equal(confirmed.deploymentUrl,url);assert.deepEqual(confirmed.package,before.package);assert.deepEqual(confirmed.target,before.target);
    assert.equal(confirmed.verificationRunId,audit.verificationRunId);assert.equal(confirmed.verificationCommit,audit.verificationCommit);
    const revision=(await readLedger(f.env.BUILDS)).state.revision;
    await report(f,run,'success',audit);assert.equal((await readLedger(f.env.BUILDS)).state.revision,revision);
    await assert.rejects(report(f,run,'success'),/final result/);
    await assert.rejects(report(f,run,'success',{...audit,verificationRunId:'888888'}),/final result/);
    assert.equal((await readLedger(f.env.BUILDS)).state.runs.length,1);assert.equal(f.log.puts.length,0);
  }finally{f.close();}
});
test('restore redeploys every original byte and never regenerates the accepted package',async()=>{
  const f=deploymentStore();try {
    await setup(f);const {run:first}=await publish(f);await claim(f,first);await report(f,first,'success');
    // A second successful version is synthetic test evidence, never Tanjug v2.
    const files=unzipSync(zip);files['README.txt']=new TextEncoder().encode('Synthetic second release for rollback verification only.\n');
    const manifest=JSON.parse(new TextDecoder().decode(files['manifest.json']));manifest.files['README.txt']={byteSize:files['README.txt'].length,sha256:await sha256(files['README.txt'])};
    files['manifest.json']=new TextEncoder().encode(JSON.stringify(manifest));
    const {descriptor}=await describeCandidate('tanjug-test',{files});
    const secondDelivery=await describeDelivery(descriptor);
    const secondZip=zipSync(files,{level:0});const pin=await cacheDeliveryZip(f.env.BUILDS,secondZip);
    await changeLedger(f.env.BUILDS,undefined,s=>s.runs.unshift({...structuredClone(s.runs[0]),id:'builtin-test-'+crypto.randomUUID(),package:{...pin,descriptor,label:'Synthetic v2'},delivery:secondDelivery,createdAt:new Date().toISOString()}));
    const before=(await readLedger(f.env.BUILDS)).state;
    const {run:restore}=await requestDeployment(f.env,actor,{expectedRevision:before.revision,siteId:'tanjug-test',action:'restore',restoreId:first.id,acknowledge:true},async()=>new Response(null,{status:204}));
    assert.equal(restore.previousId,before.runs[0].id);assert.equal(restore.restoreId,first.id);
    assert.deepEqual(restore.package,first.package);assert.deepEqual(await readDeliveryZip(f.env.BUILDS,restore.package),zip);
    await claim(f,restore);await report(f,restore,'success',{deploymentUrl:'https://5678abcd.tessera-fixture.pages.dev'});
    const after=(await readLedger(f.env.BUILDS)).state;assert.equal(after.runs[0].package.descriptor.releaseId,first.package.descriptor.releaseId);
    assert.equal(after.runs[1].package.descriptor.releaseId,descriptor.releaseId);assert.equal(f.log.puts.length,0);
  }finally{f.close();}
});
test('private transfer rejects tampering before provider access; verifies actual preview branch and public delivery',async()=>{
  const f=deploymentStore();try {
    await setup(f);const {run}=await publish(f);const claimed=(await claim(f,run)).run,input=dispatchInputs(run);let providerCalls=0;
    const fetcher=async(u,o)=>{
      assert.equal(o.redirect,'error');
      if(u.endsWith('/package')){assert.equal(o.headers.Authorization,'Bearer '+TRANSFER_SECRET);return new Response(zip);}
      assert.match(u,/^https:\/\/api.cloudflare.com\/client\/v4\/accounts\/1111/);providerCalls++;
      assert.equal(o.headers.Authorization,'Bearer synthetic-scoped-token');return Response.json({success:true,result:{name:TARGET.projectName,production_branch:'main'}});
    };
    const prepared=await prepareDelivery({run:claimed,input,token:'synthetic-scoped-token',secret:TRANSFER_SECRET,fetcher});assert.equal(providerCalls,1);
    assert.equal(prepared.evidence.zipSha256,metadata.zipSha256);
    const publicResult=await verifyPublicPackage(url,TARGET.projectName,prepared.evidence.verified,async(u,o)=>{
      assert(!o.headers.Authorization);const name=new URL(u).pathname.slice(1);
      const type=name.endsWith('.js')?'application/javascript':name.endsWith('.json')?'application/json':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'text/plain';
      return new Response(prepared.files[name],{headers:{'content-type':type,'access-control-allow-origin':'*','x-content-type-options':'nosniff','cache-control':'no-store'}});
    });assert.equal(publicResult.fileCount,10);
    const bad=zip.slice();bad[100]^=1;
    await assert.rejects(prepareDelivery({run:claimed,input,token:'x',secret:TRANSFER_SECRET,fetcher:async(u)=>{assert(u.endsWith('/package'));return new Response(bad);}}),/ZIP differs/);
    for(const project of [{name:TARGET.projectName,production_branch:'tessera-test'},{name:'wrong',production_branch:'main'}])await assert.rejects(prepareDelivery({run:claimed,input,token:'x',secret:TRANSFER_SECRET,fetcher:async(u)=>u.endsWith('/package')?new Response(zip):Response.json({success:true,result:project})}));
  }finally{f.close();}
});
test('delivery route uses TEST boundary plus cookie/Origin or the exact dedicated runner authorization',async()=>{
  const f=deploymentStore();try {
    for(const path of ['/deployments','/test-api/deployments'])assert.equal((await worker.fetch(new Request(DEPLOY_ORIGIN+path),f.env)).status,path==='/deployments'?303:401);
    const login=await worker.fetch(new Request(DEPLOY_ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:DEPLOY_ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const page=await worker.fetch(new Request(DEPLOY_ORIGIN+'/deployments',{headers:{cookie}}),f.env);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/connect-src 'self'/);
    assert.match(await page.text(),/Istorija TEST objava/);
    const body={expectedRevision:0,siteId:'tanjug-test',target:TARGET};
    for(const origin of ['', 'null','https://foreign.invalid'])assert.equal((await worker.fetch(post('/test-api/deployments/target',body,{cookie,origin}),f.env)).status,403);
    assert.equal((await worker.fetch(post('/test-api/deployments/target',body,{cookie,origin:DEPLOY_ORIGIN}),f.env)).status,200);
    const {run}=await publish(f);
    const path=`/test-api/deployment-runner/${run.id}/claim`,claimBody={inputs:dispatchInputs(run),runId,commit};
    assert.equal((await worker.fetch(post(path,claimBody,{cookie}),f.env)).status,401);
    assert.equal((await worker.fetch(post(path,claimBody,{authorization:'Bearer '+TRANSFER_SECRET}),{...f.env,TEST_WORKSPACE_ENABLED:'false'})).status,503);
    assert.equal((await worker.fetch(post(path,claimBody,{authorization:'Bearer '+TRANSFER_SECRET}),f.env)).status,200);
    assert.equal((await worker.fetch(post('/test-api/deployments/request',{...body,channel:'production'},{cookie,origin:DEPLOY_ORIGIN}),f.env)).status,422);
  }finally{f.close();}
});
test('new runner keeps legacy guards, validates workflow identity before secrets, and separates reporting from deployment',async()=>{
  const fakeRun={id:'builtin-test-12345678-1234-4123-8123-123456789abc',siteId:'tanjug-test',package:{descriptor:metadata.descriptor},target:TARGET};
  const input=dispatchInputs(fakeRun);
  for(const patch of [{channel:'production'},{callback_url:'https://foreign.invalid'},{release_base_url:'https://foreign.invalid'},{github_environment:'GITHUB_TOKEN'},{branch:'main'}])assert.throws(()=>validateRunnerInput({...input,...patch},'refs/heads/'+DEPLOY_REF,DEPLOY_REPO));
  assert.throws(()=>validateRunnerInput(input,'refs/heads/main',DEPLOY_REPO));assert.throws(()=>validateRunnerInput(input,'refs/heads/'+DEPLOY_REF,'other/repo'));
  assert.equal(runnerOutcome('success','failure',url),'unverified');assert.equal(runnerOutcome('failure','skipped'),'unverified');assert.equal(runnerOutcome('','skipped'),'unverified');assert.equal(runnerOutcome('skipped','skipped'),'failed');
  await assert.rejects(privateCall(input,'report',TRANSFER_SECRET,{status:'success'},async()=>new Response('bad',{status:503})),/could not be confirmed/);
  const workflow=readFileSync(new URL('../../.github/workflows/deploy-builtin-test.yml',import.meta.url),'utf8');
  assert(workflow.indexOf('builtin-test-delivery.mjs validate')<workflow.indexOf('TEST_TRANSFER_SECRET:'));
  assert(!workflow.slice(workflow.indexOf('\n  report:')).includes('pages deploy'));
  const legacy=readFileSync(new URL('../../scripts/pages-release-verification.mjs',import.meta.url),'utf8');assert.match(legacy,/Built-in drafts cannot use legacy publication/);
});
