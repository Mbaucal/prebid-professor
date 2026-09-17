import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/test-workspace/index.mjs';
import { deploymentStore } from '../support/deployment-store.mjs';
import { metadata } from '../../.generated/tanjug-pilot.mjs';
import { saveExperiment,transitionExperiment,readExperiments,currentExperiment,EXPERIMENT_KEY } from '../../worker/test-workspace/experiments.mjs';
const actor={email:'tester@example.invalid'};
const origin='https://prebid-professor-test.mbaucal.workers.dev';
const body=(expectedRevision=0)=>({expectedRevision,siteId:'tanjug-test',releaseA:metadata.descriptor.releaseId,releaseB:metadata.descriptor.releaseId,trafficB:50});
test('saved choices, Start/Stop and history survive rereads without changing the package',async()=>{
  const f=deploymentStore();try{
    const saved=await saveExperiment(f.env,actor,body());const row=structuredClone(saved.experiments[0]);
    assert.equal(saved.revision,1);assert.equal(saved.events.length,0);
    const active=await transitionExperiment(f.env,actor,{expectedRevision:1,experimentId:row.id},'started');
    assert.equal(currentExperiment(active,'tanjug-test').active,true);
    const edited=await saveExperiment(f.env,actor,{...body(2),trafficB:10});
    assert.deepEqual(edited.experiments[0],row);
    assert.equal(currentExperiment(edited,'tanjug-test').item.trafficB,50);
    await assert.rejects(transitionExperiment(f.env,actor,{expectedRevision:3,experimentId:edited.experiments[1].id},'started'),/Stop the active/);
    const stopped=await transitionExperiment(f.env,actor,{expectedRevision:3,experimentId:row.id},'stopped');
    assert.equal(currentExperiment(stopped,'tanjug-test').active,false);
    const next=await transitionExperiment(f.env,actor,{expectedRevision:4,experimentId:edited.experiments[1].id},'started');
    assert.equal(currentExperiment(next,'tanjug-test').item.trafficB,10);
    assert.deepEqual(next.experiments[0],row);assert.equal(next.events.length,3);
    assert.deepEqual((await readExperiments(f.env.BUILDS)).state,next);
    assert(f.deliveryPuts.every(k=>k===EXPERIMENT_KEY||k.startsWith('test-deployments/v1/packages/')));
    assert.equal(f.log.puts.length,0);
  }finally{f.close();}
});
test('two stale tabs cannot both save or start; invalid and cross-site choices make no experiment',async()=>{
  const f=deploymentStore();try{
    for(const input of [{...body(),siteId:'tanjug.rs'},{...body(),trafficB:101},{...body(),trafficB:0.1},{...body(),releaseB:'builtin-draft-'+'f'.repeat(64)}])await assert.rejects(saveExperiment(f.env,actor,input));
    assert.equal((await readExperiments(f.env.BUILDS)).state.revision,0);
    const saves=await Promise.allSettled([saveExperiment(f.env,actor,body()),saveExperiment(f.env,actor,body())]);
    assert.equal(saves.filter(r=>r.status==='fulfilled').length,1);
    const state=(await readExperiments(f.env.BUILDS)).state;
    const action={expectedRevision:1,experimentId:state.experiments[0].id};
    const starts=await Promise.allSettled([transitionExperiment(f.env,actor,action,'started'),transitionExperiment(f.env,actor,action,'started')]);
    assert.equal(starts.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await readExperiments(f.env.BUILDS)).state.events.length,1);
  }finally{f.close();}
});
test('missing/corrupt pinned bytes cannot start but Stop remains available',async()=>{
  const f=deploymentStore();try{
    const saved=await saveExperiment(f.env,actor,body()),row=saved.experiments[0];
    await transitionExperiment(f.env,actor,{expectedRevision:1,experimentId:row.id},'started');
    const key='test-deployments/v1/packages/'+row.a.zipSha256+'.zip';
    f.deliveryObjects.get(key).bytes[0]^=1;
    await transitionExperiment(f.env,actor,{expectedRevision:2,experimentId:row.id},'stopped');
    await assert.rejects(transitionExperiment(f.env,actor,{expectedRevision:3,experimentId:row.id},'started'),/differs/);
    assert.equal(currentExperiment((await readExperiments(f.env.BUILDS)).state,'tanjug-test').active,false);
  }finally{f.close();}
});
test('actual Worker routes enforce TEST login, same-origin writes, immutable selection and private preview caching',async()=>{
  const f=deploymentStore();try{
    for(const path of ['/experiments','/experiments.js','/test-api/experiments','/test-api/experiments/preview/tanjug-test/ads.js'])assert.equal((await worker.fetch(new Request(origin+path),f.env)).status,path.startsWith('/test-api')?401:303);
    const login=await worker.fetch(new Request(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:actor.email,password:'Local-fixture-only-password-927!'})}),f.env);
    assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
    const call=(path,body,extra={})=>worker.fetch(new Request(origin+path,{method:body?'POST':'GET',headers:{cookie,...(body?{origin,'content-type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined}),f.env);
    const api='/test-api/experiments';
    assert.equal((await call(api+'/save',body(),{origin:'https://other.invalid'})).status,403);
    assert.equal((await call(api+'/save',{...body(),sourceCode:'untrusted'})).status,422);
    const saved=await (await call(api+'/save',body())).json();assert.equal(saved.experiments.length,1);
    const row=saved.experiments[0];
    assert.equal((await call(api+'/preview/tanjug-test/ads.js')).status,409);
    assert.equal((await call(api+'/start',{expectedRevision:1,experimentId:row.id})).status,200);
    const loader=await call(api+'/preview/tanjug-test/ads.js');assert.equal(loader.status,200);
    assert.match(await loader.text(),/"active":true/);
    const asset=await call(api+'/preview/tanjug-test/releases/'+row.a.packageSha256+'/ads.js');
    assert.equal(asset.status,200);
    for(const h of ['cache-control','cdn-cache-control','cloudflare-cdn-cache-control'])assert.match(asset.headers.get(h),/no-store/);
    assert.equal((await call(api+'/stop',{expectedRevision:2,experimentId:row.id})).status,200);
    assert.match(await (await call(api+'/preview/tanjug-test/ads.js')).text(),/"active":false,"variant":"A"/);
    assert.equal((await call(api+'/preview/tanjug-test/releases/'+row.a.packageSha256+'/ads.js')).status,200);
    assert.equal((await call(api+'/preview/test-site/ads.js')).status,409);
    assert.equal((await call(api+'?site=tanjug.rs')).status,404);
    assert.equal((await worker.fetch(new Request('https://tanjug.rs'+api,{headers:{cookie}}),f.env)).status,404);
    assert.equal(f.log.puts.length,0);
  }finally{f.close();}
});
