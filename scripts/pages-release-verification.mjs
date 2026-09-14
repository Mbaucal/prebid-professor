import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describeCandidate } from '../worker/runtime/draft-release-store.mjs';
import { parsePrebidHeader } from '../worker/runtime/prebid-artifact-check.mjs';

const SOURCE_ORIGIN = 'https://prebid-professor.mbaucal.workers.dev';
const HASH = /^[a-f0-9]{64}$/;
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const REQUIRED = ['ads.js','ads.min.js','prebid.js','config.json','min-height.css','div-export.csv','implementation.html'];
const ALLOWED = [...REQUIRED, 'sticky.css', 'README.txt'];
// Match the legacy Prebid uploader's 20 MiB acceptance limit. Private built-in
// candidates retain their own smaller storage limits in describeCandidate.
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = ALLOWED.length * MAX_FILE + 256 * 1024;
const DISABLED_PREBID = '/* Prebid disabled for this release. Google Ad Manager / AdX only. */\n';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function requireThat(value, message) { if (!value) throw new Error(message); }
function json(bytes) { return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); }
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);

// Keep built-in draft delivery blocked until its authenticated TEST promotion
// contract exists. Supporting offline verification is not publication authority.
export function validateDeploymentInput(input, gitRef) {
  requireThat(record(input), 'Deployment inputs are required.');
  for (const key of ['site_id','release_id','release_version']) requireThat(typeof input[key] === 'string' && PART.test(input[key]), 'Invalid release identity.');
  requireThat(!input.release_id.startsWith('builtin-draft-') && !input.release_version.startsWith('builtin-draft-'), 'Built-in TEST drafts require the separate reviewed staging handoff.');
  requireThat(/^[a-f0-9-]{36}$/.test(input.correlation_id), 'Invalid deployment correlation ID.');
  requireThat(HASH.test(input.manifest_sha256), 'An exact manifest checksum is required.');
  requireThat(/^[a-f0-9]{32}$/.test(input.account_id), 'Invalid Cloudflare account.');
  requireThat(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.project_name), 'Invalid Pages project.');
  requireThat(/^CLOUDFLARE_API_TOKEN(?:_[A-Z0-9_]+)?$/.test(input.github_environment), 'Choose a scoped Cloudflare token repository secret.');
  requireThat(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(input.branch) && !input.branch.includes('..') && !input.branch.includes('//'), 'Invalid Pages branch.');
  requireThat(['staging','production'].includes(input.channel), 'Invalid deployment channel.');
  requireThat(input.channel !== 'production' || gitRef === 'refs/heads/main', 'Production jobs must use the reviewed main workflow.');
  requireThat(input.release_base_url === `${SOURCE_ORIGIN}/cdn/${input.site_id}/releases/${input.release_version}`, 'Release source must be the immutable platform URL.');
  requireThat(input.callback_url === `${SOURCE_ORIGIN}/api/deployments/callback`, 'Unrecognized deployment callback.');
  return {...input};
}

export function manifestInventory(bytes, expected) {
  requireThat(bytes.byteLength <= 256 * 1024, 'Manifest exceeds the allowed size.');
  const m = json(bytes);
  requireThat(m.schemaVersion === 1 && m.siteId === expected.site_id && HASH.test(m.configHash), 'Manifest identity is invalid.');
  requireThat(record(m.files), 'Manifest file inventory is missing.');
  const names = Object.keys(m.files).sort();
  requireThat(names.every(n => ALLOWED.includes(n)), 'Manifest contains an unsupported file name.');
  const builtin = m.kind === 'builtin-runtime-candidate';
  if (!builtin) {
    requireThat(m.releaseId === expected.release_id && m.version === expected.release_version, 'Manifest belongs to another release.');
    requireThat(REQUIRED.every(n => names.includes(n)), 'Required release files are missing.');
  }
  let total = bytes.byteLength;
  const entries = names.map(name => {
    const row = m.files[name], size = builtin ? row?.byteSize : row?.size;
    requireThat(record(row) && Number.isSafeInteger(size) && size > 0 && size <= MAX_FILE && HASH.test(row.sha256), 'Invalid file size or checksum in manifest.');
    total += size;
    return {name, byteSize:size, sha256:row.sha256};
  });
  requireThat(total <= MAX_TOTAL, 'Release package exceeds the allowed size.');
  return {manifest:m, entries, builtin};
}

