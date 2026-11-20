import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {runtimeReleaseHistory,assertRuntimeReleaseSource} from '../worker/runtime/runtime-release-history.mjs';
import {sourceFiles as previousFiles,MODULE_SHA256,exportedBrowserFunction} from './prepare-runtime3251.mjs';
export const sourceFiles=[...previousFiles,'shared/auction-timeout/settings.mjs','worker/runtime-326/browser-auction-timeout.mjs','worker/runtime-326/compiler.mjs','worker/runtime-326/snapshot.mjs','worker/runtime-326/settings-guard.mjs','worker/runtime-326/artifact-candidate.mjs','scripts/prepare-runtime326.mjs'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function runtime326Source(root){
  const components=[{path:'reference391.mjs',sha256:MODULE_SHA256}];
  for(const path of sourceFiles)components.push({path,sha256:hash(await readFile(resolve(root,path)))});
  components.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  return {codeSha256:hash(JSON.stringify(components)),components};
}
export async function prepareRuntime326(root){
  const {codeSha256,components}=await runtime326Source(root);
  const release=runtimeReleaseHistory.find(r=>r.id==='tessera-3.26.0'&&r.version==='3.26.0');
  if(!release)throw Error('Register Tessera 3.26.0 before building.');
  assertRuntimeReleaseSource(codeSha256,release);
  const browserSources={createAdaptiveAuctionTimeout:exportedBrowserFunction(await readFile(resolve(root,'worker/runtime-326/browser-auction-timeout.mjs'),'utf8'),'createAdaptiveAuctionTimeout')};
  await writeFile(resolve(root,'.generated/runtime-326-browser-source.mjs'),`export const browserSources=${JSON.stringify(browserSources)};\n`);
  const {id,version,configSchemaVersion,channel,capabilities}=release;
  await writeFile(resolve(root,'.generated/runtime-326-manifest.mjs'),`// Generated from verified versioned sources.\nexport const descriptor=${JSON.stringify({id,version,configSchemaVersion,channel,capabilities,codeSha256})};\nexport const sourceComponents=${JSON.stringify(components)};\n`);
}
