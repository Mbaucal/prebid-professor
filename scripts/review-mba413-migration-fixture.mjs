// Actual isolated TEST HTTP handler against the exact prior schema; no external resources.
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import worker from '../worker/test-workspace/index.mjs';
import {legacyStatements,legacySchemaSha256} from '../.generated/test-workspace-schema.mjs';
import {TEST_DATABASE,TEST_BUCKET} from '../worker/test-workspace/boundary.mjs';
import {runtimeCatalog} from '../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../worker/runtime/version-pin.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../tests/support/test-workspace-store.mjs';
const f=workspaceStore();for(const sql of legacyStatements)f.sqlite.exec(sql);
f.sqlite.prepare('INSERT INTO tessera_test_environment VALUES(1,?,?,?)').run(legacySchemaSha256,TEST_DATABASE,TEST_BUCKET);
f.sqlite.exec("INSERT INTO publishers(id,name,domain,gam_path) VALUES('test-site','Existing TEST','example.invalid','/123/test/'); INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES('review-config','test-site','{\"enablePrebid\":false}'); INSERT INTO bidders(id,publisher_id,bidder,params_json) VALUES('review-bidder','test-site','adf','{\"mid\":123}');");
// A real saved TEST bidder state always has the reviewed draft marker and exact
// runtime pin. Without them post-upgrade status correctly rejects malformed data.
f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify({enablePrebid:false,testPrebidDraft:{schemaVersion:1,candidateOnly:true},builtinRuntimeSelection:{schemaVersion:1,runtime:pinRuntime(runtimeCatalog.find(row=>row.version==='3.21.2')),prebid:null}}));
f.objects.set('saved-zip',new Uint8Array([7,8,9]));
globalThis.fetch=()=>{throw Error('Outbound requests are forbidden');};
const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD}).toString()}),f.env);assert.equal(login.status,303);
const cookie=login.headers.get('set-cookie').split(';')[0];console.log(JSON.stringify({ready:true,origin:ORIGIN}));
for await(const line of createInterface({input:process.stdin})){
 try{
  const input=JSON.parse(line);let response;
  if(input.path==='/__fixture/snapshot')response=Response.json({bidders:f.sqlite.prepare('SELECT * FROM bidders').all(),config:f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json,objects:[...f.objects].map(([key,value])=>[key,[...value]]),columns:f.sqlite.prepare('PRAGMA table_info(bidders)').all().map(row=>row.name)});
  else response=await worker.fetch(new Request(ORIGIN+input.path,{method:input.method,headers:{origin:ORIGIN,cookie,...(input.body?{'content-type':'application/json'}:{})},body:input.body||undefined}),f.env);
  console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
 }catch(error){console.log(JSON.stringify({error:error.message}));}
}
f.close();
