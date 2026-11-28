import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEPLOY_REF, DEPLOY_REPO, MAX_ZIP, requireThat, validateRunnerInput, verifyDeliveryZip } from '../worker/test-workspace/deployment-contract.mjs';
import { boundedGet, checkPagesProject, deploymentOrigin, verifyPublicPackage } from './pages-release-verification.mjs';
import { privateCall } from './builtin-test-delivery.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/, RUN = /^[1-9][0-9]{0,19}$/;
const json = bytes => JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);

// A reviewed TEST-only recipe authorizes verification of an existing deployment.
// This script has no deployment, claim, dispatch, reset or ledger-unlock operation.
export function validateRecovery(request, sourceBytes, context) {
  requireThat(context.ref === 'refs/heads/'+DEPLOY_REF && context.repo === DEPLOY_REPO
    && RUN.test(context.runId) && COMMIT.test(context.commit), 'Recovery requires the reviewed TEST workflow identity.');
  requireThat(request?.schemaVersion === 1 && Object.keys(request).sort().join(',') === 'deploymentCommit,deploymentRunId,deploymentUrl,schemaVersion,sourceArtifactId,sourceArtifactSha256,sourcePath,sourceSha256'
    && /^docs\/evidence\/[a-z0-9-]+\.json$/.test(request.sourcePath)
    && HASH.test(request.sourceSha256) && HASH.test(request.sourceArtifactSha256) && RUN.test(request.sourceArtifactId)
    && RUN.test(request.deploymentRunId) && COMMIT.test(request.deploymentCommit)
    && request.deploymentRunId !== context.runId, 'Invalid reviewed recovery recipe.');
  requireThat(sourceBytes.byteLength <= 256*1024 && sha(sourceBytes) === request.sourceSha256, 'Original source evidence differs from the reviewed checksum.');
  const source = json(sourceBytes), input = validateRunnerInput(source.input,context.ref,context.repo);
  requireThat(input.github_environment === 'CLOUDFLARE_API_TOKEN', 'Recovery uses the shared Cloudflare token reference.');
  requireThat(source.runId === request.deploymentRunId && source.commit === request.deploymentCommit && HASH.test(source.zipSha256)
    && source.verified?.siteId === input.site_id && source.verified.releaseId === input.release_id
    && source.verified.version === input.release_version && source.verified.manifestSha256 === input.manifest_sha256
    && source.verified.completeRelease === false && source.verified.kind === 'builtin-stored-draft'
    && input.release_id === 'builtin-draft-'+source.verified.packageSha256
    && source.project?.accountId === input.account_id && source.project.projectName === input.project_name
    && source.project.branch === input.branch && source.project.channel === 'staging'
    && typeof source.project.productionBranch === 'string' && source.project.productionBranch.length > 0
    && source.project.productionBranch !== input.branch, 'Original deployment evidence is inconsistent.');
  const deploymentUrl = deploymentOrigin(request.deploymentUrl,input.project_name);
  requireThat(request.deploymentUrl === deploymentUrl, 'Use the exact immutable deployment origin.');
  return {request,source,input,context,deploymentUrl};
}

