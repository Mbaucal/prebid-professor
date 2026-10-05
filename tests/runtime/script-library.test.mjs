import test from 'node:test';import assert from 'node:assert/strict';
import {scriptLibraryResponse} from '../../worker/site-runtime/script-library.mjs';
import {sha256} from '../../scripts/static-aa-package.mjs';
function fixture(){const row={id:'tanjug',name:'Tanjug',domain:'tanjug.rs',gam_path:'/22852026051/Tanjug.rs-Display/',config_json:JSON.stringify({enablePrebid:true,prebidBidCache:{enabled:true,maxBidAgeSeconds:60}})},objects=new Map();let writes=0;
 const env={DB:{withSession:()=>({prepare:()=>({bind:id=>({first:async()=>id===row.id?{...row}:null})})})},BUILDS:{
  delete:async k=>objects.delete(k),get:async k=>objects.get(k)||null,list:async({prefix})=>({objects:[...objects].filter(([k])=>k.startsWith(prefix)).map(([key,o])=>({key,customMetadata:o.customMetadata})),truncated:false}),
  put:async(k,b,o)=>{assert.equal(o.onlyIf.get('if-none-match'),'*');if(objects.has(k))return null;const bytes=Buffer.from(b);objects.set(k,{size:bytes.length,customMetadata:o.customMetadata,arrayBuffer:async()=>Uint8Array.from(bytes).buffer});writes++;return {};}}};
 const call=(kind=null,body,id=null,options={},site='tanjug',method=body?'POST':'GET')=>scriptLibraryResponse(new Request('https://app.invalid/api/library',{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined}),env,site,kind,id,'fixture@example.invalid',options);
 return {row,objects,call,writes:()=>writes};}
const settings={mode:'auction-with-cache',refreshSeconds:10,maxBidAgeSeconds:60};
test('named standalone versions and tests persist original bytes and references',async()=>{
 const f=fixture(),state=await(await f.call()).json(),body={revision:state.revision,name:'Cache 60s',refreshSeconds:10};
 const create=await f.call('scripts',body);assert.equal(create.status,201,await create.clone().text());const script=(await create.json()).item;
 const zip=Buffer.from(await(await f.call('scripts',null,script.id)).arrayBuffer());assert.equal(sha256(zip),script.sha256);
 const again=await f.call('scripts',body);assert.equal(again.status,200);assert.equal(f.writes(),2);
 const t=await f.call('tests',{revision:state.revision,name:'Cache A/A',scriptA:script.id,scriptB:script.id,trafficBPercent:50});assert.equal(t.status,201,await t.clone().text());const saved=(await t.json()).item;
 assert.equal(saved.scripts.A.name,'Cache 60s');assert.equal(saved.scripts.B.id,script.id);
 const list=await(await f.call()).json();assert.equal(list.scripts.length,1);assert.equal(list.tests.length,1);assert.equal(list.tests[0].name,'Cache A/A');
 const response=await f.call('tests',null,saved.id);assert.equal(sha256(Buffer.from(await response.arrayBuffer())),saved.sha256);assert.equal(f.writes(),4);
 f.row.id='other';assert.equal((await f.call('scripts',null,script.id,{},'other')).status,404);
});
test('invalid fields, stale site revisions and incompatible sites cannot write',async()=>{
 const f=fixture(),state=await(await f.call()).json(),body={revision:state.revision,name:'Cache',refreshSeconds:10};
 for(const patch of [{name:''},{refreshSeconds:0},{settings},{extra:true}])assert.equal((await f.call('scripts',{...body,...patch})).status,422);
 assert.equal((await f.call('scripts',{...body,revision:'stale'})).status,409);
 assert.equal((await f.call('scripts',{...body,name:'x'.repeat(5000)})).status,413);
 assert.equal((await f.call('tests',{revision:state.revision,name:'Bad',scriptA:'missing',scriptB:'missing',trafficBPercent:50})).status,422);
 f.row.gam_path='/other/';assert.equal((await(await f.call()).json()).supported,false);assert.equal((await f.call('scripts',body)).status,409);assert.equal(f.writes(),0);
});
test('corrupt saved script is neither downloadable nor usable by a new test',async()=>{
 const f=fixture(),state=await(await f.call()).json(),body={revision:state.revision,name:'Cache',refreshSeconds:10};
 const script=(await(await f.call('scripts',body)).json()).item;
 const zip=[...f.objects].find(([k])=>k.endsWith('.zip'))[1];zip.arrayBuffer=async()=>new Uint8Array(zip.size).buffer;
 assert.equal((await f.call('scripts',null,script.id)).status,409);assert.equal((await f.call('scripts',body)).status,409);
 assert.equal((await f.call('tests',{revision:state.revision,name:'Bad',scriptA:script.id,scriptB:script.id,trafficBPercent:50})).status,409);assert.equal(f.writes(),2);
});
test('identity changes during compilation cannot register a named script',async()=>{
 const f=fixture(),state=await(await f.call()).json();
 const response=await f.call('scripts',{revision:state.revision,name:'Cache',refreshSeconds:10},null,{scriptBuilder:async()=>{f.row.domain='changed.invalid';const archive=Buffer.from('fixture');return {id:'tanjug-script-1.0.0-'+'a'.repeat(64),archive,archiveSha256:sha256(archive)};}});
 assert.equal(response.status,409);assert.equal(f.writes(),0);
});

