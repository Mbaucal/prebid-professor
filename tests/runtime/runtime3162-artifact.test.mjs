import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {fixture,configure} from './artifact-fixture.mjs';
import {descriptor as previousDescriptor} from '../../.generated/runtime-3161-manifest.mjs';
import {descriptor} from '../../.generated/runtime-3162-manifest.mjs';
import {buildArtifactCandidate as previousCandidate} from '../../worker/runtime-3161/artifact-candidate.mjs';
import {buildArtifactCandidate} from '../../worker/runtime-3162/artifact-candidate.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {describeCandidate} from '../../worker/runtime/draft-release-store.mjs';
import {runtimeCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const snapshot=()=>configure(fixture(),config=>config.enablePrebid=false);
const buildTimestamp='20261024_120000';

test('3.16.1 retains the exact complete GAM-only fixture bytes after 3.16.2 is added',async()=>{
 const candidate=await previousCandidate({snapshot:snapshot(),pin:pinRuntime(previousDescriptor),buildTimestamp});
 const parts=Object.entries(candidate.files).sort(([a],[b])=>a.localeCompare(b)).map(([name,bytes])=>[name,hash(bytes)]);
 assert.equal(hash(JSON.stringify(parts)),'ccdbce5bd40cc86ce7d4580e02bd4c64146d2520260419e17d5e8ebd15afebb2');
 assert.equal(previousDescriptor.codeSha256,'2a7feef5b88968d756bb60421c714ba9e47f782aec90c42b402029c65eb7c25b');
});

test('3.16.2 is an explicit preview, keeps the stable recommendation and builds a verifiable package',async()=>{
 assert.equal(runtimeCatalog[0].id,'tessera-positions-preview-1');
 assert.equal(descriptor.id,'tessera-3.16.2');assert.equal(descriptor.version,'3.16.2');assert.equal(descriptor.channel,'preview');
 assert.deepEqual([...descriptor.capabilities],[...previousDescriptor.capabilities]);
 assert.equal(runtimeReleaseHistory.find(r=>r.channel==='stable').id,'tessera-3.16.1');
 assert(runtimeCatalog.some(r=>r.id==='tessera-3.16.2'&&r.codeSha256===descriptor.codeSha256));
 assert.throws(()=>pinRuntime(descriptor),/explicit opt-in/);
 const saved=snapshot(),before=structuredClone(saved),pin=pinRuntime(descriptor,{allowPreview:true});
 const candidate=await buildArtifactCandidate({snapshot:saved,pin,buildTimestamp});
 assert.deepEqual(saved,before);assert.deepEqual(candidate.manifest.runtime,pin);
 assert.equal(candidate.files['prebid.js'],undefined);
 for(const [name,entry]of Object.entries(candidate.manifest.files))assert.equal(hash(candidate.files[name]),entry.sha256);
 for(const name of ['ads.js','ads.min.js']){
  const code=new TextDecoder().decode(candidate.files[name]);parse(code,{ecmaVersion:2015});
  assert(code.includes('"tessera-3.16.2"'));assert(code.includes('tesseraDeferStickyEmptyRetry'));
 }
 const readme=new TextDecoder().decode(candidate.files['README.txt']);
 assert.match(readme,/^Tessera 3\.16\.2\n/);assert.match(readme,/Fixed in 3\.16\.1[\s\S]*Fixed in 3\.16\.2/);assert.match(readme,/Runtime: 3\.16\.2\n/);
 assert(candidate.manifest.patches.some(item=>item.startsWith('3.16.2:')));
 const described=await describeCandidate(saved.site.id,candidate);
 assert.equal(described.descriptor.runtime.runtimeVersion,'3.16.2');
 assert(described.descriptor.files.some(file=>file.name==='deals-plan.json'));
 await assert.rejects(buildArtifactCandidate({snapshot:snapshot(),pin:pinRuntime(previousDescriptor),buildTimestamp}));
});
