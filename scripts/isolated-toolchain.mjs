import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {verifyIsolation,verifyOutputs,sha,selectedProfile} from './verify-toolchain-isolation.mjs';
import {sealTestBuild,validateTestBuild} from './test-toolchain-seal.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const command=process.argv[2],profile=selectedProfile();
assert(['prepare','build','typecheck','dry-run','test-build','test-dry-run','test-deploy-check','test-deploy'].includes(command),'Unknown isolated toolchain command.');
assert(process.argv.length===3||(process.argv.length===5&&process.argv[3]==='--profile'),'Only command and explicit --profile are accepted; no Wrangler passthrough.');
if(command.startsWith('test-'))assert.equal(profile,'test','TEST commands require --profile test.');
if(command==='dry-run')assert.equal(profile,'main','Use test-dry-run for the TEST profile.');
const isolation=await verifyIsolation(root,{profile});
function run(args,cwd=root){const result=spawnSync(process.execPath,args,{cwd,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});if(result.status!==0)process.exit(result.status??1);}
const wrangler=resolve(root,'tools/node_modules/wrangler/bin/wrangler.js'),testCwd=resolve(root,'ops/runtime-test');
function dryRunTest(){
 run(['scripts/check-test-activation.mjs']);
 for(const [config,out] of [['wrangler.jsonc','test-workspace-dry-run'],['wrangler.active.jsonc','test-workspace-active-dry-run']])run([wrangler,'deploy','--config',config,'--dry-run','--outdir',resolve(root,'.generated',out)],testCwd);
 run(['scripts/check-test-activation.mjs','--compare-bundles']);
}
if(command==='typecheck'){
 for(const config of ['app','worker','tooling'])run(['tools/node_modules/typescript/bin/tsc','--noEmit','-p',`tools/tsconfig.${config}.json`]);
}else if(command==='dry-run'){
 run([wrangler,'deploy','--dry-run','--outdir','.generated/toolchain-dry-run']);
}else if(command==='test-dry-run'){
 dryRunTest();
}else if(command==='test-deploy'||command==='test-deploy-check'){
 await verifyOutputs(root,{profile});
 run(['scripts/check-test-activation.mjs','--compare-bundles']);
 console.log(JSON.stringify(await validateTestBuild(root),null,2));
 const entry=resolve(root,'.generated/test-workspace-active-dry-run/index.js');
 if(command==='test-deploy')run([wrangler,'deploy',entry,'--no-bundle','--config','wrangler.active.jsonc'],testCwd);
 else {
  const out=resolve(root,'.generated/test-workspace-sealed-dry-run');
  run([wrangler,'deploy',entry,'--no-bundle','--config','wrangler.active.jsonc','--dry-run','--outdir',out],testCwd);
  assert.equal(sha(await readFile(resolve(out,'index.js'))),sha(await readFile(entry)),'No-bundle deployment changed the sealed Worker.');
 }
}else{
 run(['scripts/prepare-builtin-runtime.mjs']);
 run(['--experimental-strip-types','scripts/prepare-site-ab-baseline.mjs']);
 const outputs=await verifyOutputs(root,{profile});
 if(command==='build')run(['tools/node_modules/vite/bin/vite.js','build','--config','tools/vite.config.ts']);
 if(command==='test-build'){
  run(['scripts/prepare-test-workspace.mjs']);dryRunTest();console.log(JSON.stringify(await sealTestBuild(root),null,2));
 }
 await mkdir(resolve(root,'.generated/toolchain-evidence'),{recursive:true});
 await writeFile(resolve(root,'.generated/toolchain-evidence/build.json'),JSON.stringify({isolation,outputs,toolsLockSha256:sha(await readFile(resolve(root,'tools/package-lock.json'))),node:process.version,command,consumerTestPageSha256:sha(await readFile(resolve(root,'.generated/test-page-client.mjs')))},null,2)+'\n');
}
