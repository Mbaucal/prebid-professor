import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {verifyIsolation,verifyOutputs} from '../../scripts/verify-toolchain-isolation.mjs';
const root=resolve(import.meta.dirname,'../..');
async function changed(path,run){const target=resolve(root,path),old=await readFile(target);try{await writeFile(target,Buffer.concat([old,Buffer.from('\nchanged\n')]));await run();}finally{await writeFile(target,old);}}
test('actual historical compiler closure and all fixed artifacts match receipt',async()=>{
 assert.equal((await verifyIsolation(root,{profile:'test'})).productionPackages,16);
 assert.equal((await verifyOutputs(root,{profile:'test'})).verifiedOutputs,66);
});
test('altered historical lock fails closed',async()=>changed('package-lock.json',()=>assert.rejects(verifyIsolation(root,{profile:'test'}),/Historical root lock changed/)));
test('altered installed historical compiler bytes fail closed',async()=>changed('node_modules/terser/dist/bundle.min.js',()=>assert.rejects(verifyIsolation(root,{profile:'test'}),/Historical dependency bytes differ/)));
test('altered esbuild platform executable fails closed',async()=>changed('tools/node_modules/@esbuild/linux-x64/bin/esbuild',()=>assert.rejects(verifyIsolation(root,{profile:'test'}),/Historical esbuild wrapper\/binary differs/)));
test('legacy root development packages cannot shadow isolated tools',async()=>{
 const path=resolve(root,'node_modules/unexpected-legacy-tool');await mkdir(path);
 try{await assert.rejects(verifyIsolation(root,{profile:'test'}),/Unexpected root package/);}finally{await rm(path,{recursive:true});}
});
test('altered generated artifact fails verification',async()=>changed('.generated/reference391.mjs',()=>assert.rejects(verifyOutputs(root,{profile:'test'}),/Historical generated output changed/)));

test('unexpected nested dependency cannot shadow the compiler closure',async()=>{
 const path=resolve(root,'node_modules/terser/node_modules');await mkdir(resolve(path,'acorn'),{recursive:true});
 try{await assert.rejects(verifyIsolation(root,{profile:'test'}),/Unexpected root package/);}finally{await rm(path,{recursive:true});}
});
for (const name of ['readiness','reporting']) {
 test(`signed ${name} preparer remains a guarded historical input`,async()=>changed(
  `scripts/prepare-${name}-runtime.mjs`,()=>assert.rejects(verifyIsolation(root,{profile:'test'}),/Historical source changed/)));
}

test('main profile cannot be accidentally used for the TEST source tree',async()=>{await assert.rejects(verifyIsolation(root,{profile:'main'}),/Wrong historical profile/);});
test('TEST history remains the exact seven-record baseline',async()=>changed('worker/runtime/runtime-releases.json',()=>assert.rejects(verifyIsolation(root,{profile:'test'}),/Historical runtime history changed/)));
test('signed 3.15 demand preparer remains guarded',async()=>changed('scripts/prepare-demand-runtime.mjs',()=>assert.rejects(verifyIsolation(root,{profile:'test'}),/Historical source changed/)));
