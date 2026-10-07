import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,cp,rm,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {localCommand} from '../../scripts/local-toolchain.mjs';
const repo=resolve('.');
test('local commands use only reviewed tools, configs and existing checks',()=>{
 assert.deepEqual(localCommand(['build']),[['scripts/isolated-toolchain.mjs','build']]);
 assert.deepEqual(localCommand(['typecheck']),[['scripts/isolated-toolchain.mjs','typecheck']]);
 for(const name of ['app','worker','tooling'])assert.deepEqual(localCommand(['typecheck:'+name]),[['tools/node_modules/typescript/bin/tsc','--noEmit','-p',`tools/tsconfig.${name}.json`]]);
 assert.deepEqual(localCommand(['test:builtin']),[['scripts/isolated-toolchain.mjs','prepare'],['--experimental-strip-types','--test','tests/runtime/builtin-preview.test.mjs']]);
 for(const name of ['dev','preview']){
  const plan=localCommand([name,'--port','4321']);const last=plan.at(-1);
  assert.equal(last[0],'tools/node_modules/vite/bin/vite.js');assert.deepEqual(last.slice(-7),['--config','tools/vite.config.ts','--host','127.0.0.1','--port','4321','--strictPort']);assert.equal(plan.length,name==='dev'?2:1);
 }
});
test('unknown commands and config/host/env passthrough fail before preparation',()=>{
 for(const args of [[],['deploy'],['build','extra'],['typecheck','--profile','test'],['dev','--host','0.0.0.0'],['dev','--config','other'],['dev','--port','0'],['preview','--port','65536'],['preview','--port','123;echo']])assert.throws(()=>localCommand(args));
});
test('npm invalid args do not run preparers, install packages or need existing node_modules',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mba237-npm-'));
 try{
  await cp(join(repo,'scripts'),join(dir,'scripts'),{recursive:true});await cp(join(repo,'package.json'),join(dir,'package.json'));
  const manifest=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));assert.equal(manifest.scripts.predev,undefined);assert.equal(manifest.scripts.prebuild,undefined);
  for(const command of ['dev','build','preview','test:builtin','typecheck']){
   const result=spawnSync('npm',['run',command,'--','--config','not-allowed'],{cwd:dir,encoding:'utf8',shell:false});assert.notEqual(result.status,0);assert.match(result.stderr,/No extra|Only --port/);assert.doesNotMatch(result.stdout,/Prepared|added \d+ packages/);
  }
  const missing=spawnSync(process.execPath,['scripts/local-toolchain.mjs','dev'],{cwd:dir,encoding:'utf8'});assert.notEqual(missing.status,0);assert.match(missing.stderr,/bootstrap-toolchain/);assert.doesNotMatch(missing.stdout,/Prepared/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('root script edits leave dependency metadata consistent with the historical lock',async()=>{
 const manifest=JSON.parse(await readFile(join(repo,'package.json'),'utf8')),lock=JSON.parse(await readFile(join(repo,'package-lock.json'),'utf8'));
 assert.deepEqual(manifest.dependencies,lock.packages[''].dependencies);assert.deepEqual(manifest.devDependencies,lock.packages[''].devDependencies);
 const receipt=JSON.parse(await readFile(join(repo,'tools/historical-inputs.json'),'utf8'));assert(!Object.hasOwn(receipt.sources,'package.json'));assert(Object.hasOwn(receipt.sources,'package-lock.json'));
});
test('locked Vite dotenv resolution rejects named environments and forces local bindings',async()=>{
 const {localViteEnvironment}=await import('../../scripts/local-toolchain.mjs');
 const dir=await mkdtemp(join(tmpdir(),'mba237-dotenv-'));
 try{
  const {mkdir,symlink}=await import('node:fs/promises');await mkdir(join(dir,'tools'));await symlink(join(repo,'tools/node_modules'),join(dir,'tools/node_modules'),'dir');
  assert.equal((await localViteEnvironment(dir,'dev')).CLOUDFLARE_VITE_FORCE_LOCAL,'true');
  await writeFile(join(dir,'.env.development.local'),'CLOUDFLARE_ENV=unexpected\n');await assert.rejects(localViteEnvironment(dir,'dev'),/Named Cloudflare/);
  await writeFile(join(dir,'.env.production'),'CLOUDFLARE_ENV=unexpected\n');await assert.rejects(localViteEnvironment(dir,'preview'),/Named Cloudflare/);await assert.rejects(localViteEnvironment(dir,'build'),/Named Cloudflare/);
  await rm(join(dir,'.env.development.local'));await rm(join(dir,'.env.production'));
  const original=process.env.CLOUDFLARE_ENV;process.env.CLOUDFLARE_ENV='unexpected';
  try{await assert.rejects(localViteEnvironment(dir,'dev'),/Named Cloudflare/);}finally{if(original===undefined)delete process.env.CLOUDFLARE_ENV;else process.env.CLOUDFLARE_ENV=original;}
 }finally{await rm(dir,{recursive:true,force:true});}
});
