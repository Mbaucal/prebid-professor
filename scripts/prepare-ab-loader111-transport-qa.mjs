import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const fixtures=resolve(process.argv[2]??'.generated/ab-loader-main-browser');
const out=resolve(process.argv[3]??'.generated/ab-loader111-transport-qa');
const sourceRoot=resolve(process.env.LOADER111_ROOT??'.');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal((await readdir(out).catch(()=>[])).length,0,'Use an empty QA output directory.');
const manifest=JSON.parse(await readFile(resolve(fixtures,'manifest.json'),'utf8'));
const record=JSON.parse(await readFile(resolve(fixtures,'bundles/ab/record.json'),'utf8'));
const bundleBytes=await readFile(resolve(fixtures,'bundles/ab/bundle.zip'));
assert.equal(hash(bundleBytes),record.bundle.zipSha256);
assert.equal(manifest.bundles.ab.zipSha256,record.bundle.zipSha256);
await mkdir(out,{recursive:true});
const arms=Object.fromEntries(['A','B'].map(side=>[side,Object.fromEntries(['release','name','runtimeVersion','path','sha256','integrity'].map(key=>[key,record.arms[side][key]]))]));
for(const arm of Object.values(arms))assert.equal(arm.runtimeVersion,'3.25.1');
const loaders={};
for(const version of ['1.1.0','1.1.1']){
  const source=resolve(sourceRoot,'worker/experiments/ab-loader-'+version+'.mjs');
  const L=await import(pathToFileURL(source).href);
  assert.equal(L.AB_LOADER_VERSION,version);
  const templateSha256=hash(L.AB_LOADER_TEMPLATE);
  const config={schema:L.AB_LOADER_CONFIG_SCHEMA,site:record.site,id:'abx-'+hash('independent-loader111-'+version),
    name:'Independent loader transport QA',testId:'loader_transport_qa',trafficBPercent:50,arms,
    loader:{version,sha256:templateSha256}};
  const entry=L.renderAbLoader(config);
  await writeFile(resolve(out,'loader-'+version+'.js'),entry,{flag:'wx'});
  loaders[version]={templateSha256,moduleSha256:hash(await readFile(source)),entrySha256:hash(entry),config};
}
const receipt={schema:'independent-loader111-transport-1',fixtures,bundleSha256:hash(bundleBytes),
  recordSha256:hash(await readFile(resolve(fixtures,'bundles/ab/record.json'))),arms,loaders,
  prebid:manifest.prebid,scope:'Technical fixture entries wrapping identical frozen complete MAIN3.25.1 arms; no saved bundle or publisher change.'};
await writeFile(resolve(out,'inputs.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({prepared:true,out,versions:Object.keys(loaders),arms:Object.fromEntries(Object.entries(arms).map(([key,value])=>[key,value.sha256]))}));
