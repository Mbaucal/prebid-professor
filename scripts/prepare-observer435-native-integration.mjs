/** Test-only native integration build. The extra audit provider is never a production artifact. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {OBSERVER435_UPSTREAM,observer435Sha as sha} from './observer435-patch.mjs';
const root=resolve(import.meta.dirname,'..'),args=process.argv.slice(2);
assert(args.length===4&&args[0]==='--upstream'&&args[2]==='--out','Use --upstream <owned patched checkout> --out <empty fixture directory>.');
const upstream=resolve(args[1]),out=resolve(args[3]);
function run(command,argv,capture=false){const result=spawnSync(command,argv,{cwd:upstream,encoding:'utf8',stdio:capture?'pipe':'inherit',env:{...process.env,PUPPETEER_SKIP_DOWNLOAD:'true'}});assert.equal(result.status,0,result.stderr||result.error||'Native fixture build failed.');return(result.stdout??'').trim();}
const candidate=JSON.parse(await readFile(resolve(root,'vendor/prebid/observer-lifecycle-11.34.0-tessera-1/manifest.json'),'utf8'));
assert.equal(run('git',['rev-parse','HEAD'],true),OBSERVER435_UPSTREAM.commit);
assert.equal(sha(await readFile(resolve(upstream,'package-lock.json'))),OBSERVER435_UPSTREAM.lockSha256);
for(const file of candidate.patches)assert.equal(sha(await readFile(resolve(upstream,file.name))),file.afterSha256,'Patched source changed.');
const moduleName='contextualAuditRtdProvider',path=`modules/${moduleName}.js`;
assert.equal(run('git',['ls-files',path],true),'','Audit provider must not overwrite tracked source.');
const audit=await readFile(resolve(root,'tests/contextual-native/audit-rtd-provider.js'));
await writeFile(resolve(upstream,path),audit);
const modules=[...candidate.modules,moduleName].sort();assert.equal(new Set(modules).size,modules.length);
run('npx',['--no-install','gulp','build',`--modules=${modules.join(',')}`]);
for(const file of candidate.patches)assert.equal(sha(await readFile(resolve(upstream,file.name))),file.afterSha256);
assert.equal(sha(await readFile(resolve(upstream,'package-lock.json'))),OBSERVER435_UPSTREAM.lockSha256);
const bytes=await readFile(resolve(upstream,'build/dist/prebid.js'));
const manifest={...candidate,kind:'observer435-native-integration-fixture',variant:'fixture-only-with-audit-provider',isProductionCandidate:false,
  modules,byteSize:bytes.length,buildSha256:sha(bytes),productionCandidateSha256:candidate.buildSha256,
  auditModule:{path:'tests/contextual-native/audit-rtd-provider.js',sha256:sha(audit)},
  scope:'Synthetic native regression instrumentation only. This21-module build is not the20-module production candidate and is not for publisher upload.'};
delete manifest.rendererSha256;delete manifest.patchSha256;
await mkdir(out,{recursive:true});
await writeFile(resolve(out,'prebid.js'),bytes,{flag:'wx'});
await writeFile(resolve(out,'prebid-config.json'),JSON.stringify({version:OBSERVER435_UPSTREAM.version,modules},null,2)+'\n',{flag:'wx'});
await writeFile(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
assert.equal(sha(await readFile(resolve(upstream,path))),sha(audit));
await unlink(resolve(upstream,path));
console.log(JSON.stringify({fixture:true,output:out,modules:modules.length,buildSha256:manifest.buildSha256}));
