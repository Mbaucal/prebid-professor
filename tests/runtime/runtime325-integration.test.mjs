import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {execFileSync} from 'node:child_process';
import {runtimeCatalog,previewInput,buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
import {recommendedRuntimeRelease} from '../../shared/runtime-notices.mjs';
import {runtime325Source,sourceFiles} from '../../scripts/prepare-runtime325.mjs';
import {sourceFiles as inheritedFiles} from '../../scripts/prepare-runtime324.mjs';
import {prebidRequirements,inspectPrebidArtifact,sha256} from '../../worker/runtime/prebid-artifact-check-v2.mjs';
import {runtime324Site} from './runtime324-site.mjs';

const TS='20261117_120000',text=bytes=>new TextDecoder().decode(bytes);
const descriptor=runtimeCatalog.find(row=>row.id==='tessera-3.25.0');
const baseline=JSON.parse(execFileSync('git',['show','e859f58209846de0c7a0e0ace0f19a66ffaab7bf:worker/runtime/runtime-releases.json'],{encoding:'utf8'}));
async function build(snapshot) {
  const input=previewInput(snapshot,descriptor,TS);
  const requirements=prebidRequirements(input,JSON.parse(snapshot.config.config_json));
  assert.deepEqual(requirements.issues,[]);
  let prebid=null;
  if(requirements.required){
    const bytes=new TextEncoder().encode(`/* prebid.js v11.34.0\nModules: ${requirements.modules.join(', ')} */\nvoid 0;`).buffer;
    const build={id:'reporting',publisher_id:snapshot.site.id,status:'current',version:'11.34.0',file_key:`publishers/${snapshot.site.id}/prebid-builds/reporting/prebid.js`,modules_json:JSON.stringify(requirements.modules)};
    const object={size:bytes.byteLength,customMetadata:{sha256:await sha256(bytes),version:'11.34.0'},async arrayBuffer(){return bytes;}};
    const report=await inspectPrebidArtifact({siteId:snapshot.site.id,builds:[build],requirements},{async get(){return object;}});
    assert.equal(report.status,'checked');prebid={bytes,report};
  }
  return buildArtifactCandidate({snapshot,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:TS,prebid});
}

test('MAIN explicitly selects the new reporting source while preserving recommendation and inherited closure',async()=>{
  assert(descriptor);assert.equal(descriptor.channel,'preview');
  assert.throws(()=>pinRuntime(descriptor),/explicit opt-in/);
  assert.equal(recommendedRuntimeRelease(runtimeReleaseHistory).id,recommendedRuntimeRelease(baseline).id);
  for(const path of inheritedFiles)assert(sourceFiles.includes(path),path);
  for(const capability of runtimeCatalog.find(row=>row.version==='3.24.0').capabilities)
    assert(descriptor.capabilities.includes(capability),capability);
  assert(descriptor.capabilities.includes('gam-bid-origin'));
  assert(descriptor.capabilities.includes('gam-request-timing'));
  assert.equal((await runtime325Source(process.cwd())).codeSha256,descriptor.codeSha256);
});

for(const cache of [false,true])test(`selected reporting package retains combined settings and a verifiable contract (cache ${cache})`,async()=>{
  const snapshot=runtime324Site({cache}),before=structuredClone(snapshot),result=await build(snapshot);
  assert.deepEqual(snapshot,before);
  const config=JSON.parse(text(result.files['config.json']));
  assert.equal(config.runtime.runtimeVersion,'3.25.0');
  assert.equal(config.bidderRules.enabled,true);
  assert(config.bidderAccounts.some(row=>row.bidder==='pm_ag'&&row.schain.mode==='custom'));
  assert.equal(config.contextualSignals.enabled,true);
  const contract=JSON.parse(text(result.files['gam-reporting.json']));
  assert.deepEqual(contract.keys.aq_bid_origin.values,['fresh','cached','none']);
  assert.equal(contract.keys.aq_bid_origin.scope,'slot');
  for(const key of ['aq_first_request','aq_consent_wait'])assert.equal(contract.keys[key].scope,'page');
  assert(contract.keys.aq_consent_wait.values.includes('timeout'));
  assert(contract.keys.aq_consent_wait.values.includes('na'));
  for(const file of ['ads.js','ads.min.js'])assert.doesNotThrow(()=>parse(text(result.files[file]),{ecmaVersion:2015}));
  for(const [file,metadata]of Object.entries(result.manifest.files))assert.equal(await sha256(result.files[file]),metadata.sha256,file);
});

test('GAM-only still ships page timing without loading Prebid or an active cache',async()=>{
  const result=await build(runtime324Site({prebid:false}));
  assert.equal(result.files['prebid.js'],undefined);
  assert.equal(JSON.parse(text(result.files['config.json'])).bidCache,null);
  assert(text(result.files['ads.js']).includes('aq_first_request'));
});

test('the reporting registration retains all earlier release records exactly',async()=>{
  const oldIds=new Set(baseline.map(row=>row.id));
  assert.deepEqual(runtimeReleaseHistory.filter(row=>oldIds.has(row.id)),baseline);
  assert.equal(new Set(runtimeReleaseHistory.map(row=>row.id+'/'+row.version+'/'+row.codeSha256)).size,runtimeReleaseHistory.length);
  assert.equal(runtimeReleaseHistory.filter(row=>row.id===descriptor.id).length,1);
});
