import { unzipSync } from 'fflate';
import { describeCandidate } from '../runtime/draft-release-store.mjs';
import { sha256, parsePrebidHeader } from '../runtime/prebid-artifact-check.mjs';

export const DEPLOY_ORIGIN = 'https://prebid-professor-test.mbaucal.workers.dev';
export const DEPLOY_REPO = 'Mbaucal/prebid-professor';
export const DEPLOY_REF = 'feature/isolated-runtime-workspace-v1';
export const REQUEST_ID = /^builtin-test-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const RELEASE_ID = /^builtin-draft-[a-f0-9]{64}$/;
export const MAX_ZIP = 13 * 1024 * 1024;
export const SITES = ['tanjug-test', 'test-site'];
export const requireThat = (ok, message) => { if (!ok) throw Error(message); };
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const destination = t => `${t.accountId}/${t.projectName}/${t.previewBranch}`;
export function validateTarget(t) {
  requireThat(t && Object.keys(t).sort().join(',') === 'accountId,previewBranch,projectName,secretName', 'Unesi samo podatke TEST odredišta.');
  requireThat(typeof t.accountId === 'string' && /^[a-f0-9]{32}$/.test(t.accountId), 'Cloudflare Account ID mora imati 32 mala heksadecimalna znaka.');
  requireThat(typeof t.projectName === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(t.projectName), 'Unesi tačan naziv Pages projekta.');
  // Deliberately restrict preview aliases to an unambiguous lowercase DNS label.
  requireThat(typeof t.previewBranch === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(t.previewBranch)
    && !['main', 'master', 'production', 'prod'].includes(t.previewBranch), 'Izaberi posebnu TEST granu, na primer tessera-test.');
  requireThat(typeof t.secretName === 'string' && /^CLOUDFLARE_API_TOKEN(?:_[A-Z][A-Z0-9_]{0,60})?$/.test(t.secretName), 'Unesi naziv GitHub tajne, na primer CLOUDFLARE_API_TOKEN, bez samog tokena.');
  return structuredClone(t);
}
export function dispatchInputs(run) {
  const base = `${DEPLOY_ORIGIN}/test-api/deployment-runner/${run.id}`;
  return {correlation_id:run.id, callback_url:base+'/report', site_id:run.siteId,
    release_id:run.package.descriptor.releaseId, release_version:run.package.descriptor.releaseId,
    release_base_url:base, manifest_sha256:run.package.descriptor.files.find(f => f.name === 'manifest.json').sha256,
    github_environment:run.target.secretName, account_id:run.target.accountId, project_name:run.target.projectName,
    branch:run.target.previewBranch, channel:'staging'};
}
export function validateRunnerInput(input, ref, repo) {
  requireThat(ref === 'refs/heads/'+DEPLOY_REF && repo === DEPLOY_REPO, 'Builtin delivery is restricted to the reviewed TEST branch and repository.');
  requireThat(input && REQUEST_ID.test(input.correlation_id) && SITES.includes(input.site_id)
    && RELEASE_ID.test(input.release_id) && input.release_version === input.release_id && input.channel === 'staging', 'Invalid TEST deployment identity.');
  validateTarget({accountId:input.account_id, projectName:input.project_name, previewBranch:input.branch, secretName:input.github_environment});
  const base = `${DEPLOY_ORIGIN}/test-api/deployment-runner/${input.correlation_id}`;
  requireThat(input.release_base_url === base && input.callback_url === base+'/report'
    && /^[a-f0-9]{64}$/.test(input.manifest_sha256), 'Invalid private TEST source or callback.');
  requireThat(Object.keys(input).length === 12, 'Unexpected deployment inputs.');
  return input;
}
export async function verifyDeliveryZip(bytes, expected) {
  requireThat(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= MAX_ZIP, 'Invalid delivery ZIP size.');
  if (expected.zipSha256) requireThat(await sha256(bytes) === expected.zipSha256, 'Saved delivery ZIP differs.');
  let total = 0, count = 0;
  const allowed = new Set(['README.txt','ads.js','ads.min.js','config.json','div-export.csv','implementation.html','manifest.json','min-height.css','sticky.css','prebid.js','gam-reporting.json']);
  const names = new Set();
  const files = unzipSync(bytes, {filter(entry) {
    requireThat(allowed.has(entry.name) && !names.has(entry.name), 'Unexpected or duplicate ZIP entry.');
    names.add(entry.name); total += entry.originalSize; count++;
    requireThat(count <= allowed.size && entry.originalSize > 0 && entry.originalSize <= 8*1024*1024 && total <= 12*1024*1024, 'Expanded ZIP exceeds delivery limits.');
    return true;
  }});
  const result = await describeCandidate(expected.siteId, {files});
  requireThat(result.descriptor.packageSha256 === expected.packageSha256, 'Saved package identity differs.');
  if (files['prebid.js']) {
    const header = parsePrebidHeader(new TextDecoder().decode(files['prebid.js'])), pin = result.descriptor.prebidBuild;
    requireThat(header.version === pin.version && same(header.modules, [...new Set(pin.modules)].sort()), 'Prebid declarations differ from the pinned build.');
  }
  return result;
}
