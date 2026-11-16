import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {createUnitRule} from '../../worker/unit-rules.ts';
import {updateAdvancedRule} from '../../worker/advanced-rules.ts';
import {updateUserIdConfig,defaultUserIdSettings} from '../../worker/user-id-config.ts';
import {createBidder} from '../../worker/bidders.ts';
import {updateRuntimeIntegrations} from '../../worker/runtime-integrations.ts';
import {generateReleaseWithRuntimeControls} from '../../worker/runtime-controls-release.ts';
import {assertCompilerStrings,assertSchainCompatibility,assertSnapshotCompilerCompatibility} from '../../worker/compiler-input-compatibility.mjs';
const request=body=>new Request('https://test.invalid/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const fixtures=[];const setup=options=>{const f=adminAuditStore(options);fixtures.push(f);return f;};test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
const configSnapshot=config=>({config:{config_json:JSON.stringify(config)},bidders:[],overrides:[],rules:[]});
test('Unit rules and Refresh reject timeouts that frozen generators cannot accept',async()=>{
 const f=setup();for(const key of ['__DEFAULT__','__ATF__','__BTF__','P1']){
  const rule=await createUnitRule(request({ruleKey:key,rule:{timeout:45000}}),f.env,'audit-site');assert.equal(rule.status,422);assert.match(await rule.text(),/30000/);
  const advanced=await updateAdvancedRule(request({timeout:45000}),f.env,'audit-site',key);assert.equal(advanced.status,422);assert.match(await advanced.text(),/30000/);
 }
 assert.equal(f.log.batches,0);assert.equal((await createUnitRule(request({ruleKey:'P1',rule:{timeout:30000}}),f.env,'audit-site')).status,201);
});
test('ID5 numeric Partner Number strings normalize to numbers before saving generated userSync',async()=>{
 const f=setup(),body=defaultUserIdSettings().userIdConfig;body.modules=[{name:'id5Id',moduleCode:'id5IdSystem',enabled:true,params:{partner:'1355'},storage:{type:'html5',name:'id5id',expires:90,refreshInSeconds:7200}}];
 const response=await updateUserIdConfig(request(body),f.env,'audit-site');assert.equal(response.status,200,await response.clone().text());const saved=f.readConfig();assert.equal(saved.userIdConfig.modules[0].params.partner,1355);assert.equal(saved.userSync.userIds[0].params.partner,1355);
 assert.doesNotThrow(()=>assertSnapshotCompilerCompatibility(configSnapshot(saved),{version:'3.16.0'}));
});
for(const separator of ['\u2028','\u2029'])test(`bidder API refuses Unicode separator ${separator.codePointAt(0).toString(16)} with field feedback and no write`,async()=>{
 const f=setup();const response=await createBidder(request({bidder:'openx',params:{nested:{placement:'one'+separator+'two'}}}),f.env,'audit-site');assert.equal(response.status,422);assert.match(await response.text(),/params.nested.placement.*Unicode line separator/);assert.equal(f.log.batches,0);
 assert.throws(()=>assertCompilerStrings({nested:['one'+separator+'two']},'Bidder params'),/Bidder params.nested\[0\]/);
 assert.throws(()=>assertCompilerStrings({nested:{['one'+separator+'two']:1}},'Bidder params'),/Unicode line separator in a field name/);
});
for(const token of ['$$','$&',"$'",'$`'])test(`SChain ${JSON.stringify(token)} is rejected for older scripts but allowed for literal-safe version`,async()=>{
 const f=setup();const schain={enabled:true,version:'1.0',complete:1,nodes:[{asi:'seller.invalid',sid:'left'+token+'right',hp:1}]};
 let response=await updateRuntimeIntegrations(request({schain,consent:{mode:'cmp'}}),f.env,'audit-site');assert.equal(response.status,422);assert.match(await response.text(),/SChain node 1.sid.*replacement token/);assert.equal(f.log.batches,0);
 const c=f.readConfig();c.builtinRuntimeSelection={runtime:{runtimeId:'tessera-3.16.1',runtimeVersion:'3.16.1'}};f.writeConfig(c);
 response=await updateRuntimeIntegrations(request({schain,consent:{mode:'cmp'}}),f.env,'audit-site');assert.equal(response.status,200,await response.clone().text());assert.equal(f.readConfig().runtimeControls.schain.nodes[0].sid,'left'+token+'right');
 assert.throws(()=>assertSchainCompatibility(schain,{id:'tessera-3.16.0',version:'3.16.0'}),/unsupported/);assert.doesNotThrow(()=>assertSchainCompatibility(schain,{id:'tessera-3.16.1',version:'3.16.1'}));
});
test('ordinary dollar strings remain valid for older scripts',async()=>{
 const f=setup(),schain={enabled:true,version:'1.0',complete:1,nodes:[{asi:'seller.invalid',sid:'Ca$h',rid:'R$D',name:'Sell$er',hp:1}]};assert.equal((await updateRuntimeIntegrations(request({schain,consent:{mode:'cmp'}}),f.env,'audit-site')).status,200);
});
test('already saved problematic values stop legacy Generate before artifact writes',async()=>{
 for(const kind of ['timeout','id5','separator','schain']){const f=setup();const c=f.readConfig();if(kind==='timeout')f.sqlite.prepare("INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES('bad','audit-site','__DEFAULT__','{\"timeout\":45000}')").run();
 if(kind==='id5')c.userSync={userIds:[{name:'id5Id',params:{partner:'1355'}}]};
 if(kind==='separator')f.sqlite.prepare("UPDATE bidders SET params_json=? WHERE publisher_id='audit-site'").run(JSON.stringify({placement:'one\u2028two'}));
 if(kind==='schain')c.runtimeControls.schain={enabled:true,nodes:[{asi:'seller.invalid',sid:'s$&t',hp:1}]};f.writeConfig(c);
 const response=await generateReleaseWithRuntimeControls(request({}),f.env,'audit-site');assert.equal(response.status,422,kind+':'+await response.clone().text());assert.equal(f.log.puts.length,0);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM releases WHERE publisher_id='audit-site'").get().n,0);
 }
});
