import { zipSync } from 'fflate';
import { metadata, zipBase64 } from '../../.generated/tanjug-pilot.mjs';
import { describeCandidate, readDraftRelease } from '../runtime/draft-release-store.mjs';
import { WorkspaceError, jsonBody, TEST_SITE } from './boundary.mjs';
import { inspectTestSchema } from './schema.mjs';
import { DEPLOY_ORIGIN, DEPLOY_REPO, DEPLOY_REF, SITES, RELEASE_ID, REQUEST_ID, validateTarget,
  destination, dispatchInputs, verifyDeliveryZip } from './deployment-contract.mjs';
import { readLedger, changeLedger, deliveryRun, unsettled, cacheDeliveryZip, readDeliveryZip } from './deployment-store.mjs';
import { deploymentPage, deploymentScript } from './deployment-page.mjs';

const check = (ok, message, status=422) => {if (!ok) throw new WorkspaceError(status,message);};
const now = () => new Date().toISOString();
const validRevision = n => Number.isSafeInteger(n) && n >= 0;
const readiness = env => ({githubConfigured:typeof env.TEST_GITHUB_ACTIONS_TOKEN === 'string' && env.TEST_GITHUB_ACTIONS_TOKEN.length >= 20,
  transferConfigured:typeof env.TEST_DEPLOY_SECRET === 'string' && env.TEST_DEPLOY_SECRET.length >= 32});
