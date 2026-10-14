import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeLabel,publicRuntimeHistory} from '../../src/site-workspace/runtime-labels.ts';

test('public version labels hide only known development suffixes and never mutate pins',()=>{
 for(const [input,output] of [['3.16.0','3.16.0'],['3.16.0-revenue.preview.3','3.16.0'],['3.10.0-tessera.preview.1','3.10.0'],['3.16.0-customer.preview.3','3.16.0-customer.preview.3'],['custom-revenue.preview.3','custom-revenue.preview.3'],['','Invalid saved version']])assert.equal(runtimeLabel(input),output);
 const pin=Object.freeze({runtimeVersion:'3.16.0-revenue.preview.3',runtimeSha256:'c257412bbcfa4e004a4e56dd320b4c043bdfc4b755bde7cdfa32b09ce4a189da'});
 assert.equal(runtimeLabel(pin.runtimeVersion),'3.16.0');assert.equal(pin.runtimeVersion,'3.16.0-revenue.preview.3');
});
test('public history groups known builds into one version and always prefers its stable record',()=>{
 const stable=Object.freeze({version:'3.16.0',codeSha256:'stable',title:'Tessera 3.16.0'}),preview1=Object.freeze({version:'3.16.0-revenue.preview.1',codeSha256:'old1'}),preview3=Object.freeze({version:'3.16.0-revenue.preview.3',codeSha256:'old3'}),older=Object.freeze({version:'3.14.0',codeSha256:'older'});
 for(const records of [[preview1,older,preview3,stable],[stable,preview1,preview3,older]]){
  const frozen=Object.freeze(records);const before=JSON.stringify(frozen),visible=publicRuntimeHistory(frozen);
  assert.equal(visible.filter(item=>runtimeLabel(item.version)==='3.16.0').length,1);
  assert.equal(visible.find(item=>runtimeLabel(item.version)==='3.16.0'),stable);
  assert(visible.includes(older));assert.equal(JSON.stringify(frozen),before);
 }
 const unknown=[{version:'3.16.0-other.preview.1'},{version:'3.16.0-other.preview.2'}];assert.deepEqual(publicRuntimeHistory(unknown),unknown);
});
