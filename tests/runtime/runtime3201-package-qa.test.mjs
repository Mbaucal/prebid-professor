import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {parse} from 'acorn';
import {unzipSync} from 'fflate';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
import {storePrebidFile} from '../../worker/test-workspace/prebid-files.mjs';
import {prebidStore} from '../../worker/test-workspace/prebid-settings.mjs';
import {previewCsvImport,applyCsvImport} from '../../worker/imports.ts';

// These checks use actual TEST HTTP handlers, in-memory SQLite/R2 and the
// production CSV button handlers. No external ad library or network is used.
const fixtures=[],oldFetch=globalThis.fetch,decoder=new TextDecoder();
test.before(()=>{globalThis.fetch=()=>assert.fail('Combined package QA must not request external resources');});
test.after(()=>{globalThis.fetch=oldFetch;});
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
async function req(f,path,cookie,body){
  const response=await worker.fetch(new Request(ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{origin:ORIGIN,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}),f.env);
  return {response,data:response.headers.get('content-type')?.includes('json')?await response.json():null};
}
function ok(result,status=200){assert.equal(result.response.status,status,JSON.stringify(result.data));return result.data;}
const settings=async(f,cookie)=>ok(await req(f,'/test-api/site-settings',cookie));
const save=(f,cookie,state)=>req(f,'/test-api/site-settings',cookie,{expectedRevision:state.revision,acknowledge:true,draft:state.draft});
async function select(f,cookie,version){
  const before=ok(await req(f,'/test-api/runtime-selection',cookie));
  const runtime=before.runtimes.find(item=>item.version===version);assert(runtime,`Runtime ${version} must be registered`);
  ok(await req(f,'/test-api/runtime-selection',cookie,{expectedRevision:before.revision,selection:{runtime:runtime.pin,allowPreview:true,enablePrebid:false,prebidBuildId:null}}));
  return runtime.pin;
}
async function ready(version='3.20.1'){
  const f=workspaceStore({prebidFiles:true});fixtures.push(f);
  const logged=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
  assert.equal(logged.status,303);const cookie=logged.headers.get('set-cookie').split(';')[0];
  ok(await req(f,'/test-api/setup',cookie,{confirm:'prepare-empty-test-database'}));
  await select(f,cookie,version);return {f,cookie};
}
function storedRows(f){return JSON.stringify({configs:f.sqlite.prepare('SELECT * FROM publisher_configs ORDER BY id').all(),units:f.sqlite.prepare('SELECT * FROM ad_units ORDER BY id').all(),maps:f.sqlite.prepare('SELECT * FROM size_maps ORDER BY id').all(),overrides:f.sqlite.prepare('SELECT * FROM bidder_overrides ORDER BY id').all(),audit:f.sqlite.prepare('SELECT * FROM audit_log ORDER BY id').all()});}
async function generatedPackage(f,cookie,note){
  const before=storedRows(f),generated=ok(await req(f,'/test-api/generate',cookie,{acknowledge:true}));
  assert.equal(storedRows(f),before,'Generate must not change saved input');
  const stored=ok(await req(f,'/test-api/save',cookie,{receipt:generated.receipt,acknowledge:true,note}));
  const path='/test-api/releases/'+stored.draft.id+'/download';
  const response=await req(f,path,cookie);assert.equal(response.response.status,200);
  const bytes=new Uint8Array(await response.response.arrayBuffer()),files=unzipSync(bytes);
  assert.equal(decoder.decode(files['ads.js']),generated.adsJs);
  return {path,bytes,files,config:JSON.parse(decoder.decode(files['config.json']))};
}

