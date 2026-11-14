import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateTestBuild} from '../../scripts/test-toolchain-seal.mjs';
const root=resolve(import.meta.dirname,'../..');
async function changed(path){const target=resolve(root,path),old=await readFile(target);try{await writeFile(target,Buffer.concat([old,Buffer.from('\nchanged\n')]));await assert.rejects(validateTestBuild(root),/stale|clean|different Worker bytes/);}finally{await writeFile(target,old);}}
test('exact committed TEST build seal remains valid',()=>validateTestBuild(root));
for(const path of ['.generated/site-workspace.mjs','.generated/test-page-client.mjs','.generated/test-workspace-active-dry-run/index.js','ops/runtime-test/wrangler.active.jsonc','scripts/local-miniflare.mjs'])test(`reject changed deployment input ${path}`,()=>changed(path));
test('audit and parity evidence does not invalidate deployment inputs',async()=>{
 const dir=resolve(root,'.generated/toolchain-evidence');await mkdir(dir,{recursive:true});
 const path=resolve(dir,'seal-test-transient.json');try{await writeFile(path,'{"synthetic":true}');await validateTestBuild(root);}finally{await rm(path);}
});
