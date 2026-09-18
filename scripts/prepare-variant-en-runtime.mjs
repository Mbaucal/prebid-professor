import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { runtimeReleaseHistory, assertRuntimeReleaseSource } from '../worker/runtime/runtime-release-history.mjs';
export const MODULE_SHA256='80a5e8259a579891043e0d49bb47e18fb4c3b8319cfd73af49a1461c18447639';
export const sourceFiles=[
  'worker/runtime-compiler.ts','worker/runtime/reference-bridge.mjs','worker/runtime/consent-timer.mjs',
  'worker/runtime/version-pin.mjs','worker/runtime/preview-snapshot.mjs','worker/runtime/artifact-candidate.mjs',
  'worker/runtime/artifact-styles.mjs','worker/runtime/artifact-minifier.mjs','worker/runtime/prebid-artifact-check.mjs',
  'worker/runtime-next/position-settings.mjs','worker/runtime-next/snapshot.mjs','worker/runtime-next/compiler.mjs',
  'worker/runtime-next/browser-functions.mjs','worker/runtime-next/artifact-candidate.mjs','package-lock.json',
  'worker/runtime-observed/observer.mjs','worker/runtime-observed/compiler.mjs','worker/runtime-observed/artifact-candidate.mjs',
  'worker/runtime-measured/targeting.mjs','worker/runtime-measured/compiler.mjs','worker/runtime-measured/artifact-candidate.mjs',
  'worker/runtime-cache/policy.mjs','worker/runtime-cache/consent-epoch.mjs','worker/runtime-cache/lifecycle.mjs',
  'worker/runtime-cache/snapshot.mjs','worker/runtime-cache/compiler.mjs','worker/runtime-cache/artifact-candidate.mjs',
  'vendor/prebid/tanjug-11.34.0/prebid.js',
  'worker/runtime-variant-en/targeting.mjs','worker/runtime-variant-en/compiler.mjs','worker/runtime-variant-en/artifact-candidate.mjs'
];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function englishVariantRuntimeSource(root){
  const components=[{path:'reference391.mjs',sha256:MODULE_SHA256}];
  for(const path of sourceFiles)components.push({path,sha256:hash(await readFile(resolve(root,path)))});
  components.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  return {codeSha256:hash(JSON.stringify(components)),components};
}
export async function prepareEnglishVariantRuntime(root){
  const {codeSha256,components}=await englishVariantRuntimeSource(root);
  const release=runtimeReleaseHistory.find(r=>r.id==='variant-labels-en-preview-1');
  if(!release)throw Error('Register the variant runtime before building.');
  assertRuntimeReleaseSource(codeSha256,release);
  const {id,version,configSchemaVersion,channel,capabilities}=release;
  const descriptor={id,version,configSchemaVersion,channel,capabilities,codeSha256};
  await writeFile(resolve(root,'.generated/runtime-variant-en-manifest.mjs'),`// Generated from verified versioned sources.\nexport const descriptor=${JSON.stringify(descriptor)};\nexport const sourceComponents=${JSON.stringify(components)};\n`);
}
