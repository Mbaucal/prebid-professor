/** Actual generated combined-runtime packages, with exact native Prebid bytes. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {runtimeCatalog,previewInput,buildArtifactCandidate} from '../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../worker/runtime/version-pin.mjs';
import {prebidRequirements,inspectPrebidArtifact,sha256} from '../worker/runtime/prebid-artifact-check-v2.mjs';
import {runtime324Site} from '../tests/runtime/runtime324-site.mjs';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){assert(['--prebid','--out'].includes(args[i])&&args[i+1]&&!Object.hasOwn(options,args[i]),'Use --prebid <directory> --out <directory>');options[args[i]]=resolve(args[i+1]);}
const root=resolve(import.meta.dirname,'..'),out=options['--out']??resolve(root,'.generated/runtime324-browser');
assert(options['--prebid'],'Supply an exact native build with --prebid <directory>.');
const source=options['--prebid'],bytes=await readFile(resolve(source,'prebid.js'));
const prebid=JSON.parse(await readFile(resolve(source,'prebid-config.json'),'utf8'));
const nativeBuild=JSON.parse(await readFile(resolve(source,'manifest.json'),'utf8'));
const pinned={'11.11.0':'0f6ba177203d5f63e0a11453ed0c887fcf5efe33','11.34.0':'195e0c6069928ed906bde550cb4e4183d1dc8474'};
assert.equal(nativeBuild.sourceCommit,pinned[prebid.version],'Native build must use the pinned upstream commit');
assert.equal(nativeBuild.buildSha256,createHash('sha256').update(bytes).digest('hex'),'Native build differs from its receipt');
const descriptor=runtimeCatalog.find(row=>row.id==='tessera-3.24.0');assert(descriptor,'3.24.0 must be registered');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const files={},cases={on:{},off:{cache:false},expiry:{maxAge:1},lazy:{lazy:true},sticky:{sticky:true},floor:{floor:'raise'},'floor-valid':{floor:'valid'},'floor-deal':{floor:'deal'},'floor-zero':{floor:'zero'},gam:{prebid:false},...(prebid.version==='11.34.0'?{formats:{formats:true}}:{})};
await mkdir(out,{recursive:true});
for(const [name,options]of Object.entries(cases)){
 const snapshot=runtime324Site(options),input=previewInput(snapshot,descriptor,'20261116_120000');
 let checked=null;
 if(options.prebid!==false){
  const requirements=prebidRequirements(input,JSON.parse(snapshot.config.config_json));assert.deepEqual(requirements.issues,[]);
  const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  const build={id:'native',publisher_id:snapshot.site.id,status:'current',version:prebid.version,file_key:`publishers/${snapshot.site.id}/prebid-builds/native/prebid.js`,modules_json:JSON.stringify(prebid.modules)};
  const object={size:bytes.byteLength,customMetadata:{sha256:await sha256(buffer),version:prebid.version},async arrayBuffer(){return buffer;}};
  const report=await inspectPrebidArtifact({siteId:snapshot.site.id,builds:[build],requirements},{async get(){return object;}});
  assert.equal(report.status,'checked',JSON.stringify(report));checked={bytes:buffer,report};
 }
 const result=await buildArtifactCandidate({snapshot,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:'20261116_120000',prebid:checked});
 const dir=resolve(out,name);await mkdir(dir,{recursive:true});
 for(const file of ['ads.js','ads.min.js','prebid.js','config.json','manifest.json']){
  if(file==='prebid.js'&&!checked)continue;
  assert(result.files[file],file);await writeFile(resolve(dir,file),result.files[file]);files[`${name}/${file}`]=hash(result.files[file]);
 }
 assert.equal(result.manifest.runtime.runtimeVersion,'3.24.0');
}
await writeFile(resolve(out,'manifest.json'),JSON.stringify({runtime:descriptor,prebid,nativeBuild,cases,files},null,2)+'\n');
console.log(JSON.stringify({packages:Object.keys(cases),prebid:prebid.version,output:out}));
