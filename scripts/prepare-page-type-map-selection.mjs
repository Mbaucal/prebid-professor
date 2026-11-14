// Generates two 3.21.1 packages for one synthetic site through the real admin Worker routes,
// before and after renaming the base map P (local SQLite, no hosted traffic). The browser check
// scripts/verify-page-type-map-selection.py loads both with the repository GPT mock.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {unzipSync} from 'fflate';
import worker from '../worker/app-builtin-runtime-preview.ts';
import {adminAuditStore} from '../tests/support/admin-audit-store.mjs';
import {TEST_EMAIL,TEST_PASSWORD,TEST_SECRET} from '../tests/support/test-workspace-store.mjs';
const origin='https://page-type.fixture.invalid',site='audit-site',base='/api/publishers/'+site;
const output=new URL('../.generated/page-type-map-selection/',import.meta.url);
const P=[{minViewPort:[0,0],sizes:[[300,250],[300,600]]},{minViewPort:[768,0],sizes:[[300,600],[160,600],[300,250],[336,280],[250,250],[200,200]]}];
const NASLOVNA=[{minViewPort:[0,0],sizes:[[300,250],[320,100]]},{minViewPort:[768,0],sizes:[[300,250],[250,250]]}];
const CLANAK=[{minViewPort:[0,0],sizes:[[320,100]]},{minViewPort:[768,0],sizes:[[336,280]]}];
const f=adminAuditStore({config:{enablePrebid:false}});
Object.assign(f.env,{ADMIN_EMAIL:TEST_EMAIL,ADMIN_PASSWORD:TEST_PASSWORD,SESSION_SECRET:TEST_SECRET,ASSETS:{fetch(){throw Error('No remote assets');}}});
globalThis.fetch=()=>{throw Error('Outbound requests forbidden');};
const ctx={waitUntil(){},passThroughOnException(){}};
const login=await worker.fetch(new Request(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env,ctx);
assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
const http=(path,method='GET',body)=>worker.fetch(new Request(origin+base+path,{method,headers:{origin,cookie,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}),f.env,ctx);
const json=async(path,method,body)=>{const response=await http(path,method,body);return {status:response.status,data:await response.json()};};
f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('p-map',?,'P',?),('np-map',?,'naslovna_P',?)").run(site,JSON.stringify(P),site,JSON.stringify(NASLOVNA));
f.sqlite.prepare("UPDATE ad_units SET size_map_key='P',sort_order=0 WHERE code='P1'").run();
f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,sort_order) VALUES('unit-P2',?,'P2','BTF','P',1)").run(site);
// The size-map CSV import stores names that the create form would refuse; the generator selects them.
const imported=await json('/imports/apply','POST',{kind:'size-maps',csv:'name,minWidth,sizes\nčlanak_P,0,320x100\nčlanak_P,768,336x280\n'});
assert.equal(imported.status,200,JSON.stringify(imported.data));
async function generate(){
 const state=(await json('/builtin-site-settings')).data;
 const response=await http('/builtin-site-settings','POST',{action:'bundle',revision:state.revision,acknowledge:true});
 assert.equal(response.status,200,await response.clone().text());
 return new TextDecoder().decode(unzipSync(new Uint8Array(await response.arrayBuffer()))['ads.js']);
}
const state=(await json('/builtin-site-settings')).data,runtime=state.runtimes.find(row=>row.version==='3.21.1');
assert.equal((await http('/builtin-site-settings','POST',{action:'setup',revision:state.revision,runtime:runtime.pin,allowPreview:false,enablePrebid:false})).status,200);
await mkdir(output,{recursive:true});
await writeFile(new URL('ads-before.js',output),await generate());
const renamed=await json('/size-maps/p-map','PATCH',{name:'Pravougaonik',map:P});
assert.equal(renamed.status,200,JSON.stringify(renamed.data));
await writeFile(new URL('ads-after.js',output),await generate());
const names=f.sqlite.prepare('SELECT name FROM size_maps ORDER BY name').all().map(row=>row.name);
const rows=map=>map.map(row=>({viewport:row.minViewPort,sizes:row.sizes}));
const cases={
 before:{naslovna:{map:'naslovna_P',rows:rows(NASLOVNA)},'Članak':{map:'članak_P',rows:rows(CLANAK)},Galerija:{map:'P',rows:rows(P)}},
 after:{naslovna:{map:'naslovna_Pravougaonik',rows:rows(NASLOVNA)},'Članak':{map:'članak_Pravougaonik',rows:rows(CLANAK)},Galerija:{map:'Pravougaonik',rows:rows(P)}},
};
await writeFile(new URL('cases.json',output),JSON.stringify({names,cases},null,2)+'\n');
f.close();
console.log(JSON.stringify({prepared:true,names}));
