import test from 'node:test';
import assert from 'node:assert/strict';
import * as frozen from '../../worker/runtime/prebid-artifact-check.mjs';
import {parsePrebidHeader,inspectPrebidArtifact,prebidRequirements,moduleReason,sha256,prebidFailureMessage} from '../../worker/runtime/prebid-artifact-check-v2.mjs';

const required=['consentManagementTcf','pubmaticBidAdapter','tcfControl'];
const extras=['33acrossBidAdapter','33acrossIdSystem','51DegreesRtdProvider','1plusXRtdProvider'];
const source=list=>`/* prebid.js v11.34.0\nModules: ${list.join(', ')} */\nthrow Error('Uploaded source must never execute');`;
async function fixture(list=[...required,...extras]) {
  const bytes=new TextEncoder().encode(source(list));
  const build={id:'original',publisher_id:'test-site',version:'11.34.0',status:'current',file_key:'publishers/test-site/prebid-builds/original/prebid.js',modules_json:JSON.stringify([...new Set(list)].sort())};
  const metadata={version:build.version,sha256:await sha256(bytes)};
  let reads=0;
  const object={size:bytes.length,customMetadata:metadata,arrayBuffer:async()=>bytes.slice().buffer};
  const bucket={get:async key=>{reads++;assert.equal(key,build.file_key);return object;},put:()=>assert.fail('Read-only check must not write'),delete:()=>assert.fail('Read-only check must not delete')};
  const args={siteId:'test-site',builds:[build],requirements:{required:true,modules:required,issues:[]}};
  return {args,build,metadata,object,bytes,bucket,reads:()=>reads,inspect:()=>inspectPrebidArtifact(args,bucket)};
}

test('admin checker accepts valid digit-leading names while frozen requirements and parser stay unchanged',async()=>{
  assert.equal(prebidRequirements,frozen.prebidRequirements);assert.equal(moduleReason,frozen.moduleReason);assert.equal(sha256,frozen.sha256);
  for(const module of extras){
    assert.throws(()=>frozen.parsePrebidHeader(source([...required,module])),/Invalid module declarations/);
    assert(parsePrebidHeader(source([...required,module])).modules.includes(module));
  }
  const f=await fixture(),report=await f.inspect();
  assert.equal(report.status,'checked');assert.equal(report.build.sha256,await sha256(f.bytes));assert.equal(f.reads(),1);
  assert.deepEqual(report.requiredModules,[...required].sort());assert.deepEqual(report.declaredModules,[...required,...extras].sort());
});
for(const name of ['<script>','bad module','bad-module','_module','', 'A'.repeat(121)])test('admin header rejects malformed module name: '+JSON.stringify(name),()=>{
  assert.throws(()=>parsePrebidHeader(source([...required,name])),/module name.*could not be read/);
});
test('extra modules never bypass TCF enforcement or checksum checks',async()=>{
  const missing=await fixture(['pubmaticBidAdapter',...extras]);
  const report=await missing.inspect();assert.equal(report.status,'blocked');assert.deepEqual(report.missingModules,['consentManagementTcf','tcfControl']);
  assert.match(prebidFailureMessage(report),/TCF consent enforcement/);
  const tampered=await fixture();tampered.metadata.sha256='0'.repeat(64);
  assert.equal((await tampered.inspect()).issues.at(-1).code,'checksum_mismatch');
});
test('malformed stored metadata is rejected before storage with an actionable redacted message',async()=>{
  const f=await fixture();f.build.modules_json=JSON.stringify(['<script>']);
  const report=await f.inspect();assert.equal(report.issues[0].code,'invalid_module_metadata');assert.equal(f.reads(),0);
  assert.match(prebidFailureMessage(report),/Stored Prebid module declarations are invalid/);
  assert.doesNotMatch(prebidFailureMessage(report),/<script>/);
});
