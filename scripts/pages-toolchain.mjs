import assert from 'node:assert/strict';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {verifyIsolation} from './verify-toolchain-isolation.mjs';
import {validateDeploymentInput} from './pages-release-verification.mjs';
export const WRANGLER_VERSION='4.131.0';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function absent(path){try{await lstat(path);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}}
const baselines={main:'685d90b6974133e19e96f7ceb28e60a58b7ce402',test:'893bf83fbefc29dca966207574f57ce35575e9de'};
export async function pagesProfile(repo,env){
 const input=validateDeploymentInput(JSON.parse(env.DEPLOY_INPUTS||'null'),env.GITHUB_REF);
 assert.equal(env.GITHUB_REPOSITORY,'Mbaucal/prebid-professor','Unexpected deployment repository.');
 let marker=null;try{marker=JSON.parse(await readFile(resolve(repo,'tools/target-profile.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const profile=marker?.profile??'main';assert(['main','test'].includes(profile),'Unknown source profile.');
 const testReceiptExists=!(await absent(resolve(repo,'tools/test-historical-inputs.json')));
 assert.equal(testReceiptExists,profile==='test','TEST source requires its explicit marker; no fallback to main.');
 const receipt=JSON.parse(await readFile(resolve(repo,profile==='test'?'tools/test-historical-inputs.json':'tools/historical-inputs.json'),'utf8'));
 assert.equal(receipt.baselineCommit,baselines[profile],'Unreviewed historical baseline.');
 if(marker)assert.equal(marker.baselineCommit,receipt.baselineCommit,'Source marker differs from historical receipt.');
 if(input.channel==='production')assert.equal(profile,'main','Production requires the reviewed main source profile.');
 return profile;
}
export async function verifyPagesTools(repo,execute=spawnSync,profile='main'){
 assert.equal(profile,'main','This MAIN toolchain cannot execute a TEST profile.');
 await verifyIsolation(repo);
 const cwd=resolve(repo,'tools');
 assert.equal(await realpath(resolve(cwd,'node_modules/.bin/wrangler')),resolve(cwd,'node_modules/wrangler/bin/wrangler.js'),'Wrangler resolution escaped locked tools.');
 // Pages discovers configuration/functions from cwd. Reject additional implicit inputs;
 // the existing parent Worker config has no Pages output directory and is ignored by Pages.
 for(const base of [repo,cwd])for(const name of ['functions','wrangler.toml','wrangler.json','.wrangler/deploy/config.json'])assert(await absent(resolve(base,name)),'Unexpected Pages configuration/functions.');
 assert(await absent(resolve(cwd,'wrangler.jsonc')),'Unexpected tools Pages configuration.');
 const workerConfig=await readFile(resolve(repo,'wrangler.jsonc'),'utf8');assert(!workerConfig.includes('pages_build_output_dir'),'Parent configuration became a Pages configuration.');
 const result=execute('npx',['--no-install','wrangler','--version'],{cwd,encoding:'utf8',shell:false,env:{...process.env,WRANGLER_SEND_METRICS:'false',CI:'true'}});
 assert.equal(result.status,0,'Locked Wrangler must execute before the action can run.');
 const versions=result.stdout?.match(/\d+\.\d+\.\d+[^\s]*/g)??[];
 assert.deepEqual(versions,[WRANGLER_VERSION],'Ambiguous or nonexact Wrangler version output.');
 const actual=versions[0];
 assert.equal(actual,WRANGLER_VERSION,'Action must reuse the exact installed Wrangler; no fallback installation.');
 return actual;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert(process.argv.length===3&&['check','bootstrap'].includes(process.argv[2]),'Use check or bootstrap; no profile/command passthrough.');
 const profile=await pagesProfile(root,process.env);
 assert.equal(profile,'main','This MAIN checkout supports only the MAIN bootstrap API.');
 if(process.argv[2]==='bootstrap'){
  // The reviewed main bootstrap predates explicit profile flags; its default is main.
  const args=['scripts/bootstrap-toolchain.mjs'];
  const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',shell:false});if(result.status!==0)process.exit(result.status??1);
 }
 console.log('Validated Pages source profile: '+profile);
}
