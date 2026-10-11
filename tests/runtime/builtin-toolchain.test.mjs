import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,cp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {assertMainBuiltinSource} from '../../scripts/builtin-toolchain.mjs';
const repo=resolve('.');
test('MAIN guard accepts reviewed lock and rejects TEST markers, foreign baseline and changed lock',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mba235-main-'));
 try{
  await mkdir(join(dir,'tools'));await cp(join(repo,'tools/historical-inputs.json'),join(dir,'tools/historical-inputs.json'));await cp(join(repo,'package-lock.json'),join(dir,'package-lock.json'));
  await assertMainBuiltinSource(dir);
  for(const name of ['target-profile.json','test-historical-inputs.json']){await writeFile(join(dir,'tools',name),'{}');await assert.rejects(assertMainBuiltinSource(dir),/TEST markers/);await rm(join(dir,'tools',name));}
  const p=join(dir,'tools/historical-inputs.json'),receipt=JSON.parse(await readFile(p,'utf8'));await writeFile(p,JSON.stringify({...receipt,baselineCommit:'b'.repeat(40)}));await assert.rejects(assertMainBuiltinSource(dir),/baseline/);await writeFile(p,JSON.stringify(receipt));
  await writeFile(join(dir,'package-lock.json'),'{}');await assert.rejects(assertMainBuiltinSource(dir),/lock differs/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Node-only wrapper rejects invalid CLI before any installation',()=>{
 for(const args of [[],['--profile','test'],['bootstrap','--profile','test'],['deploy']]){const result=spawnSync(process.execPath,['scripts/builtin-toolchain.mjs',...args],{encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/bootstrap only/);assert.equal(result.stdout,'');}
});
