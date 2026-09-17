import { sources, sourcePackage } from './deployments.mjs';
import { cacheDeliveryZip, readDeliveryZip } from './deployment-store.mjs';
import { verifyDeliveryZip, SITES } from './deployment-contract.mjs';
import { WorkspaceError, jsonBody } from './boundary.mjs';
import { createExperimentDelivery, EXPERIMENT_PROFILE } from '../experiments/delivery.mjs';
import { createCollectedDelivery, COLLECTED_PROFILE } from '../experiments/collected-delivery.mjs';
import { issueAssignmentTicket, verifyAssignmentTicket } from './assignment-ticket.mjs';
import { storeAssignment, assignmentSummary } from './assignment-store.mjs';
import { experimentPage, experimentScript } from './experiments-page.mjs';
import { reportingPlan, reportingCsv } from '../experiments/reporting.mjs';
import { readReporting, storeReporting } from './experiment-report-store.mjs';

export const EXPERIMENT_KEY = 'test-experiments/v1/state.json';
const check=(ok,message,status=422)=>{if(!ok)throw new WorkspaceError(status,message);};
const revision=n=>Number.isSafeInteger(n)&&n>=0;
const options={httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'}};
export async function readExperiments(bucket) {
  check(bucket,'TEST storage unavailable.',503);
  const object=await bucket.get(EXPERIMENT_KEY);
  if(!object)return {state:{schemaVersion:1,revision:0,experiments:[],events:[]},etag:null};
  check(object.size<=1024*1024&&object.httpEtag,'Invalid experiment history.',409);
  const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await object.arrayBuffer()));
  check(state.schemaVersion===1&&revision(state.revision)&&Array.isArray(state.experiments)&&state.experiments.length<=100
    &&Array.isArray(state.events)&&state.events.length<=500,'Invalid experiment history.',409);
  return {state,etag:object.httpEtag};
}
async function change(bucket,expected,mutate) {
  check(revision(expected),'Refresh the experiment list.');
  const {state,etag}=await readExperiments(bucket);
  check(state.revision===expected,'Experiment history changed. Refresh before trying again.',409);
  mutate(state);state.revision++;
  const bytes=new TextEncoder().encode(JSON.stringify(state));
  check(bytes.length<=1024*1024,'Experiment history is full. Existing records are retained.',409);
  const saved=await bucket.put(EXPERIMENT_KEY,bytes,{...options,onlyIf:new Headers(etag?{'If-Match':etag}:{'If-None-Match':'*'})});
  check(saved,'Another action changed this experiment. Refresh before trying again.',409);
  return state;
}
export function currentExperiment(state,siteId) {
  const event=[...state.events].reverse().find(e=>e.siteId===siteId);
  if(!event)return null;
  const item=state.experiments.find(e=>e.id===event.experimentId);
  check(item&&item.siteId===siteId,'Experiment history is inconsistent.',409);
  return {item,active:event.type==='started'};
}
async function verifiedPackage(env,siteId,pin) {
  const bytes=await readDeliveryZip(env.BUILDS,pin);
  return verifyDeliveryZip(bytes,{siteId,packageSha256:pin.packageSha256,zipSha256:pin.zipSha256});
}
function makeDelivery(env,item,active,packages) {
  const collected=item.deliveryProfile===COLLECTED_PROFILE;
  check(!item.deliveryProfile||collected,'Unsupported experiment delivery profile.',409);
  const build=collected?createCollectedDelivery:createExperimentDelivery;
  return build({profile:collected?COLLECTED_PROFILE:EXPERIMENT_PROFILE,siteId:item.siteId,experimentId:item.id,revision:item.version,
    enabled:active,trafficB:item.trafficB,controlPackageSha256:item.a.packageSha256,testPackageSha256:item.b.packageSha256},packages,
    {issueTicket:context=>issueAssignmentTicket(context,env.TEST_SESSION_SECRET)});
}
async function delivery(env,item,active) {
  const entries=await Promise.all([item.a,item.b].map(async pin=>[pin.packageSha256,await verifiedPackage(env,item.siteId,pin)]));
  const handler=await makeDelivery(env,item,active,Object.fromEntries(entries));
  if(active) {
    const plan=(await readReporting(env.BUILDS)).plans.find(p=>p.experimentId===item.id);
    check(!plan||plan.deliverySha256===handler.deliverySha256,'Delivery changed since reporting was prepared. Save a new experiment to keep its GAM values separate.',409);
  }
  return handler;
}
export async function saveExperiment(env,actor,body) {
  check(body.collectAssignments===undefined||typeof body.collectAssignments==='boolean','Choose whether to collect TEST assignments.');
  check(revision(body.expectedRevision)&&SITES.includes(body.siteId),'Choose a TEST site and refresh its history.');
  check(Number.isInteger(body.trafficB)&&body.trafficB>=0&&body.trafficB<=100,'B traffic must be a whole percentage from 0 to 100.');
  const initial=await readExperiments(env.BUILDS);
  check(initial.state.revision===body.expectedRevision,'Experiment history changed. Refresh before saving.',409);
  const pins=[];
  // These are trusted saved packages, never caller-supplied code or hashes.
  for(const id of [body.releaseA,body.releaseB]) {
    const pkg=await sourcePackage(env,body.siteId,id);
    pins.push({...await cacheDeliveryZip(env.BUILDS,pkg.bytes),releaseId:pkg.descriptor.releaseId,
      packageSha256:pkg.descriptor.packageSha256,label:pkg.label,runtimeVersion:pkg.descriptor.runtime.runtimeVersion});
  }
  return change(env.BUILDS,body.expectedRevision,state=>{
    check(state.experiments.length<100,'Experiment history is full. Existing versions are retained.',409);
    state.experiments.push({id:'experiment-'+crypto.randomUUID(),siteId:body.siteId,version:state.revision+1,
      ...(body.collectAssignments?{deliveryProfile:COLLECTED_PROFILE}:{}),trafficB:body.trafficB,a:pins[0],b:pins[1],createdAt:new Date().toISOString(),createdBy:actor.email});
  });
}
export async function transitionExperiment(env,actor,body,type) {
  check(['started','stopped'].includes(type)&&revision(body.expectedRevision),'Invalid experiment action.');
  const {state}=await readExperiments(env.BUILDS);
  check(state.revision===body.expectedRevision,'Experiment history changed. Refresh before trying again.',409);
  const item=state.experiments.find(e=>e.id===body.experimentId);
  check(item,'Saved experiment not found.',404);
  if(type==='started'&&item.deliveryProfile===COLLECTED_PROFILE)await prepareReporting(env,body);
  if(type==='started')await delivery(env,item,true); // refuse corrupt/missing archives before activation
  return change(env.BUILDS,body.expectedRevision,next=>{
    check(next.events.length<(type==='started'?499:500),'Experiment history is full. Existing events are retained.',409);
    const current=currentExperiment(next,item.siteId);
    if(type==='started')check(!current?.active,'Stop the active preview before starting another version.',409);
    else check(current?.active&&current.item.id===item.id,'This experiment is no longer active. Refresh the page.',409);
    next.events.push({id:crypto.randomUUID(),type,siteId:item.siteId,experimentId:item.id,
      at:new Date().toISOString(),actor:actor.email});
  });
}

