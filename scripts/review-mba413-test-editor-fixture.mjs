// Actual isolated TEST handler and schema. No remote resources or ad execution.
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import worker from '../worker/test-workspace/index.mjs';
import {initializeTestSchema} from '../worker/test-workspace/schema.mjs';
import {readRuntimeSelectionSettings,saveRuntimeSelectionSettings} from '../worker/test-workspace/runtime-selection.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../tests/support/test-workspace-store.mjs';
const f=workspaceStore({prebidFiles:true});
await initializeTestSchema(f.env.DB,TEST_EMAIL);
const state=await readRuntimeSelectionSettings(f.env);
const runtime=state.runtimes.find(row=>row.version==='3.22.1');assert(runtime);
await saveRuntimeSelectionSettings(f.env,TEST_EMAIL,{expectedRevision:state.revision,selection:{runtime:runtime.pin,allowPreview:true,enablePrebid:false,prebidBuildId:null}});
globalThis.fetch=()=>{throw Error('Outbound requests are forbidden');};
const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD}).toString()}),f.env);assert.equal(login.status,303);
const cookie=login.headers.get('set-cookie').split(';')[0];console.log(JSON.stringify({ready:true,origin:ORIGIN}));
for await(const line of createInterface({input:process.stdin})){
 try {
  const input=JSON.parse(line);let response;
  if(input.path==='/__fixture/snapshot')response=Response.json({bidders:f.sqlite.prepare('SELECT * FROM bidders ORDER BY bidder').all(),overrides:f.sqlite.prepare('SELECT * FROM bidder_overrides ORDER BY bidder').all(),config:JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json),objects:[...f.objects.keys()]});
  else if(input.path==='/test-api/prebid/versions')response=Response.json({versions:['11.11.0','11.45.0']});
  else response=await worker.fetch(new Request(ORIGIN+input.path,{method:input.method,headers:{origin:ORIGIN,cookie,...input.headers},body:input.body||undefined}),f.env);
  console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
 } catch(error){console.log(JSON.stringify({error:error.message}));}
}
f.close();
