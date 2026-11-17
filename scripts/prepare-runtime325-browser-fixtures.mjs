/** MAIN generated packages plus a QA-only canonical A/B delivery adapter. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {pinRuntime} from '../worker/runtime/version-pin.mjs';
import {prebidRequirements,inspectPrebidArtifact,sha256} from '../worker/runtime/prebid-artifact-check-v2.mjs';
import {runtime325BrowserSite} from '../tests/runtime/runtime325-browser-site.mjs';
import {runtime325ABFixture} from '../tests/runtime/runtime325-ab-fixture.mjs';

const root=resolve(import.meta.dirname,'..'),options={};
for(let i=2;i<process.argv.length;i+=2) {
  const name=process.argv[i],value=process.argv[i+1];
  assert(['--prebid','--out'].includes(name)&&value&&!Object.hasOwn(options,name),'Use --prebid <directory> --out <directory>');
  options[name]=resolve(value);
}
assert(options['--prebid'],'Supply the exact pinned native build directory');
const runtimeRoot=resolve(process.env.RUNTIME325_RUNTIME_ROOT||root);
const {runtimeCatalog,previewInput,buildArtifactCandidate}=await import(pathToFileURL(resolve(runtimeRoot,'worker/test-workspace/runtime-catalog.mjs')));
const out=options['--out']??resolve(root,'.generated/runtime325-browser');
const native=options['--prebid'],prebidBytes=await readFile(resolve(native,'prebid.js'));
const prebid=JSON.parse(await readFile(resolve(native,'prebid-config.json'),'utf8'));
const nativeBuild=JSON.parse(await readFile(resolve(native,'manifest.json'),'utf8'));
const pins={'11.11.0':'0f6ba177203d5f63e0a11453ed0c887fcf5efe33','11.34.0':'195e0c6069928ed906bde550cb4e4183d1dc8474'};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(nativeBuild.sourceCommit,pins[prebid.version]);
assert.equal(nativeBuild.buildSha256,hash(prebidBytes));
const versions=(process.env.RUNTIME325_QA_VERSIONS||'3.24.0,3.25.0').split(',');
const cases=['standard','lazy','late-lazy','mixed-gam','gam','timeout'];
const files={},packages=[];await mkdir(out,{recursive:true});
for(const version of versions) {
  const descriptor=runtimeCatalog.find(row=>row.version===version);assert(descriptor,'Register runtime '+version);
  for(const kind of cases) {
    const arms={},generated={};
    for(const arm of ['A','B']) {
      const snapshot=runtime325BrowserSite({cache:arm==='B',kind});
      const input=previewInput(snapshot,descriptor,'20261117_020000');
      const requirements=prebidRequirements(input,JSON.parse(snapshot.config.config_json));assert.deepEqual(requirements.issues,[]);
      let checked=null;
      if(requirements.required) {
        const bytes=prebidBytes.buffer.slice(prebidBytes.byteOffset,prebidBytes.byteOffset+prebidBytes.byteLength);
        const build={id:'native',publisher_id:snapshot.site.id,status:'current',version:prebid.version,
          file_key:`publishers/${snapshot.site.id}/prebid-builds/native/prebid.js`,modules_json:JSON.stringify(prebid.modules)};
        const object={size:prebidBytes.byteLength,customMetadata:{sha256:await sha256(bytes),version:prebid.version},async arrayBuffer(){return bytes;}};
        const report=await inspectPrebidArtifact({siteId:snapshot.site.id,builds:[build],requirements},{async get(){return object;}});
        assert.equal(report.status,'checked',JSON.stringify(report));checked={bytes,report};
      }
      const result=await buildArtifactCandidate({snapshot,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:'20261117_020000',prebid:checked});
      arms[arm]=new TextDecoder().decode(result.files['ads.js']);
      generated[arm]=Object.fromEntries(['ads.js','ads.min.js','config.json','manifest.json'].map(name=>[name,hash(result.files[name])]));
    }
    const snapshot=runtime325BrowserSite({kind});
    const fixture=await runtime325ABFixture({arms,prebid:prebidBytes,prebidVersion:prebid.version,
      positions:snapshot.units.map(row=>row.code),release:`mba424-qa-${version}-${kind}`,runtimeVersion:version});
    const folder=resolve(out,version,kind);await mkdir(folder,{recursive:true});
    for(const [name,bytes]of Object.entries({...fixture.files,'prebid.js':prebidBytes})) {
      const path=resolve(folder,name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,bytes);
      files[`${version}/${kind}/${name}`]=hash(bytes);
    }
    packages.push({version,kind,runtime:descriptor,generated,canonicalLoaderSha256:fixture.canonicalLoaderSha256,scope:fixture.scope});
  }
}
const gpt=JSON.parse(await readFile(resolve(root,'vendor/gpt/m202611120201/manifest.json'),'utf8'));
for(const entry of gpt.files)assert.equal(hash(await readFile(resolve(root,'vendor/gpt/m202611120201',entry.file))),entry.sha256);
await writeFile(resolve(out,'manifest.json'),JSON.stringify({schemaVersion:1,versions,cases,prebid,nativeBuild,gpt,files,packages},null,2)+'\n');
console.log(JSON.stringify({packages:packages.length,prebid:prebid.version,output:out}));