// Preserve the user's 43 code/type/map/enabled combinations. Notes and map
// dimensions below are synthetic: this tests identity and recovery, not the
// original publisher's layout or commercial setup.
const rows=[
 ['branding_left','ATF','REP_Branding_D'],['branding_right','ATF','REP_Branding_D'],
 ['leaderboard_top','ATF','REP_Top_D'],['leaderboard_top_A1','DRAFT','REP_Top_A1_D'],
 ['sidebar_1','ATF','REP_Sidebar_1_D'],...Array.from({length:4},(_,i)=>['sidebar_'+(i+2),i===3?'DRAFT':'BTF','REP_Sidebar_D']),
 ...Array.from({length:4},(_,i)=>['desktop_box_'+(i+1),'BTF','REP_Box_D']),
 ...Array.from({length:5},(_,i)=>['InText_'+(i+1),'BTF','REP_InText_D']),
 ['footer_sticky','BTF','REP_Sticky_D'],['m_top','ATF','REP_Top_M'],
 ...Array.from({length:5},(_,i)=>['m.box_'+(i+1),i===4?'DRAFT':'BTF','REP_Content_M']),
 ...Array.from({length:5},(_,i)=>['m.InText_'+(i+1),'BTF','REP_Content_M']),
 ['mobile_sticky','BTF','REP_Sticky_M'],['under_text','BTF','REP_Under_Text'],['footer_script','BTF','REP_Footer_Script'],
 ...Array.from({length:5},(_,i)=>['m_box_'+(i+1),'DRAFT','REP_Content_M']),
 ...Array.from({length:5},(_,i)=>['m_InText_'+(i+1),'DRAFT','REP_Content_M']),
];
const unitCsv='code,type,mediaType,sizeMapKey,enabled,sortOrder,notes\n'+rows.map(([code,type,map],i)=>`${code},${type},banner,${map},${type!=='DRAFT'},${(i+1)*10},Synthetic QA`).join('\n');
const mapNames=[...new Set(rows.map(row=>row[2]))];
const mapCsv='name,minWidth,minHeight,sizes\n'+mapNames.map(name=>`${name},0,0,300x250`).join('\n');

// Execute the exact served Add to draft logic with a minimal event/DOM surface.
// This is a functional client-handler test, not a browser/visual QA claim.
async function csvEditor(f,cookie,state){
  const scriptResult=await req(f,'/site-settings.js',cookie);assert.equal(scriptResult.response.status,200);
  const source=await scriptResult.response.text(),names=new Set(['setupCsv','integer','sizes','unitDraft','requestDraft']);
  const declarations=parse(source,{ecmaVersion:'latest'}).body.filter(n=>n.type==='FunctionDeclaration'&&names.has(n.id.name));
  // MAIN carries the legacy TEST editor without the TEST-only CSV UI. Exercise
  // its real MAIN import handlers below instead of inventing missing controls.
  if(!declarations.some(n=>n.id.name==='setupCsv'))return null;
  const functions=declarations.map(n=>source.slice(n.start,n.end)).join('\n');
  const node=(tag,text)=>({tag,textContent:text??'',children:[],listeners:{},style:{},append(...children){this.children.push(...children);},setAttribute(key,value){this[key]=value;},addEventListener(type,fn){this.listeners[type]=fn;}});
  const roots=Object.fromEntries(['csv-ad-units','csv-size-maps'].map(id=>[id,node('details')]));
  const ctx={structuredClone,JSON,Error,Number,editing:structuredClone(state.draft),busy:false,make:node,el:id=>roots[id],changed(){},render(){},action:async fn=>fn(),fetch:async(path,options)=>{
    const result=await req(f,path,cookie,options?.body?JSON.parse(options.body):undefined);
    return {ok:result.response.ok,status:result.response.status,json:async()=>result.data,text:()=>result.response.text()};
  }};
  ctx.editing.maps=ctx.editing.maps.map(m=>({...m,breakpoints:m.breakpoints.map(r=>({minWidth:String(r.minWidth),sizeText:r.sizes.map(s=>s==='fluid'?s:s.join('x')).join(', ')}))}));
  runInNewContext(functions+'\nsetupCsv("ad-units","Ad units");setupCsv("size-maps","Size maps");',ctx);
  return {ctx,async add(kind,csv){const root=roots['csv-'+kind],actions=root.children.find(n=>n.tag==='div'),text=root.children.find(n=>n.tag==='textarea'),status=root.children.at(-1);text.value=csv;await actions.children.find(n=>n.textContent==='Preview CSV').listeners.click();actions.children.find(n=>n.textContent==='Add to draft').listeners.click();return status.textContent;},draft:()=>JSON.parse(JSON.stringify(runInNewContext('requestDraft()',ctx)))};
}

