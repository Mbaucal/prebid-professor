import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { metadata, zipBase64 } from '../../.generated/tanjug-pilot.mjs';
import { DEPLOY_REF, DEPLOY_REPO } from '../../worker/test-workspace/deployment-contract.mjs';
import { validateRecovery, reverifyExisting, reportRecovery, validateReceipt } from '../../scripts/reverify-builtin-test.mjs';
import { verifyPublicPackage } from '../../scripts/pages-release-verification.mjs';

const sha = bytes=>createHash('sha256').update(bytes).digest('hex');
const zip = new Uint8Array(Buffer.from(zipBase64,'base64')), files = unzipSync(zip);
const request = JSON.parse(readFileSync(new URL('../../ops/runtime-test/verify-existing.json',import.meta.url)));
const sourceBytes = readFileSync(new URL('../../'+request.sourcePath,import.meta.url));
const context = {ref:'refs/heads/'+DEPLOY_REF,repo:DEPLOY_REPO,runId:'7777777',commit:'b'.repeat(40)};
const recovery = validateRecovery(request,sourceBytes,context);
const {source,input,deploymentUrl:origin} = recovery;
const headersFor = name=>({'content-type':name.endsWith('.js')?'application/javascript':name.endsWith('.json')?'application/json':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'text/plain',
  'access-control-allow-origin':'*','x-content-type-options':'nosniff','cache-control':'no-store'});
const publicFile = name=>new Response(files[name],{headers:headersFor(name)});

