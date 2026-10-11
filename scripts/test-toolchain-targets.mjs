/** Fixed local compilation only. MAIN historical isolation is enforced by the caller. */
import assert from 'node:assert/strict';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {assertTestDeployment} from './check-test-activation.mjs';
export function parseToolchainCommand(args){
 const commands=['prepare','build','typecheck','dry-run','test-dry-run','test-bootstrap-dry-run'];
 assert(args.length===1&&commands.includes(args[0]),`Usage: isolated-toolchain.mjs ${commands.join('|')} (no additional arguments or profiles)`);
 return args[0];
}
export async function testCompilationTargets(root,command,env=process.env){
 assert(['test-dry-run','test-bootstrap-dry-run'].includes(command),'Only fixed local TEST compilation targets');
 for(const key of ['CLOUDFLARE_ENV','WRANGLER_ENV','WRANGLER_CONFIG'])assert(!env[key],`Refusing configuration override: ${key}`);
 const configs=command==='test-dry-run' ? [
  ['ops/runtime-test/wrangler.jsonc','.generated/test-workspace-dry-run',false],
  ['ops/runtime-test/wrangler.active.jsonc','.generated/test-workspace-active-dry-run',true],
 ]:[['ops/test-worker/wrangler.jsonc','.generated/test-worker-dry-run',false]];
 const targets=[];
 for(const [file,output,active] of configs){
  const config=resolve(root,file);assert.equal(await realpath(config),config,'Fixed config must not be redirected by a symlink');
  const value=JSON.parse(await readFile(config,'utf8'));
  if(command==='test-dry-run')assertTestDeployment(value,{active});
  else {
   const {vars,...expected}=JSON.parse(await readFile(resolve(root,'ops/runtime-test/wrangler.jsonc'),'utf8'));
   assertTestDeployment({...expected,vars});expected.main='./worker.mjs';
   assert.deepEqual(value,expected,'Bootstrap config differs from the reviewed TEST-only allowlist');
  }
  targets.push({cwd:dirname(config),args:[resolve(root,'tools/node_modules/wrangler/bin/wrangler.js'),'deploy','--config',config,'--dry-run','--outdir',resolve(root,output)]});
 }
 return targets;
}
