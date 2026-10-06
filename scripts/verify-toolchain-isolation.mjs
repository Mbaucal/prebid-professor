import assert from 'node:assert/strict';
import {readFile,readdir,realpath,lstat} from 'node:fs/promises';
import {resolve,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function selectedProfile(args=process.argv.slice(2)){const at=args.indexOf('--profile');const profile=at<0?'main':args[at+1];assert(['main','test'].includes(profile),'Use explicit profile main or test.');return profile;}
export async function readReceipt(root=ROOT,profile='main'){
 assert(['main','test'].includes(profile),'Unknown historical profile.');
 const receipt=JSON.parse(await readFile(resolve(root,profile==='test'?'tools/test-historical-inputs.json':'tools/historical-inputs.json'),'utf8'));
 let target=null;try{target=JSON.parse(await readFile(resolve(root,'tools/target-profile.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(target){assert.equal(target.profile,profile,'Wrong historical profile for this source tree.');assert.equal(target.baselineCommit,receipt.baselineCommit,'Wrong historical baseline receipt.');}
 return receipt;
}
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function filesUnder(directory,{skipModules=false}={}){
 const files={};
 async function visit(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
  if(skipModules && entry.name==='node_modules')continue;
  const path=resolve(dir,entry.name);
  assert(!entry.isSymbolicLink(),`Unexpected source/dependency symlink: ${path}`);
  if(entry.isDirectory())await visit(path);else if(entry.isFile())files[relative(directory,path).replaceAll('\\','/')]=sha(await readFile(path));
 }}
 await visit(directory);return Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b,'en')));
}
export async function verifyIsolation(root=ROOT,{profile='main'}={}){
 assert.equal(process.platform,'linux','Initial isolated toolchain receipt supports Linux x64 only.');
 assert.equal(process.arch,'x64','Initial isolated toolchain receipt supports Linux x64 only.');
 const receipt=await readReceipt(root,profile);
 if(receipt.historySha256)assert.equal(sha(await readFile(resolve(root,'worker/runtime/runtime-releases.json'))),receipt.historySha256,'Historical runtime history changed.');
 assert.equal(sha(await readFile(resolve(root,'package-lock.json'))),receipt.lockSha256,'Historical root lock changed.');
 for(const [path,digest] of Object.entries(receipt.sources))assert.equal(sha(await readFile(resolve(root,path))),digest,`Historical source changed: ${path}`);
 for(const [path,expected] of Object.entries(receipt.productionPackages)){
  assert.equal(await realpath(resolve(root,path)),resolve(root,path),`Historical dependency redirected: ${path}`);
  assert.deepEqual(await filesUnder(resolve(root,path),{skipModules:true}),expected,`Historical dependency bytes differ: ${path}`);
 }
 // Reject any real root development install or alternate package shadowing.
 const allowed=new Set(Object.keys(receipt.productionPackages));
 async function checkPackages(dir){
  for(const entry of await readdir(dir,{withFileTypes:true})){
   if(entry.name==='.bin'||entry.name==='.package-lock.json')continue;
   const path=resolve(dir,entry.name);
   if(entry.name.startsWith('@')){await checkPackages(path);continue;}
   const name=relative(root,path).replaceAll('\\','/');
   assert(allowed.has(name)||name==='node_modules/esbuild',`Unexpected root package (legacy dev/shadow): ${name}`);
   if(name==='node_modules/esbuild')continue;
   const nested=resolve(path,'node_modules');
   try{await lstat(nested);}catch(error){if(error.code==='ENOENT')continue;throw error;}
   await checkPackages(nested);
  }
 }
 await checkPackages(resolve(root,'node_modules'));
 const toolsLock=JSON.parse(await readFile(resolve(root,'tools/package-lock.json'),'utf8'));
 for(const name of ['wrangler','vite','typescript','@cloudflare/vite-plugin']){
  const installed=JSON.parse(await readFile(resolve(root,'tools/node_modules',name,'package.json'),'utf8'));
  assert.equal(installed.version,toolsLock.packages['node_modules/'+name].version,`Installed tool version differs from dedicated lock: ${name}`);
 }
 const bridge=resolve(root,'node_modules/esbuild'),target=resolve(root,'tools/node_modules/esbuild');
 assert((await lstat(bridge)).isSymbolicLink(),'esbuild must be the explicit tools bridge, not a root dev install.');
 assert.equal(await realpath(bridge),target,'esbuild bridge escaped tools.');
 for(const [name,expected] of Object.entries(receipt.esbuildPackages))assert.deepEqual(await filesUnder(resolve(root,'tools',name),{skipModules:true}),expected,`Historical esbuild wrapper/binary differs: ${name}`);
 const require=createRequire(resolve(root,'worker/runtime/artifact-minifier.mjs'));
 for(const name of ['terser','acorn','fflate'])assert((await realpath(require.resolve(name))).startsWith(resolve(root,'node_modules',name)+'/'),`Compiler ${name} escaped historical root.`);
 const fromTerser=createRequire(require.resolve('terser'));
 assert.equal(await realpath(fromTerser.resolve('acorn')),await realpath(require.resolve('acorn')),'Terser parser was shadowed.');
 assert((await realpath(fromTerser.resolve('@jridgewell/source-map'))).startsWith(resolve(root,'node_modules/@jridgewell/source-map')+'/'),'Terser source map dependency escaped historical root.');
 assert.equal(await realpath(require.resolve('esbuild')),resolve(target,'lib/main.js'));
 return {profile,baselineCommit:receipt.baselineCommit,rootLockSha256:receipt.lockSha256,productionPackages:Object.keys(receipt.productionPackages).length,esbuild:'0.28.1',platform:'linux-x64'};
}
export async function verifyOutputs(root=ROOT,{profile='main'}={}){
 const expected=(await readReceipt(root,profile)).outputs;
 for(const [path,digest] of Object.entries(expected))assert.equal(sha(await readFile(resolve(root,'.generated',path))),digest,`Historical generated output changed: ${path}`);
 return {verifiedOutputs:Object.keys(expected).length};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify({...await verifyIsolation(ROOT,{profile:selectedProfile()}),...(process.argv.includes('--outputs')?await verifyOutputs(ROOT,{profile:selectedProfile()}):{})},null,2));
