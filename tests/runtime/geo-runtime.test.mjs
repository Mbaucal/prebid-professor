import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {conditionalFixture} from '../support/conditional-maps-fixture.mjs';
import {checkedFixture} from './artifact-fixture.mjs';
import {descriptor} from '../../.generated/runtime-318-manifest.mjs';
import {descriptor as previousDescriptor} from '../../.generated/runtime-317-manifest.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {previewInput,COUNTRY_ENDPOINTS} from '../../worker/runtime-318/snapshot.mjs';
import {buildArtifactCandidate} from '../../worker/runtime-318/artifact-candidate.mjs';
import {buildArtifactCandidate as previousCandidate} from '../../worker/runtime-317/artifact-candidate.mjs';
import {buildArtifactCandidate as catalogCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
const stamp='20261109_170000',decode=new TextDecoder();

test('country input is independent of future page values and does not mutate saved settings',()=>{
  const s=conditionalFixture(),before=structuredClone(s);
  const input=previewInput(s,descriptor,stamp);
  assert.deepEqual(s,before);
  assert.deepEqual(input.countrySignal,{version:1,endpoint:COUNTRY_ENDPOINTS.main,timeoutMs:1500,scope:'document',blocking:false,storage:'memory'});
  assert.equal(input.conditionalUnits.P2.rules[0].conditions[0].key,'category');
  assert.equal(previewInput(s,descriptor,stamp,undefined,'test').countrySignal.endpoint,COUNTRY_ENDPOINTS.test);
  assert.throws(()=>previewInput(s,descriptor,stamp,undefined,'https://arbitrary.invalid'),/Unknown country/);
});

for(const prebidEnabled of [false,true])test(`complete ${prebidEnabled?'Prebid':'GAM-only'} packages preserve maps and record the selected country service`,async()=>{
  const s=conditionalFixture({prebid:prebidEnabled}),pin=pinRuntime(descriptor);
  const check=structuredClone(s);check.rules=[];
  const prebid=prebidEnabled?await checkedFixture(check):null;
  for(const countryTarget of ['main','test']){
    const args={snapshot:s,pin,prebid,buildTimestamp:stamp,countryTarget};
    const result=await buildArtifactCandidate(args),throughCatalog=await catalogCandidate(args);
    assert.deepEqual(result.manifest,throughCatalog.manifest);
    const config=JSON.parse(decode.decode(result.files['config.json']));
    assert.equal(config.runtime.runtimeVersion,'3.18.0');
    assert.equal(config.countrySignal.endpoint,COUNTRY_ENDPOINTS[countryTarget]);
    assert.equal(config.conditionalUnits.P2.rules[0].sizeMapKey,'naslovna_P2');
    for(const name of ['ads.js','ads.min.js']){
      const source=decode.decode(result.files[name]);parse(source,{ecmaVersion:2015});
      assert(source.includes(COUNTRY_ENDPOINTS[countryTarget]));
      assert(!source.includes(COUNTRY_ENDPOINTS[countryTarget==='main'?'test':'main']));
      assert(source.includes('__AD_GEO'));assert(!source.includes('__COUNTRY_ENDPOINT__'));
      assert(!source.includes('createCountrySignal.toString'));
    }
    assert(decode.decode(result.files['README.txt']).includes('Country recognition in 3.18.0'));
    for(const [name,entry] of Object.entries(result.manifest.files))assert.equal(createHash('sha256').update(result.files[name]).digest('hex'),entry.sha256);
  }
});

test('choosing 3.17 retains its exact identity and never adds country requests',async()=>{
  assert.equal(previousDescriptor.codeSha256,'1082c1c4c6803852687c80827c9fa23ad952fa2fc09d8f5379111bf109e9f51d');
  const result=await previousCandidate({snapshot:conditionalFixture(),pin:pinRuntime(previousDescriptor),buildTimestamp:stamp});
  for(const name of ['ads.js','ads.min.js'])assert(!decode.decode(result.files[name]).includes('__AD_GEO'));
  assert.equal(JSON.parse(decode.decode(result.files['config.json'])).countrySignal,undefined);
});
