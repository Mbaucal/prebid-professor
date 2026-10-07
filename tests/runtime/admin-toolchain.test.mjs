import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {runAdmin,assertAdminBuild} from '../../scripts/admin-toolchain.mjs';
const repo=resolve(import.meta.dirname,'../..');
async function fixture(){
 const root=await mkdtemp(resolve(tmpdir(),'main-admin-'));
 for(const p of ['wrangler.jsonc','package-lock.json','tools/historical-inputs.json','tools/package-lock.json']){await mkdir(resolve(root,p,'..'),{recursive:true});await cp(resolve(repo,p),resolve(root,p));}
 await mkdir(resolve(root,'tools/node_modules/wrangler/bin'),{recursive:true});await writeFile(resolve(root,'tools/node_modules/wrangler/bin/wrangler.js'),'synthetic executor only');
 const lock=JSON.parse(await readFile(resolve(repo,'tools/package-lock.json'),'utf8'));await writeFile(resolve(root,'tools/node_modules/wrangler/package.json'),JSON.stringify({version:lock.packages['node_modules/wrangler'].version}));
 await mkdir(resolve(root,'migrations'));await mkdir(resolve(root,'dist/prebid_professor'),{recursive:true});await mkdir(resolve(root,'dist/client'));
 const generated=JSON.parse(await readFile(resolve(repo,'tests/fixtures/main-generated-wrangler.json'),'utf8'));generated.configPath=generated.userConfigPath=resolve(root,'wrangler.jsonc');
 const save=()=>writeFile(resolve(root,'dist/prebid_professor/wrangler.json'),JSON.stringify(generated));await save();await writeFile(resolve(root,'dist/prebid_professor/index.js'),'synthetic');await writeFile(resolve(root,'dist/client/index.html'),'synthetic');
 const calls=[];let verifies=0;const options={root,env:{},verify:async()=>{verifies++;},execute:(file,args,opts)=>{calls.push({file,args,opts});return{status:0};}};
 return{root,generated,save,calls,options,get verifies(){return verifies;},close:()=>rm(root,{recursive:true,force:true})};
}
test('invalid command/flags refuse before prep or executor',async()=>{for(const args of [[],['deploy','--dry-run'],['db-local','--remote'],['types','--config','other'],['deploy','--profile','test'],['unknown']]){let touched=false;await assert.rejects(runAdmin(args,{verify:async()=>{touched=true;},execute:()=>{touched=true;}}));assert.equal(touched,false);}});
test('fixed MAIN deployment builds once and uses generated config; local/admin use original config',async()=>{
 const f=await fixture();try{
  await mkdir(resolve(f.root,'.wrangler/deploy'),{recursive:true});await writeFile(resolve(f.root,'.wrangler/deploy/config.json'),'invalid redirect is not used');
  for(const command of ['deploy','deploy-dry-run','types','db-local','db-remote']){
   f.calls.length=0;await runAdmin([command],f.options);const deploy=command.startsWith('deploy');assert.equal(f.calls.length,deploy?2:1);
   if(deploy)assert.deepEqual(f.calls[0].args,[resolve(f.root,'scripts/isolated-toolchain.mjs'),'build']);
   const call=f.calls.at(-1);assert.equal(call.file,process.execPath);assert.equal(call.opts.cwd,f.root);assert.equal(call.opts.shell,false);assert.equal(call.opts.env.WRANGLER_SEND_METRICS,'false');
   const wrangler=resolve(f.root,'tools/node_modules/wrangler/bin/wrangler.js'),config=resolve(f.root,deploy?'dist/prebid_professor/wrangler.json':'wrangler.jsonc');
   const expected=deploy?[wrangler,'deploy','--config',config,...(command==='deploy-dry-run'?['--dry-run','--outdir',resolve(f.root,'.generated/admin-deploy-dry-run')]:[])]:command==='types'?[wrangler,'types','--config',config]:[wrangler,'d1','migrations','apply','prebid-professor-db',command==='db-local'?'--local':'--remote','--config',config];
   assert.deepEqual(call.args,expected);
  }
 }finally{await f.close();}
});
test('foreign profile, config/environment override, changed resources and dependency versions fail before executor',async()=>{
 for(const mode of ['test-marker','test-receipt','config','env','vite-env','dotenv','version']){
  const f=await fixture();try{
   if(mode==='test-marker')await writeFile(resolve(f.root,'tools/target-profile.json'),'{}');
   if(mode==='test-receipt')await writeFile(resolve(f.root,'tools/test-historical-inputs.json'),'{}');
   if(mode==='config')await writeFile(resolve(f.root,'wrangler.jsonc'),'{}');
   if(mode==='env')f.options.env.WRANGLER_ENV='test';
   if(mode==='vite-env')f.options.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH='other';
   if(mode==='dotenv')await writeFile(resolve(f.root,'.env.production'),'CLOUDFLARE_ENV=test');
   if(mode==='version')await writeFile(resolve(f.root,'tools/node_modules/wrangler/package.json'),'{}');
   await assert.rejects(runAdmin(['db-remote'],f.options));assert.equal(f.calls.length,0);
  }finally{await f.close();}
 }
});
test('changed generated bindings/crons/vars/paths or added configuration never reach deploy',async()=>{
 for(const mutate of [x=>x.name='other',x=>x.d1_databases[0].database_id='other',x=>x.r2_buckets[0].bucket_name='other',x=>x.triggers.crons=[],x=>x.vars={new:'value'},x=>x.env={test:{}},x=>x.main='other.js',x=>x.assets.directory='other',x=>x.configPath='other',x=>x.services=[{binding:'service',service:'other'}]]){
  const f=await fixture();try{mutate(f.generated);await f.save();await assert.rejects(runAdmin(['deploy'],f.options));assert.equal(f.calls.length,1);assert.equal(f.calls[0].args.at(-1),'build');}finally{await f.close();}
 }
});
test('failed build, source change during build and output symlinks prevent mutation',async()=>{
 const f=await fixture();try{
  await assert.rejects(runAdmin(['deploy'],{...f.options,execute:()=>({status:1})}));assert.equal(f.calls.length,0);
  const initial=await readFile(resolve(f.root,'wrangler.jsonc'));
  const {writeFileSync}=await import('node:fs');
  await assert.rejects(runAdmin(['deploy'],{...f.options,execute:()=>{writeFileSync(resolve(f.root,'wrangler.jsonc'),'{}');return{status:0};}}));await writeFile(resolve(f.root,'wrangler.jsonc'),initial);
  await symlink(resolve(f.root,'wrangler.jsonc'),resolve(f.root,'dist/client/escape'));
  await assert.rejects(assertAdminBuild(f.root),/symlink/);
 }finally{await f.close();}
});
