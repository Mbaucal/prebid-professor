import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_ZIP, requireThat, dispatchInputs, validateRunnerInput, verifyDeliveryZip } from '../worker/test-workspace/deployment-contract.mjs';
import { boundedGet, checkPagesProject, verifyPublicPackage, deploymentOrigin } from './pages-release-verification.mjs';
import { selectDelivery } from '../worker/test-workspace/delivery-layout.mjs';
import { verifyDeliveryPublication } from './publisher-delivery-verification.mjs';

export async function privateCall(input, suffix, secret, body, fetcher=fetch) {
  requireThat(typeof secret === 'string' && secret.length >= 32, 'Dedicated TEST transfer secret is missing.');
  const result = await fetcher(input.release_base_url+'/'+suffix,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
    headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body)});
  requireThat(result.ok && !result.redirected, `TEST ${suffix} could not be confirmed (${result.status}). Inspect the existing request before retrying.`);
  const reader=result.body?.getReader();requireThat(reader,'TEST runner response is missing.');
  const chunks=[];let size=0;
  try {for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024){await reader.cancel();throw Error('TEST runner response is too large.');}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export function runnerOutcome(deployOutcome, verifyOutcome, deploymentUrl='') {
  if (deployOutcome === 'success') return verifyOutcome === 'success' ? 'success' : 'unverified';
  // Only an explicitly skipped deployment step proves Wrangler never started.
  return deployOutcome === 'skipped' && !deploymentUrl ? 'failed' : 'unverified';
}
function assertRun(run,input,runId,commit) {
  requireThat(run && run.githubRunId === runId && run.commit === commit
    && Object.entries(dispatchInputs(run)).every(([k,v]) => input[k] === v), 'Claimed job differs from this workflow.');
}
export async function prepareDelivery({run,input,token,secret,fetcher=fetch}) {
  const {bytes} = await boundedGet(input.release_base_url+'/package',MAX_ZIP,{fetcher,
    headers:{Authorization:'Bearer '+secret,'x-tessera-run-id':run.githubRunId}});
  const checked = await verifyDeliveryZip(bytes,{siteId:run.siteId,...run.package,packageSha256:run.package.descriptor.packageSha256});
  const manifest = checked.descriptor.files.find(f => f.name === 'manifest.json');
  requireThat(manifest.sha256 === input.manifest_sha256, 'Manifest differs from the saved deployment request.');
  const project = await checkPagesProject(input,token,fetcher);
  const selected = await selectDelivery(checked.files,checked.descriptor,run.delivery);
  return {files:checked.files,deploymentFiles:selected.files,headers:selected.headers,evidence:{input,runId:run.githubRunId,commit:run.commit,project,
    ...(run.delivery ? {delivery:selected.delivery} : {}),
    zipSha256:run.package.zipSha256,verified:{...checked.descriptor,manifestSha256:manifest.sha256}}};
}
async function main() {
  const input = validateRunnerInput(JSON.parse(process.env.DEPLOY_INPUTS || 'null'),process.env.GITHUB_REF,process.env.GITHUB_REPOSITORY);
  const mode=process.argv[2], root=resolve('.generated/builtin-delivery'), runId=process.env.GITHUB_RUN_ID, commit=process.env.GITHUB_SHA;
  requireThat(/^[1-9][0-9]{0,19}$/.test(runId) && /^[a-f0-9]{40}$/.test(commit),'Invalid GitHub run identity.');
  if (mode === 'validate') {console.log('Private builtin TEST identity validated.');return;}
  if (mode === 'claim') {
    const {run} = await privateCall(input,'claim',process.env.TEST_TRANSFER_SECRET,{inputs:input,runId,commit});
    assertRun(run,input,runId,commit);
    await mkdir(root,{recursive:true});await writeFile(resolve(root,'request.json'),JSON.stringify(run),{flag:'wx'});
    console.log('TEST job claimed once; a repeated deployment cannot claim it again.');return;
  }
  if (mode === 'prepare') {
    const run = JSON.parse(await readFile(resolve(root,'request.json'),'utf8'));
    assertRun(run,input,runId,commit);
    const {deploymentFiles:files,headers,evidence} = await prepareDelivery({run,input,token:process.env.CLOUDFLARE_API_TOKEN,secret:process.env.TEST_TRANSFER_SECRET});
    const dist=resolve(root,'dist');await mkdir(dist,{recursive:true});requireThat((await readdir(dist)).length===0,'Deployment directory must be empty.');
    for(const [name,bytes] of Object.entries(files))await writeFile(resolve(dist,name),bytes,{flag:'wx'});
    await writeFile(resolve(dist,'_headers'),headers,{flag:'wx'});
    await writeFile(resolve(root,'verification.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
    console.log(`Verified ${evidence.verified.files.length} original package files; publishing ${Object.keys(files).length} assets plus _headers to the actual Pages preview branch.`);return;
  }
  if (mode === 'verify-public') {
    const evidence = JSON.parse(await readFile(resolve(root,'verification.json'),'utf8'));
    requireThat(evidence.runId === runId && evidence.commit === commit && Object.entries(input).every(([k,v])=>evidence.input?.[k]===v)
      && evidence.verified.releaseId === input.release_id && evidence.verified.manifestSha256 === input.manifest_sha256,'Verification evidence belongs to another deployment.');
    const result = evidence.delivery
      ? await verifyDeliveryPublication(process.env.PAGES_DEPLOYMENT_URL,input,evidence.verified,evidence.delivery)
      : await verifyPublicPackage(process.env.PAGES_DEPLOYMENT_URL,input.project_name,evidence.verified);
    await writeFile(resolve(root,'public-verification.json'),JSON.stringify({...result,runId,commit,project:evidence.project},null,2)+'\n');
    // Branch names can contain arbitrary text on provider records; never emit one
    // directly into GITHUB_OUTPUT. The callback reads the JSON evidence instead.
    console.log(`Verified ${result.fileCount} public files, MIME, CORS and no-store headers.`);return;
  }
  if (mode === 'report') {
    const status = runnerOutcome(process.env.DEPLOY_STEP_OUTCOME,process.env.VERIFY_OUTCOME,process.env.PAGES_DEPLOYMENT_URL);
    let productionBranch='', deliverySha256;
    if (status === 'success') {
      const evidence = JSON.parse(await readFile(resolve(root,'public-verification.json'),'utf8'));
      requireThat(evidence.verified === true && evidence.runId === runId && evidence.commit === commit
        && evidence.deploymentUrl === deploymentOrigin(process.env.PAGES_DEPLOYMENT_URL,input.project_name)
        && evidence.manifestSha256 === input.manifest_sha256 && evidence.project.accountId === input.account_id
        && evidence.project.projectName === input.project_name && evidence.project.branch === input.branch
        && evidence.project.channel === 'staging','Public verification proof differs.');
      productionBranch=evidence.project.productionBranch;
      deliverySha256=evidence.deliverySha256;
    }
    await privateCall(input,'report',process.env.TEST_TRANSFER_SECRET,{runId,commit,status,
      deploymentUrl:process.env.PAGES_DEPLOYMENT_URL || '',productionBranch,...(deliverySha256 ? {deliverySha256} : {})});
    console.log(`TEST status reported: ${status}. A report retry does not redeploy files.`);return;
  }
  throw Error('Unknown builtin delivery command.');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