const connected = env => Object.values(readiness(env)).every(Boolean);
const activeFor = (state, siteId, target) => state.runs.find(r => unsettled(r) && (r.siteId === siteId || destination(r.target) === destination(target)));
const currentFor = (state, target) => target && state.runs.find(r => r.status === 'success' && destination(r.target) === destination(target));
function revision(body) {check(validRevision(body.expectedRevision),'Osveži listu objava pre čuvanja.');}
function assertSite(siteId) {check(SITES.includes(siteId),'Nepoznata TEST kopija.');}
function cleanTarget(target) {try{return validateTarget(target);}catch(e){throw new WorkspaceError(422,e.message);}}
function response(value, headers, status=200) {return new Response(JSON.stringify(value),{status,headers:{...headers,'content-type':'application/json; charset=utf-8'}});}
async function sources(env) {
  const result = [{siteId:'tanjug-test',releaseId:metadata.descriptor.releaseId,label:metadata.version,
    packageSha256:metadata.descriptor.packageSha256,runtimeVersion:metadata.descriptor.runtime.runtimeVersion,
    prebidVersion:metadata.descriptor.prebidBuild?.version ?? null,fileCount:metadata.descriptor.files.length}];
  if (!(await inspectTestSchema(env.DB)).ready) return result;
  const rows = await env.DB.withSession('first-primary').prepare('SELECT release_id,note,descriptor_json FROM builtin_draft_uploads WHERE publisher_id=? AND state=? ORDER BY created_at DESC,release_id LIMIT 20').bind(TEST_SITE,'stored').all();
  for (const row of rows.results) {
    const d = JSON.parse(row.descriptor_json);
    check(RELEASE_ID.test(row.release_id) && d.releaseId === row.release_id && d.siteId === TEST_SITE,'Sačuvani opis paketa se razlikuje.',409);
    result.push({siteId:TEST_SITE,releaseId:row.release_id,label:row.note || 'Sačuvani TEST paket',packageSha256:d.packageSha256,
      runtimeVersion:d.runtime.runtimeVersion,prebidVersion:d.prebidBuild?.version ?? null,fileCount:d.files.length});
  }
  return result;
}
export async function deploymentState(env) {
  const {state} = await readLedger(env.BUILDS);
  return {...state,connection:readiness(env),sources:await sources(env)};
}
export async function saveTarget(env, body) {
  revision(body); assertSite(body.siteId);
  const target = cleanTarget(body.target);
  return changeLedger(env.BUILDS,body.expectedRevision,state => {
    check(!activeFor(state,body.siteId,target),'Sačekaj razrešenje prethodne objave pre promene odredišta.',409);
    check(!Object.entries(state.targets).some(([site,t]) => site !== body.siteId && destination(t) === destination(target)), 'Dve TEST kopije ne mogu da koriste isto odredište.',409);
    state.targets[body.siteId] = target;
  });
}
async function sourcePackage(env, siteId, releaseId) {
  if (siteId === 'tanjug-test') {
    check(releaseId === metadata.descriptor.releaseId,'Nepoznat Tanjug paket.');
    const bytes = Uint8Array.from(atob(zipBase64),c => c.charCodeAt(0));
    const {descriptor} = await verifyDeliveryZip(bytes,{siteId,packageSha256:metadata.descriptor.packageSha256,zipSha256:metadata.zipSha256});
    return {bytes,descriptor,label:metadata.version};
  }
  check(RELEASE_ID.test(releaseId),'Izaberi sačuvani TEST paket.');
  const saved = await readDraftRelease({isolation:'explicit-test-store',db:env.DB,bucket:env.BUILDS},{siteId,releaseId});
  check(saved,'Sačuvani paket nije pronađen.',404);
  const {descriptor,files} = await describeCandidate(siteId,saved);
  const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([name,data]) => [name,[data,{level:0,mtime:new Date(1980,0,1,0,0,0)}]])),{level:0});
  await verifyDeliveryZip(bytes,{siteId,packageSha256:descriptor.packageSha256});
  return {bytes,descriptor,label:saved.draft.note || 'Sačuvani TEST paket'};
}
export async function requestDeployment(env, actor, body, fetcher=fetch) {
  revision(body); assertSite(body.siteId);
  check(body.acknowledge === true && ['publish','restore'].includes(body.action),'Potvrdi objavu celog paketa na TEST.');
  check(connected(env),'Veza za automatsku TEST objavu još nije podešena. Odredište možeš da sačuvaš.',409);
  const {state} = await readLedger(env.BUILDS), target = state.targets[body.siteId];
  check(target,'Prvo sačuvaj TEST odredište.',409);
  check(state.revision === body.expectedRevision && !activeFor(state,body.siteId,target),'Osveži prikaz i sačekaj prethodnu objavu.',409);
  const current = currentFor(state,target);
  let pkg;
  if (body.action === 'restore') {
    const previous = deliveryRun(state,body.restoreId);
    check(current && previous.status === 'success' && previous.siteId === body.siteId
      && destination(previous.target) === destination(target)
      && previous.package.descriptor.packageSha256 !== current.package.descriptor.packageSha256,'Izaberi ranije potvrđen paket za isto TEST odredište.',409);
    const bytes = await readDeliveryZip(env.BUILDS,previous.package);
    await verifyDeliveryZip(bytes,{siteId:body.siteId,...previous.package,packageSha256:previous.package.descriptor.packageSha256});
    pkg = structuredClone(previous.package);
  } else {
    const source = await sourcePackage(env,body.siteId,body.releaseId);
    check(source.descriptor.packageSha256 !== current?.package.descriptor.packageSha256,'Ovaj paket je već poslednja potvrđena objava.',409);
    pkg = {...await cacheDeliveryZip(env.BUILDS,source.bytes),descriptor:source.descriptor,label:source.label};
  }
  const run = {id:'builtin-test-'+crypto.randomUUID(),siteId:body.siteId,action:body.action,
    restoreId:body.action === 'restore' ? body.restoreId : null,previousId:current?.id ?? null,
    target:structuredClone(target),package:pkg,status:'queued',createdAt:now(),actor:actor.email};
  await changeLedger(env.BUILDS,body.expectedRevision,latest => {
    check(latest.runs.length < 100,'Istorija je dostigla 100 pokušaja. Sve verzije su sačuvane.',409);
    check(!activeFor(latest,body.siteId,target),'Druga objava je već u toku.',409);
    latest.runs.unshift(run);
  });
  let outcome = 'dispatch_unknown';
  try {
    const result = await fetcher(`https://api.github.com/repos/${DEPLOY_REPO}/actions/workflows/deploy-pages-release.yml/dispatches`,{
      method:'POST',redirect:'manual',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${env.TEST_GITHUB_ACTIONS_TOKEN}`,
        Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Tessera-TEST','Content-Type':'application/json'},
      body:JSON.stringify({ref:DEPLOY_REF,inputs:dispatchInputs(run)})});
    if (result.status === 204 && !result.redirected) outcome = 'queued';
    else if ([400,401,403,404,422].includes(result.status)) outcome = 'failed';
  } catch { /* Dispatch may have reached GitHub. Never automatically send it twice. */ }
  const final = await changeLedger(env.BUILDS,undefined,latest => {
    const row = deliveryRun(latest,run.id);
    if (row.status !== 'queued') return false; // Runner may already have claimed it.
    row.status = outcome; row.dispatchCheckedAt = now();
    if (outcome === 'failed') row.reason = 'GitHub nije prihvatio zahtev. Proveri vezu pre novog pokušaja.';
  });
  return {run:deliveryRun(final,run.id),revision:final.revision};
}
// Only this exact runner namespace bypasses browser Origin/cookie auth, after the
// outer Worker TEST boundary. The dedicated shared secret is never returned.
export const runnerPath = path => /^\/test-api\/deployment-runner\/builtin-test-[a-f0-9-]+\/(claim|package|report)$/.test(path);
async function authenticateRunner(request, env) {
  check(typeof env.TEST_DEPLOY_SECRET === 'string' && env.TEST_DEPLOY_SECRET.length >= 32,'Runner connection unavailable.',503);
  const actual = request.headers.get('authorization') || '';
  const encode = s => new TextEncoder().encode(s);
  const [a,b] = await Promise.all([crypto.subtle.digest('SHA-256',encode(actual)),crypto.subtle.digest('SHA-256',encode('Bearer '+env.TEST_DEPLOY_SECRET))]);
  let diff = 0;const aa=new Uint8Array(a),bb=new Uint8Array(b);for(let i=0;i<aa.length;i++)diff |= aa[i]^bb[i];
  check(diff === 0,'Runner authorization required.',401);
}
const immutableUrl = (value,project) => {
  try {const u=new URL(value);return u.protocol==='https:' && !u.username && !u.password && !u.port && !u.search && !u.hash && u.pathname==='/' && new RegExp(`^[a-f0-9]{8,32}\\.${project}\\.pages\\.dev$`).test(u.hostname);}catch{return false;}
};
export async function runnerResponse(request, env, headers) {
  await authenticateRunner(request,env);
  const u = new URL(request.url), [,id,operation] = u.pathname.match(/\/deployment-runner\/([^/]+)\/(\w+)$/) || [];
  check(REQUEST_ID.test(id) && !u.search,'Invalid runner request.',404);
  if (operation === 'package' && request.method === 'GET') {
    const run = deliveryRun((await readLedger(env.BUILDS)).state,id);
    check(run.githubRunId && request.headers.get('x-tessera-run-id') === run.githubRunId,'Claim this package first.',409);
    return new Response(await readDeliveryZip(env.BUILDS,run.package),{headers:{...headers,'content-type':'application/zip'}});
  }
  check(request.method === 'POST' && ['claim','report'].includes(operation),'Unknown runner operation.',405);
  const body = await jsonBody(request,operation === 'claim' ? ['inputs','runId','commit'] : ['runId','commit','status','deploymentUrl','productionBranch','verificationRunId','verificationCommit']);
  check(typeof body.runId === 'string' && /^[1-9][0-9]{0,19}$/.test(body.runId) && typeof body.commit === 'string' && /^[a-f0-9]{40}$/.test(body.commit),'Invalid workflow identity.');
  const state = await changeLedger(env.BUILDS,undefined,latest => {
    const run = deliveryRun(latest,id);
    if (operation === 'claim') {
      const expected = dispatchInputs(run);
      check(body.inputs && Object.keys(body.inputs).length === Object.keys(expected).length
        && Object.entries(expected).every(([k,v]) => body.inputs[k] === v),'Workflow inputs differ from the saved request.',409);
      check(['queued','dispatch_unknown'].includes(run.status),'This job has already been claimed. Do not redeploy it.',409);
      run.status='running';run.githubRunId=body.runId;run.commit=body.commit;run.startedAt=now();
    } else {
      check(run.githubRunId === body.runId && run.commit === body.commit,'Result belongs to another workflow.',409);
      check(['failed','unverified','success'].includes(body.status),'Invalid deployment result.');
      const reverified = body.verificationRunId !== undefined || body.verificationCommit !== undefined;
      if (reverified) check(body.status === 'success'
        && typeof body.verificationRunId === 'string' && /^[1-9][0-9]{0,19}$/.test(body.verificationRunId) && body.verificationRunId !== run.githubRunId
        && typeof body.verificationCommit === 'string' && /^[a-f0-9]{40}$/.test(body.verificationCommit), 'Invalid independent verification identity.');
      if (body.status === 'success' || body.deploymentUrl) check(immutableUrl(body.deploymentUrl,run.target.projectName),'An immutable URL on the selected Pages project is required.');
      if (body.deploymentUrl) body.deploymentUrl = new URL(body.deploymentUrl).origin;
      if (body.status === 'success') check(typeof body.productionBranch === 'string' && body.productionBranch.length > 0 && body.productionBranch.length <= 255 && body.productionBranch !== run.target.previewBranch,'Production branch proof is required.');
      check(body.status !== 'failed' || !body.deploymentUrl,'An attempted deployment cannot be recorded as a pre-deploy failure.');
      // Reporting/verification retries may confirm an unverified run; they cannot
      // reverse a final success, change its URL, or unlock an uncertain deployment.
      if (['success','failed'].includes(run.status)) {
        check(run.status === body.status && (run.deploymentUrl || '') === (body.deploymentUrl || '')
          && run.verificationRunId === body.verificationRunId && run.verificationCommit === body.verificationCommit,'A final result cannot be changed.',409);
        return false;
      }
      check(run.status === 'running' || (run.status === 'unverified' && body.status !== 'failed'),'Inspect the existing deployment before changing its status.',409);
      if (run.deploymentUrl) check(run.deploymentUrl === body.deploymentUrl,'Deployment URL cannot be replaced.',409);
      run.status=body.status;run.deploymentUrl=body.deploymentUrl || '';run.productionBranch=body.productionBranch || '';run.finishedAt=now();
      if (reverified) {run.verificationRunId=body.verificationRunId;run.verificationCommit=body.verificationCommit;}
    }
  });
  return response({run:deliveryRun(state,id)},headers);
}
export async function deploymentResponse(request, env, actor, headers) {
  const u = new URL(request.url);
  if (u.search) return null;
  if (request.method === 'GET' && u.pathname === '/deployments') return new Response(deploymentPage,{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
  if (request.method === 'GET' && u.pathname === '/deployments.js') return new Response(deploymentScript,{headers:{...headers,'content-type':'application/javascript; charset=utf-8'}});
  if (request.method === 'GET' && u.pathname === '/test-api/deployments') return response(await deploymentState(env),headers);
  if (request.method === 'POST' && u.pathname === '/test-api/deployments/target') return response(await saveTarget(env,await jsonBody(request,['expectedRevision','siteId','target'])),headers);
  if (request.method === 'POST' && u.pathname === '/test-api/deployments/request') return response(await requestDeployment(env,actor,await jsonBody(request,['expectedRevision','siteId','action','releaseId','restoreId','acknowledge'])),headers,202);
  return null;
}
