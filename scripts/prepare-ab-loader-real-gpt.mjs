/** Offline GAM-only 3.25.1 packages for the generic loader's real-GPT wire checks. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {runtimeCatalog, buildArtifactCandidate} from '../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../worker/runtime/version-pin.mjs';
import {describeCandidate} from '../worker/runtime/draft-release-store.mjs';
import {runtime325BrowserSite} from '../tests/runtime/runtime325-browser-site.mjs';
import {composeAbBundle} from '../worker/experiments/ab-bundle.mjs';
import {AB_LOADER_TEMPLATE, AB_LOADER_VERSION} from '../worker/experiments/ab-loader-1.1.1.mjs';

const root=resolve(import.meta.dirname,'..');
const args=process.argv.slice(2);
assert(args.length===0||(args.length===2&&args[0]==='--out'),'Use --out <fixture directory>');
const out=resolve(args[1]??resolve(root,'.generated/ab-loader-real-gpt'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const registry=JSON.parse(await readFile(resolve(root,'worker/experiments/ab-loader-registry.json'),'utf8'));
assert.equal(hash(AB_LOADER_TEMPLATE),registry[AB_LOADER_VERSION].sha256,'The loader must match its immutable registry entry');
const descriptor=runtimeCatalog.find(row=>row.version==='3.25.1');
assert(descriptor,'Explicitly registered 3.25.1 is required');
const pin=pinRuntime(descriptor,{allowPreview:true});
const packages={};
for(const [side,stamp]of [['A','20261120_010000'],['B','20261120_010001']]){
  const snapshot=runtime325BrowserSite({kind:'gam'});
  const candidate=await buildArtifactCandidate({snapshot,pin,buildTimestamp:stamp,prebid:null});
  const {descriptor:saved}=await describeCandidate(snapshot.site.id,candidate);
  assert.equal(saved.runtime.runtimeVersion,'3.25.1');
  assert.equal(saved.prebidBuild,null,'These bounded checks deliberately use GAM only');
  packages[side]={files:candidate.files,release:{id:saved.releaseId,siteId:snapshot.site.id,note:`Native GAM-only ${side}`}};
}
const bundle=await composeAbBundle({site:'reporting-site',a:packages.A,b:packages.B,
  trafficBPercent:100,testId:'real_gpt_111',name:'Offline generic-loader wire regression'});
assert.equal(bundle.record.loader.version,AB_LOADER_VERSION);
assert(!bundle.files['prebid.js']);
const gptRoot='vendor/gpt/m202611120201';
const gpt=JSON.parse(await readFile(resolve(root,gptRoot,'manifest.json'),'utf8'));
for(const file of gpt.files){
  const bytes=await readFile(resolve(root,gptRoot,file.file));
  assert.equal(hash(bytes),file.sha256,'Pinned GPT changed: '+file.file);
  assert.equal(bytes.length,file.bytes);
}
await mkdir(out,{recursive:true});
const files={};
for(const [name,bytes]of Object.entries({...bundle.files,'record.json':new TextEncoder().encode(JSON.stringify(bundle.record,null,2)+'\n')})){
  const path=resolve(out,name);
  assert(path.startsWith(out+sep),'Fixture path escaped its output directory');
  await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,bytes);
  files[name]={sha256:hash(bytes),bytes:bytes.length};
}
const manifest={schemaVersion:1,
  scope:'Offline GAM-only native 3.25.1 + pinned real GPT. Every GAM request receives local204; no paid traffic, SSP or hosted acceptance.',
  runtime:pin,loader:bundle.record.loader,site:'reporting-site',testId:bundle.record.testId,
  assigned:'B',armDeadlineMs:8000,arms:bundle.record.arms,files,gptRoot,gpt};
await writeFile(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({output:out,runtimeVersion:pin.runtimeVersion,loaderVersion:AB_LOADER_VERSION,
  loaderTemplateSha256:bundle.record.loader.sha256,files:Object.keys(files).length,scope:manifest.scope}));
