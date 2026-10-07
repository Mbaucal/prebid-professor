import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {verifyIsolation,verifyOutputs,sha} from './verify-toolchain-isolation.mjs';
import {parseToolchainCommand,testCompilationTargets} from './test-toolchain-targets.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const command=parseToolchainCommand(process.argv.slice(2));
const isolation=await verifyIsolation(root);
function run(args,cwd=root){const result=spawnSync(process.execPath,args,{cwd,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});if(result.status!==0)process.exit(result.status??1);}
if(command==='test-dry-run'||command==='test-bootstrap-dry-run'){
 const targets=await testCompilationTargets(root,command);
 if(command==='test-dry-run'){
  run(['scripts/prepare-builtin-runtime.mjs']);
  run(['--experimental-strip-types','scripts/prepare-site-ab-baseline.mjs']);
  await verifyOutputs(root);
  run(['scripts/prepare-test-workspace.mjs']);
 }
 for(const target of targets)run(target.args,target.cwd);
}else if(command==='typecheck'){
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