test('confirmed deletion is recoverable and saved tests keep exact script copies',async()=>{
 const f=fixture(),state=await(await f.call()).json(),body={revision:state.revision,name:'Disposable cache',refreshSeconds:10};
 const script=(await(await f.call('scripts',body)).json()).item;
 const testBody={revision:state.revision,name:'Keep test',scriptA:script.id,scriptB:script.id,trafficBPercent:50};
 const experiment=(await(await f.call('tests',testBody)).json()).item;
 const zip=Buffer.from(await(await f.call('scripts',null,script.id)).arrayBuffer());
 const change=(kind,item,method='DELETE',confirmation={confirmId:item.id,sha256:item.sha256})=>f.call(kind,confirmation,item.id,{},'tanjug',method);
 assert.equal((await change('scripts',script,'DELETE',{confirmId:'wrong',sha256:script.sha256})).status,422);
 assert.equal((await change('scripts',script)).status,200);assert.equal((await change('scripts',script)).status,200);
 const deleted=await(await f.call()).json();assert.equal(deleted.scripts.length,0);assert.equal(deleted.deletedScripts[0].id,script.id);
 assert.equal((await f.call('scripts',null,script.id)).status,410);
 assert.equal((await f.call('scripts',body)).status,410);
 assert.equal((await f.call('tests',{...testBody,name:'New test'})).status,410);
 assert.equal(sha256(Buffer.from(await(await f.call('tests',null,experiment.id)).arrayBuffer())),experiment.sha256);
 assert.equal((await change('scripts',script,'PUT')).status,200);
 assert.deepEqual(Buffer.from(await(await f.call('scripts',null,script.id)).arrayBuffer()),zip);
 assert.equal((await(await f.call()).json()).scripts.length,1);
 assert.equal((await change('tests',experiment)).status,200);assert.equal((await f.call('tests',null,experiment.id)).status,410);
 assert.equal((await f.call('scripts',null,script.id)).status,200);
 assert.equal((await change('tests',experiment,'PUT')).status,200);
 assert.equal(sha256(Buffer.from(await(await f.call('tests',null,experiment.id)).arrayBuffer())),experiment.sha256);
});


test('Demand settings own new versions; stale requests and client overrides cannot change them',async()=>{
 const f=fixture(),before=await(await f.call()).json();
 const first=(await(await f.call('scripts',{revision:before.revision,name:'Cache',refreshSeconds:30})).json()).item;
 assert.equal(first.settings.mode,'auction-with-cache');assert.equal(first.settings.maxBidAgeSeconds,60);
 f.row.config_json=JSON.stringify({enablePrebid:true,prebidBidCache:{enabled:false,maxBidAgeSeconds:60}});
 assert.equal((await f.call('scripts',{revision:before.revision,name:'Stale',refreshSeconds:30})).status,409);
 const after=await(await f.call()).json();assert.equal(after.prebid.bidCache.enabled,false);
 assert.equal((await f.call('scripts',{revision:after.revision,name:'Override',refreshSeconds:30,settings})).status,422);
 const second=(await(await f.call('scripts',{revision:after.revision,name:'Fresh',refreshSeconds:30})).json()).item;
 assert.equal(second.settings.mode,'fresh-only');assert.equal(second.settings.maxBidAgeSeconds,undefined);
 assert.equal(sha256(Buffer.from(await(await f.call('scripts',null,first.id)).arrayBuffer())),first.sha256);
 const saved=(await(await f.call('tests',{revision:after.revision,name:'Compare',scriptA:first.id,scriptB:second.id,trafficBPercent:50})).json()).item;
 assert.equal(saved.scripts.A.settings.mode,'auction-with-cache');assert.equal(saved.scripts.B.settings.mode,'fresh-only');
 f.row.config_json=JSON.stringify({enablePrebid:false,prebidBidCache:{enabled:true,maxBidAgeSeconds:60}});
 const disabled=await(await f.call()).json();
 assert.equal((await f.call('scripts',{revision:disabled.revision,name:'Disabled',refreshSeconds:30})).status,409);
 assert.equal(sha256(Buffer.from(await(await f.call('tests',null,saved.id)).arrayBuffer())),saved.sha256);
});
test('a Demand change during compilation cannot register a script under stale settings',async()=>{
 const f=fixture(),state=await(await f.call()).json();
 const response=await f.call('scripts',{revision:state.revision,name:'Changed policy',refreshSeconds:30},null,{scriptBuilder:async()=>{
  f.row.config_json=JSON.stringify({enablePrebid:true,prebidBidCache:{enabled:true,maxBidAgeSeconds:30}});
  const archive=Buffer.from('fixture');return {id:'tanjug-script-1.0.0-'+'a'.repeat(64),archive,archiveSha256:sha256(archive)};
 }});
 assert.equal(response.status,409);assert.equal(f.writes(),0);
});
