import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {checkRuntimeReleaseHistory} from '../../scripts/runtime-release-history-contract.mjs';
const root=resolve(import.meta.dirname,'../..');
test('fresh checkout bootstrap reaches locked npm ci without any installed package',async()=>{
 const dir=await mkdtemp(resolve(tmpdir(),'tessera-bootstrap-history-'));
 try{
  for(const path of ['scripts/bootstrap-toolchain.mjs','scripts/verify-toolchain-isolation.mjs','scripts/runtime-release-history-contract.mjs','tools/test-historical-inputs.json','tools/target-profile.json','package-lock.json']){
   await mkdir(dirname(resolve(dir,path)),{recursive:true});await copyFile(resolve(root,path),resolve(dir,path));
  }
  const bin=resolve(dir,'fixture-bin');await mkdir(bin);
  // Stop exactly at the first installation, recording argv; never call npm/network.
  await writeFile(resolve(bin,'npm'),'#!/bin/sh\nprintf "%s\\n" "$@"\nexit 23\n',{mode:0o755});
  const run=()=>spawnSync(process.execPath,['scripts/bootstrap-toolchain.mjs','--profile','test'],{cwd:dir,env:{...process.env,PATH:bin},encoding:'utf8'});
  const clean=run();assert.equal(clean.status,23,clean.stderr);assert.deepEqual(clean.stdout.trim().split('\n'),['ci','--omit=dev','--ignore-scripts']);
  await writeFile(resolve(dir,'package-lock.json'),'{}');const altered=run();assert.notEqual(altered.status,23);assert.match(altered.stderr,/Refusing install against altered historical lock/);assert.equal(altered.stdout,'');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('dependency-free contract retains append-only checks against exact TEST baseline',async()=>{
 const baseline=JSON.parse(await readFile(resolve(root,'tools/test-runtime-history.json'))),current=JSON.parse(await readFile(resolve(root,'worker/runtime/runtime-releases.json')));
 assert.doesNotThrow(()=>checkRuntimeReleaseHistory(current,baseline));
 for(const changed of [current.slice(0,-1),current.toReversed(),current.map((r,i)=>i===current.length-1?{...r,title:'rewritten'}:r)])assert.throws(()=>checkRuntimeReleaseHistory(changed,baseline));
});
