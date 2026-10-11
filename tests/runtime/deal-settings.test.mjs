import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
import {getDealSettings,saveDealSettings,dealSettingsResponse} from '../../worker/site-runtime/deal-settings.mjs';
const fixtures=[];test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
async function setup(){const f=workspaceStore();fixtures.push(f);const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);const cookie=login.headers.get('set-cookie').split(';')[0];const response=await worker.fetch(new Request(ORIGIN+'/test-api/setup',{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({confirm:'prepare-empty-test-database'})}),f.env);assert.equal(response.status,200);return f;}
const entry={id:'one',name:'Contract',bidder:'pubmatic',dealId:'0000199',positions:[],startsAt:'2026-10-01T00:00:00.000Z',endsAt:'2026-12-01T00:00:00.000Z',enabled:false,mode:'price'};
test('Actual SQLite save/reopen is idempotent, preserves unrelated config and rejects stale revision before write',async()=>{
 const f=await setup(),before=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json),s=await getDealSettings(f.env,'test-site');
 const settings={schemaVersion:1,entries:[entry]},saved=await saveDealSettings(f.env,'test-site',TEST_EMAIL,{revision:s.revision,settings});
 assert.equal(saved.changed,true);assert.deepEqual((await getDealSettings(f.env,'test-site')).settings,settings);
 const after=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);delete after.runtimeControls.deals;assert.deepEqual(after,before);
 const n=f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n;
 assert.equal((await saveDealSettings(f.env,'test-site',TEST_EMAIL,{revision:saved.revision,settings})).changed,false);
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n,n);
 await assert.rejects(saveDealSettings(f.env,'test-site',TEST_EMAIL,{revision:s.revision,settings}),/changed/);
 assert.equal(f.log.puts.length,0);
});
test('Configuration change between read and commit fails the existing atomic snapshot guard',async()=>{
 const f=await setup(),s=await getDealSettings(f.env,'test-site'),original=f.env.DB.batch;let changed=false;
 f.env.DB.batch=async items=>{if(!changed&&items.some(i=>i.sql.startsWith('UPDATE publisher_configs'))){changed=true;f.sqlite.exec("UPDATE publishers SET name='Concurrent name'");}return original(items);};
 await assert.rejects(saveDealSettings(f.env,'test-site',TEST_EMAIL,{revision:s.revision,settings:{schemaVersion:1,entries:[entry]}}),/changed/);
 assert.equal((await getDealSettings(f.env,'test-site')).settings.entries.length,0);
});
test('Manual PubMatic filter conflict and malformed/oversize requests retain saved values',async()=>{
 const f=await setup();f.sqlite.exec("INSERT INTO bidders(id,publisher_id,bidder) VALUES ('pubmatic-test','test-site','pubmatic')");f.sqlite.exec("UPDATE bidders SET params_json='{"+'"deals":["manual"]'+"}' WHERE bidder='pubmatic'");
 const s=await getDealSettings(f.env,'test-site');await assert.rejects(saveDealSettings(f.env,'test-site',TEST_EMAIL,{revision:s.revision,settings:{schemaVersion:1,entries:[{...entry,enabled:true}]}}),/Move existing/);
 for(const [body,status] of [['{',400],['x'.repeat(24001),413]]){const r=await dealSettingsResponse(new Request(ORIGIN+'/deals',{method:'POST',headers:{'content-type':'application/json'},body}),f.env,'test-site',TEST_EMAIL);assert.equal(r.status,status);}
 assert.equal((await getDealSettings(f.env,'test-site')).settings.entries.length,0);
 await assert.rejects(getDealSettings(f.env,'missing-site'),/not found/);
 assert.equal((await dealSettingsResponse(new Request(ORIGIN+'/deals'),f.env,'missing-site',TEST_EMAIL)).status,404);
});
test('A later manual filter conflict is visible on GET and does not discard saved contract',async()=>{
 const f=await setup();f.sqlite.exec("INSERT INTO bidders(id,publisher_id,bidder) VALUES ('pubmatic-test','test-site','pubmatic')");
 const s=await getDealSettings(f.env,'test-site');await saveDealSettings(f.env,'test-site',TEST_EMAIL,{revision:s.revision,settings:{schemaVersion:1,entries:[{...entry,enabled:true}]}});
 f.sqlite.prepare('UPDATE bidders SET params_json=? WHERE bidder=?').run('{"deals":["manual"]}','pubmatic');
 const after=await getDealSettings(f.env,'test-site');assert.match(after.validationIssue,/Move existing/);assert.equal(after.settings.entries[0].dealId,'0000199');
});
