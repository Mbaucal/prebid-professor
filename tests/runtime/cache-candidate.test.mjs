import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {buildArtifactCandidate,runtimeDescriptor} from '../../worker/runtime-cache/artifact-candidate.mjs';
import {buildArtifactCandidate as previousBuild,runtimeDescriptor as previousDescriptor} from '../../worker/runtime-measured/artifact-candidate.mjs';
import {previewInput,PREBID_SHA256} from '../../worker/runtime-cache/snapshot.mjs';
import {prebidRequirements,inspectPrebidArtifact,parsePrebidHeader,sha256} from '../../worker/runtime/prebid-artifact-check.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {describeCandidate} from '../../worker/runtime/draft-release-store.mjs';
const timestamp='20260917_120000',pin=pinRuntime(runtimeDescriptor,{allowPreview:true});
const raw=await readFile('vendor/prebid/tanjug-11.34.0/prebid.js'),bytes=raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength);
function fixture(mode='auction-with-cache',legacyLazy=false,refresh=false){
  const s=positionFixture(true),c=JSON.parse(s.config.config_json);
  c.runtimeControls.bidCache={mode,maxAgeSeconds:30};c.runtimeControls.floors.currency='USD';
  s.bidders.push({bidder:'openx',params_json:'{"unit":"synthetic"}',enabled:1});
  if(legacyLazy)s.rules=s.rules.map(r=>({...r,rule_json:'{"timeout":300}'}));
  if(refresh)s.rules.push({rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{enabled:true,minSeconds:2,maxRefreshes:1,minViewPct:50}})});
  s.config.config_json=JSON.stringify(c);return s;
}
async function checked(snapshot){
  const header=parsePrebidHeader(raw.toString()),input=previewInput(snapshot,runtimeDescriptor,timestamp);
  const requirements=prebidRequirements(input,JSON.parse(snapshot.config.config_json));
  const report=await inspectPrebidArtifact({siteId:snapshot.site.id,requirements,
    builds:[{id:'pinned-cache-fixture',publisher_id:snapshot.site.id,status:'current',version:header.version,modules_json:JSON.stringify(header.modules),file_key:'publishers/'+snapshot.site.id+'/prebid-builds/pinned-cache-fixture/prebid.js'}]},
    {get:async()=>({size:bytes.byteLength,customMetadata:{version:header.version,sha256:PREBID_SHA256},arrayBuffer:async()=>bytes})});
  assert.equal(report.status,'checked',JSON.stringify(report));return {report,bytes};
}
test('new package independently pins actual Prebid bytes and saved cache rules, while old packages remain byte-identical',async()=>{
  const snapshot=fixture(),before=structuredClone(snapshot),prebid=await checked(snapshot);
  const args={snapshot,buildTimestamp:timestamp,prebid};
  const old=await previousBuild({...args,pin:pinRuntime(previousDescriptor,{allowPreview:true})});
  const candidate=await buildArtifactCandidate({...args,pin});
  const verified=await describeCandidate('test-site',candidate);
  assert.equal(verified.descriptor.runtime.runtimeVersion,'3.13.0');
  assert.equal(candidate.manifest.prebidBuild.sha256,PREBID_SHA256);
  assert.deepEqual(candidate.files['prebid.js'],new Uint8Array(bytes));
  const config=JSON.parse(new TextDecoder().decode(candidate.files['config.json']));assert.deepEqual(config.bidCache,{mode:'auction-with-cache',maxAgeSeconds:30});
  assert.deepEqual((await previousBuild({...args,pin:pinRuntime(previousDescriptor,{allowPreview:true})})).files,old.files);
  assert.deepEqual(snapshot,before);assert.deepEqual(await buildArtifactCandidate({...args,pin}),candidate);
  for(const [name,meta] of Object.entries(candidate.manifest.files))assert.equal(await sha256(candidate.files[name]),meta.sha256);
  await assert.rejects(buildArtifactCandidate({...args,pin:pinRuntime(previousDescriptor,{allowPreview:true})}),/Pinned runtime/);
});
test('another file claiming the same Prebid version cannot enter a cached package',async()=>{
  const snapshot=fixture(),prebid=await checked(snapshot),changed=bytes.slice(0);new Uint8Array(changed)[changed.byteLength-1]^=1;
  const report=structuredClone(prebid.report);report.build.sha256=await sha256(changed);
  await assert.rejects(buildArtifactCandidate({snapshot,pin,buildTimestamp:timestamp,prebid:{report,bytes:changed}}),/exact reviewed/);
});
test('emit exact packaged readable/minified scripts for native browser verification',async()=>{
  await mkdir('.generated/cache-package-evidence',{recursive:true});
  const metadata=[];
  for(const [name,mode,lazy,refresh] of [['cached','auction-with-cache',false,false],['fresh','fresh-only',false,false],['default-lazy','auction-with-cache',true,false],['refresh','auction-with-cache',false,true],['fresh-refresh','fresh-only',false,true]]){
    const snapshot=fixture(mode,lazy,refresh),candidate=await buildArtifactCandidate({snapshot,pin,buildTimestamp:timestamp,prebid:await checked(snapshot)});
    await writeFile('.generated/cache-package-evidence/'+name+'.js',candidate.files['ads.js']);
    await writeFile('.generated/cache-package-evidence/'+name+'.min.js',candidate.files['ads.min.js']);
    metadata.push({name,runtime:pin,prebidSha256:PREBID_SHA256,files:candidate.manifest.files});
  }
  await writeFile('.generated/cache-package-evidence/packages.json',JSON.stringify(metadata,null,2));
});
