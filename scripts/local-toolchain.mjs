/** Local npm entrypoints: fixed locked tools/configuration, no deploy surface. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {assertMainBuiltinSource} from './builtin-toolchain.mjs';
import {verifyIsolation} from './verify-toolchain-isolation.mjs';
export function localCommand(args){
 const [command,...extra]=args;
 const allowed=['dev','build','preview','typecheck','typecheck:app','typecheck:worker','typecheck:tooling','test:builtin'];
 assert(allowed.includes(command),'Unknown local toolchain command.');
 let port=command==='preview'?'4173':'5173';
 if(['dev','preview'].includes(command)&&extra.length){
  assert(extra.length===2&&extra[0]==='--port'&&/^[1-9][0-9]{0,4}$/.test(extra[1])&&Number(extra[1])<=65535,'Only --port 1..65535 is accepted for local servers.');port=extra[1];
 }else assert.equal(extra.length,0,'No extra arguments accepted.');
 const isolated=mode=>['scripts/isolated-toolchain.mjs',mode];
 if(command==='build'||command==='typecheck')return [isolated(command)];
 if(command.startsWith('typecheck:'))return [['tools/node_modules/typescript/bin/tsc','--noEmit','-p',`tools/tsconfig.${command.split(':')[1]}.json`]];
 if(command==='test:builtin')return [isolated('prepare'),['--experimental-strip-types','--test','tests/runtime/builtin-preview.test.mjs']];
 const vite=['tools/node_modules/vite/bin/vite.js',...(command==='preview'?['preview']:[]),'--config','tools/vite.config.ts','--host','127.0.0.1','--port',port,'--strictPort'];
 return command==='dev'?[isolated('prepare'),vite]:[vite];
}
export async function localViteEnvironment(root,command){
 const environment={...process.env,WRANGLER_SEND_METRICS:'false'};
 if(['dev','preview','build'].includes(command)){
  const {loadEnv}=await import(pathToFileURL(resolve(root,'tools/node_modules/vite/dist/node/index.js')).href);
  const values=loadEnv(command==='dev'?'development':'production',root,'CLOUDFLARE_');
  assert(!values.CLOUDFLARE_ENV,'Named Cloudflare environments are not accepted by local npm commands.');
  environment.CLOUDFLARE_VITE_FORCE_LOCAL='true';
  environment.MINIFLARE_CACHE_DIR=resolve(root,'.generated/local-miniflare-cache');
  environment.CLOUDFLARE_CF_FETCH_PATH=resolve(environment.MINIFLARE_CACHE_DIR,'cf.json');
 }
 return environment;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const commands=localCommand(process.argv.slice(2)); // Reject arguments before preparation.
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 try{await assertMainBuiltinSource(root);await verifyIsolation(root);}catch(error){throw new Error('Local tools are not ready. Run node scripts/bootstrap-toolchain.mjs on Linux x64. '+error.message,{cause:error});}
 const environment=await localViteEnvironment(root,process.argv[2]);
 for(const args of commands){
  const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',shell:false,env:environment});
  if(result.status!==0)process.exit(result.status??1);
 }
}
