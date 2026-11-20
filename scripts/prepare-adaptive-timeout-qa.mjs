/** Exact native Prebid + complete new-runtime packages. No hosted reads or publisher writes. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
const own=resolve(import.meta.dirname,'..'),root=resolve(process.env.ADAPTIVE_TIMEOUT_QA_ROOT??own);
const args=process.argv.slice(2),options={};
for(let n=0;n<args.length;n+=2){assert(['--prebid','--out'].includes(args[n])&&args[n+1]);options[args[n]]=resolve(args[n+1]);}
assert(options['--prebid']&&options['--out'],'Use --prebid <pinned directory> --out <owned evidence directory>');
const out=options['--out'];assert(out!==root&&out!==own,'Output must be an evidence directory');
const load=p=>import(pathToFileURL(resolve(root,p)).href),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const {runtimeCatalog,previewInput,buildArtifactCandidate}=await load('worker/test-workspace/runtime-catalog.mjs');
const {pinRuntime}=await load('worker/runtime/version-pin.mjs');
const {describeCandidate}=await load('worker/runtime/draft-release-store.mjs');
const {runtime325BrowserSite}=await load('tests/runtime/runtime325-browser-site.mjs');
const {prebidRequirements,inspectPrebidArtifact}=await load('worker/runtime/prebid-artifact-check-v2.mjs');
const descriptor=runtimeCatalog.find(row=>row.version==='3.26.0');assert(descriptor,'3.26.0 must be explicitly registered');
const nativeBytes=new Uint8Array(await readFile(resolve(options['--prebid'],'prebid.js')));
const prebid=JSON.parse(await readFile(resolve(options['--prebid'],'prebid-config.json'),'utf8'));
const native=JSON.parse(await readFile(resolve(options['--prebid'],'manifest.json'),'utf8'));
assert.equal(native.sourceCommit,{'11.11.0':'0f6ba177203d5f63e0a11453ed0c887fcf5efe33','11.34.0':'195e0c6069928ed906bde550cb4e4183d1dc8474'}[prebid.version]);
assert.equal(hash(nativeBytes),native.buildSha256);
const zero={enabled:true,minMs:100,maxMs:4000,mobileAdjustmentMs:0,slowConnectionAdjustmentMs:0,videoAdjustmentMs:0,additionalPositionMs:0,maxPositionAdjustmentMs:0};
const cases={off:{enabled:false},local:{...zero,minMs:800,mobileAdjustmentMs:200,slowConnectionAdjustmentMs:500},
  pending:{...zero},preauction:{...zero},extension:{...zero,maxMs:1200},shortening:{...zero},concurrent:{...zero}};
const files={};await mkdir(out,{recursive:true});
let rejectedOld=false;
for(const [name,policy]of Object.entries(cases)){
 const snapshot=runtime325BrowserSite({cache:true});
 const config=JSON.parse(snapshot.config.config_json);config.adaptiveAuctionTimeout=policy;
 snapshot.config.config_json=JSON.stringify(config);
 snapshot.rules=[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({lazy:{enabled:false,fetchMarginPx:0,renderMarginPx:0},
  timeout:name==='shortening'?3000:500,cmpTimeout:10000,refresh:{enabled:false}})}];
 if(name==='concurrent')snapshot.rules.push({rule_key:'P1',rule_json:JSON.stringify({timeout:1200})});
 const input=previewInput(snapshot,descriptor,'20261120_120000'),requirements=prebidRequirements(input,config);
 assert.deepEqual(requirements.issues,[]);
 const buffer=nativeBytes.buffer.slice(nativeBytes.byteOffset,nativeBytes.byteOffset+nativeBytes.byteLength);
 const build={id:'native',publisher_id:snapshot.site.id,status:'current',version:prebid.version,
  file_key:`publishers/${snapshot.site.id}/prebid-builds/native/prebid.js`,modules_json:JSON.stringify(prebid.modules)};
 const object={size:nativeBytes.byteLength,customMetadata:{sha256:hash(nativeBytes),version:prebid.version},async arrayBuffer(){return buffer;}};
 const report=await inspectPrebidArtifact({siteId:snapshot.site.id,builds:[build],requirements},{async get(){return object;}});
 assert.equal(report.status,'checked',JSON.stringify(report));
 if(name==='local'){
  const old=runtimeCatalog.find(row=>row.version==='3.25.1');
  assert.throws(()=>previewInput(snapshot,old,'20261120_120000'),/3\.26\.0/);rejectedOld=true;
 }
 const result=await buildArtifactCandidate({snapshot,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:'20261120_120000',prebid:{bytes:buffer,report}});
 assert.equal(result.manifest.runtime.runtimeVersion,'3.26.0');
 const saved=await describeCandidate(snapshot.site.id,result);assert.equal(saved.descriptor.runtime.runtimeVersion,'3.26.0');
 for(const file of ['ads.js','ads.min.js','config.json','manifest.json','prebid.js']){
  const nameInOutput=name+'/'+file,path=resolve(out,nameInOutput);assert(path.startsWith(out+sep));
  await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,result.files[file]);files[nameInOutput]=hash(result.files[file]);
 }
}
const mock=await readFile(resolve(root,'tests/runtime/mock-ad-libraries.js'));
await writeFile(resolve(out,'mock-ad-libraries.js'),mock);files['mock-ad-libraries.js']=hash(mock);
await writeFile(resolve(out,'manifest.json'),JSON.stringify({schemaVersion:1,runtime:descriptor,prebid,native,files,cases:Object.keys(cases),
  oldEnabledPolicyRejected:rejectedOld,scope:'Exact native Prebid; intercepted synthetic adapters and mock GPT only. Native request hooks model external timeout/RTD changes; no remote provider, paid traffic, publisher activation or real GAM acceptance.'},null,2)+'\n');
console.log(JSON.stringify({output:out,runtime:descriptor.version,prebid:prebid.version,cases:Object.keys(cases).length,oldEnabledPolicyRejected:rejectedOld}));
