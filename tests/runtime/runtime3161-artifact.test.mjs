import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {fixture,configure} from './artifact-fixture.mjs';
import {descriptor as oldDescriptor} from '../../.generated/runtime-316-manifest.mjs';
import {descriptor} from '../../.generated/runtime-3161-manifest.mjs';
import {buildArtifactCandidate as oldCandidate} from '../../worker/runtime-316/artifact-candidate.mjs';
import {buildArtifactCandidate} from '../../worker/runtime-3161/artifact-candidate.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {describeCandidate} from '../../worker/runtime/draft-release-store.mjs';
import {runtimeCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const snapshot=()=>configure(fixture(),config=>config.enablePrebid=false);
const buildTimestamp='20261024_120000';

test('3.16.0 retains the exact complete GAM-only fixture bytes observed before this patch release',async()=>{
 const candidate=await oldCandidate({snapshot:snapshot(),pin:pinRuntime(oldDescriptor),buildTimestamp});
 const parts=Object.entries(candidate.files).sort(([a],[b])=>a.localeCompare(b)).map(([name,bytes])=>[name,hash(bytes)]);
 assert.equal(hash(JSON.stringify(parts)),'bd3665f6f0981faf0692ceb9cb175bf77af179a767036f4915e7c781abd9f35e');
});

test('3.16.1 is explicit, keeps historical catalog default, and creates a verifiable standalone package',async()=>{
 assert.equal(runtimeCatalog[0].id,'tessera-positions-preview-1');
 assert.equal(descriptor.id,'tessera-3.16.1');assert.equal(descriptor.version,'3.16.1');
 const saved=snapshot(),before=structuredClone(saved),pin=pinRuntime(descriptor);
 const candidate=await buildArtifactCandidate({snapshot:saved,pin,buildTimestamp});
 assert.deepEqual(saved,before);assert.deepEqual(candidate.manifest.runtime,pin);
 assert.equal(candidate.files['prebid.js'],undefined);
 for(const [name,entry]of Object.entries(candidate.manifest.files))assert.equal(hash(candidate.files[name]),entry.sha256);
 for(const name of ['ads.js','ads.min.js'])parse(new TextDecoder().decode(candidate.files[name]),{ecmaVersion:2015});
 assert.match(new TextDecoder().decode(candidate.files['README.txt']),/Fixed in 3\.16\.1/);
 const described=await describeCandidate(saved.site.id,candidate);
 assert.equal(described.descriptor.runtime.runtimeVersion,'3.16.1');
 assert(described.descriptor.files.some(file=>file.name==='deals-plan.json'));
});
