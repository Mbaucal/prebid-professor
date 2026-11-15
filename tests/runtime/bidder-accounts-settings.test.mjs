import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAccountSchain, normalizeBidderAccount, normalizeBidderAccounts} from '../../shared/bidder-accounts/settings.mjs';
const chain = () => ({ver:'1.0', complete:1, nodes:[{asi:'seller.invalid',sid:'001',hp:1}]});
test('legacy account defaults preserve exact identity; two accounts keep separate settings', () => {
  assert.deepEqual(normalizeBidderAccount({}, {bidder:'adf'}), {bidder:'adf',baseAdapter:'adf',displayName:'',schain:{mode:'inherit'}});
  const config = chain();
  const accounts = normalizeBidderAccounts([{bidder:'adf_smn',baseAdapter:'adf',schain:{mode:'custom',config}}, {bidder:'adf_ag',baseAdapter:'adf',schain:{mode:'none'}}]);
  assert.equal(accounts[0].schain.config.nodes[0].sid,'001'); assert.equal(accounts[1].schain.mode,'none');
  config.nodes[0].sid='changed'; assert.equal(accounts[0].schain.config.nodes[0].sid,'001');
});
test('custom chain values survive mode changes but custom requires explicit valid nodes', () => {
  assert.deepEqual(normalizeBidderAccount({schain:{mode:'inherit',config:chain()}},{bidder:'ix'}).schain.config,chain());
  for (const config of [{}, {...chain(),nodes:[]}, {...chain(),nodes:[{asi:'https://seller.invalid',sid:'1',hp:1}]}, {...chain(),nodes:[{asi:'seller.invalid',sid:'1',hp:0}]}, {...chain(),nodes:[{asi:'seller.invalid',sid:'1',hp:1,domain:'https://publisher.invalid'}]}]) {
    assert.throws(() => normalizeAccountSchain(config), error => error.status===422);
  }
  assert.throws(() => normalizeBidderAccount({schain:{mode:'custom'}},{bidder:'ix'}),/custom SChain/);
});
test('reject ambiguous aliases, reserved object keys, duplicate accounts and identity drift', () => {
  assert.throws(() => normalizeBidderAccounts([{bidder:'one',baseAdapter:'adf'},{bidder:'two',baseAdapter:'one'}]),/original base adapter/);
  assert.throws(() => normalizeBidderAccounts([{bidder:'adf'},{bidder:'adf'}]),/duplicated/);
  assert.throws(() => normalizeBidderAccount({}, {bidder:'constructor'}),/lower-case/);
  assert.throws(() => normalizeBidderAccount({bidder:'adf_ag'},{bidder:'adf_smn'}),/identity/);
  assert.throws(() => normalizeAccountSchain({...chain(),ext:JSON.parse('{"__proto__":{"polluted":true}}')}),/reserved/);
});
