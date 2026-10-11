// Reproduce, never refresh/re-sign, the receipt from an exact baseline checkout.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {filesUnder,sha} from './verify-toolchain-isolation.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(!process.argv[2])throw Error('Provide clean baseline checkout after npm ci --ignore-scripts and both historical preparers.');
const baseline=resolve(process.argv[2]),expected=JSON.parse(await readFile(resolve(root,'tools/historical-inputs.json'),'utf8'));
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:baseline,encoding:'utf8'}).trim(),expected.baselineCommit);
assert.equal(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:baseline,encoding:'utf8'}).trim(),'','Baseline tracked files changed.');
const bytes=await readFile(resolve(baseline,'package-lock.json')),lock=JSON.parse(bytes);
assert.equal(sha(bytes),expected.lockSha256);
const productionPackages={};
for(const [path,pkg] of Object.entries(lock.packages))if(path&&!pkg.dev&&!pkg.optional)productionPackages[path]=await filesUnder(resolve(baseline,path),{skipModules:true});
assert.deepEqual(productionPackages,expected.productionPackages);
const sources={};
for(const name of ['runtime-manifest','runtime-next-manifest','runtime-reporting-manifest','runtime-readiness-manifest']){
 const {sourceComponents}=await import(pathToFileURL(resolve(baseline,'.generated',name+'.mjs')));
 for(const component of sourceComponents)if(component.path!=='reference391.mjs')sources[component.path]=component.sha256;
}
assert.deepEqual(sources,expected.sources);
for(const [path,digest] of Object.entries(expected.baselinePreparers))assert.equal(sha(await readFile(resolve(baseline,path))),digest);
for(const [path,files] of Object.entries(expected.esbuildPackages))assert.deepEqual(await filesUnder(resolve(baseline,path),{skipModules:true}),files);
const outputs=await filesUnder(resolve(baseline,'.generated'));
const consumer={'test-page-client.mjs':outputs['test-page-client.mjs']};delete outputs['test-page-client.mjs'];
assert.deepEqual(outputs,expected.outputs);assert.deepEqual(consumer,expected.consumerBaseline);
console.log(JSON.stringify({baseline:expected.baselineCommit,node:process.version,productionPackages:Object.keys(productionPackages).length,historicalOutputs:Object.keys(outputs).length,consumerBaselineMatches:true},null,2));
