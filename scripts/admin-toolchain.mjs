/** Fixed MAIN administration targets. Importing this module performs no operation. */
import assert from 'node:assert/strict';
import {readFile,lstat,realpath,readdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseEnv} from 'node:util';
import {assertMainBuiltinSource} from './builtin-toolchain.mjs';
import {verifyIsolation,sha} from './verify-toolchain-isolation.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ROOT_CONFIG_SHA='23baa00fd65291177e5719db106a3c5ea6eb83324c312bd4b24c7724767a3df5';
// Actual locked Vite 8.2.0/plugin 1.54.7 build; normalize only checkout-dependent config paths.
const GENERATED_CONFIG_SHA='b1c402c1bc57f679919dfa73d1ad4d93ff81ce0f47e630f9e0e111050549d14d';
const commands=['deploy','deploy-dry-run','types','db-local','db-remote'];
export function parseAdminCommand(args){assert(args.length===1&&commands.includes(args[0]),'Use one fixed admin command; no flags, configuration, profiles or passthrough.');return args[0];}
function canonical(value){return JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);}
async function fixedPath(root,path,{optional=false}={}){
 let current=root;
 for(const part of path.split('/')){current=resolve(current,part);try{assert(!(await lstat(current)).isSymbolicLink(),'Fixed admin path must not be a symlink: '+path);}catch(e){if(optional&&e.code==='ENOENT')return current;throw e;}}
 assert.equal(await realpath(current),current,'Fixed admin path escaped checkout');return current;
}
async function noSymlinks(root,path){await fixedPath(root,path);for(const entry of await readdir(resolve(root,path),{withFileTypes:true})){assert(!entry.isSymbolicLink(),'Built output symlink');if(entry.isDirectory())await noSymlinks(root,path+'/'+entry.name);}}
export async function assertAdminSource(root,env){
 await assertMainBuiltinSource(root);
 const overrides=['CLOUDFLARE_ENV','WRANGLER_ENV','WRANGLER_CONFIG','CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH'];
 for(const key of overrides)assert(!env[key],'Refusing configuration override: '+key);
 for(const file of ['.env','.env.local','.env.production','.env.production.local']){
  let values;try{values=parseEnv(await readFile(resolve(root,file),'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
  for(const key of overrides)assert(!values[key],'Refusing dotenv configuration override: '+key);
 }
 await fixedPath(root,'wrangler.jsonc');
 assert.equal(sha(await readFile(resolve(root,'wrangler.jsonc'))),ROOT_CONFIG_SHA,'Reviewed MAIN Worker/resource configuration changed');
}
export async function assertAdminBuild(root){
 const path=await fixedPath(root,'dist/prebid_professor/wrangler.json');
 const generated=JSON.parse(await readFile(path,'utf8'));
 assert.equal(generated.configPath,resolve(root,'wrangler.jsonc'),'Generated source config changed');
 assert.equal(generated.userConfigPath,resolve(root,'wrangler.jsonc'),'Generated user config changed');
 const normalized={...generated,configPath:'<ROOT>/wrangler.jsonc',userConfigPath:'<ROOT>/wrangler.jsonc'};
 assert.equal(sha(canonical(normalized)),GENERATED_CONFIG_SHA,'Generated deployment config differs from the locked MAIN build');
 await fixedPath(root,'dist/prebid_professor/index.js');await noSymlinks(root,'dist/client');
 return path;
}
export async function runAdmin(args,{root=ROOT,env=process.env,execute=spawnSync,verify=verifyIsolation}={}){
 const command=parseAdminCommand(args); // Refuse additional args before verification, build or any process.
 await assertAdminSource(root,env);await verify(root);
 const wrangler=await fixedPath(root,'tools/node_modules/wrangler/bin/wrangler.js');
 const lock=JSON.parse(await readFile(resolve(root,'tools/package-lock.json'),'utf8'));
 const installed=JSON.parse(await readFile(resolve(root,'tools/node_modules/wrangler/package.json'),'utf8'));
 assert.equal(installed.version,lock.packages['node_modules/wrangler'].version,'Installed Wrangler differs from tools lock');
 // Local D1/type generation can instantiate Miniflare; keep runtime metadata outside signed dependencies.
 const cache=resolve(root,'.generated/local-miniflare-cache');
 await fixedPath(root,'.generated/local-miniflare-cache/cf.json',{optional:true});
 const childEnv={...env,WRANGLER_SEND_METRICS:'false',MINIFLARE_CACHE_DIR:cache,CLOUDFLARE_CF_FETCH_PATH:resolve(cache,'cf.json')};
 function run(argv){const r=execute(process.execPath,argv,{cwd:root,env:childEnv,shell:false,stdio:'inherit'});assert.equal(r.status,0,'Admin child failed; no later operation was executed');}
 if(command==='deploy'||command==='deploy-dry-run'){
  await fixedPath(root,'dist',{optional:true});await fixedPath(root,'dist/prebid_professor',{optional:true});await fixedPath(root,'dist/client',{optional:true});
  run([resolve(root,'scripts/isolated-toolchain.mjs'),'build']);
  await assertAdminSource(root,env);const config=await assertAdminBuild(root);
  if(command==='deploy-dry-run')await fixedPath(root,'.generated/admin-deploy-dry-run',{optional:true});
  run([wrangler,'deploy','--config',config,...(command==='deploy-dry-run'?['--dry-run','--outdir',resolve(root,'.generated/admin-deploy-dry-run')]:[])]);
 }else{
  const config=resolve(root,'wrangler.jsonc');
  if(command==='types'){
   await fixedPath(root,'worker-configuration.d.ts',{optional:true});
   run([wrangler,'types','--config',config]);
  }else{
   await fixedPath(root,'migrations');
   run([wrangler,'d1','migrations','apply','prebid-professor-db',command==='db-local'?'--local':'--remote','--config',config]);
  }
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await runAdmin(process.argv.slice(2));
