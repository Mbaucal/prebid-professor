import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {verifyIsolation,verifyOutputs,sha} from './verify-toolchain-isolation.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const command=process.argv[2];
if(!['prepare','build','typecheck','dry-run'].includes(command))throw Error('Usage: node scripts/isolated-toolchain.mjs prepare|build|typecheck|dry-run');
const isolation=await verifyIsolation(root);
function run(args){const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});if(result.status!==0)process.exit(result.status??1);}
if(command==='typecheck'){
 for(const config of ['app','worker','tooling'])run(['tools/node_modules/typescript/bin/tsc','--noEmit','-p',`tools/tsconfig.${config}.json`]);
}else if(command==='dry-run'){
 run(['tools/node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--outdir','.generated/toolchain-dry-run']);
}else{
 run(['scripts/prepare-builtin-runtime.mjs']);
 run(['--experimental-strip-types','scripts/prepare-site-ab-baseline.mjs']);
 const outputs=await verifyOutputs(root);
 if(command==='build')run(['tools/node_modules/vite/bin/vite.js','build','--config','tools/vite.config.ts']);
 await mkdir(resolve(root,'.generated/toolchain-evidence'),{recursive:true});
 await writeFile(resolve(root,'.generated/toolchain-evidence/build.json'),JSON.stringify({isolation,outputs,toolsLockSha256:sha(await readFile(resolve(root,'tools/package-lock.json'))),node:process.version,command,consumerTestPageSha256:sha(await readFile(resolve(root,'.generated/test-page-client.mjs')))},null,2)+'\n');
}
