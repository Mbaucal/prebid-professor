import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {getRuntimeControls,updateRuntimeControls} from '../../worker/runtime-controls.ts';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {descriptor} from '../../.generated/runtime-319-manifest.mjs';
import {createAdUnit,updateAdUnit,duplicateAdUnit} from '../../worker/ad-units.ts';
const request=body=>new Request('https://audit.invalid/api/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const active=[];test.afterEach(()=>{while(active.length)active.pop().close();});
function store(builtin=true,sticky={bottomAdUnitId:'',topAdUnitId:null,allowClosePortal:false}){
 const f=adminAuditStore({config:{...(builtin?{builtinRuntimeSelection:pinRuntime(descriptor)}:{}),runtimeControls:{sticky,floors:{enabled:true,currency:'EUR',hardFloor:0.04,bidderFloors:{pubmatic:0.08},rules:{'banner|300x250|desktop|*|*':0.1}},output:{cleanComments:true}}}});active.push(f);
 f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key) VALUES('audit-second','audit-site','P2','BTF','display')").run();return f;
}
async function form(f){return (await (await getRuntimeControls(f.env,'audit-site')).json()).controls;}
async function rejectedWithoutWrite(f,body,pattern){
 const before=JSON.stringify(f.readConfig()),batches=f.log.batches;
 const response=await updateRuntimeControls(request(body),f.env,'audit-site');assert.equal(response.status,422,await response.clone().text());
 assert.match(await response.text(),pattern);assert.equal(JSON.stringify(f.readConfig()),before);assert.equal(f.log.batches,batches);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_log").get().n,0);
}
for(const group of ['bidderFloors','rules'])test(`floor ${group} rejects invalid bounds without saving or silently dropping input`,async()=>{
 for(const value of [-0.01,1000.01,1001,'not-a-number']){
  const f=store(),body=await form(f),key=group==='bidderFloors'?'pubmatic':'banner|300x250|desktop|*|*';body.floors[group][key]=value;
  await rejectedWithoutWrite(f,body,/floor|1000|number/i);
 }
});
for(const value of [0,0.01,1000])test(`floor boundary ${value} stays exact after save/reload`,async()=>{
 const f=store(),body=await form(f);body.floors.bidderFloors.pubmatic=value;body.floors.rules['banner|300x250|desktop|*|*']=value;
 const response=await updateRuntimeControls(request(body),f.env,'audit-site');assert.equal(response.status,200,await response.clone().text());
 const after=await form(f);assert.equal(after.floors.bidderFloors.pubmatic,value);assert.equal(after.floors.rules['banner|300x250|desktop|*|*'],value);
});
test('built-in Top Sticky and portal cannot be newly activated',async()=>{
 for(const change of [b=>b.sticky.topAdUnitId='P1',b=>b.sticky.allowClosePortal=true]){const f=store(),body=await form(f);change(body);await rejectedWithoutWrite(f,body,/supported|script|sticky|portal/i);}
});
test('existing unsupported values survive unrelated settings edits and can be explicitly removed',async()=>{
 const sticky={bottomAdUnitId:'',topAdUnitId:'P1',allowClosePortal:true},f=store(true,sticky),body=await form(f);body.floors.hardFloor=0.12;
 let response=await updateRuntimeControls(request(body),f.env,'audit-site');assert.equal(response.status,200,await response.clone().text());
 assert.equal((await form(f)).sticky.topAdUnitId,'P1');assert.equal((await form(f)).sticky.allowClosePortal,true);assert.equal((await form(f)).floors.hardFloor,0.12);
 const clear=await form(f);clear.sticky.topAdUnitId=null;clear.sticky.allowClosePortal=false;
 response=await updateRuntimeControls(request(clear),f.env,'audit-site');assert.equal(response.status,200,await response.clone().text());
 assert.equal((await form(f)).sticky.topAdUnitId,null);assert.equal((await form(f)).sticky.allowClosePortal,false);
});
test('existing unsupported Top Sticky cannot silently switch to a different unit',async()=>{
 const f=store(true,{bottomAdUnitId:'',topAdUnitId:'P1',allowClosePortal:false}),body=await form(f);body.sticky.topAdUnitId='P2';
 await rejectedWithoutWrite(f,body,/supported|script|sticky/i);
});
test('legacy template controls retain their supported activation path',async()=>{
 const f=store(false),body=await form(f);body.sticky.topAdUnitId='P1';body.sticky.allowClosePortal=true;
 const response=await updateRuntimeControls(request(body),f.env,'audit-site');assert.equal(response.status,200,await response.clone().text());
 assert.equal((await form(f)).sticky.topAdUnitId,'P1');assert.equal((await form(f)).sticky.allowClosePortal,true);
});
function units(f){return JSON.stringify(f.sqlite.prepare('SELECT * FROM ad_units ORDER BY id').all());}
async function mediaRejected(f,run){
 const before=units(f),config=JSON.stringify(f.readConfig()),batches=f.log.batches,response=await run();
 assert.equal(response.status,422,await response.clone().text());assert.match(await response.text(),/Banner.*Outstream.*Formats/);
 assert.equal(units(f),before);assert.equal(JSON.stringify(f.readConfig()),config);assert.equal(f.log.batches,batches);
}
for(const mediaType of ['video','native'])test(`built-in raw ${mediaType} create/change/enable/undraft/copy rejects before writes`,async()=>{
 {
  const f=store();await mediaRejected(f,()=>createAdUnit(request({code:'P3',mediaType,type:'BTF',sizeMapKey:'display'}),f.env,'audit-site'));
 }
 {
  const f=store();await mediaRejected(f,()=>updateAdUnit(request({mediaType}),f.env,'audit-site','audit-unit'));
 }
 {
  const f=store();f.sqlite.prepare("UPDATE ad_units SET media_type=?,enabled=0 WHERE id='audit-unit'").run(mediaType);
  await mediaRejected(f,()=>updateAdUnit(request({enabled:true}),f.env,'audit-site','audit-unit'));
 }
 {
  const f=store();f.sqlite.prepare("UPDATE ad_units SET media_type=?,type='DRAFT' WHERE id='audit-unit'").run(mediaType);
  await mediaRejected(f,()=>updateAdUnit(request({type:'BTF'}),f.env,'audit-site','audit-unit'));
 }
 {
  const f=store();f.sqlite.prepare("UPDATE ad_units SET media_type=? WHERE id='audit-unit'").run(mediaType);
  await mediaRejected(f,()=>duplicateAdUnit(request({code:'P3'}),f.env,'audit-site','audit-unit'));
 }
});
test('raw media can be saved inactive and existing records can be edited or recovered without silent conversion',async()=>{
 for(const inactive of [{enabled:false},{type:'DRAFT'}]){
  const f=store();let response=await createAdUnit(request({code:'P3',mediaType:'video',type:'BTF',sizeMapKey:'display',...inactive}),f.env,'audit-site');assert.equal(response.status,201,await response.clone().text());
  assert.equal(f.sqlite.prepare("SELECT media_type FROM ad_units WHERE code='P3'").get().media_type,'video');
 }
 const f=store();f.sqlite.prepare("UPDATE ad_units SET media_type='native' WHERE id='audit-unit'").run();
 let response=await updateAdUnit(request({notes:'preserved unsupported legacy record'}),f.env,'audit-site','audit-unit');assert.equal(response.status,200,await response.clone().text());
 assert.equal(f.sqlite.prepare("SELECT media_type FROM ad_units WHERE id='audit-unit'").get().media_type,'native');
 response=await updateAdUnit(request({mediaType:'banner'}),f.env,'audit-site','audit-unit');assert.equal(response.status,200,await response.clone().text());
 assert.equal(f.sqlite.prepare("SELECT media_type FROM ad_units WHERE id='audit-unit'").get().media_type,'banner');
});
test('legacy raw media create and copy remain available',async()=>{
 const f=store(false);let response=await createAdUnit(request({code:'P3',mediaType:'video',type:'BTF',sizeMapKey:'display'}),f.env,'audit-site');assert.equal(response.status,201,await response.clone().text());
 const id=f.sqlite.prepare("SELECT id FROM ad_units WHERE code='P3'").get().id;
 response=await duplicateAdUnit(request({code:'P4'}),f.env,'audit-site',id);assert.equal(response.status,201,await response.clone().text());
 assert.equal(f.sqlite.prepare("SELECT media_type FROM ad_units WHERE code='P4'").get().media_type,'video');
});