export async function verifyPackage(files, expected) {
  requireThat(files['manifest.json'] instanceof Uint8Array, 'Manifest bytes are missing.');
  const {manifest, entries, builtin} = manifestInventory(files['manifest.json'], expected);
  requireThat(same(Object.keys(files).sort(), [...entries.map(e => e.name), 'manifest.json'].sort()), 'Package file set differs from manifest.');
  for (const e of entries) requireThat(files[e.name] instanceof Uint8Array && files[e.name].byteLength === e.byteSize && digest(files[e.name]) === e.sha256, `Release bytes do not match manifest: ${e.name}.`);
  const config = json(files['config.json']);
  let packageSha256 = null;
  if (builtin) {
    const {descriptor} = await describeCandidate(expected.site_id, {files});
    requireThat(descriptor.releaseId === expected.release_id && expected.release_version === descriptor.releaseId, 'Built-in package identity differs from selected release.');
    packageSha256 = descriptor.packageSha256;
  } else {
    requireThat(config.site?.id === expected.site_id && config.version === expected.release_version && digest(files['config.json']) === manifest.configHash, 'Release configuration identity or checksum differs.');
    requireThat(same(config.prebidBuild, manifest.prebidBuild), 'Prebid configuration and manifest differ.');
  }
  if (!builtin && (manifest.prebidEnabled === false || config.enablePrebid === false || manifest.prebidBuild === null)) {
    requireThat(manifest.prebidEnabled === false && config.enablePrebid === false
      && manifest.demandMode === 'gam-adx-only' && config.demandMode === 'gam-adx-only'
      && manifest.prebidBuild === null && config.prebidBuild === null, 'AdX-only mode declarations differ.');
    requireThat(Buffer.from(files['prebid.js']).equals(Buffer.from(DISABLED_PREBID)), 'AdX-only Prebid placeholder differs.');
  } else if (files['prebid.js']) {
    requireThat(record(manifest.prebidBuild) && Array.isArray(manifest.prebidBuild.modules), 'Prebid metadata is missing.');
    const header = parsePrebidHeader(new TextDecoder('utf-8',{fatal:true}).decode(files['prebid.js']).slice(0,500000));
    requireThat(header.version === manifest.prebidBuild?.version && Array.isArray(manifest.prebidBuild.modules), 'Prebid version differs from manifest.');
    requireThat(same(header.modules, [...new Set(manifest.prebidBuild.modules)].sort()), 'Prebid modules differ from manifest.');
  }
  return {schemaVersion:1, siteId:expected.site_id, releaseId:expected.release_id, version:expected.release_version,
    packageSha256, manifestSha256:digest(files['manifest.json']), builtinDraft:builtin,
    files:[...entries,{name:'manifest.json',byteSize:files['manifest.json'].byteLength,sha256:digest(files['manifest.json'])}].sort((a,b)=>a.name.localeCompare(b.name))};
}

export async function boundedGet(url, maxBytes, {fetcher=fetch, headers={}}={}) {
  const response = await fetcher(url, {method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(20000)});
  requireThat(response.ok && !response.redirected, 'Artifact or provider request failed.');
  const length = response.headers.get('content-length');
  requireThat(length === null || (/^\d+$/.test(length) && Number(length) <= maxBytes), 'Response exceeds the expected size.');
  requireThat(response.body, 'Response body is missing.');
  const reader=response.body.getReader(), chunks=[]; let size=0;
  try { for (;;) {const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new Error('Response exceeds the expected size.');}chunks.push(value);} }
  finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return {bytes,headers:response.headers};
}

export async function checkPagesProject(input, token, fetcher=fetch) {
  requireThat(typeof token === 'string' && token.length > 0, 'Scoped Cloudflare token is missing.');
  const {bytes}=await boundedGet(`https://api.cloudflare.com/client/v4/accounts/${input.account_id}/pages/projects/${input.project_name}`,256*1024,{fetcher,headers:{Authorization:`Bearer ${token}`}});
  const data=json(bytes), project=data.result;
  requireThat(data.success === true && project?.name === input.project_name && typeof project.production_branch === 'string' && project.production_branch.length > 0, 'Target Pages project could not be confirmed.');
  requireThat(input.channel === 'staging' ? input.branch !== project.production_branch : input.branch === project.production_branch, 'Selected branch does not match the requested staging/production channel.');
  return {accountId:input.account_id,projectName:project.name,productionBranch:project.production_branch,branch:input.branch,channel:input.channel};
}