export async function prepareReporting(env,body) {
  const {state}=await readExperiments(env.BUILDS);
  check(revision(body.expectedRevision)&&body.expectedRevision===state.revision,'Experiment history changed. Refresh before preparing the report.',409);
  const item=state.experiments.find(e=>e.id===body.experimentId);
  check(item,'Saved experiment not found.',404);
  const packages=await Promise.all([item.a,item.b].map(pin=>verifiedPackage(env,item.siteId,pin)));
  const handler=await makeDelivery(env,item,true,Object.fromEntries(packages.map(p=>[p.descriptor.packageSha256,p])));
  const plan=reportingPlan(item,handler.deliverySha256,packages.map(p=>p.descriptor));
  // A concurrent Start/Stop must not silently turn a reviewed state into another.
  check((await readExperiments(env.BUILDS)).state.revision===state.revision,'Experiment history changed. Refresh before preparing the report.',409);
  return storeReporting(env.BUILDS,plan);
}

// Runs only inside the existing exact TEST boundary, login and Origin guards.
export async function experimentResponse(request,env,actor,headers) {
  const url=new URL(request.url),path=url.pathname;
  if(!['/experiments','/experiments.js'].includes(path)&&!path.startsWith('/test-api/experiments'))return null;
  check(!url.search,'Not found.',404);
  const response=(body,type='application/json; charset=utf-8')=>new Response(body,{headers:{...headers,'content-type':type}});
  if(path==='/experiments'&&request.method==='GET')return response(experimentPage,'text/html; charset=utf-8');
  if(path==='/experiments.js'&&request.method==='GET')return response(experimentScript,'application/javascript; charset=utf-8');
  if(path==='/test-api/experiments'&&request.method==='GET') {
    const {state}=await readExperiments(env.BUILDS);
    return response(JSON.stringify({...state,sources:await sources(env),reporting:(await readReporting(env.BUILDS)).plans,scope:'private-test-preview'}));
  }
  if(path==='/test-api/experiments/reporting/prepare'&&request.method==='POST') {
    return response(JSON.stringify(await prepareReporting(env,await jsonBody(request,['expectedRevision','experimentId']))));
  }
  const collectionMatch=path.match(/^\/test-api\/experiments\/collection\/(experiment-[a-f0-9-]{36})\.json$/);
  if(collectionMatch&&request.method==='GET') {
    const plan=(await readReporting(env.BUILDS)).plans.find(p=>p.experimentId===collectionMatch[1]);
    check(plan&&plan.denominatorStatus==='test-collection','No TEST collection for this experiment.',404);
    return response(JSON.stringify(await assignmentSummary(env.BUILDS,plan)));
  }
  const collectMatch=path.match(/^\/test-api\/experiments\/preview\/(tanjug-test|test-site)\/collect$/);
  if(collectMatch&&request.method==='POST') {
    const body=await jsonBody(request,['ticket','types']);
    const claim=await verifyAssignmentTicket(body.ticket,env.TEST_SESSION_SECRET);
    check(claim.siteId===collectMatch[1],'Assignment belongs to a different TEST site.',403);
    const plan=(await readReporting(env.BUILDS)).plans.find(p=>p.experimentId===claim.experimentId);
    check(plan&&plan.denominatorStatus==='test-collection','TEST collection is not enabled for this experiment.',403);
    await storeAssignment(env.BUILDS,plan,claim,body.types);
    return new Response(null,{status:204,headers});
  }
  const reportMatch=path.match(/^\/test-api\/experiments\/reporting\/(experiment-[a-f0-9-]{36})\.(json|csv)$/);
  if(reportMatch&&request.method==='GET') {
    const plan=(await readReporting(env.BUILDS)).plans.find(p=>p.experimentId===reportMatch[1]);
    check(plan,'Prepare the reporting values first.',404);
    const csv=reportMatch[2]==='csv';
    check(!csv||plan.labelsReady,'Both script versions need measurement support before exporting GAM values.');
    return new Response(csv?reportingCsv(plan):JSON.stringify(plan,null,2)+'\n',{headers:{...headers,
      'content-type':csv?'text/csv; charset=utf-8':'application/json; charset=utf-8',
      'content-disposition':'attachment; filename="'+plan.experimentId+'.'+reportMatch[2]+'"'}});
  }
  const match=path.match(/^\/test-api\/experiments\/preview\/(tanjug-test|test-site)(\/ads\.js|\/releases\/[a-f0-9]{64}\/(?:ads|prebid)\.js)$/);
  if(match&&request.method==='GET') {
    const {state}=await readExperiments(env.BUILDS),siteId=match[1],tail=match[2];
    let current=currentExperiment(state,siteId);
    if(tail.startsWith('/releases/')) {
      const pin=tail.split('/')[2];
      const archived=state.experiments.find(e=>e.siteId===siteId&&[e.a.packageSha256,e.b.packageSha256].includes(pin));
      if(archived)current={item:archived,active:false};
    }
    check(current,'Start a saved TEST preview first.',409);
    const handler=await delivery(env,current.item,current.active);
    const rewritten=new Request(url.origin+tail,{method:'GET'});
    Object.defineProperty(rewritten,'cf',{value:request.cf});
    const served=await handler.fetch(rewritten);
    // Authenticated preview responses cannot enter shared caches, even assets.
    return new Response(served.body,{status:served.status,headers:{...Object.fromEntries(served.headers),...headers,
      'cdn-cache-control':'no-store','cloudflare-cdn-cache-control':'no-store'}});
  }
  if(request.method==='POST'&&['/test-api/experiments/save','/test-api/experiments/start','/test-api/experiments/stop'].includes(path)) {
    const saving=path.endsWith('/save');
    const body=await jsonBody(request,saving?['expectedRevision','siteId','releaseA','releaseB','trafficB','collectAssignments']:['expectedRevision','experimentId']);
    const state=saving?await saveExperiment(env,actor,body):await transitionExperiment(env,actor,body,path.endsWith('/start')?'started':'stopped');
    return response(JSON.stringify(state));
  }
  throw new WorkspaceError(404,'Unknown experiment operation.');
}
