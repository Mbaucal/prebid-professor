import assert from 'node:assert/strict';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {pagesProfile,verifyPagesTools} from './pages-toolchain.mjs';
import {validateDeploymentInput,assertPreparedEvidence,PAGES_HEADERS} from './pages-release-verification.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function verifyPreparedPages(repo,env){
 const profile=await pagesProfile(repo,env);
 const input=validateDeploymentInput(JSON.parse(env.DEPLOY_INPUTS),env.GITHUB_REF);
 const root=resolve(repo,'.generated/pages-release'),dist=resolve(root,'dist');
 for(const path of [root,dist,resolve(root,'verification.json')])assert(!(await lstat(path)).isSymbolicLink(),'Prepared paths must not be symlinks.');
 const proof=JSON.parse(await readFile(resolve(root,'verification.json'),'utf8'));
 const verified=assertPreparedEvidence(input,proof,env);
 const allowed=['README.txt','ads.js','ads.min.js','prebid.js','config.json','div-export.csv','implementation.html','manifest.json','min-height.css','sticky.css','gam-reporting.json'];
 assert(Array.isArray(verified.files)&&verified.files.length>0&&verified.files.length<=allowed.length,'Invalid prepared inventory.');
 assert(new Set(verified.files.map(f=>f.name)).size===verified.files.length,'Duplicate prepared file.');
 for(const f of verified.files)assert(allowed.includes(f.name)&&Number.isSafeInteger(f.byteSize)&&f.byteSize>0&&f.byteSize<=20*1024*1024&&/^[a-f0-9]{64}$/.test(f.sha256),'Invalid prepared file metadata.');
 if(verified.deliveryProfile==='scripts-v1')assert(verified.files.some(f=>f.name==='ads.js')&&verified.files.every(f=>['ads.js','prebid.js'].includes(f.name)),'Invalid compact inventory.');
 else{assert.equal(verified.deliveryProfile,undefined);assert(verified.files.some(f=>f.name==='manifest.json'&&f.sha256===input.manifest_sha256),'Original manifest is missing.');}
 const headers=Buffer.from(PAGES_HEADERS),files=[...verified.files,{name:'_headers',byteSize:headers.length,sha256:digest(headers)}];
 assert.deepEqual((await readdir(dist)).sort(),files.map(f=>f.name).sort(),'Prepared file set differs.');
 for(const f of files){const path=resolve(dist,f.name),stat=await lstat(path);assert(stat.isFile()&&!stat.isSymbolicLink(),'Only verified regular files may be published.');const bytes=await readFile(path);assert.equal(bytes.length,f.byteSize);assert.equal(digest(bytes),f.sha256,'Prepared bytes differ: '+f.name);}
 return profile;
}
export async function preflight(repo,env,execute){const profile=await verifyPreparedPages(repo,env);return verifyPagesTools(repo,execute,profile);}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert.equal(process.argv.length,2,'No command passthrough accepted.');
 await preflight(resolve(dirname(fileURLToPath(import.meta.url)),'..'),process.env);
 console.log('Verified prepared release bytes and locked Pages tools.');
}