test('HTML canonical redirect verifies original bytes with one same-origin hop',async()=>{
  for (const status of [301,308]) {
    const calls=[];
    const fetcher=async(url,options)=>{
      calls.push(url);assert.equal(options.method,'GET');assert.deepEqual(options.headers,{});
      const name=new URL(url).pathname.slice(1);
      if(name==='implementation.html') {assert.equal(options.redirect,'manual');return new Response(null,{status,headers:{location:status===301?origin+'/implementation':'/implementation'}});}
      assert.equal(options.redirect,'error');return publicFile(name==='implementation'?'implementation.html':name);
    };
    assert.equal((await verifyPublicPackage(origin,input.project_name,source.verified,fetcher)).fileCount,10);
    assert.equal(calls.length,11);
  }
});
test('HTML canonical exception rejects foreign destinations, extra hops, bad bytes and missing headers',async()=>{
  for (const mode of ['foreign','query','fragment','path','double','js','body','mime','cors','cache','nosniff','302','307','missing']) {
    let canonicalCalls=0;
    await assert.rejects(verifyPublicPackage(origin,input.project_name,source.verified,async(url,options)=>{
      const name=new URL(url).pathname.slice(1);
      if(name==='ads.js'&&mode==='js') {assert.equal(options.redirect,'error');return new Response(null,{status:308,headers:{location:'/ads'}});}
      if(name==='implementation.html') {
        const locations={foreign:'https://other.invalid/implementation',query:'/implementation?x=1',fragment:'/implementation#x',path:'/other'};
        return new Response(null,{status:['302','307'].includes(mode)?Number(mode):308,headers:mode==='missing'?{}:{location:locations[mode]||'/implementation'}});
      }
      if(name==='implementation') {
        canonicalCalls++;assert.equal(options.redirect,'error');
        if(mode==='double')return new Response(null,{status:308,headers:{location:'/other'}});
        const headers=headersFor('implementation.html');
        const key={mime:'content-type',cors:'access-control-allow-origin',cache:'cache-control',nosniff:'x-content-type-options'}[mode];
        if(key)delete headers[key];
        return new Response(mode==='body'?'changed':files['implementation.html'],{headers});
      }
      return publicFile(name);
    }), mode==='js'?/ads.js/:/implementation.html/);
    assert(canonicalCalls<=1);
  }
});
test('recovery rejects mismatched reviewed evidence and production context before network',()=>{
  assert.equal(source.zipSha256,sha(zip));assert.equal(source.verified.packageSha256,metadata.descriptor.packageSha256);
  for(const patch of [{ref:'refs/heads/main'},{repo:'other/repo'},{runId:request.deploymentRunId},{commit:'bad'}])
    assert.throws(()=>validateRecovery(request,sourceBytes,{...context,...patch}));
  for(const patch of [{sourcePath:'../../secret'},{sourceSha256:'f'.repeat(64)},{deploymentCommit:'c'.repeat(40)},{deploymentUrl:'https://tanjug.pages.dev'},{extra:true}])
    assert.throws(()=>validateRecovery({...request,...patch},sourceBytes,context));
  for(const mutate of [s=>s.input.branch='main',s=>s.input.callback_url='https://other.invalid',s=>s.input.github_environment='GITHUB_TOKEN',s=>s.verified.manifestSha256='f'.repeat(64),s=>s.project.projectName='wrong']) {
    const s=structuredClone(source);mutate(s);const bytes=Buffer.from(JSON.stringify(s));
    assert.throws(()=>validateRecovery({...request,sourceSha256:sha(bytes)},bytes,context));
  }
});
function recoveryFetch({badRun=false,badZip=false,badPublic=false,production=false}={}) {
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,method:options.method});assert.equal(options.method,'GET');
    if(url.startsWith('https://api.github.com/')) {assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer github-fixture');return Response.json({id:Number(request.deploymentRunId),repository:{full_name:DEPLOY_REPO},event:'workflow_dispatch',head_sha:badRun?'a'.repeat(40):request.deploymentCommit,head_branch:DEPLOY_REF,path:'.github/workflows/deploy-pages-release.yml',status:'completed'});}
    if(url.endsWith('/package')) {assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+'s'.repeat(32));assert.equal(options.headers['x-tessera-run-id'],source.runId);return new Response(badZip?'wrong':zip);}
    if(url.startsWith('https://api.cloudflare.com/')) {assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer cloudflare-fixture');return Response.json({success:true,result:{name:input.project_name,production_branch:production?input.branch:'main'}});}
    assert(url.startsWith(origin+'/'));assert.deepEqual(options.headers,{});
    const name=new URL(url).pathname.slice(1);
    if(name==='implementation.html')return new Response(null,{status:308,headers:{location:'/implementation'}});
    if(name==='ads.js'&&badPublic)return new Response('changed',{headers:headersFor(name)});
    return publicFile(name==='implementation'?'implementation.html':name);
  };
  return {calls,fetcher};
}
test('recovery reads exact original private/public bytes and reports only the original deployment with separate audit',async()=>{
  const mock=recoveryFetch();
  const receipt=await reverifyExisting({recovery,githubToken:'github-fixture',cloudflareToken:'cloudflare-fixture',secret:'s'.repeat(32),fetcher:mock.fetcher});
  assert.equal(mock.calls.length,14);assert.equal(receipt.fileCount,10);assert.equal(receipt.runId,source.runId);assert.equal(receipt.verificationRunId,context.runId);
  validateReceipt(receipt,recovery);
  for(const patch of [{runId:context.runId},{verificationCommit:'a'.repeat(40)},{deploymentUrl:'https://abcdef12.tanjug.pages.dev'},{zipSha256:'f'.repeat(64)},{files:[]},{verified:false}]) {
    await assert.rejects(reportRecovery({recovery,receipt:{...receipt,...patch},secret:'s'.repeat(32),fetcher:()=>assert.fail('No callback on invalid evidence')}));
  }
  let posts=0;
  await reportRecovery({recovery,receipt,secret:'s'.repeat(32),fetcher:async(url,options)=>{
    posts++;assert.equal(url,input.callback_url);assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body);assert.equal(body.runId,source.runId);assert.equal(body.commit,source.commit);assert.equal(body.verificationRunId,context.runId);assert.equal(body.verificationCommit,context.commit);
    return Response.json({run:{...body,githubRunId:body.runId}});
  }});assert.equal(posts,1);
});
test('recovery stops before provider or success callback when original identity, bytes, branch or public proof differ',async()=>{
  for(const key of ['badRun','badZip','production','badPublic']) {
    const mock=recoveryFetch({[key]:true});
    await assert.rejects(reverifyExisting({recovery,githubToken:'github-fixture',cloudflareToken:'cloudflare-fixture',secret:'s'.repeat(32),fetcher:mock.fetcher}));
    if(key==='badRun')assert.equal(mock.calls.length,1);
    if(key==='badZip')assert.equal(mock.calls.length,2);
    assert(mock.calls.every(c=>c.method==='GET'));
  }
});
