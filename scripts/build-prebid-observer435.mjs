/** Build a separate reviewed Prebid lifecycle candidate; never replaces an existing build. */
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {OBSERVER435_VARIANT,OBSERVER435_UPSTREAM,OBSERVER435_BEFORE,applyObserver435Patch,observer435Sha,observer435Modules,observer435BuildDate,normalizeObserver435Banner} from './observer435-patch.mjs';

const root=resolve(import.meta.dirname,'..'),args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){
  assert(['--out','--modules','--build-date'].includes(args[i])&&args[i+1]&&!Object.hasOwn(options,args[i]),'Use [--out <empty build directory>] [--modules <explicit Prebid11.34 module JSON>] [--build-date YYYY-MM-DD].');
  options[args[i]]=args[i]==='--build-date'?args[i+1]:resolve(args[i+1]);
}
const output=resolve(options['--out']??resolve(root,'.generated/observer435-builds')),upstream=resolve(output,'upstream-11.34.0');
const sha=observer435Sha,pin=OBSERVER435_UPSTREAM;
const buildDate=observer435BuildDate(options['--build-date']??new Date().toISOString().slice(0,10));
const moduleInput=await readFile(options['--modules']??resolve(root,'vendor/prebid/tanjug-11.34.0/prebid-config.json'));
const modules=observer435Modules(JSON.parse(moduleInput),Boolean(options['--modules']));
function run(command,argv,cwd,capture=false){
  const result=spawnSync(command,argv,{cwd,encoding:'utf8',stdio:capture?'pipe':'inherit',env:{...process.env,PUPPETEER_SKIP_DOWNLOAD:'true'}});
  assert.equal(result.status,0,`${command} ${argv.join(' ')} failed: ${result.stderr||result.error||''}`);
  return(result.stdout??'').trim();
}
await mkdir(output,{recursive:true});
assert(!existsSync(resolve(output,'comparison.json')),'Refusing to replace the retained build comparison.');
for(const label of ['control','fixed'])assert.equal((await readdir(resolve(output,label)).catch(()=>[])).length,0,`Refusing to replace ${label} build files.`);
if(!existsSync(resolve(upstream,'.git'))){
  await mkdir(upstream,{recursive:true});run('git',['init'],upstream);run('git',['remote','add','origin','https://github.com/prebid/Prebid.js.git'],upstream);
  run('git',['fetch','--depth=1','origin',pin.commit],upstream);run('git',['checkout','--detach','FETCH_HEAD'],upstream);
}
assert.equal(run('git',['rev-parse','HEAD'],upstream,true),pin.commit,'Unreviewed upstream commit.');
assert.equal(run('git',['status','--porcelain','--untracked-files=no'],upstream,true),'','Upstream source must start clean.');
const untrackedModules=run('git',['ls-files','--others','--exclude-standard','--','modules'],upstream,true).split('\n').filter(Boolean);
assert(untrackedModules.every(name=>name==='modules/contextualSignalsRtdProvider.js'),'Undeclared custom module source in upstream checkout.');
assert.equal(sha(await readFile(resolve(upstream,'package-lock.json'))),pin.lockSha256,'Unreviewed upstream lockfile.');
assert.equal(JSON.parse(await readFile(resolve(upstream,'package.json'),'utf8')).version,pin.version);
for(const [name,hash]of Object.entries(OBSERVER435_BEFORE))assert.equal(sha(await readFile(resolve(upstream,name))),hash,`Unreviewed source: ${name}`);

