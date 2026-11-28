import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inspectPrebidArtifact,parsePrebidHeader} from '../../worker/runtime/prebid-artifact-check-v2.mjs';
import {OBSERVER435_REPORTING_SOURCE,OBSERVER435_UPSTREAM,observer435Sha as sha} from '../../scripts/observer435-patch.mjs';
const folder=new URL('../../vendor/prebid/observer-lifecycle-11.34.0-tessera-1/',import.meta.url);
const bytes=await readFile(new URL('prebid.js',folder)),manifest=JSON.parse(await readFile(new URL('manifest.json',folder),'utf8'));
const config=JSON.parse(await readFile(new URL('prebid-config.json',folder),'utf8'));
function fixture({body=bytes,status='current',modules=config.modules}={}){
  const siteId='observer-candidate',id='candidate';
  return{siteId,builds:[{id,publisher_id:siteId,status,version:config.version,file_key:`publishers/${siteId}/prebid-builds/${id}/observer-fixed.js`,modules_json:JSON.stringify(modules)}],
    requirements:{required:true,modules:['consentManagementTcf','tcfControl','pubmaticBidAdapter'],issues:[]},
    bucket:{get:async()=>({size:body.length,customMetadata:{version:config.version,sha256:manifest.buildSha256},arrayBuffer:async()=>body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength)})}};
}
test('candidate pins its exact upstream lock, source patch, compiled renderers and content identity',async()=>{
  assert.equal(config.version,OBSERVER435_UPSTREAM.version);assert.equal(manifest.sourceCommit,OBSERVER435_UPSTREAM.commit);
  assert.equal(manifest.upstreamLockSha256,OBSERVER435_UPSTREAM.lockSha256);assert.equal(manifest.variant,'tessera-observer-lifecycle-1');
  assert.equal(manifest.moduleSelection.kind,'reviewed-tanjug-derived-profile');
  assert.equal(manifest.moduleSelection.inputSha256,sha(await readFile(new URL('../../vendor/prebid/tanjug-11.34.0/prebid-config.json',import.meta.url))));
  assert.equal(bytes.length,manifest.byteSize);assert.equal(sha(bytes),manifest.buildSha256);
  assert.deepEqual(parsePrebidHeader(bytes.toString().slice(0,500000)),{version:config.version,modules:config.modules});
  assert.equal(sha(await readFile(new URL('observer-lifecycle.patch',folder))),manifest.patchSha256);
  assert.equal(manifest.patches.find(row=>row.name==='creative/reporting.js').afterSha256,sha(OBSERVER435_REPORTING_SOURCE));
  for(const renderer of ['display','native'])assert.equal(sha(await readFile(new URL(`renderer-${renderer}.js`,folder))),manifest.rendererSha256[renderer]);
  assert(!config.modules.includes('contextualAuditRtdProvider'));assert.equal(config.modules.length,20);
});
test('existing byte/module inspection accepts an explicitly selected compatible candidate',async()=>{
  const f=fixture(),result=await inspectPrebidArtifact(f,f.bucket);
  assert.equal(result.status,'checked');assert.equal(result.build.sha256,manifest.buildSha256);assert.deepEqual(result.missingModules,[]);
});
test('changed candidate bytes remain blocked by the normal checksum gate',async()=>{
  const f=fixture({body:Buffer.concat([bytes,Buffer.from('\n// changed')])}),result=await inspectPrebidArtifact(f,f.bucket);
  assert.equal(result.status,'blocked');assert(result.issues.some(row=>row.code==='checksum_mismatch'));
});
test('the Tanjug-derived profile cannot silently satisfy another site missing required adapters',async()=>{
  const f=fixture();f.requirements.modules.push('connectadBidAdapter','smartadserverBidAdapter');
  const result=await inspectPrebidArtifact(f,f.bucket);
  assert.equal(result.status,'blocked');assert.deepEqual(result.missingModules,['connectadBidAdapter','smartadserverBidAdapter']);
});
test('an archived upload is not mistaken for explicit current selection',async()=>{
  const f=fixture({status:'archived'}),result=await inspectPrebidArtifact(f,f.bucket);
  assert.equal(result.status,'blocked');assert(result.issues.some(row=>row.code==='build_site_mismatch'));
});
test('the existing frozen11.34 vendor bytes keep their original identity',async()=>{
  const frozen=await readFile(new URL('../../vendor/prebid/tanjug-11.34.0/prebid.js',import.meta.url));
  assert.equal(sha(frozen),'384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b');
  assert.notEqual(sha(frozen),manifest.buildSha256);
});
