// Executes only the pinned action against local fake npm/npx binaries; never Wrangler.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const source=resolve(process.argv[2]||'');
assert.equal(process.argv.length,3,'Pass the exact pinned action bundle.');
const bytes=await readFile(source);
assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),'ccab30acedbf9809f60d5e8de0454a730a2a75ff','Action bundle differs from reviewed pinned commit.');
const dir=await mkdtemp(resolve(tmpdir(),'mba216-action-'));
try{
 const bin=resolve(dir,'bin'),cwd=resolve(dir,'tools');await mkdir(bin);await mkdir(cwd);
 await writeFile(resolve(bin,'npm'),`#!/usr/bin/env node\nrequire('fs').appendFileSync(process.env.CALL_LOG,JSON.stringify({install:process.argv.slice(2)})+'\\n');process.exit(99);\n`,{mode:0o755});
 await writeFile(resolve(bin,'npx'),`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),args=process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG,JSON.stringify({args,cwd:process.cwd()})+'\\n');
if(args.join(' ')==='--no-install wrangler --version'){console.log('4.131.0');process.exit(0);}
if(process.env.SIMULATE_FAILURE==='1')process.exit(7);
if(args[0]!=='wrangler'||args[1]!=='pages'||args[2]!=='deploy')process.exit(98);
const out=process.env.WRANGLER_OUTPUT_FILE_DIRECTORY;fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'wrangler-output-2026-10-06_00-00-00_000-abcdef.json'),JSON.stringify({type:'pages-deploy-detailed',version:1,pages_project:'tessera-fixture',deployment_id:'synthetic-id',url:'https://1234abcd.tessera-fixture.pages.dev',alias:'https://test.tessera-fixture.pages.dev',environment:'preview'})+'\\n');
console.log('Synthetic Pages command completed; no network.');
`,{mode:0o755});
 // Fail any unexpected network side-effect in the action; Github metadata is not invoked without its optional token.
 const block=resolve(dir,'block.cjs');await writeFile(block,"for(const n of ['http','https']){const m=require(n);m.request=m.get=()=>{throw Error('Unexpected network in action contract test');};}global.fetch=()=>{throw Error('Unexpected fetch');};");
 for(const variant of [{directory:'builtin-delivery',message:'Tessera builtin TEST builtin-test-12345678-1234-4123-8123-123456789abc'},{directory:'pages-release',message:'Tessera staging fixture 20260914_010000'},{directory:'pages-release',message:'Tessera production fixture 20260914_010000'}])for(const fail of [false,true]){
  const log=resolve(dir,fail?'fail-calls':'calls'),output=resolve(dir,fail?'fail-output':'output');await writeFile(log,'');await writeFile(output,'');
  const env={PATH:bin+':'+process.env.PATH,RUNNER_TEMP:dir,GITHUB_WORKSPACE:dir,GITHUB_OUTPUT:output,GITHUB_REPOSITORY:'Mbaucal/prebid-professor',GITHUB_REF:'refs/heads/feature/isolated-runtime-workspace-v1',GITHUB_SHA:'a'.repeat(40),CALL_LOG:log,SIMULATE_FAILURE:fail?'1':'0',NODE_OPTIONS:'--require '+block,
   INPUT_QUIET:'false',INPUT_WORKINGDIRECTORY:cwd,INPUT_PACKAGEMANAGER:'npm',INPUT_WRANGLERVERSION:'4.131.0',INPUT_APITOKEN:'synthetic-only',INPUT_ACCOUNTID:'1'.repeat(32),INPUT_COMMAND:`pages deploy ../.generated/${variant.directory}/dist --project-name=tessera-fixture --branch=test --commit-dirty=false --commit-message="${variant.message}"`};
  const result=spawnSync(process.execPath,[source],{cwd:dir,env,encoding:'utf8',timeout:20000});
  const raw=await readFile(log,'utf8');assert(raw.trim(),result.stdout+'\n'+result.stderr);const calls=raw.trim().split('\n').map(JSON.parse);assert.equal(calls.length,2);assert(calls.every(c=>!c.install&&c.cwd===cwd));assert.deepEqual(calls[0].args,['--no-install','wrangler','--version']);
  assert.deepEqual(calls[1].args,['wrangler','pages','deploy',`../.generated/${variant.directory}/dist`,'--project-name=tessera-fixture','--branch=test','--commit-dirty=false',`--commit-message=${variant.message}`]);
  const published=await readFile(output,'utf8');
  if(fail){assert.notEqual(result.status,0);assert(!published.includes('deployment-url'));}
  else{assert.equal(result.status,0,result.stderr+'\n'+result.stdout);assert.match(published,/deployment-url<<[^\n]+\nhttps:\/\/1234abcd.tessera-fixture.pages.dev/);assert.match(published,/pages-environment<<[^\n]+\npreview/);}
 }
 console.log('PASS exact pinned action (builtin and generic argv): locked version skips install, tools cwd/fixed argv, structured immutable URL, failed command has no success output; no network.');
}finally{await rm(dir,{recursive:true,force:true});}
