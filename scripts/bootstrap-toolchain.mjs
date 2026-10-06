import {spawnSync} from 'node:child_process';
import {symlink,readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {sha,verifyIsolation,selectedProfile,readReceipt} from './verify-toolchain-isolation.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const profile=selectedProfile();
const receipt=await readReceipt(root,profile);
assert.equal(sha(await readFile(resolve(root,'package-lock.json'))),receipt.lockSha256,'Refusing install against altered historical lock.');
for(const [cwd,args] of [[root,['ci','--omit=dev','--ignore-scripts']],[resolve(root,'tools'),['ci','--include=dev','--ignore-scripts']]]){
 const result=spawnSync('npm',args,{cwd,stdio:'inherit'});if(result.status!==0)process.exit(result.status??1);
}
// Only a package bridge: no compiler source or old source-component is redirected.
await symlink('../tools/node_modules/esbuild',resolve(root,'node_modules/esbuild'));
console.log(JSON.stringify(await verifyIsolation(root,{profile}),null,2));
