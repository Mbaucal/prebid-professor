import { sha256 } from '../runtime/prebid-artifact-check.mjs';
import { requireThat, same } from './deployment-contract.mjs';

export const ARCHIVE_LAYOUT = 'archive-v1';
export const SCRIPT_LAYOUT = 'publisher-scripts-v1';
const HASH = /^[a-f0-9]{64}$/;
export const deliveryIdentity = run => `${run.delivery?.profile || ARCHIVE_LAYOUT}:${run.package.descriptor.packageSha256}`;
export function deliveryHeaders(profile) {
  requireThat([ARCHIVE_LAYOUT,SCRIPT_LAYOUT].includes(profile),'Unknown delivery layout.');
  return '/*\n  Access-Control-Allow-Origin: *\n  X-Content-Type-Options: nosniff\n  Cache-Control: '
    +(profile === ARCHIVE_LAYOUT ? 'no-store' : 'public, max-age=0, must-revalidate')+'\n  X-Robots-Tag: noindex\n';
}
// Layouts are versioned separately from the accepted source package. Never
// rename files inside that archive or infer an old run's layout from today's UI.
export async function describeDelivery(descriptor, profile=SCRIPT_LAYOUT) {
  requireThat(HASH.test(descriptor?.packageSha256) && Array.isArray(descriptor.files),'Source package descriptor is missing.');
  const names = profile === SCRIPT_LAYOUT ? ['ads.min.js',...(descriptor.prebidBuild ? ['prebid.js'] : [])] : descriptor.files.map(f=>f.name);
  const files = names.map(sourceName => {
    const file = descriptor.files.find(f=>f.name === sourceName);
    requireThat(file && HASH.test(file.sha256) && Number.isSafeInteger(file.byteSize) && file.byteSize>0,'Required delivery file is missing.');
    return {name:profile === SCRIPT_LAYOUT && sourceName === 'ads.min.js' ? 'ads.js' : sourceName,sourceName,byteSize:file.byteSize,sha256:file.sha256};
  }).sort((a,b)=>a.name.localeCompare(b.name));
  const body = {schemaVersion:1,profile,sourcePackageSha256:descriptor.packageSha256,files,
    headersSha256:await sha256(new TextEncoder().encode(deliveryHeaders(profile)))};
  return {...body,sha256:await sha256(new TextEncoder().encode(JSON.stringify(body)))};
}
export async function selectDelivery(files, descriptor, saved) {
  const expected = await describeDelivery(descriptor,saved === undefined ? ARCHIVE_LAYOUT : saved?.profile);
  requireThat(saved === undefined || same(saved,expected),'Saved delivery layout differs from the original package.');
  const selected = {};
  for (const file of expected.files) {
    const bytes=files[file.sourceName];
    requireThat(bytes instanceof Uint8Array && bytes.byteLength === file.byteSize && await sha256(bytes) === file.sha256,'Delivery bytes differ: '+file.name);
    selected[file.name]=bytes;
  }
  return {files:selected,delivery:expected,headers:deliveryHeaders(expected.profile)};
}
