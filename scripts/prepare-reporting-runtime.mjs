import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {runtimeReleaseHistory, assertRuntimeReleaseSource} from '../worker/runtime/runtime-release-history.mjs';
export const MODULE_SHA256 = '80a5e8259a579891043e0d49bb47e18fb4c3b8319cfd73af49a1461c18447639';
export const sourceFiles = [
  'worker/runtime-compiler.ts','worker/runtime/reference-bridge.mjs','worker/runtime/consent-timer.mjs',
  'worker/runtime/version-pin.mjs','worker/runtime/preview-snapshot.mjs','worker/runtime/artifact-candidate.mjs',
  'worker/runtime/artifact-styles.mjs','worker/runtime/artifact-minifier.mjs','worker/runtime/prebid-artifact-check.mjs',
  'worker/runtime-next/position-settings.mjs','worker/runtime-next/snapshot.mjs','worker/runtime-next/compiler.mjs',
  'worker/runtime-next/browser-functions.mjs','worker/runtime-next/artifact-candidate.mjs','package-lock.json',
  'worker/runtime-reporting-v1/browser-reporting.mjs','worker/runtime-reporting-v1/compiler.mjs',
  'worker/runtime-reporting-v1/contract.mjs','worker/runtime-reporting-v1/artifact-candidate.mjs',
  'scripts/prepare-reporting-runtime.mjs'
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function reportingRuntimeSource(root) {
  const components = [{path:'reference391.mjs',sha256:MODULE_SHA256}];
  for (const path of sourceFiles) components.push({path,sha256:hash(await readFile(resolve(root,path)))});
  components.sort((a,b) => a.path.localeCompare(b.path,'en'));
  return {codeSha256:hash(JSON.stringify(components)),components};
}
export async function prepareReportingRuntime(root) {
  const {codeSha256,components} = await reportingRuntimeSource(root);
  const release = runtimeReleaseHistory.find(r=>r.id==='tessera-reporting-v1');
  if (!release) throw Error('Register the reporting runtime before building.');
  assertRuntimeReleaseSource(codeSha256,release);
  const {id,version,configSchemaVersion,channel,capabilities}=release;
  const browserSources={};
  for(const path of ['worker/runtime-next/browser-functions.mjs','worker/runtime-reporting-v1/browser-reporting.mjs']){
    const source=await readFile(resolve(root,path),'utf8');
    for(const node of parse(source,{ecmaVersion:'latest',sourceType:'module'}).body){
      if(node.type==='ExportNamedDeclaration'&&node.declaration?.type==='FunctionDeclaration'){
        const fn=node.declaration;browserSources[fn.id.name]=source.slice(fn.start,fn.end);
      }
    }
  }
  await writeFile(resolve(root,'.generated/runtime-reporting-browser-source.mjs'),
    `// Browser source preserved before Worker bundling; never Function#toString.\nexport const browserSources=${JSON.stringify(browserSources)};\n`);
  await writeFile(resolve(root,'.generated/runtime-reporting-manifest.mjs'),
    `// Generated from verified versioned sources.\nexport const descriptor=${JSON.stringify({id,version,configSchemaVersion,channel,capabilities,codeSha256})};\nexport const sourceComponents=${JSON.stringify(components)};\n`);
}
