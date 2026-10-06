import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseToolchainCommand,testCompilationTargets} from '../../scripts/test-toolchain-targets.mjs';
const root=resolve('.');
test('runner rejects missing, unknown, profile and extra arguments before installation or preparation',()=>{
 for(const args of [[],['deploy'],['test-dry-run','--profile','test'],['test-bootstrap-dry-run','--config','other'],['build','extra'],['dry-run','--outdir','other']]){
  assert.throws(()=>parseToolchainCommand(args),/no additional arguments/);
  const result=spawnSync(process.execPath,['scripts/isolated-toolchain.mjs',...args],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/no additional arguments/);assert.doesNotMatch(result.stdout,/Wrangler|Prepared/);
 }
});
test('fixed targets use absolute locked tool/config/output and dedicated cwd with dry-run only',async()=>{
 for(const command of ['test-dry-run','test-bootstrap-dry-run']){
  const targets=await testCompilationTargets(root,command,{});assert.equal(targets.length,command==='test-dry-run'?2:1);
  for(const target of targets){assert.equal(target.args[0],resolve(root,'tools/node_modules/wrangler/bin/wrangler.js'));assert.equal(target.args[1],'deploy');assert.equal(target.args[4],'--dry-run');assert.equal(target.args.length,7);assert(target.args[3].startsWith(target.cwd+'/'));assert(target.args[6].startsWith(resolve(root,'.generated')+'/'));}
 }
});
test('config changes, symlinks and ambient target overrides fail closed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mba233-guard-'));
 try{
  await mkdir(join(dir,'ops'),{recursive:true});await cp(join(root,'ops/runtime-test'),join(dir,'ops/runtime-test'),{recursive:true});await cp(join(root,'ops/test-worker'),join(dir,'ops/test-worker'),{recursive:true});
  for(const key of ['CLOUDFLARE_ENV','WRANGLER_ENV','WRANGLER_CONFIG'])await assert.rejects(testCompilationTargets(dir,'test-dry-run',{[key]:'unexpected'}),/override/);
  const path=join(dir,'ops/runtime-test/wrangler.active.jsonc'),original=await readFile(path,'utf8');
  const config=JSON.parse(original);config.build={command:'unexpected'};await writeFile(path,JSON.stringify(config));await assert.rejects(testCompilationTargets(dir,'test-dry-run',{}),/allowlist/);
  await writeFile(path,original);await rm(path);await symlink(join(root,'ops/runtime-test/wrangler.active.jsonc'),path);await assert.rejects(testCompilationTargets(dir,'test-dry-run',{}),/symlink/);
  const bootstrap=join(dir,'ops/test-worker/wrangler.jsonc');const other=JSON.parse(await readFile(bootstrap,'utf8'));other.name='production';await writeFile(bootstrap,JSON.stringify(other));await assert.rejects(testCompilationTargets(dir,'test-bootstrap-dry-run',{}),/allowlist/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('actual locked Wrangler explicit config bypasses root and target redirect files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mba233-redirect-'));
 try{
  await mkdir(join(dir,'ops'),{recursive:true});await cp(join(root,'ops/runtime-test'),join(dir,'ops/runtime-test'),{recursive:true});await cp(join(root,'ops/test-worker'),join(dir,'ops/test-worker'),{recursive:true});
  for(const cwd of [dir,join(dir,'ops/test-worker')]){await mkdir(join(cwd,'.wrangler/deploy'),{recursive:true});await writeFile(join(cwd,'.wrangler/deploy/config.json'),JSON.stringify({configPath:'must-not-be-read.json'}));}
  const [target]=await testCompilationTargets(dir,'test-bootstrap-dry-run',{});
  const result=spawnSync(process.execPath,[resolve(root,'tools/node_modules/wrangler/bin/wrangler.js'),...target.args.slice(1)],{cwd:target.cwd,encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
  assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/--dry-run: exiting now/);assert.doesNotMatch(result.stdout,/Using redirected Wrangler configuration/);
  assert.match(await readFile(join(dir,'.generated/test-worker-dry-run/worker.js'),'utf8'),/tessera-test-bootstrap/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
