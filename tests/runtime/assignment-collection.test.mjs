import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from '../../worker/test-workspace/index.mjs';
import { deploymentStore } from '../support/deployment-store.mjs';
import { metadata } from '../../.generated/tanjug-pilot.mjs';
import { issueAssignmentTicket,verifyAssignmentTicket } from '../../worker/test-workspace/assignment-ticket.mjs';
import { storeAssignment,assignmentSummary,MAX_ASSIGNMENTS } from '../../worker/test-workspace/assignment-store.mjs';
import { experimentFixture,experimentConfig } from '../support/experiment-fixture.mjs';
import { createCollectedDelivery,COLLECTED_PROFILE } from '../../worker/experiments/collected-delivery.mjs';
import { createExperimentDelivery } from '../../worker/experiments/delivery.mjs';
const secret='Local-test-signing-secret-for-assignments-only';
const origin='https://prebid-professor-test.mbaucal.workers.dev';
const identity={experimentId:'experiment-00000000-0000-4000-8000-000000000000',siteId:'test-site',deliverySha256:'a'.repeat(64),packageSha256:'b'.repeat(64),variant:'A'};
const plan={schemaVersion:1,kind:'tessera-gam-reporting-plan',...identity,arms:['A','B'].map(variant=>({variant,packageSha256:identity.packageSha256,trafficPercent:50}))};
test('tickets reject tampering, wrong keys, expiry and future issue times',async()=>{
 const now=Date.parse('2026-09-17T12:00:00.000Z'),ticket=await issueAssignmentTicket(identity,secret,now);
 const claim=await verifyAssignmentTicket(ticket,secret,now);assert.equal(claim.variant,'A');assert.equal(claim.assignmentId.length,32);
 for(const [value,key,time] of [[ticket+'a',secret,now],[ticket,secret+'wrong',now],[ticket,secret,now+3600000],[ticket,secret,now-31000],['garbage',secret,now]])await assert.rejects(verifyAssignmentTicket(value,key,time),/Invalid or expired/);
});
test('atomic collection deduplicates retries, unions outcomes and preserves full samples',async()=>{
 const f=deploymentStore();try{
  const claim=await verifyAssignmentTicket(await issueAssignmentTicket(identity,secret),secret);
  await Promise.all([storeAssignment(f.env.BUILDS,plan,claim,['assigned']),storeAssignment(f.env.BUILDS,plan,claim,['assigned','script-loaded'])]);
  await storeAssignment(f.env.BUILDS,plan,claim,['assigned']);
  assert.equal((await assignmentSummary(f.env.BUILDS,plan)).totals.A.assigned,1);
  assert.equal((await assignmentSummary(f.env.BUILDS,plan)).totals.A.scriptLoaded,1);
  await assert.rejects(storeAssignment(f.env.BUILDS,plan,{...claim,packageSha256:'f'.repeat(64)},['assigned']),/package/);
  await assert.rejects(storeAssignment(f.env.BUILDS,plan,claim,['impression']),/outcomes/);
  const key='test-experiments/assignments-v1/'+plan.deliverySha256+'.json',entry=f.deliveryObjects.get(key);
  const records=Array.from({length:MAX_ASSIGNMENTS},(_,i)=>({assignmentId:i.toString(16).padStart(32,'0'),variant:'A',packageSha256:claim.packageSha256,assignedAt:claim.assignedAt,types:['assigned']}));
  entry.bytes=new TextEncoder().encode(JSON.stringify({schemaVersion:1,deliverySha256:plan.deliverySha256,records}));
  await assert.rejects(storeAssignment(f.env.BUILDS,plan,claim,['assigned']),/sample is full/);
  await storeAssignment(f.env.BUILDS,plan,{...claim,assignmentId:records[0].assignmentId},['assigned','load-error']);
  const summary=await assignmentSummary(f.env.BUILDS,plan);assert.equal(summary.totals.A.assigned,MAX_ASSIGNMENTS);assert.equal(summary.totals.A.loadError,1);assert.equal(summary.atCapacity,true);assert.equal(summary.coverage,'unknown');
 }finally{f.close();}
});
const settle=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert(predicate());};
test('new loader retries a lost acknowledgement, reports load errors and never restarts duplicate ads',async()=>{
 const a=await experimentFixture('A'),config={...experimentConfig(a),experimentId:identity.experimentId,profile:COLLECTED_PROFILE};
 const old=await createExperimentDelivery({...config,profile:'experiment-preview-v1'},{[a.descriptor.packageSha256]:a},{random:()=>0.9});
 const oldBytes=await old.fetch(new Request(origin+'/ads.js')).text();
 const handler=await createCollectedDelivery(config,{[a.descriptor.packageSha256]:a},{issueTicket:c=>issueAssignmentTicket(c,secret),random:()=>0.9});
 const entries=[],requests=[];let seen=0;
 const window={location:{origin},fetch:async(url,init)=>{requests.push(JSON.parse(init.body));return {status:++seen===1?503:204};}};
 const document={currentScript:{src:origin+'/test-api/experiments/preview/tanjug-test/ads.js'},createElement:()=>({}),head:{appendChild:e=>entries.push(e)}};
 const context=vm.createContext({window,document,URL,AbortController,setTimeout,clearTimeout});
 const source=await (await handler.fetch(new Request(origin+'/ads.js'))).text();
 vm.runInContext(source,context);entries[0].onerror();vm.runInContext(source,context);
 const snapshot=()=>window.__tesseraExperiments['tanjug-test'].snapshot();
 await settle(()=>snapshot().collection.acknowledgedTypes.includes('load-error'));
 assert.equal(entries.length,1);assert.equal(snapshot().blockedDuplicates,1);assert(requests.length>=2);
 assert(requests.every(r=>r.ticket===requests[0].ticket));assert(requests.at(-1).types.includes('assigned'));
 assert(!JSON.stringify(snapshot()).includes(requests[0].ticket));assert.equal(snapshot().collection.pendingTypes.length,0);
 assert.equal(await old.fetch(new Request(origin+'/ads.js')).text(),oldBytes);
 assert.notEqual(handler.deliverySha256,old.deliverySha256);
});
test('actual private Worker collects signed events, retains in-flight outcomes after Stop and rejects foreign writes',async()=>{
 const f=deploymentStore();try{
  const login=await worker.fetch(new Request(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:'tester@example.invalid',password:'Local-fixture-only-password-927!'})}),f.env);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const call=(path,body,extra={})=>worker.fetch(new Request(origin+path,{method:body?'POST':'GET',headers:{cookie,...(body?{origin,'content-type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined}),f.env);
  const api='/test-api/experiments',collect=api+'/preview/tanjug-test/collect';
  const saved=await (await call(api+'/save',{expectedRevision:0,siteId:'tanjug-test',releaseA:metadata.descriptor.releaseId,releaseB:metadata.descriptor.releaseId,trafficB:100,collectAssignments:true})).json();
  const row=saved.experiments[0];assert.equal(row.deliveryProfile,COLLECTED_PROFILE);
  assert.equal((await call(api+'/start',{expectedRevision:1,experimentId:row.id})).status,200);
  const source=await (await call(api+'/preview/tanjug-test/ads.js')).text(),bodies=[];
  const window={location:{origin},pbjs:{},fetch:async(url,init)=>{const body=JSON.parse(init.body);bodies.push(body);return call(collect,body);}};
  const document={currentScript:{src:origin+api+'/preview/tanjug-test/ads.js'}};
  vm.runInNewContext(source,{window,document,URL,AbortController,setTimeout,clearTimeout});
  await settle(()=>window.__tesseraExperiments['tanjug-test'].snapshot().collection.acknowledgedTypes.includes('conflict'));
  const reportPath=api+'/collection/'+row.id+'.json';
  let summary=await (await call(reportPath)).json();assert.equal(summary.totals.B.assigned,1);assert.equal(summary.totals.B.conflict,1);
  assert.equal((await call(collect,bodies[0],{origin:'https://other.invalid'})).status,403);
  assert.equal((await worker.fetch(new Request(origin+collect,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(bodies[0])}),f.env)).status,401);
  assert.equal((await call(collect,{...bodies[0],ticket:bodies[0].ticket+'tampered'})).status,403);
  assert.equal((await call(api+'/preview/test-site/collect',bodies[0])).status,403);
  assert.equal((await call(collect,{...bodies[0],ip:'not-accepted'})).status,422);
  assert.equal((await call(api+'/stop',{expectedRevision:2,experimentId:row.id})).status,200);
  assert.equal((await call(collect,bodies.at(-1))).status,204);
  const stopped=await (await call(api+'/preview/tanjug-test/ads.js')).text();
  const stoppedWindow={location:{origin},pbjs:{},fetch(){assert.fail('Stopped pages do not collect');}};
  vm.runInNewContext(stopped,{window:stoppedWindow,document,URL,AbortController,setTimeout,clearTimeout});
  assert.equal(stoppedWindow.__tesseraExperiments['tanjug-test'].snapshot().collection.status,'disabled');
  summary=await (await call(reportPath)).json();assert.equal(summary.totals.B.assigned,1);assert.equal(summary.revenueReady,false);
 }finally{f.close();}
});
