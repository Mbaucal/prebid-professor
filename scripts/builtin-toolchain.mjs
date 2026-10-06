/** Node-only MAIN source guard; exposes locked installation, no deployment command. */
import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
export async function assertMainBuiltinSource(repo){
 for(const name of ['tools/target-profile.json','tools/test-historical-inputs.json']){
  let found=false;try{await lstat(resolve(repo,name));found=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  assert(!found,'Builtin delivery requires the explicit MAIN source contract; TEST markers/receipts are not accepted.');
 }
 const receipt=JSON.parse(await readFile(resolve(repo,'tools/historical-inputs.json'),'utf8'));
 assert.equal(receipt.baselineCommit,'685d90b6974133e19e96f7ceb28e60a58b7ce402','Unreviewed MAIN historical baseline.');
 assert.equal(createHash('sha256').update(await readFile(resolve(repo,'package-lock.json'))).digest('hex'),receipt.lockSha256,'Historical root lock differs.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert(process.argv.length===3&&process.argv[2]==='bootstrap','Use bootstrap only; no profiles or extra arguments.');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 await assertMainBuiltinSource(root);
 const result=spawnSync(process.execPath,['scripts/bootstrap-toolchain.mjs'],{cwd:root,stdio:'inherit',shell:false});
 if(result.status!==0)process.exit(result.status??1);
}