async function githubGet(path, token, fetcher) {
  requireThat(typeof token === 'string' && token.length > 0, 'GitHub read token is missing.');
  const {bytes} = await boundedGet(`https://api.github.com/repos/${DEPLOY_REPO}/${path}`,1024*1024,
    {fetcher,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
  return json(bytes);
}
export async function reverifyExisting({recovery,githubToken,cloudflareToken,secret,fetcher=fetch}) {
  const {request,source,input,context,deploymentUrl} = recovery;
  const run = await githubGet('actions/runs/'+request.deploymentRunId,githubToken,fetcher);
  requireThat(String(run.id) === request.deploymentRunId && run.repository?.full_name === DEPLOY_REPO
    && run.event === 'workflow_dispatch' && run.head_sha === request.deploymentCommit && run.head_branch === DEPLOY_REF
    && run.path === '.github/workflows/deploy-pages-release.yml' && run.status === 'completed', 'Original GitHub deployment identity could not be confirmed.');
  requireThat(typeof secret === 'string' && secret.length >= 32, 'Dedicated TEST transfer secret is missing.');
  const {bytes} = await boundedGet(input.release_base_url+'/package',MAX_ZIP,{fetcher,
    headers:{Authorization:'Bearer '+secret,'x-tessera-run-id':request.deploymentRunId}});
  const checked = await verifyDeliveryZip(bytes,{siteId:input.site_id,zipSha256:source.zipSha256,packageSha256:source.verified.packageSha256});
  const manifestSha256 = checked.descriptor.files.find(f=>f.name === 'manifest.json').sha256;
  requireThat(same({...checked.descriptor,manifestSha256},source.verified), 'Private package differs from the original source evidence.');
  const project = await checkPagesProject(input,cloudflareToken,fetcher);
  const publicResult = await verifyPublicPackage(deploymentUrl,input.project_name,source.verified,fetcher);
  return {...publicResult,project,runId:source.runId,commit:source.commit,verificationRunId:context.runId,
    verificationCommit:context.commit,sourceSha256:request.sourceSha256,zipSha256:source.zipSha256,
    packageSha256:checked.descriptor.packageSha256,files:checked.descriptor.files,verifiedAt:new Date().toISOString()};
}

export function validateReceipt(receipt, recovery) {
  const {request,source,input,context,deploymentUrl} = recovery;
  requireThat(receipt?.verified === true && receipt.runId === source.runId && receipt.commit === source.commit
    && receipt.verificationRunId === context.runId && receipt.verificationCommit === context.commit
    && receipt.deploymentUrl === deploymentUrl && receipt.sourceSha256 === request.sourceSha256
    && receipt.zipSha256 === source.zipSha256 && receipt.packageSha256 === source.verified.packageSha256
    && receipt.manifestSha256 === input.manifest_sha256 && receipt.fileCount === source.verified.files.length
    && same(receipt.files,source.verified.files) && receipt.project?.accountId === input.account_id
    && receipt.project.projectName === input.project_name && receipt.project.branch === input.branch && receipt.project.channel === 'staging'
    && typeof receipt.project.productionBranch === 'string' && receipt.project.productionBranch.length > 0
    && receipt.project.productionBranch !== input.branch, 'Recovery receipt differs from the original deployment or current verifier.');
  return receipt;
}
export async function reportRecovery({recovery,receipt,secret,fetcher=fetch}) {
  validateReceipt(receipt,recovery);
  const payload = {runId:receipt.runId,commit:receipt.commit,status:'success',deploymentUrl:receipt.deploymentUrl,
    productionBranch:receipt.project.productionBranch,verificationRunId:receipt.verificationRunId,verificationCommit:receipt.verificationCommit};
  const {run} = await privateCall(recovery.input,'report',secret,payload,fetcher);
  requireThat(run?.status === 'success' && run.githubRunId === payload.runId && run.commit === payload.commit
    && run.deploymentUrl === payload.deploymentUrl && run.verificationRunId === payload.verificationRunId
    && run.verificationCommit === payload.verificationCommit, 'Recovery confirmation differs. Inspect this run; do not redeploy.');
}
async function waitForTestWorker(context, token) {
  for (let attempt=0; attempt<48; attempt++) {
    const data = await githubGet(`commits/${context.commit}/check-runs?per_page=100`,token,fetch);
    const builds = (data.check_runs || []).filter(c=>c.name === 'Workers Builds: prebid-professor-test' && c.head_sha === context.commit);
    if (builds.some(c=>c.status === 'completed' && c.conclusion === 'success')) return;
    requireThat(!builds.some(c=>c.status === 'completed' && c.conclusion !== 'success'), 'TEST Worker build failed. Retry only reporting after fixing it.');
    await new Promise(done=>setTimeout(done,5000));
  }
  throw Error('TEST Worker build is not confirmed yet. Retry only this report job after it succeeds.');
}
async function main() {
  const request = json(await readFile(resolve('ops/runtime-test/verify-existing.json')));
  requireThat(/^docs\/evidence\/[a-z0-9-]+\.json$/.test(request.sourcePath), 'Invalid source evidence path.');
  const context = {ref:process.env.GITHUB_REF,repo:process.env.GITHUB_REPOSITORY,runId:process.env.GITHUB_RUN_ID,commit:process.env.GITHUB_SHA};
  const recovery = validateRecovery(request,await readFile(resolve(request.sourcePath)),context);
  const mode = process.argv[2], root = resolve('.generated/builtin-reverification');
  if (mode === 'validate') {console.log('Reviewed existing TEST deployment and source evidence validated.');return;}
  if (mode === 'verify') {
    const receipt = await reverifyExisting({recovery,githubToken:process.env.GH_READ_TOKEN,cloudflareToken:process.env.CLOUDFLARE_API_TOKEN,secret:process.env.TEST_TRANSFER_SECRET});
    await mkdir(root,{recursive:true});await writeFile(resolve(root,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    console.log(`Verified ${receipt.fileCount} original files and delivery headers at ${receipt.deploymentUrl}. No deployment was made.`);return;
  }
  if (mode === 'report') {
    const receipt = validateReceipt(json(await readFile(resolve(root,'receipt.json'))),recovery);
    await waitForTestWorker(context,process.env.GH_READ_TOKEN);
    await reportRecovery({recovery,receipt,secret:process.env.TEST_TRANSFER_SECRET});
    console.log('Existing TEST deployment confirmed with a separate verification audit. No deployment was made.');return;
  }
  throw Error('Unknown recovery command.');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
