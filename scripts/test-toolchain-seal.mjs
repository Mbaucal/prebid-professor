import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {filesUnder,sha,readReceipt} from './verify-toolchain-isolation.mjs';
const evidence='.generated/toolchain-evidence/test-build.json';
async function state(root){
 const inputs={};
 for(const path of ['worker','scripts','src','shared','vendor','ops/runtime-test','tools'])inputs[path]=await filesUnder(resolve(root,path),{skipModules:true});
 for(const path of ['package.json','package-lock.json'])inputs[path]=sha(await readFile(resolve(root,path)));
 const generated={};
 // All current Worker generated imports are direct files here; evidence and dry-run subdirectories are excluded.
 for(const name of (await readdir(resolve(root,'.generated'))).sort()){
  const path=resolve(root,'.generated',name),stat=await lstat(path);
  assert(!stat.isSymbolicLink(),'Generated build inputs must not be symlinks.');
  if(stat.isFile())generated[name]=sha(await readFile(path));
 }
 const compiled={};
 for(const path of ['.generated/test-workspace-dry-run','.generated/test-workspace-active-dry-run']){
  const names=(await readdir(resolve(root,path))).filter(name=>/\.m?js$/.test(name));assert.equal(names.length,1,'Expected one bundled TEST Worker.');
  compiled[path]=sha(await readFile(resolve(root,path,names[0])));
 }
 assert.equal(...Object.values(compiled),'Enabled and disabled TEST configurations produced different Worker bytes.');
 return {profile:'test',baselineCommit:(await readReceipt(root,'test')).baselineCommit,
  commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:root,encoding:'utf8'}).trim(),
  clean:execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'}).trim()==='',
  sourceSha256:sha(JSON.stringify(inputs)),generated,
  toolsLockSha256:sha(await readFile(resolve(root,'tools/package-lock.json'))),
  activeConfigSha256:sha(await readFile(resolve(root,'ops/runtime-test/wrangler.active.jsonc'))),compiled};
}
export async function sealTestBuild(root){const current=await state(root);await mkdir(resolve(root,'.generated/toolchain-evidence'),{recursive:true});await writeFile(resolve(root,evidence),JSON.stringify(current,null,2)+'\n');return current;}
export async function validateTestBuild(root){const expected=JSON.parse(await readFile(resolve(root,evidence),'utf8'));const current=await state(root);assert(expected.clean&&current.clean,'TEST deployment requires a clean committed source tree and a clean build receipt.');assert.deepEqual(current,expected,'TEST build is stale: rerun guarded test-build for this exact source and toolchain.');return current;}
