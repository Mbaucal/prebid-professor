import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { metadata, zipBase64 } from '../../.generated/tanjug-pilot.mjs';
import { describeDelivery, selectDelivery, deliveryHeaders, deliveryIdentity, SCRIPT_LAYOUT, ARCHIVE_LAYOUT } from '../../worker/test-workspace/delivery-layout.mjs';
import { prepareDelivery } from '../../scripts/builtin-test-delivery.mjs';
import { verifyDeliveryPublication } from '../../scripts/publisher-delivery-verification.mjs';
import { DEPLOY_ORIGIN, dispatchInputs } from '../../worker/test-workspace/deployment-contract.mjs';
import { saveTarget, requestDeployment, runnerResponse } from '../../worker/test-workspace/deployments.mjs';
import { changeLedger, readLedger } from '../../worker/test-workspace/deployment-store.mjs';
import { deploymentStore, TARGET, TRANSFER_SECRET } from '../support/deployment-store.mjs';

const zip=new Uint8Array(Buffer.from(zipBase64,'base64')),files=unzipSync(zip),descriptor=metadata.descriptor;
const origin='https://1234abcd.tessera-fixture.pages.dev',alias='https://tessera-test.tessera-fixture.pages.dev';
const verified={...descriptor,manifestSha256:descriptor.files.find(f=>f.name==='manifest.json').sha256};
const layout=await describeDelivery(descriptor),actor={email:'tester@example.invalid'},commit='a'.repeat(40);
async function publish(f) {
  return requestDeployment(f.env,actor,{expectedRevision:(await readLedger(f.env.BUILDS)).state.revision,siteId:'tanjug-test',action:'publish',releaseId:descriptor.releaseId,acknowledge:true},async()=>new Response(null,{status:204}));
}
async function runner(f,run,operation,body) {
  const request=new Request(`${DEPLOY_ORIGIN}/test-api/deployment-runner/${run.id}/${operation}`,{method:'POST',headers:{authorization:'Bearer '+TRANSFER_SECRET,'content-type':'application/json'},body:JSON.stringify(body)});
  return (await runnerResponse(request,f.env,{})).json();
}
async function finish(f,run,id='123456') {
  await runner(f,run,'claim',{inputs:dispatchInputs(run),runId:id,commit});
  return runner(f,run,'report',{runId:id,commit,status:'success',deploymentUrl:origin,productionBranch:'main',deliverySha256:run.delivery?.sha256});
}
test('publisher layout exposes exact minified ads.js and original Prebid while retaining all source bytes',async()=>{
  const snapshot=zip.slice();
  const selected=await selectDelivery(files,descriptor,layout);
  assert.deepEqual(Object.keys(selected.files),['ads.js','prebid.js']);
  assert.deepEqual(selected.files['ads.js'],files['ads.min.js']);assert.notDeepEqual(selected.files['ads.js'],files['ads.js']);
  assert.deepEqual(selected.files['prebid.js'],files['prebid.js']);assert.deepEqual(zip,snapshot);
  assert.equal(layout.profile,SCRIPT_LAYOUT);assert.match(selected.headers,/public, max-age=0, must-revalidate/);
  assert(!selected.headers.includes('no-store'));assert.equal(Object.keys(files).length,10);
  for(const mutate of [x=>x.files[0].sourceName='ads.js',x=>x.files[0].sha256='f'.repeat(64),x=>x.headersSha256='f'.repeat(64),x=>x.extra=true]) {
    const bad=structuredClone(layout);mutate(bad);await assert.rejects(selectDelivery(files,descriptor,bad),/layout differs/);
  }
  const badFiles={...files,'ads.min.js':new Uint8Array([1])};await assert.rejects(selectDelivery(badFiles,descriptor,layout),/bytes differ/);
  assert.equal((await describeDelivery({...descriptor,prebidBuild:null,files:descriptor.files.filter(f=>f.name!=='prebid.js')})).files.length,1);
});
test('old rows retain their full archive and no-store headers instead of acquiring the new layout',async()=>{
  const selected=await selectDelivery(files,descriptor,undefined);
  assert.equal(selected.delivery.profile,ARCHIVE_LAYOUT);assert.equal(Object.keys(selected.files).length,10);
  assert.deepEqual(selected.files,files);assert.match(selected.headers,/Cache-Control: no-store/);
  assert.equal(selected.headers,deliveryHeaders(ARCHIVE_LAYOUT));
  assert.notEqual(deliveryIdentity({package:{descriptor}}),deliveryIdentity({package:{descriptor},delivery:layout}));
});
test('new delivery of the same source is publishable and restore reinstates the exact historical layout',async()=>{
  const f=deploymentStore();try {
    await saveTarget(f.env,{expectedRevision:0,siteId:'tanjug-test',target:TARGET});
    const {run:old}=await publish(f);
    // Simulate a persisted pre-layout v1 row, without altering its archived bytes.
    await changeLedger(f.env.BUILDS,undefined,s=>delete s.runs[0].delivery);delete old.delivery;
    await finish(f,old);
    const {run:next}=await publish(f);assert.equal(next.package.zipSha256,old.package.zipSha256);assert.equal(next.delivery.profile,SCRIPT_LAYOUT);
    await runner(f,next,'claim',{inputs:dispatchInputs(next),runId:'234567',commit});
    for(const hash of [undefined,'f'.repeat(64)])await assert.rejects(runner(f,next,'report',{runId:'234567',commit,status:'success',deploymentUrl:origin,productionBranch:'main',deliverySha256:hash}),/another delivery layout/);
    await runner(f,next,'report',{runId:'234567',commit,status:'success',deploymentUrl:origin,productionBranch:'main',deliverySha256:next.delivery.sha256});
    await assert.rejects(publish(f),/već poslednja/);
    const restored=await requestDeployment(f.env,actor,{expectedRevision:(await readLedger(f.env.BUILDS)).state.revision,siteId:'tanjug-test',action:'restore',restoreId:old.id,acknowledge:true},async()=>new Response(null,{status:204}));
    assert.deepEqual(restored.run.package,old.package);assert.equal(restored.run.delivery.profile,ARCHIVE_LAYOUT);
    assert.equal(restored.run.delivery.files.length,10);assert.equal(restored.run.previousId,next.id);
    await finish(f,restored.run,'345678');
    assert.equal((await publish(f)).run.delivery.profile,SCRIPT_LAYOUT);
    assert.equal(f.log.puts.length,0);assert.deepEqual((await readLedger(f.env.BUILDS)).state.targets['tanjug-test'],TARGET);
  }finally{f.close();}
});
function publicFetch(mode='ok') {
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,options});assert([origin,alias].includes(new URL(url).origin));assert.equal(options.method,'GET');assert(!options.headers.Authorization);
    const name=new URL(url).pathname.slice(1),entry=layout.files.find(f=>f.name===name);
    if(!entry)return new Response(null,{status:mode==='leak'&&name==='config.json'?200:404});
    assert.equal(options.redirect,'error');
    if(options.headers['If-None-Match'])return new Response(null,{status:mode==='conditional'?200:304});
    const headers={'content-type':'application/javascript','access-control-allow-origin':'*','x-content-type-options':'nosniff','x-robots-tag':'noindex','cache-control':mode==='stale'?'public, max-age=3600':'public, max-age=0, must-revalidate','etag':'"fixture"'};
    if(mode==='etag')delete headers.etag;
    if(mode==='cors')delete headers['access-control-allow-origin'];
    if(mode==='mime')headers['content-type']='text/html';
    if(mode==='redirect')return new Response(null,{status:308,headers:{location:'https://other.invalid/ads.js'}});
    const data=(mode==='wrong-ads'&&name==='ads.js')?files['ads.js']:(mode==='alias'&&url.startsWith(alias))?new Uint8Array([1]):files[entry.sourceName];
    return new Response(data,{headers});
  };return {fetcher,calls};
}
test('publisher verification checks immutable and stable preview URLs, conditional cache, and excluded-file absence',async()=>{
  const input={project_name:TARGET.projectName,branch:TARGET.previewBranch},mock=publicFetch();
  const receipt=await verifyDeliveryPublication(origin,input,verified,layout,mock.fetcher);
  assert.equal(receipt.fileCount,2);assert.equal(receipt.previewAliasUrl,alias);assert.equal(receipt.deliverySha256,layout.sha256);
  assert(receipt.immutable.files.every(f=>f.revalidated));assert(receipt.preview.excludedFilesAbsent);assert.equal(mock.calls.length,28);
  for(const mode of ['wrong-ads','alias','stale','etag','cors','mime','redirect','conditional','leak'])
    await assert.rejects(verifyDeliveryPublication(origin,input,verified,layout,publicFetch(mode).fetcher));
  await assert.rejects(verifyDeliveryPublication(origin,{...input,branch:'main'},verified,layout,()=>assert.fail('No production fetch')));
});
test('runner keeps the original private ZIP while selecting the reviewed public layout before deployment',async()=>{
  const f=deploymentStore();try {
    await saveTarget(f.env,{expectedRevision:0,siteId:'tanjug-test',target:TARGET});const {run}=await publish(f);
    const claimed=(await runner(f,run,'claim',{inputs:dispatchInputs(run),runId:'123456',commit})).run;
    const prepared=await prepareDelivery({run:claimed,input:dispatchInputs(run),token:'synthetic',secret:TRANSFER_SECRET,fetcher:async(url,options)=>{
      assert.equal(options.redirect,'error');return url.endsWith('/package')?new Response(zip):Response.json({success:true,result:{name:TARGET.projectName,production_branch:'main'}});
    }});
    assert.equal(Object.keys(prepared.files).length,10);assert.equal(Object.keys(prepared.deploymentFiles).length,2);
    assert.deepEqual(prepared.deploymentFiles['ads.js'],files['ads.min.js']);assert.deepEqual(prepared.evidence.delivery,run.delivery);
    assert.equal(prepared.evidence.zipSha256,metadata.zipSha256);
  }finally{f.close();}
});
