/** Pinned native Prebid builds for the combined 3.24.0 integration checks.
 *
 * node scripts/build-runtime324-prebid.mjs --version 11.11.0|11.34.0
 * Writes .generated/runtime324-prebid/<version>/{prebid.js,prebid-config.json,manifest.json}.
 * RUNTIME324_PREBID_ROOT may select a separate output folder. Upstream tracked
 * core/adapter sources and lockfiles stay unchanged. Only the canonical Tessera
 * contextual provider and the synthetic audit provider are added as untracked
 * custom modules. No ad requests or deployment occur during this build.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(process.env.RUNTIME324_PREBID_ROOT||resolve(root,'.generated/runtime324-prebid'));
const pins={
  '11.11.0':{commit:'0f6ba177203d5f63e0a11453ed0c887fcf5efe33',lockSha256:'8207a5e5551ec1d02125276b412e1cb18db5ff305c2babbb8c68fc361b109b7b'},
  '11.34.0':{commit:'195e0c6069928ed906bde550cb4e4183d1dc8474',lockSha256:'077338389169c8834d5bd1dedacd92094fb3b0e05a1c54fb4de7ffaa4b7d02d9'},
};
const args=process.argv.slice(2);
assert(args.length===2&&args[0]==='--version'&&Object.hasOwn(pins,args[1]),'Usage: node scripts/build-runtime324-prebid.mjs --version 11.11.0|11.34.0');
const version=args[1],pin=pins[version];
const {modules:vendorModules}=JSON.parse(await readFile(resolve(root,'vendor/prebid/tanjug-11.34.0/prebid-config.json'),'utf8'));
assert(Array.isArray(vendorModules)&&vendorModules.includes('consentManagementTcf')&&vendorModules.includes('tcfControl'));
const modules=[...new Set([...vendorModules,'allowActivities','gptPreAuction','rtdModule','contextualSignalsRtdProvider','contextualAuditRtdProvider','videoModule'])].sort();
const sha256=value=>createHash('sha256').update(value).digest('hex');
const modulePath=resolve(root,'worker/runtime-321/prebid-module.mjs');
const moduleSourceSha256=sha256(await readFile(modulePath));
const {PREBID_CONTEXTUAL_MODULE_SOURCE:moduleSource}=await import(pathToFileURL(modulePath));
assert.equal(typeof moduleSource,'string');
const auditModulePath=resolve(root,'tests/contextual-native/audit-rtd-provider.js');
const auditModule=await readFile(auditModulePath),auditModuleSha256=sha256(auditModule);

function run(command,argv,cwd,capture=false){
  const result=spawnSync(command,argv,{cwd,encoding:'utf8',stdio:capture?'pipe':'inherit',env:{...process.env,PUPPETEER_SKIP_DOWNLOAD:'true'}});
  assert.equal(result.status,0,`${command} ${argv.join(' ')} failed: ${result.stderr||result.error||''}`);
  return(result.stdout||'').trim();
}
const upstream=resolve(output,`upstream-${version}`);
if(!existsSync(resolve(upstream,'.git'))){
  await mkdir(upstream,{recursive:true});
  run('git',['init'],upstream);
  run('git',['remote','add','origin','https://github.com/prebid/Prebid.js.git'],upstream);
  run('git',['fetch','--depth=1','origin',pin.commit],upstream);
  run('git',['checkout','--detach','FETCH_HEAD'],upstream);
}
assert.equal(run('git',['rev-parse','HEAD'],upstream,true),pin.commit,'Wrong pinned upstream checkout');
assert.equal(run('git',['status','--porcelain','--untracked-files=no'],upstream,true),'','Upstream tracked files were modified');
const lockPath=resolve(upstream,'package-lock.json');
assert.equal(sha256(await readFile(lockPath)),pin.lockSha256,'Upstream lock differs from pinned input');
assert.equal(JSON.parse(await readFile(resolve(upstream,'package.json'),'utf8')).version,version);
for(const [name,source] of [['contextualSignalsRtdProvider',moduleSource],['contextualAuditRtdProvider',auditModule]]){
  const path=`modules/${name}.js`;
  assert.equal(run('git',['ls-files',path],upstream,true),'',`Refusing to overwrite an upstream module: ${name}`);
  await writeFile(resolve(upstream,path),source);
}
for(const name of modules){
  assert(['.js','.ts',''].some(suffix=>existsSync(resolve(upstream,'modules',name+suffix))),`Upstream module missing: ${name}`);
}
run('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],upstream);
run('npx',['--no-install','gulp','build',`--modules=${modules.join(',')}`],upstream);
assert.equal(sha256(await readFile(lockPath)),pin.lockSha256,'Build changed the upstream lock');
assert.equal(run('git',['status','--porcelain','--untracked-files=no'],upstream,true),'','Build changed upstream tracked files');
assert.equal(sha256(await readFile(modulePath)),moduleSourceSha256,'Canonical module source changed during the build');
assert.equal(sha256(await readFile(auditModulePath)),auditModuleSha256,'Audit module source changed during the build');
assert.equal(sha256(await readFile(resolve(upstream,'modules/contextualSignalsRtdProvider.js'))),sha256(moduleSource));
assert.equal(sha256(await readFile(resolve(upstream,'modules/contextualAuditRtdProvider.js'))),auditModuleSha256);
const build=await readFile(resolve(upstream,'build/dist/prebid.js'));
assert(build.includes(Buffer.from(`"v${version}"`)),`Build is not Prebid.js ${version}`);
assert(build.includes(Buffer.from('contextualSignals'))&&build.includes(Buffer.from('contextualAudit')),'Custom providers missing from build');
const destination=resolve(output,version);await mkdir(destination,{recursive:true});
const buildPath=resolve(destination,'prebid.js');
await writeFile(buildPath,build);
await writeFile(resolve(destination,'prebid-config.json'),JSON.stringify({version,modules},null,2)+'\n');
const manifest={schemaVersion:1,prebidVersion:version,sourceRepository:'https://github.com/prebid/Prebid.js',sourceCommit:pin.commit,
  upstreamLockSha256:pin.lockSha256,modules,nodeVersion:process.version,npmVersion:run('npm',['--version'],upstream,true),
  buildPath,buildSha256:sha256(build),moduleSourcePath:modulePath,moduleSourceSha256,moduleContentSha256:sha256(moduleSource),
  auditModulePath,auditModuleSha256,
  scope:'Pinned upstream Prebid core/adapters plus canonical contextual and synthetic audit RTD modules. Build success is not auction, hosted, SSP or revenue acceptance.'};
await writeFile(resolve(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`BUILT combined-runtime Prebid ${version}: ${manifest.buildSha256}`);
