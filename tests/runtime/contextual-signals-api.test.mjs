import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {getContextualSignalSettings,contextualSignalSettingsResponse} from '../../worker/site-runtime/contextual-signals-settings.mjs';

const fixtures=[];
const fixture=options=>{const f=adminAuditStore(options);fixtures.push(f);return f;};
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
const url='https://fixture.invalid/api/publishers/audit-site/contextual-signals';
const request=(body,options={})=>new Request(url,{method:'POST',headers:{'content-type':'application/json',...options.headers},body:typeof body==='string'?body:JSON.stringify(body),...options});
const settings=()=>({schemaVersion:1,enabled:true,sourceKey:'category',gam:{enabled:true},bidders:[{bidder:'pubmatic',taxonomy:'iab-content-2.2'}],mappings:[{value:'Books',taxonomies:{'iab-content-2.2':['48'],'iab-content-3.0':[]}}]});
const post=(f,body,options)=>contextualSignalSettingsResponse(request(body,options),f.env,'audit-site','admin@example.invalid');

test('default is off; metadata is site scoped and does not require future page categories',async()=>{
  const f=fixture();const data=await getContextualSignalSettings(f.env,'audit-site');
  assert.equal(data.settings.enabled,false);assert.equal(data.settings.gam.enabled,false);assert.deepEqual(data.settings.bidders,[]);
  assert.equal(data.settings.sourceKey,'category');assert.equal(data.runtimeEligible,false);assert.equal(data.prebidVersion,'11.34.0');
  assert.deepEqual(data.bidders,[{bidder:'pubmatic',enabled:true,configured:true}]);
  assert.deepEqual(data.taxonomies.map(row=>[row.id,row.segtax]),[['iab-content-2.2',6],['iab-content-3.0',7]]);
  assert.equal(data.published,false);assert.equal(f.sqlite.prepare('SELECT COUNT(*) count FROM audit_log').get().count,0);
  assert.equal(data.prebidIntegration.status,'modules-missing');
  assert.deepEqual(data.prebidIntegration.missingModules,['rtdModule','contextualSignalsRtdProvider']);
});

test('current build module status changes on upload without changing contextual settings',async()=>{
  const f=fixture(),before=f.readConfig();
  f.sqlite.prepare('UPDATE prebid_builds SET modules_json=?').run(JSON.stringify(['pubmaticBidAdapter','rtdModule','contextualSignalsRtdProvider']));
  const present=await getContextualSignalSettings(f.env,'audit-site');
  assert.equal(present.prebidIntegration.status,'modules-present');assert.deepEqual(present.prebidIntegration.missingModules,[]);
  f.sqlite.prepare('UPDATE prebid_builds SET modules_json=?').run('{broken');
  assert.equal((await getContextualSignalSettings(f.env,'audit-site')).prebidIntegration.status,'unknown');
  assert.deepEqual(f.readConfig(),before);assert.equal(f.sqlite.prepare('SELECT COUNT(*) count FROM audit_log').get().count,0);
});

test('save and reload preserve unrelated config, bidder params and script selection',async()=>{
  const f=fixture({config:{enablePrebid:true,schain:{config:{ver:'1.0',nodes:[{asi:'example.invalid',sid:'12',hp:1}]}},runtimeControls:{sticky:{bottomAdUnitId:'P1'},output:{cleanComments:false}},builtinRuntimeSelection:{runtime:{runtimeVersion:'3.20.1',runtimeId:'tessera-3.20.1'}}}});
  const before=f.readConfig(),state=await getContextualSignalSettings(f.env,'audit-site');
  const response=await post(f,{revision:state.revision,settings:settings()});
  assert.equal(response.status,200,await response.clone().text());
  const result=await response.json(),reloaded=await getContextualSignalSettings(f.env,'audit-site');
  assert.deepEqual(result,reloaded);assert.notEqual(result.revision,state.revision);assert.equal(result.runtimeEligible,false);
  assert.equal(result.settings.enabled,true);assert.equal(result.settings.mappings[0].value,'Books');
  const after=f.readConfig();assert.deepEqual(after.schain,before.schain);assert.deepEqual(after.builtinRuntimeSelection,before.builtinRuntimeSelection);
  assert.deepEqual(after.runtimeControls.sticky,before.runtimeControls.sticky);assert.deepEqual(after.runtimeControls.output,before.runtimeControls.output);
  assert.equal(f.sqlite.prepare('SELECT params_json FROM bidders').get().params_json,'{}');assert.equal(f.log.puts.length,0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) count FROM audit_log WHERE action='contextual_signals.saved'").get().count,1);
});

