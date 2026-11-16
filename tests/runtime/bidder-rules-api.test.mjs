import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {getBidderRuleSettings,bidderRuleSettingsResponse} from '../../worker/site-runtime/bidder-rule-settings.mjs';
const fixtures=[];
const fixture=options=>{const f=adminAuditStore(options);fixtures.push(f);return f;};
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
const url='https://fixture.invalid/api/publishers/audit-site/bidder-rules';
const request=(body,options={})=>new Request(url,{method:'POST',headers:{'content-type':'application/json',...options.headers},body:typeof body==='string'?body:JSON.stringify(body),...options});
const settings=()=>({schemaVersion:1,enabled:true,rules:[{id:'rs',name:'Serbia',enabled:true,bidder:'pubmatic',positions:['P1'],countries:{mode:'include',values:['RS'],unknown:'skip'},devices:['mobile','tablet','desktop']}]});
const post=(f,body,options)=>bidderRuleSettingsResponse(request(body,options),f.env,'audit-site','admin@example.invalid');

test('default is off and GET is site scoped without requiring a visitor country',async()=>{
  const f=fixture(),data=await getBidderRuleSettings(f.env,'audit-site');
  assert.deepEqual(data.settings,{schemaVersion:1,enabled:false,rules:[]});assert.equal(data.runtimeEligible,false);
  assert.deepEqual(data.bidders,[{bidder:'pubmatic',enabled:true,configured:true}]);
  assert.deepEqual(data.positions,[{code:'P1',enabled:true,configured:true}]);assert.equal(data.published,false);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) count FROM audit_log').get().count,0);
});
test('save/reload preserve SChain, contextual signals, consent, parameters and selected script',async()=>{
  const f=fixture({config:{enablePrebid:true,schain:{config:{ver:'1.0',nodes:[{asi:'example.invalid',sid:'12',hp:1}]}},consentManagement:{gdpr:{cmpApi:'iab'}},runtimeControls:{sticky:{bottomAdUnitId:'P1'},contextualSignals:{enabled:false},output:{cleanComments:false}},builtinRuntimeSelection:{runtime:{runtimeVersion:'3.21.0',runtimeId:'tessera-3.21.0'}}}});
  const before=f.readConfig(),state=await getBidderRuleSettings(f.env,'audit-site'),response=await post(f,{revision:state.revision,settings:settings()});
  assert.equal(response.status,200,await response.clone().text());
  const result=await response.json();assert.deepEqual(result,await getBidderRuleSettings(f.env,'audit-site'));assert.notEqual(result.revision,state.revision);
  const after=f.readConfig();for(const key of ['schain','consentManagement','builtinRuntimeSelection'])assert.deepEqual(after[key],before[key]);
  for(const key of ['sticky','contextualSignals','output'])assert.deepEqual(after.runtimeControls[key],before.runtimeControls[key]);
  assert.equal(result.settings.enabled,true);assert.equal(result.runtimeEligible,false);
  assert.equal(f.sqlite.prepare('SELECT params_json FROM bidders').get().params_json,'{}');assert.equal(f.log.puts.length,0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) count FROM audit_log WHERE action='bidder_rules.saved'").get().count,1);
});
test('stale revisions cannot overwrite changed settings; reload enables retry',async()=>{
  const f=fixture(),state=await getBidderRuleSettings(f.env,'audit-site');
  assert.equal((await post(f,{revision:state.revision,settings:settings()})).status,200);
  const before=f.readConfig(),changed=settings();changed.rules[0].countries.values=['DE'];
  assert.equal((await post(f,{revision:state.revision,settings:changed})).status,409);assert.deepEqual(f.readConfig(),before);
  const fresh=await getBidderRuleSettings(f.env,'audit-site');assert.equal((await post(f,{revision:fresh.revision,settings:changed})).status,200);
  assert.deepEqual(f.readConfig().runtimeControls.bidderRules.rules[0].countries.values,['DE']);
});
test('invalid policies fail before writes and deleted bidders/positions remain visible',async()=>{
  const f=fixture(),state=await getBidderRuleSettings(f.env,'audit-site');
  for(const patch of [{devices:[]},{countries:{mode:'include',values:['ZZ'],unknown:'skip'}},{positions:['/bad-position']},{bidder:'bad bidder'}]){
    const value=settings();Object.assign(value.rules[0],patch);
    const response=await post(f,{revision:state.revision,settings:value});assert.equal(response.status,422,await response.clone().text());
  }
  assert.equal(f.readConfig().runtimeControls.bidderRules,undefined);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) count FROM audit_log').get().count,0);
  const value=settings();value.rules[0].bidder='deletedAlias';value.rules[0].positions=['m.box_1'];
  const response=await post(f,{revision:state.revision,settings:value});assert.equal(response.status,200);
  const data=await response.json();assert.deepEqual(data.settings,value);
  assert.deepEqual(data.bidders.find(b=>b.bidder==='deletedAlias'),{bidder:'deletedAlias',enabled:false,configured:false});
  assert.deepEqual(data.positions.find(p=>p.code==='m.box_1'),{code:'m.box_1',enabled:false,configured:false});
});
test('method, JSON and size errors and missing sites do not mutate settings',async()=>{
  const f=fixture();assert.equal((await post(f,'{broken')).status,400);assert.equal((await post(f,'text',{headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await post(f,' '.repeat(131073))).status,413);
  assert.equal((await bidderRuleSettingsResponse(new Request(url,{method:'DELETE'}),f.env,'audit-site','admin')).status,405);
  assert.equal((await bidderRuleSettingsResponse(new Request(url),f.env,'not-found','admin')).status,404);
  assert.equal((await bidderRuleSettingsResponse(new Request(url),f.env,'INVALID','admin')).status,400);
  assert.equal(f.log.batches,0);
});
test('failed transaction is recoverable without losing settings',async()=>{
  const f=fixture(),state=await getBidderRuleSettings(f.env,'audit-site'),before=f.readConfig(),batch=f.env.DB.batch;
  f.env.DB.batch=async()=>{throw Error('synthetic failure');};
  assert.equal((await post(f,{revision:state.revision,settings:settings()})).status,503);assert.deepEqual(f.readConfig(),before);
  f.env.DB.batch=batch;assert.equal((await post(f,{revision:state.revision,settings:settings()})).status,200);
});