const modulePath=resolve(root,'worker/runtime-321/prebid-module.mjs'),moduleFile=await readFile(modulePath);
const {PREBID_CONTEXTUAL_MODULE_SOURCE:moduleSource}=await import(pathToFileURL(modulePath));
assert.equal(typeof moduleSource,'string');
assert.equal(run('git',['ls-files','modules/contextualSignalsRtdProvider.js'],upstream,true),'','Refusing to overwrite upstream module.');
if(modules.includes('contextualSignalsRtdProvider'))await writeFile(resolve(upstream,'modules/contextualSignalsRtdProvider.js'),moduleSource);
for(const name of modules)assert(['.js','.ts',''].some(suffix=>existsSync(resolve(upstream,'modules',name+suffix))),`Missing module ${name}`);
run('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],upstream);
const tools={nodeVersion:process.version,npmVersion:run('npm',['--version'],upstream,true)};
const source={sourceRepository:'https://github.com/prebid/Prebid.js',upstreamVersion:pin.version,sourceCommit:pin.commit,
  upstreamLockSha256:pin.lockSha256,modules,moduleSelection:{kind:options['--modules']?'explicit-module-profile':'reviewed-tanjug-derived-profile',inputSha256:sha(moduleInput)},
  ...(modules.includes('contextualSignalsRtdProvider')?{canonicalContextualModule:{path:'worker/runtime-321/prebid-module.mjs',sourceFileSha256:sha(moduleFile),contentSha256:sha(moduleSource)}}:{})};
const results={};let changes=[];
for(const label of ['control','fixed']){
  if(label==='fixed')changes=await applyObserver435Patch(upstream);
  run('npx',['--no-install','gulp','build',`--modules=${modules.join(',')}`],upstream);
  assert.equal(sha(await readFile(resolve(upstream,'package-lock.json'))),pin.lockSha256,'Build altered lockfile.');
  if(source.canonicalContextualModule){
    assert.equal(sha(await readFile(modulePath)),source.canonicalContextualModule.sourceFileSha256,'Canonical module changed.');
    assert.equal(sha(await readFile(resolve(upstream,'modules/contextualSignalsRtdProvider.js'))),source.canonicalContextualModule.contentSha256);
  }
  const modified=run('git',['diff','--name-only'],upstream,true).split('\n').filter(Boolean).sort();
  assert.deepEqual(modified,label==='fixed'?Object.keys(OBSERVER435_BEFORE).sort():[],'Unexpected upstream source changes.');
  const rawBytes=await readFile(resolve(upstream,'build/dist/prebid.js')),folder=resolve(output,label);
  const normalized=normalizeObserver435Banner(rawBytes,buildDate),{bytes}=normalized;
  assert(bytes.includes(Buffer.from(`"v${pin.version}"`)),'Wrong Prebid core version.');
  await mkdir(folder,{recursive:true});await writeFile(resolve(folder,'prebid.js'),bytes,{flag:'wx'});
  await writeFile(resolve(folder,'prebid-config.json'),JSON.stringify({version:pin.version,modules},null,2)+'\n',{flag:'wx'});
  const rendererSha256={};
  for(const renderer of ['display','native']){
    const declaration=await readFile(resolve(upstream,`dist/src/creative-renderers/${renderer}.js`),'utf8');
    const literal=declaration.slice(declaration.indexOf('export const RENDERER = ')+24).trim().replace(/;$/,'');
    const source=JSON.parse(literal);
    assert.equal(typeof source,'string');assert(source.includes('window.render='),'Missing compiled renderer.');
    rendererSha256[renderer]=sha(source);await writeFile(resolve(folder,`renderer-${renderer}.js`),source,{flag:'wx'});
  }
  const manifest={schemaVersion:1,kind:'tessera-prebid-build-candidate',prebidVersion:pin.version,variant:label==='fixed'?OBSERVER435_VARIANT:'observer435-source-control',...source,...tools,
    byteSize:bytes.length,buildSha256:sha(bytes),buildDate,upstreamBannerDate:normalized.upstreamBannerDate,
    executableBodySha256:normalized.executableBodySha256,bannerNormalization:'UTC date comment line only; executable bytes unchanged',
    rendererSha256,patches:label==='fixed'?changes:[],
    scope:'Separate opt-in Prebid build. No publisher activation, runtime change, SSP acceptance or revenue claim.'};
  if(label==='fixed'){
    const patch=run('git',['diff','--',...Object.keys(OBSERVER435_BEFORE)],upstream,true)+'\n';
    await writeFile(resolve(folder,'observer-lifecycle.patch'),patch,{flag:'wx'});manifest.patchSha256=sha(patch);
  }
  run(process.execPath,['--check',resolve(folder,'prebid.js')],root);
  await writeFile(resolve(folder,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});results[label]=manifest;
}
assert.notEqual(results.control.buildSha256,results.fixed.buildSha256,'Patched output must be distinct.');
assert.deepEqual(results.control.modules,results.fixed.modules);
await writeFile(resolve(output,'comparison.json'),JSON.stringify({kind:'observer435-source-pair',control:results.control,fixed:results.fixed},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({built:true,output,controlSha256:results.control.buildSha256,fixedSha256:results.fixed.buildSha256,modules:modules.length}));