test('stale tab fails without overwriting new settings and reload enables retry',async()=>{
  const f=fixture(),state=await getContextualSignalSettings(f.env,'audit-site');
  const first=await post(f,{revision:state.revision,settings:settings()});assert.equal(first.status,200);
  const before=f.readConfig();const changed=settings();changed.sourceKey='section';
  const stale=await post(f,{revision:state.revision,settings:changed});assert.equal(stale.status,409);assert.deepEqual(f.readConfig(),before);
  const fresh=await getContextualSignalSettings(f.env,'audit-site');assert.equal((await post(f,{revision:fresh.revision,settings:changed})).status,200);
  assert.equal(f.readConfig().runtimeControls.contextualSignals.sourceKey,'section');
});

test('invalid taxonomy IDs, routes and extra properties fail before writes',async()=>{
  const f=fixture(),state=await getContextualSignalSettings(f.env,'audit-site');
  const badId=settings();badId.mappings[0].taxonomies['iab-content-2.2']=['IAB17'];
  const wrongVersion=settings();wrongVersion.bidders[0].taxonomy='IAB_CONTENT_9_9';
  const invalidBidder=settings();invalidBidder.bidders[0].bidder='bad bidder name';
  for(const value of [badId,wrongVersion,invalidBidder]){const response=await post(f,{revision:state.revision,settings:value});assert.equal(response.status,422,await response.clone().text());}
  assert.equal((await post(f,{revision:state.revision,settings:settings(),published:true})).status,422);assert.equal(f.readConfig().runtimeControls.contextualSignals,undefined);assert.equal(f.sqlite.prepare('SELECT COUNT(*) count FROM audit_log').get().count,0);
});

test('removed bidder routes remain visible for editing rather than silently disappearing',async()=>{
  const value=settings();value.bidders.push({bidder:'removed',taxonomy:'iab-content-3.0'});
  const f=fixture({config:{runtimeControls:{contextualSignals:value}}});
  const data=await getContextualSignalSettings(f.env,'audit-site');
  assert.deepEqual(data.bidders.find(row=>row.bidder==='removed'),{bidder:'removed',configured:false,enabled:false});
  assert.deepEqual(data.settings,value);
});

test('JSON/method/size errors and missing sites do not mutate settings',async()=>{
  const f=fixture();
  assert.equal((await post(f,'{broken')).status,400);
  assert.equal((await post(f,'text',{headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await post(f,' '.repeat(131073))).status,413);
  assert.equal((await contextualSignalSettingsResponse(new Request(url,{method:'DELETE'}),f.env,'audit-site','admin')).status,405);
  assert.equal((await contextualSignalSettingsResponse(new Request(url),f.env,'not-found','admin')).status,404);
  assert.equal((await contextualSignalSettingsResponse(new Request(url),f.env,'INVALID','admin')).status,400);
  assert.equal(f.log.batches,0);
});

test('transaction failure preserves original settings; subsequent retry succeeds',async()=>{
  const f=fixture(),state=await getContextualSignalSettings(f.env,'audit-site'),before=f.readConfig();
  const original=f.env.DB.batch;f.env.DB.batch=async()=>{throw Error('synthetic storage failure');};
  const failed=await post(f,{revision:state.revision,settings:settings()});assert.equal(failed.status,503);assert.deepEqual(f.readConfig(),before);
  f.env.DB.batch=original;const retry=await post(f,{revision:state.revision,settings:settings()});assert.equal(retry.status,200);
});
