// Ephemeral SQLite/fake R2 only. No live account or external requests.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import worker from '../../worker/test-workspace/index.mjs';
import {deploymentStore} from './deployment-store.mjs';
import {ORIGIN,TEST_EMAIL,TEST_PASSWORD} from './test-workspace-store.mjs';
import {positionFixture} from './position-runtime-fixture.mjs';
import {parsePrebidHeader,sha256} from '../../worker/runtime/prebid-artifact-check.mjs';
import {readPreviewSnapshot} from '../../worker/runtime/builtin-preview-service.mjs';
import {digest} from '../../worker/runtime/preview-snapshot.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {prepareSiteRuntimeSelection,runtimeDescriptor} from '../../worker/test-workspace/private-runtime-catalog.mjs';
export async function cacheSelectionFixture(){
 const f=deploymentStore({prebidFiles:true});
 const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 async function request(path,body,origin=ORIGIN){
  const response=await worker.fetch(new Request(ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{origin,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}),f.env);
  return {response,data:await response.clone().json().catch(()=>null)};
 }
 async function api(path,body,status=200){const r=await request(path,body);assert.equal(r.response.status,status,JSON.stringify(r.data));return r.data;}
 await api('/test-api/setup',{confirm:'prepare-empty-test-database'});
 const fixture=positionFixture(true),config=JSON.parse(fixture.config.config_json);
 config.testPrebidDraft={schemaVersion:1,candidateOnly:true};config.runtimeControls.floors.currency='USD';
 fixture.bidders.push({bidder:'openx',params_json:'{"unit":"synthetic"}',enabled:1});
 f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
 for(const [table,rows] of [['ad_units',fixture.units],['bidders',fixture.bidders],['bidder_overrides',fixture.overrides],['size_maps',fixture.maps],['unit_rules',fixture.rules]]){
  f.sqlite.prepare('DELETE FROM '+table+" WHERE publisher_id='test-site'").run();
  rows.forEach((row,i)=>{const keys=Object.keys(row);f.sqlite.prepare('INSERT INTO '+table+' (id,publisher_id,'+keys.join(',')+') VALUES ('+Array(keys.length+2).fill('?').join(',')+')').run(table+'-'+i,'test-site',...Object.values(row));});
 }
 const bytes=new Uint8Array(await readFile('vendor/prebid/tanjug-11.34.0/prebid.js')),hash=await sha256(bytes),header=parsePrebidHeader(new TextDecoder().decode(bytes));
 const id='test-pb-'+hash,key='publishers/test-site/prebid-builds/'+id+'/prebid.js';
 f.objects.set(key,bytes);f.metadata.set(key,{version:header.version,sha256:hash});
 f.sqlite.prepare("INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES (?,'test-site',?,?,?,'current')").run(id,header.version,key,JSON.stringify(header.modules));
 const snapshot=await readPreviewSnapshot(f.env.DB.withSession('first-primary'),'test-site',{includePrebid:true});
 const plan=await prepareSiteRuntimeSelection({siteId:'test-site',snapshot,catalog:(await import('../../worker/test-workspace/private-runtime-catalog.mjs')).runtimeCatalog,expectedRevision:await digest(snapshot),selection:{runtime:pinRuntime(runtimeDescriptor,{allowPreview:true}),allowPreview:true,enablePrebid:true,prebidBuildId:id}},f.env.BUILDS);
 f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(plan.configJson);
 return {...f,cookie,request,api,prebidKey:key,readConfig:()=>JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json)};
}
