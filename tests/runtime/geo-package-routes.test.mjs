import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../../tests/support/test-workspace-store.mjs';
import {siteRuntimeBundle} from '../../worker/site-runtime/service.mjs';
import test from 'node:test';
test('all package routes bind GEO to the server environment and preserve historical ZIPs',async()=>{
const f=workspaceStore(),decode=new TextDecoder();
const MAIN='https://prebid-professor.mbaucal.workers.dev/geo/v1/country';
const TEST='https://prebid-professor-test.mbaucal.workers.dev/geo/v1/country';
const rows=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=()=>assert.fail('External calls forbidden');
try{
 const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 async function req(path,body){const r=await worker.fetch(new Request(ORIGIN+path,{method:body?'POST':'GET',headers:{cookie,origin:ORIGIN,'content-type':'application/json'},body:body?JSON.stringify(body):undefined}),f.env);assert(r.ok,await r.clone().text());return r;}
 async function settings(){return (await req('/test-api/site-runtime')).json();}
 async function select(version){const s=await settings();await req('/test-api/site-runtime',{action:'setup',revision:s.revision,runtime:s.runtimes.find(r=>r.version===version).pin,allowPreview:false,enablePrebid:false});}
 async function generate(){const s=await settings();return (await (await req('/test-api/site-packages',{action:'generate',revision:s.revision,notes:'QA fixture'})).json()).release;}
 async function download(id){return new Uint8Array(await (await req('/test-api/site-packages',{action:'download',releaseId:id})).arrayBuffer());}
 function inspect(bytes,label,expected){const files=unzipSync(bytes),config=JSON.parse(decode.decode(files['config.json']));const actual=config.countrySignal?.endpoint;rows.push({label,actual,expected,pass:actual===expected});if(expected){for(const name of ['ads.js','ads.min.js']){assert(decode.decode(files[name]).includes(actual));assert(!decode.decode(files[name]).includes(actual===MAIN?TEST:MAIN));}}return files;}
 await req('/test-api/setup',{confirm:'prepare-empty-test-database'});
 await select('3.17.0');const old=await generate(),before=await download(old.id);inspect(before,'saved 3.17',undefined);
 await select('3.18.0');
 const newRelease=await generate();inspect(await download(newRelease.id),'TEST site-packages Generate',TEST);
 assert.deepEqual(await download(old.id),before);rows.push({label:'saved 3.17 ZIP byte-preserved after 3.18 Generate',pass:true});
 let s=await settings();inspect(new Uint8Array(await(await req('/test-api/site-runtime',{action:'bundle',revision:s.revision,acknowledge:true})).arrayBuffer()),'TEST site-runtime candidate bundle',TEST);
 inspect(new Uint8Array(await(await siteRuntimeBundle(f.env,'test-site',{action:'bundle',revision:s.revision,acknowledge:true})).arrayBuffer()),'MAIN server default candidate',MAIN);
 const legacy=await(await req('/test-api/generate',{acknowledge:true,takeOverEnabled:false})).json();assert(legacy.adsJs.includes(TEST));assert(!legacy.adsJs.includes(MAIN));rows.push({label:'legacy TEST generate',pass:true});
 const saved=await(await req('/test-api/save',{receipt:legacy.receipt,acknowledge:true,note:'QA fixture legacy'})).json();inspect(new Uint8Array(await(await req('/test-api/releases/'+saved.draft.id+'/download')).arrayBuffer()),'legacy TEST saved ZIP',TEST);
 assert(rows.every(r=>r.pass),JSON.stringify(rows));
 const bad=await worker.fetch(new Request(ORIGIN+'/test-api/site-runtime',{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({action:'bundle',revision:(await settings()).revision,acknowledge:true,testOnly:false})}),f.env);assert.equal(bad.status,422);

}finally{f.close();globalThis.fetch=originalFetch;}
});
