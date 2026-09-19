import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createMeasurement} from '../../worker/runtime-measured/targeting.mjs';
const version='3.12.0-tessera.preview.1';
function fixture(patch={},statePatch={}) {
 const context={profile:'experiment-preview-v1',siteId:'test-site',runtimeVersion:version,active:true,variant:'A',experimentId:'experiment-test',revision:1,deliverySha256:'a'.repeat(64),packageSha256:'b'.repeat(64),...patch};
 const window={__tesseraExperimentOwner:'test-site',__tesseraExperiments:{'test-site':{context,status:'loading',...statePatch}}};
 const apply=vm.runInNewContext('('+createMeasurement.toString()+')("test-site",'+JSON.stringify(version)+')',{window});
 const slot={targeting:{hb_bidder:'existing'},setConfig(c){Object.assign(this.targeting,c.targeting);}};
 return {window,context,apply,slot,snapshot:()=>window.__tesseraGamMeasurement['test-site'].snapshot()};
}
test('A and B get distinct short delivery labels without replacing bid targeting',()=>{
 for(const variant of ['A','B']) {
  const f=fixture({variant});f.apply(f.slot);f.apply(f.slot);
  assert.equal(f.slot.targeting.tessera_ab,'d'+'a'.repeat(32)+'_'+variant.toLowerCase());
  assert.equal(f.slot.targeting.hb_bidder,'existing');assert.equal(f.snapshot().appliedSlots,1);
  assert.equal(f.snapshot().value.length,35);
 }
});
test('inactive, absent, mismatched and conflicting loader contexts never tag slots',()=>{
 for(const patch of [{active:false},{variant:'C'},{runtimeVersion:'3.11.0'},{siteId:'foreign'},{profile:'other'},{revision:0},{deliverySha256:'bad'},{experimentId:'bad value'},{packageSha256:null}]) {
  const f=fixture(patch);f.apply(f.slot);assert.equal(f.slot.targeting.tessera_ab,undefined);
 }
 for(const status of ['conflict','load-error']) {const f=fixture({}, {status});f.apply(f.slot);assert.equal(f.snapshot().appliedSlots,0);}
 const window={};const apply=vm.runInNewContext('('+createMeasurement.toString()+')("test-site","'+version+'")',{window});
 assert.doesNotThrow(()=>apply({}));
});
test('assignment is frozen for this page; a new delivery produces another reporting pair',()=>{
 const f=fixture();f.context.variant='B';f.context.deliverySha256='c'.repeat(64);f.apply(f.slot);
 assert.equal(f.slot.targeting.tessera_ab,'d'+'a'.repeat(32)+'_a');
 const snapshot=f.snapshot();snapshot.identity.variant='B';assert.equal(f.snapshot().identity.variant,'A');
 const next=fixture({deliverySha256:'c'.repeat(64)});next.apply(next.slot);assert.notEqual(next.snapshot().value,f.snapshot().value);
});
test('GPT errors are counted locally and do not break existing ad flow',()=>{
 const f=fixture();assert.doesNotThrow(()=>f.apply({setConfig(){throw Error('mock');}}));assert.equal(f.snapshot().failedSlots,1);
});