test('3.20.1 CSV imports all 43 literal codes through the available editor, while old ZIP and selected version remain stable',async t=>{
  assert.equal(rows.length,43);assert.equal(mapNames.length,13);
  const {f,cookie}=await ready('3.19.1'),old=await generatedPackage(f,cookie,'Existing 3.19.1 package');
  const oldCatalog=ok(await req(f,'/test-api/runtime-selection',cookie)).runtimes;
  const pin=await select(f,cookie,'3.20.1'),state=await settings(f,cookie),before=storedRows(f),objectCount=f.objects.size;
  const editor=await csvEditor(f,cookie,state);
  if(editor){
    t.diagnostic('TEST editor: actual CSV button handlers, missing-map recovery and revision-checked Save');
    const beforeDraft=JSON.stringify(editor.ctx.editing);
    assert.match(await editor.add('ad-units',unitCsv),/Import size maps first: missing REP_Branding_D/);
    assert.equal(JSON.stringify(editor.ctx.editing),beforeDraft,'A failed Add to draft must not partially add earlier rows');
    assert.equal(storedRows(f),before);assert.equal(f.objects.size,objectCount);
    assert.match(await editor.add('size-maps',mapCsv),/Added to the draft/);
    assert.match(await editor.add('ad-units',unitCsv),/Added to the draft/);
    const imported=editor.draft();
    assert.deepEqual(imported.units.filter(u=>rows.some(r=>r[0]===u.code)).map(u=>u.code),rows.map(r=>r[0]));
    assert.equal(storedRows(f),before,'CSV preview and Add to draft are not persisted writes');
    ok(await save(f,cookie,{revision:state.revision,draft:imported}));
  }else{
    t.diagnostic('MAIN editor: real preview/apply handlers, maps first; TEST-only Add to draft UI is absent');
    assert.equal((await req(f,'/test-api/inventory-preview',cookie,{kind:'ad-units',csv:unitCsv})).response.status,404);
    const request=(kind,csv)=>new Request(ORIGIN+'/api/publishers/test-site/imports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,csv})});
    for(const [kind,csv,count]of [['size-maps',mapCsv,13],['ad-units',unitCsv,43]]){
      const unchanged=storedRows(f),preview=await previewCsvImport(request(kind,csv),f.env,'test-site'),data=await preview.json();
      assert.equal(preview.status,200,JSON.stringify(data));assert.equal(data.preview.errorCount,0);assert.equal(data.preview.rows.length,count);
      assert.equal(storedRows(f),unchanged,'MAIN import preview must not write');
      const applied=await applyCsvImport(request(kind,csv),f.env,'test-site');assert.equal(applied.status,200,await applied.clone().text());
    }
  }
  const reopened=await settings(f,cookie);
  for(const [code,type,map]of rows){const u=reopened.draft.units.find(u=>u.code===code);assert(u,code);assert.equal(u.type,type);assert.equal(u.sizeMap,map);assert.equal(u.enabled,type!=='DRAFT');}
  const selected=ok(await req(f,'/test-api/runtime-selection',cookie));
  assert.deepEqual(selected.runtimes,oldCatalog,'Selecting/saving a version does not rewrite its release catalog');
  assert.equal(selected.selected.runtime.runtimeVersion,pin.runtimeVersion);
  const result=await generatedPackage(f,cookie,'43-row combined runtime QA');
  assert.equal(result.config.runtime.runtimeVersion,'3.20.1');
  const codes=result.config.core.explicitUnits.map(u=>u.id);
  for(const [code,type]of rows)assert.equal(codes.includes(code),type!=='DRAFT',code);
  assert(codes.includes('m.box_3'));assert(!codes.includes('m_box_3'));
  assert.deepEqual(new Uint8Array(await(await req(f,old.path,cookie)).response.arrayBuffer()),old.bytes,'Old package download bytes are immutable across new runtime/import');
});

async function overrideFixture(){
  const {f,cookie}=await ready(),state=await settings(f,cookie);
  state.draft.units.push(...['m.box_3','__proto__'].map(code=>({code,type:'BTF',enabled:true,sizeMap:'display'})));
  ok(await save(f,cookie,state));
  const bytes=new TextEncoder().encode('/* prebid.js v11.11.0\nModules: consentManagementTcf,tcfControl,currency,adformBidAdapter */\nvoid 0;');
  const file=await storePrebidFile(prebidStore(f.env),bytes,TEST_EMAIL),prebid=ok(await req(f,'/test-api/prebid-settings',cookie));
  ok(await req(f,'/test-api/prebid-settings',cookie,{expectedRevision:prebid.revision,acknowledge:true,draft:{...prebid.draft,enablePrebid:true,buildId:file.file.id,bidders:[{bidder:'adform',params:{mid:123},enabled:true}],overrides:['m.box_3','__proto__'].map((code,i)=>({bidder:'adform',scopeType:'adunit',scopeKey:code,params:{mid:456+i},enabled:true}))}}));
  return {f,cookie};
}
for(const inactive of ['disabled','draft'])test(`3.20.1 TEST Save/Generate retains ${inactive} dotted/prototype override and restores it exactly on reactivation`,async()=>{
  const {f,cookie}=await overrideFixture(),before=await settings(f,cookie);
  const overrideRows=JSON.stringify(f.sqlite.prepare('SELECT * FROM bidder_overrides ORDER BY id').all());
  for(const u of before.draft.units.filter(u=>['m.box_3','__proto__'].includes(u.code)))if(inactive==='disabled')u.enabled=false;else u.type='DRAFT';
  ok(await save(f,cookie,before));
  const inactivePackage=await generatedPackage(f,cookie,'Inactive '+inactive);
  for(const code of ['m.box_3','__proto__']){
    assert(!inactivePackage.config.core.explicitUnits.some(u=>u.id===code));
    assert(!Object.hasOwn(inactivePackage.config.core.bidderAdUnitParams.adform??{},code));
  }
  assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM bidder_overrides ORDER BY id').all()),overrideRows);
  const reactivate=await settings(f,cookie);
  for(const u of reactivate.draft.units.filter(u=>['m.box_3','__proto__'].includes(u.code))){u.enabled=true;u.type='BTF';}
  ok(await save(f,cookie,reactivate));
  const active=await generatedPackage(f,cookie,'Reactivated '+inactive);
  for(const [i,code]of ['m.box_3','__proto__'].entries()){
    assert(active.config.core.explicitUnits.some(u=>u.id===code));
    assert.deepEqual(active.config.core.bidderAdUnitParams.adform[code],{mid:456+i});
  }
  assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM bidder_overrides ORDER BY id').all()),overrideRows);
  assert.deepEqual(new Uint8Array(await(await req(f,inactivePackage.path,cookie)).response.arrayBuffer()),inactivePackage.bytes);
  assert.equal(Object.prototype.mid,undefined);
});
test('3.20.1 TEST still rejects removing an actual enabled override target before writes',async()=>{
  const {f,cookie}=await overrideFixture(),state=await settings(f,cookie),before=storedRows(f),objects=f.objects.size;
  state.draft.units=state.draft.units.filter(u=>u.code!=='m.box_3');
  const rejected=await save(f,cookie,state);assert.equal(rejected.response.status,422);assert.match(rejected.data.error,/override|position|target/i);
  assert.equal(storedRows(f),before);assert.equal(f.objects.size,objects);
});
