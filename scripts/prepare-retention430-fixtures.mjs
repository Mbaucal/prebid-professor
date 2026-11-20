/** MBA-430 only: generate immutable 3.25.1 synthetic OFF/ON/control packages. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runtimeCatalog,previewInput,buildArtifactCandidate} from '../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../worker/runtime/version-pin.mjs';
import {prebidRequirements,inspectPrebidArtifact} from '../worker/runtime/prebid-artifact-check-v2.mjs';
import {bidCacheSite} from '../tests/runtime/bid-cache323-site.mjs';

const root=resolve(import.meta.dirname,'..'),args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){
  assert(['--native-root','--out'].includes(args[i])&&args[i+1]&&!options[args[i]],'Use --native-root <pinned build root> [--out <empty directory>].');
  options[args[i]]=resolve(args[i+1]);
}
assert(options['--native-root'],'Build both versions with scripts/build-runtime324-prebid.mjs first.');
const out=options['--out']??resolve(root,'.generated/retention430-fixtures');
assert.equal((await readdir(out).catch(()=>[])).length,0,'Fixture directory must be empty.');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const descriptor=runtimeCatalog.find(row=>row.id==='tessera-3.25.1'&&row.version==='3.25.1');assert(descriptor);
const pins={
  '11.11.0':{commit:'0f6ba177203d5f63e0a11453ed0c887fcf5efe33',lock:'8207a5e5551ec1d02125276b412e1cb18db5ff305c2babbb8c68fc361b109b7b'},
  '11.34.0':{commit:'195e0c6069928ed906bde550cb4e4183d1dc8474',lock:'077338389169c8834d5bd1dedacd92094fb3b0e05a1c54fb4de7ffaa4b7d02d9'},
};
const manifest={schemaVersion:1,scope:'Synthetic MAIN-target 3.25.1 packages; no serving/runtime changes or publication',
  runtime:descriptor,stamp:'20261120_120000',refreshSeconds:30,syntheticCap:150,defaultCap:20,versions:{},files:{}};
async function put(name,bytes){await mkdir(resolve(out,name,'..'),{recursive:true});await writeFile(resolve(out,name),bytes,{flag:'wx'});manifest.files[name]=sha(bytes);}
for(const [version,pin]of Object.entries(pins)){
  const folder=resolve(options['--native-root'],version),bytes=await readFile(resolve(folder,'prebid.js'));
  const prebid=JSON.parse(await readFile(resolve(folder,'prebid-config.json'),'utf8'));
  const build=JSON.parse(await readFile(resolve(folder,'manifest.json'),'utf8'));
  assert.equal(prebid.version,version);assert.equal(build.sourceCommit,pin.commit);assert.equal(build.upstreamLockSha256,pin.lock);
  assert.equal(build.buildSha256,sha(bytes));assert.deepEqual(build.modules,prebid.modules);
  manifest.versions[version]={...build,packages:{}};
  for(const pacing of ['long','cap20','static']){
    let identity;
    for(const enabled of [false,true]){
      const snapshot=bidCacheSite({cache:{enabled,maxBidAgeSeconds:60}}),config=JSON.parse(snapshot.config.config_json);
      snapshot.site={...snapshot.site,id:'retention430',name:'Synthetic retention profile',domain:'retention430.example.invalid',gam_path:'/999/retention430/'};
      config.userSync={syncEnabled:false,syncsPerBidder:0,syncDelay:0,auctionDelay:0,userIds:[]};
      snapshot.config.config_json=JSON.stringify(config);
      if(pacing==='long')for(const row of snapshot.rules){const rule=JSON.parse(row.rule_json);rule.refresh.maxRefreshes=150;row.rule_json=JSON.stringify(rule);}
      if(pacing==='static')for(const row of snapshot.rules){const rule=JSON.parse(row.rule_json);rule.refresh.enabled=false;row.rule_json=JSON.stringify(rule);}
      const withoutCache=structuredClone(snapshot);delete config.prebidBidCache;withoutCache.config.config_json=JSON.stringify(config);
      if(identity)assert.equal(JSON.stringify(withoutCache),identity,'OFF/ON must have identical ad opportunities/configuration.');else identity=JSON.stringify(withoutCache);
      const input=previewInput(snapshot,descriptor,manifest.stamp),requirements=prebidRequirements(input,JSON.parse(snapshot.config.config_json));
      assert.deepEqual(requirements.issues,[]);
      const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
      const selected={id:'pinned',publisher_id:snapshot.site.id,status:'current',version,
        file_key:`publishers/${snapshot.site.id}/prebid-builds/pinned/prebid.js`,modules_json:JSON.stringify(prebid.modules)};
      const object={size:bytes.byteLength,customMetadata:{sha256:sha(bytes),version},arrayBuffer:async()=>buffer};
      const report=await inspectPrebidArtifact({siteId:snapshot.site.id,builds:[selected],requirements},{get:async()=>object});
      assert.equal(report.status,'checked',JSON.stringify(report));
      const result=await buildArtifactCandidate({snapshot,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:manifest.stamp,
        prebid:{bytes:buffer,report},countryTarget:'main'});
      assert.equal(result.manifest.runtime.runtimeSha256,descriptor.codeSha256);
      const label=pacing+'-'+(enabled?'on':'off');
      for(const name of ['ads.min.js','prebid.js','config.json','manifest.json'])await put(`${version}/${label}/${name}`,result.files[name]);
      manifest.versions[version].packages[label]={cache:enabled,pacing,inputWithoutCacheSha256:sha(identity),
        generatedRuntime:result.manifest.runtime,adsSha256:sha(result.files['ads.min.js']),prebidSha256:sha(bytes)};
    }
  }
}
await writeFile(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({prepared:true,runtime:descriptor.version,versions:Object.keys(pins),output:out}));
