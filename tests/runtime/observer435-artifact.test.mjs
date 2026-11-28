import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inspectPrebidArtifact,parsePrebidHeader} from '../../worker/runtime/prebid-artifact-check-v2.mjs';
import {OBSERVER435_REPORTING_SOURCE,OBSERVER435_UPSTREAM,observer435Sha as sha,normalizeObserver435Banner,observer435BuildDate} from '../../scripts/observer435-patch.mjs';
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
  assert.equal(manifest.moduleSelection.kind,'explicit-module-profile');
  assert.equal(manifest.moduleSelection.inputSha256,sha(await readFile(new URL('prebid-config.json',folder))));
  assert.equal(bytes.length,manifest.byteSize);assert.equal(sha(bytes),manifest.buildSha256);
  assert.equal(manifest.buildSha256,'d58129a05e32ea325cbbb8bbf8531b4676b7df5ace5b32a3f8474beb8dff5889');
  assert.equal(manifest.executableBodySha256,'31964338d1f3e6c3f6c822747bbc97569e18ff2f52592570a545c0f8a2903ce3');
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
test('reviewed build date reproduces exact candidate bytes and records executable-body identity',()=>{
  const result=normalizeObserver435Banner(bytes,'2026-11-28');
  assert.deepEqual(result.bytes,bytes);assert.equal(result.buildDate,manifest.buildDate);assert.equal(result.upstreamBannerDate,manifest.upstreamBannerDate);
  assert.equal(result.executableBodySha256,manifest.executableBodySha256);
});
test('a different build date changes only the comment line, never the executable body',()=>{
  const result=normalizeObserver435Banner(bytes,'2026-11-29');
  assert.notEqual(sha(result.bytes),sha(bytes));assert.equal(result.executableBodySha256,manifest.executableBodySha256);
  assert.deepEqual(normalizeObserver435Banner(result.bytes,'2026-11-28').bytes,bytes);
});
test('invalid dates or an unknown banner fail closed',()=>{
  for(const value of ['2026-02-30','2026-11-28T00:00:00Z','yesterday','2026-1-1'])assert.throws(()=>observer435BuildDate(value));
  assert.throws(()=>normalizeObserver435Banner(Buffer.from('unknown source'),'2026-11-28'),/Unexpected upstream build banner/);
  assert.throws(()=>normalizeObserver435Banner(Buffer.concat([bytes,Buffer.from([255])]),'2026-11-28'));
});
