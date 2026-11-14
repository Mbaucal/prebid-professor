import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {downloadStoredPackage} from '../../src/download/saved-package.mjs';
import {sha256} from '../../worker/runtime/prebid-artifact-check.mjs';

const required=['README.txt','ads.js','ads.min.js','config.json','div-export.csv','implementation.html','manifest.json','min-height.css','sticky.css'];
const encode=value=>new TextEncoder().encode(value);
async function fixture({prebid=true,reporting=true,deals=true,main=false,largePrebid=false}={}){
 const names=[...required,...(prebid?['prebid.js']:[]),...(reporting?['gam-reporting.json']:[]),...(deals?['deals-plan.json']:[])].sort();
 const bytes=Object.fromEntries(names.map(n=>[n,n==='prebid.js'&&largePrebid?new Uint8Array(8*1024*1024).fill(37):encode(n)]));
 const siteId=main?'main-site':'test-site';let id='builtin-release-'+'a'.repeat(64);
 if(main){
  const files={};for(const name of names.filter(n=>n!=='manifest.json'))files[name]={byteSize:bytes[name].length,sha256:await sha256(bytes[name])};
  bytes['manifest.json']=encode(JSON.stringify({kind:'builtin-runtime-release',completeRelease:true,siteId,releaseId:id,version:id,files,prebidBuild:prebid?{id:'synthetic-build'}:null}));
 }
 const inventory=[];for(const name of names)inventory.push({name,byteSize:bytes[name].length,sha256:await sha256(bytes[name])});
 if(!main)id='builtin-draft-'+await sha256(encode(JSON.stringify({siteId,inventory})));
 return {id,bytes,descriptor:{releaseId:id,siteId,files:inventory},options:main?{siteId}:{}};
}
async function browser(f,run){
 const original={fetch:globalThis.fetch,document:globalThis.document,create:URL.createObjectURL,revoke:URL.revokeObjectURL,timeout:globalThis.setTimeout};
 const state={downloads:[],requests:[],progress:[],corrupt:null,status:200};let blob,anchor;
 const base=f.options.siteId?'/api/publishers/'+f.options.siteId+'/builtin-releases/'+f.id:'/test-api/releases/'+f.id;
 globalThis.fetch=async(url,options)=>{
  assert.deepEqual(options,{credentials:'same-origin',cache:'no-store'});assert(url.startsWith(base+'/'));state.requests.push(url);
  if(url.endsWith('/index'))return Response.json({descriptor:f.descriptor},{status:state.status});
  const name=decodeURIComponent(url.split('/').pop());return new Response(state.corrupt===name?new Uint8Array([0]):f.bytes[name]);
 };
 globalThis.document={body:{append(value){assert.equal(value,anchor);}},createElement(tag){assert.equal(tag,'a');return anchor={click(){state.downloads.push({blob,filename:this.download});},remove(){}};}};
 URL.createObjectURL=value=>{blob=value;return 'blob:local';};URL.revokeObjectURL=()=>{};globalThis.setTimeout=fn=>{fn();return 0;};
 state.download=()=>downloadStoredPackage(f.id,text=>state.progress.push(text),f.options);
 try{await run(state);}finally{globalThis.fetch=original.fetch;globalThis.document=original.document;URL.createObjectURL=original.create;URL.revokeObjectURL=original.revoke;globalThis.setTimeout=original.timeout;}
}
for(const prebid of [false,true])for(const reporting of [false,true])for(const deals of [false,true])test(`browser downloads exact saved files (Prebid=${prebid}, reporting=${reporting}, deals=${deals})`,async()=>{
 const f=await fixture({prebid,reporting,deals,largePrebid:true});
 await browser(f,async state=>{
  await state.download();assert.equal(state.downloads.length,1);const saved=state.downloads[0];assert.equal(saved.filename,f.id+'.zip');assert.equal(saved.blob.type,'application/zip');
  assert.deepEqual(unzipSync(new Uint8Array(await saved.blob.arrayBuffer())),f.bytes);
  assert.equal(state.progress.at(-1),'Saved ZIP downloaded.');
  state.corrupt=deals?'deals-plan.json':'ads.js';await assert.rejects(state.download(),/checksum/);assert.equal(state.downloads.length,1);
 });
});
for(const main of [false,true])test(`12-file revenue ${main?'MAIN':'TEST'} download keeps inventory, identity and size guards`,async t=>{
 const cases=[
  ['wrong release',f=>{f.descriptor.releaseId='builtin-draft-'+'b'.repeat(64);},/inventory/],
  ['wrong site',f=>{f.descriptor.siteId='another-site';},/inventory/],
  ['extra file',f=>{f.descriptor.files.push({...f.descriptor.files[0],name:'extra.json'});},/inventory/],
  ['unknown name',f=>{f.descriptor.files[0].name='extra.json';},/saved file/],
  ['path traversal',f=>{f.descriptor.files[0].name='../ads.js';},/saved file/],
  ['duplicate',f=>{f.descriptor.files[1]={...f.descriptor.files[0]};},/saved file/],
  ['missing required file',f=>{f.descriptor.files=f.descriptor.files.filter(x=>x.name!=='ads.min.js');},/identity|file set/],
  ['invalid hash',f=>{f.descriptor.files[0].sha256='invalid';},/saved file/],
  ['empty file',f=>{f.descriptor.files[0].byteSize=0;},/saved file/],
  ['fractional size',f=>{f.descriptor.files[0].byteSize=1.5;},/saved file/],
  ['file exceeds limit',f=>{f.descriptor.files[0].byteSize=8*1024*1024+1;},/saved file/],
  ['total exceeds limit',async f=>{
   for(const [index,size] of [[0,5*1024*1024],[1,8*1024*1024]]){const entry=f.descriptor.files[index];entry.byteSize=size;f.bytes[entry.name]=new Uint8Array(size);entry.sha256=await sha256(f.bytes[entry.name]);}
  },/Package exceeds limit/]
 ];
 for(const [name,change,expected] of cases)await t.test(name,async()=>{
  const f=await fixture({main});await change(f);await browser(f,async state=>{await assert.rejects(state.download(),expected);assert.equal(state.downloads.length,0);});
 });
});
test('TEST rejects altered package identity even when every file checksum matches',async()=>{
 const f=await fixture();f.bytes['deals-plan.json']=encode('changed saved file');const entry=f.descriptor.files.find(x=>x.name==='deals-plan.json');entry.sha256=await sha256(f.bytes[entry.name]);entry.byteSize=f.bytes[entry.name].length;
 await browser(f,async state=>{await assert.rejects(state.download(),/Package identity differs/);assert.equal(state.downloads.length,0);});
});
test('MAIN downloads all 12 exact files and retains manifest binding and inventory checks',async t=>{
 const f=await fixture({main:true});await browser(f,async state=>{await state.download();assert.deepEqual(unzipSync(new Uint8Array(await state.downloads[0].blob.arrayBuffer())),f.bytes);});
 for(const [name,change,expected] of [
  ['site binding',m=>{m.siteId='other';},/identity/],['release binding',m=>{m.releaseId='builtin-release-'+'b'.repeat(64);},/identity/],
  ['complete status',m=>{m.completeRelease=false;},/identity/],['Prebid presence',m=>{m.prebidBuild=null;},/identity/],
  ['deals hash',m=>{m.files['deals-plan.json'].sha256='b'.repeat(64);},/Manifest inventory/],
  ['deals inventory',m=>{delete m.files['deals-plan.json'];},/Manifest inventory/]
 ])await t.test(name,async()=>{
  const current=await fixture({main:true}),manifest=JSON.parse(new TextDecoder().decode(current.bytes['manifest.json']));change(manifest);current.bytes['manifest.json']=encode(JSON.stringify(manifest));const entry=current.descriptor.files.find(x=>x.name==='manifest.json');entry.byteSize=current.bytes['manifest.json'].length;entry.sha256=await sha256(current.bytes['manifest.json']);
  await browser(current,async state=>{await assert.rejects(state.download(),expected);assert.equal(state.downloads.length,0);});
 });
});
test('saved package read failure leaves retry available and does not emit a ZIP',async()=>{
 const f=await fixture();await browser(f,async state=>{state.status=503;await assert.rejects(state.download(),/Sign in and try again/);assert.equal(state.downloads.length,0);state.status=200;await state.download();assert.equal(state.downloads.length,1);});
});