export function deploymentOrigin(value, projectName) {
  requireThat(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(projectName), 'Invalid Pages project.');
  let u;try{u=new URL(value);}catch{throw new Error('Pages deployment URL is missing.');}
  requireThat(u.protocol==='https:' && !u.username && !u.password && !u.port && !u.search && !u.hash && u.pathname==='/'
    && new RegExp(`^[a-f0-9]{8,32}\\.${projectName}\\.pages\\.dev$`).test(u.hostname), 'An immutable Pages deployment URL is required.');
  return u.origin;
}

export function previewOrigin(value, projectName, branch) {
  requireThat(/^[a-z][a-z0-9-]{0,39}$/.test(branch) && !['main','master','production','prod'].includes(branch), 'A separate preview branch is required.');
  // Reuse the project validator without allowing arbitrary public origins.
  deploymentOrigin(`https://12345678.${projectName}.pages.dev`,projectName);
  const expected=`https://${branch}.${projectName}.pages.dev`;
  requireThat(value === expected, 'Preview URL differs from the selected branch.');
  return expected;
}
export async function verifyPublicPackage(url, projectName, verified, fetcher=fetch, expectedPreviewBranch) {
  const origin=expectedPreviewBranch === undefined ? deploymentOrigin(url,projectName) : previewOrigin(url,projectName,expectedPreviewBranch);
  requireThat(Array.isArray(verified?.files) && verified.files.length>=8 && verified.files.length<=10
    && new Set(verified.files.map(e=>e.name)).size===verified.files.length
    && verified.files.every(e=>[...ALLOWED,'manifest.json'].includes(e.name) && Number.isSafeInteger(e.byteSize) && e.byteSize>0 && e.byteSize<=MAX_FILE && HASH.test(e.sha256))
    && verified.files.some(e=>e.name==='manifest.json' && e.sha256===verified.manifestSha256), 'Invalid verified file inventory.');
  for (const e of verified.files) {
    // Pages canonicalizes static HTML paths. Permit exactly its one same-origin
    // implementation.html -> /implementation hop, never redirects for assets,
    // authenticated source reads or provider API calls.
    const publicFetch = e.name === 'implementation.html' ? async (url, options) => {
      const response = await fetcher(url, {...options, redirect:'manual'});
      if (![301,308].includes(response.status)) return response;
      const location = response.headers.get('location');
      await response.body?.cancel();
      requireThat(location === '/implementation' || location === `${origin}/implementation`, 'Unexpected HTML canonical redirect.');
      return fetcher(`${origin}/implementation`, options);
    } : fetcher;
    let fetched;
    try { fetched = await boundedGet(`${origin}/${e.name}`,e.byteSize,{fetcher:publicFetch}); }
    catch (error) { throw new Error(`Published file could not be read: ${e.name}. ${error.message}`); }
    const {bytes,headers}=fetched;
    requireThat(bytes.byteLength===e.byteSize && digest(bytes)===e.sha256, `Published file differs: ${e.name}.`);
    const type=(headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    const allowed=e.name.endsWith('.js')?['application/javascript','text/javascript']:e.name.endsWith('.json')?['application/json']:e.name.endsWith('.css')?['text/css']:e.name.endsWith('.html')?['text/html']:['text/plain','text/csv'];
    requireThat(allowed.includes(type), `Unexpected content type: ${e.name}.`);
    requireThat(headers.get('access-control-allow-origin')==='*' && headers.get('x-content-type-options')==='nosniff', `Missing delivery headers: ${e.name}.`);
    requireThat(/(?:^|,)\s*no-store\s*(?:,|$)/i.test(headers.get('cache-control')||''), `Missing cache policy: ${e.name}.`);
  }
  return {verified:true,deploymentUrl:origin,fileCount:verified.files.length,manifestSha256:verified.manifestSha256};
}

export function callbackResult({deployOutcome,verificationOutcome,runId,runUrl,correlationId,deploymentUrl='',aliasUrl=''}) {
  const deployed=deployOutcome==='success';
  const verified=deployed && verificationOutcome==='success';
  return {correlationId,status:verified?'success':'failed',githubRunId:runId,githubRunUrl:runUrl,
    deploymentUrl:deployed?deploymentUrl:'',aliasUrl:deployed?aliasUrl:'',
    message:verified?'Cloudflare Pages deployment and every published file were verified.':deployed?'Pages deployment completed, but public file verification failed. Inspect this deployment before retrying.':'No successful Pages deployment was confirmed. Inspect the workflow before retrying.'};
}

async function main() {
  const mode=process.argv[2];
  const input=validateDeploymentInput(JSON.parse(process.env.DEPLOY_INPUTS||'null'),process.env.GITHUB_REF);
  const root=resolve('.generated/pages-release'), dist=resolve(root,'dist');
  if(mode==='validate'){console.log('Deployment identity, URLs, secret reference and channel validated.');return;}
  if(mode==='prepare') {
    const project=await checkPagesProject(input,process.env.CLOUDFLARE_API_TOKEN);
    const {bytes:manifest}=await boundedGet(input.release_base_url+'/manifest.json',256*1024);
    requireThat(digest(manifest)===input.manifest_sha256, 'Source manifest differs from the dispatched checksum.');
    const inventory=manifestInventory(manifest,input);
    requireThat(!inventory.builtin, 'Built-in drafts cannot use legacy publication.');
    const files={'manifest.json':manifest};
    for(const e of inventory.entries)files[e.name]=(await boundedGet(input.release_base_url+'/'+e.name,e.byteSize)).bytes;
    const verified=await verifyPackage(files,input);
    await mkdir(dist,{recursive:true});requireThat((await readdir(dist)).length===0,'Deployment directory must be empty.');
    for(const [name,bytes] of Object.entries(files))await writeFile(resolve(dist,name),bytes,{flag:'wx'});
    const headers='/*\n  Access-Control-Allow-Origin: *\n  X-Content-Type-Options: nosniff\n  Cache-Control: no-store\n  X-Robots-Tag: noindex\n';
    await writeFile(resolve(dist,'_headers'),headers,{flag:'wx'});
    await writeFile(resolve(root,'verification.json'),JSON.stringify({project,verified},null,2)+'\n');
    console.log(`Verified ${verified.files.length} release files and the actual Pages branch.`);return;
  }
  if(mode==='verify-public'){
    const {verified}=JSON.parse(await readFile(resolve(root,'verification.json'),'utf8'));
    requireThat(verified.manifestSha256===input.manifest_sha256 && verified.siteId===input.site_id && verified.releaseId===input.release_id && verified.version===input.release_version, 'Verification evidence belongs to another deployment.');
    const result=await verifyPublicPackage(process.env.PAGES_DEPLOYMENT_URL,input.project_name,verified);
    await writeFile(resolve(root,'public-verification.json'),JSON.stringify(result,null,2)+'\n');
    console.log(`Verified ${result.fileCount} files at the immutable Pages deployment.`);return;
  }
  if(mode==='callback'){
    requireThat(process.env.CALLBACK_SECRET, 'Deployment status callback secret is missing.');
    const payload=callbackResult({deployOutcome:process.env.DEPLOY_OUTCOME,verificationOutcome:process.env.VERIFY_OUTCOME,
      runId:process.env.GITHUB_RUN_ID,runUrl:`https://github.com/Mbaucal/prebid-professor/actions/runs/${process.env.GITHUB_RUN_ID}`,
      correlationId:input.correlation_id,deploymentUrl:process.env.PAGES_DEPLOYMENT_URL,aliasUrl:process.env.PAGES_ALIAS_URL});
    const response=await fetch(input.callback_url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${process.env.CALLBACK_SECRET}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    requireThat(response.ok,'Status callback failed. The Pages outcome above is unchanged; reconcile the status without redeploying.');
    console.log('Deployment result reported.');return;
  }
  throw new Error('Unknown verification command.');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
