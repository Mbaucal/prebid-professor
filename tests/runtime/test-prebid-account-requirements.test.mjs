import test from 'node:test';
import assert from 'node:assert/strict';
import {prebidRequirements, moduleReason} from '../../worker/test-workspace/prebid-requirements.mjs';
import {prebidRequirements as frozenDemandRequirements} from '../../worker/runtime-demand-v1/requirements.mjs';
const input=()=>({core:{bidders:[{bidder:'rubicon'}],userSync:{userIds:[]}},options:{enablePrebid:true},demandSignals:{enabled:true}});
test('TEST demand-preview module requirements remain exact without account settings',()=>{
  const value=input();assert.deepEqual(prebidRequirements(value),frozenDemandRequirements(value));
  assert(prebidRequirements(value).modules.includes('gptPreAuction'));
  assert(prebidRequirements(value).modules.includes('rubiconBidAdapter'));
  assert.equal(moduleReason('gptPreAuction'),'Stable GPID and GAM slot identity');
});
test('TEST account planning maps exact aliases once and retains GPID demand requirement',()=>{
  const value=input();value.core.bidders=[{bidder:'adf_smn'},{bidder:'adf_ag'}];
  value.bidderAccounts=value.core.bidders.map(row=>({...row,baseAdapter:'adf',schain:{mode:row.bidder==='adf_ag'?'none':'inherit'}}));
  const before=JSON.stringify(value),result=prebidRequirements(value);
  assert.deepEqual(result.issues,[]);assert.deepEqual(result.modules,['adfBidAdapter','consentManagementTcf','gptPreAuction','tcfControl']);
  assert.equal(JSON.stringify(value),before);
});
