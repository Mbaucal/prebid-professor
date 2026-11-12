import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
const fixtures=[];
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
async function fixture(){
 const f=workspaceStore();fixtures.push(f);
 const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
 assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
 f.req=(path,body,headers={})=>worker.fetch(new Request(ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{origin:ORIGIN,cookie,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)}),f.env);
 assert.equal((await f.req('/test-api/setup',{confirm:'prepare-empty-test-database'})).status,200);
 return f;
}
const endpoint='/test-api/bidder-rules';
const config=f=>JSON.parse(f.sqlite.prepare("SELECT config_json FROM publisher_configs WHERE publisher_id='test-site'").get().config_json);
test('TEST bidder rules save only the isolated copy and preserve runtime selection and other settings',async()=>{
 const f=await fixture(),before=config(f),response=await f.req(endpoint);
 assert.equal(response.status,200);const state=await response.json();assert.equal(state.settings.enabled,false);
 const settings={schemaVersion:1,enabled:true,rules:[{id:'rs-only',name:'Serbia',enabled:true,bidder:'pubmatic',positions:['m.box_1'],countries:{mode:'include',values:['RS'],unknown:'skip'},devices:['desktop']}]};
 const saved=await f.req(endpoint,{revision:state.revision,settings});assert.equal(saved.status,200,await saved.clone().text());
 assert.deepEqual(config(f).builtinRuntimeSelection,before.builtinRuntimeSelection);
 assert.deepEqual(config(f).runtimeControls.bidderRules,settings);
 const after=config(f);delete after.runtimeControls.bidderRules;assert.deepEqual(after,before);
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM publishers WHERE id<>'test-site'").get().n,0);
 assert.equal((await f.req(endpoint,{revision:state.revision,settings})).status,409);
 assert.equal(f.objects.size,0);
 const audits=f.sqlite.prepare("SELECT actor FROM audit_log WHERE action='bidder_rules.saved'").all();assert.equal(audits.length,1);assert.equal(audits[0].actor,TEST_EMAIL);
 const script=await f.req('/site-workspace.js');assert.equal(script.status,200);
 const js=await script.text();assert.match(js,/\/test-api\/bidder-rules/);assert.match(js,/__AD_BIDDER_RULES/);assert.match(js,/Bidder rules console command/);
});
test('TEST bidder rule route retains authentication, origin, host, query and exact site boundaries',async()=>{
 const f=await fixture(),before=config(f);
 assert.equal((await f.req(endpoint,undefined,{cookie:''})).status,401);
 assert.equal((await f.req(endpoint,{}, {origin:'https://other.invalid','sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await f.req(endpoint,{}, {origin:'https://other.invalid'})).status,403);
 assert.equal((await f.req(endpoint+'?site=politika')).status,404);
 assert.equal((await f.req('/api/publishers/politika/bidder-rules')).status,404);
 assert.equal((await f.req('/api/publishers/test-site/bidder-rules')).status,404);
 const wrong=await worker.fetch(new Request('https://prebid-professor.mbaucal.workers.dev'+endpoint),f.env);assert.equal(wrong.status,404);
 assert.deepEqual(config(f),before);assert.equal(f.objects.size,0);
});
test('TEST console command reads the diagnostic snapshot without starting auctions or mutating config',()=>{
 const source=readFileSync(new URL('../../src/site-workspace/test-entry.tsx',import.meta.url),'utf8');
 const command=source.match(/const bidderRulesInspectCommand=`([\s\S]*?)`;/)?.[1];assert(command);
 const report={enabled:true,decisions:[{bidder:'pubmatic',allowed:false,reason:'country-excluded'}]};
 let reads=0;const logs=[],warnings=[];
 const context={window:{__AD_BIDDER_RULES:{snapshot(){reads++;return report;}}},console:{log(...args){logs.push(args);},warn(...args){warnings.push(args);}}};
 assert.equal(vm.runInNewContext(command,context),report);assert.equal(reads,1);assert.equal(logs.length,1);assert.equal(warnings.length,0);
 assert.equal(vm.runInNewContext(command,{window:{},console:context.console}),null);assert.equal(warnings.length,1);
});
