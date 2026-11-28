import test from 'node:test';
import assert from 'node:assert/strict';
import {bidderAccountsForBuild} from '../../shared/bidder-accounts/snapshot.mjs';
import {requireBidderAccounts} from '../../worker/site-runtime/bidder-account-settings.mjs';
import {prebidRequirements} from '../../worker/runtime/prebid-artifact-check-v2.mjs';
import {normalizeDeals} from '../../shared/bidder-accounts/deals.mjs';
import {scriptVersionText} from '../../worker/site-runtime/script-version-guidance.mjs';
const row=(bidder, metadata={}, enabled=1)=>({bidder,params_json:'{"mid":123}',account_json:JSON.stringify(metadata),enabled});
const snapshot=bidders=>({site:{id:'sample'},config:{config_json:JSON.stringify({enablePrebid:true})},bidders});
const input=accounts=>({core:{bidders:accounts.map(account=>({bidder:account.bidder,params:{mid:123}})),userSync:{userIds:[]}},options:{enablePrebid:true},bidderAccounts:accounts});
test('accounts resolve one base-adapter module; no alias-named modules',()=>{
 const saved=snapshot([row('adf_smn',{baseAdapter:'adf'}),row('adf_ag',{baseAdapter:'adf',schain:{mode:'none'}})]);
 const accounts=bidderAccountsForBuild(saved),requirements=prebidRequirements(input(accounts));
 assert.deepEqual(requirements.issues,[]);assert.deepEqual(requirements.modules,['adfBidAdapter','consentManagementTcf','tcfControl']);
 assert.equal(accounts[1].schain.mode,'none');assert.equal(saved.bidders[1].bidder,'adf_ag');
});
test('only active new account behavior requires explicit capable version',()=>{
 assert.doesNotThrow(()=>requireBidderAccounts(snapshot([row('openx')]),{capabilities:[]}));
 assert.doesNotThrow(()=>requireBidderAccounts(snapshot([row('adf_ag',{baseAdapter:'adf'},0)]),{capabilities:[]}));
 assert.throws(()=>requireBidderAccounts(snapshot([row('adf_ag',{baseAdapter:'adf'})]),{capabilities:[]}),{status:422,message:`This script cannot apply bidder accounts (adf_ag). Select ${scriptVersionText(['bidder-accounts'])} in Script setup and save. Your saved settings and previous packages are unchanged.`});
 assert.doesNotThrow(()=>requireBidderAccounts(snapshot([row('adf_ag',{baseAdapter:'adf'})]),{capabilities:['bidder-accounts']}));
 const off=snapshot([row('adf_ag',{baseAdapter:'adf'})]);off.config.config_json='{"enablePrebid":false}';assert.deepEqual(bidderAccountsForBuild(off),[]);
});
test('corrupt account data cannot silently inherit the site chain',()=>{
 const saved=snapshot([row('adf_ag')]);saved.bidders[0].account_json='{broken';assert.throws(()=>bidderAccountsForBuild(saved),/account settings contain invalid JSON/);
 const missing=input([]);missing.core.bidders=[{bidder:'adf_ag'}];assert.equal(prebidRequirements(missing).issues[0].code,'missing_bidder_account');
});
test('two accounts of one adapter retain independent deal identity',()=>{
 const bidders=[row('adf_smn',{baseAdapter:'adf'}),row('adf_ag',{baseAdapter:'adf',schain:{mode:'none'}})];
 const deal=(id,bidder)=>({id,name:id,bidder,dealId:id,positions:[],startsAt:'2026-11-15T00:00:00.000Z',endsAt:'2026-11-16T00:00:00.000Z',enabled:true,mode:'price'});
 const settings=normalizeDeals({schemaVersion:1,entries:[deal('first','adf_smn'),deal('second','adf_ag')]},{bidders,units:[]});
 assert.deepEqual(settings.entries.map(entry=>entry.bidder),['adf_smn','adf_ag']);
 assert.throws(()=>normalizeDeals({schemaVersion:1,entries:[deal('first','adf_ag'),deal('second','adf_ag')]},{bidders,units:[]}),/cannot overlap/);
});
