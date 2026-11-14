// Actual component and authenticated Worker, local SQLite only; no hosted traffic.
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {build} from 'esbuild';
import worker from '../worker/app-builtin-runtime-preview.ts';
import {adminAuditStore} from '../tests/support/admin-audit-store.mjs';
import {TEST_EMAIL,TEST_PASSWORD,TEST_SECRET} from '../tests/support/test-workspace-store.mjs';
const origin='https://map-audit.fixture.invalid',siteId='audit-site';
const f=adminAuditStore({config:{enablePrebid:false}});
const mapping=(name,enabled=true)=>({id:name,name,enabled,priority:100,match:'all',conditions:[{key:'category',operator:'equals',value:'Naslovna'}],sizeMapKey:'home',slotAction:'inherit'});
f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('home-map',?,'home',?)").run(siteId,JSON.stringify([{minViewPort:[0,0],sizes:[[300,250]]},{minViewPort:[768,0],sizes:[[300,300],[300,250]]}]));
// Page-type map of P1's base map "display" (selected by name for pageType "naslovna").
f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('naslovna-display-map',?,'naslovna_display',?)").run(siteId,JSON.stringify([{minViewPort:[0,0],sizes:[[300,250]]},{minViewPort:[768,0],sizes:[[300,250],[250,250]]}]));
// A page-type map of "display" with a long saved name (one unbreakable token): it must wrap in its card
// heading and in the dialog title without hiding the references badge or the close button.
const LONG_PREFIX='vesti_sport_regionalno_beograd_i_okolina_najnovije_vesti_dana_iz_grada_i_regiona_sa_fotografijama';
f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('long-display-map',?,?,?)").run(siteId,LONG_PREFIX+'_display',JSON.stringify([{minViewPort:[0,0],sizes:[[300,250]]}]));
const rule={conditionalMappings:[mapping('Homepage'),mapping('Future disabled',false)]};
f.sqlite.prepare("INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES('home-rule',?,'P1',?)").run(siteId,JSON.stringify(rule));
f.writeConfig({...f.readConfig(),unitRules:{P1:rule},advancedUnitRules:{P1:{conditionalMappings:[mapping('Advanced homepage')]}}});
Object.assign(f.env,{ADMIN_EMAIL:TEST_EMAIL,ADMIN_PASSWORD:TEST_PASSWORD,SESSION_SECRET:TEST_SECRET,ASSETS:{fetch(){throw Error('No remote assets');}}});
globalThis.fetch=()=>{throw Error('Outbound requests forbidden');};
const ctx={waitUntil(){},passThroughOnException(){}};
const login=await worker.fetch(new Request(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env,ctx);
assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
const bundle=await build({stdin:{contents:`import{createRoot}from'react-dom/client';import{useState}from'react';import UnitRulesPanel from'./src/components/UnitRulesPanel';import SizeMapsCompatPanel from'./src/components/SizeMapsCompatPanel';import'./src/dashboard-styles';function Fixture(){const[view,setView]=useState('maps');return <main style={{maxWidth:1200,margin:'24px auto',padding:16,minWidth:0}}><h1>Size map fixture</h1><nav><button onClick={()=>setView('maps')}>Size maps</button><button onClick={()=>setView('rules')}>Unit rules</button></nav>{view==='maps'?<SizeMapsCompatPanel publisherId="audit-site"/>:<UnitRulesPanel publisherId="audit-site"/>}</main>;}createRoot(document.getElementById('root')).render(<Fixture/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:'.generated/size-map-references-fixture',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
console.log(JSON.stringify({ready:true,siteId}));
for await(const line of createInterface({input:process.stdin})){
 try{
  const input=JSON.parse(line);let response;
  if(input.path==='/')response=new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',{headers:{'content-type':'text/html'}});
  else if(['/fixture.js','/fixture.css'].includes(input.path)){
   const ext=input.path.endsWith('.js')?'.js':'.css';response=new Response(bundle.outputFiles.find(file=>file.path.endsWith(ext)).text,{headers:{'content-type':ext==='.js'?'application/javascript':'text/css'}});
  }else if(input.path==='/__fixture/snapshot')response=Response.json({config:f.readConfig(),rules:f.sqlite.prepare('SELECT rule_json FROM unit_rules').all(),maps:f.sqlite.prepare('SELECT id,name FROM size_maps').all(),units:f.sqlite.prepare('SELECT code,size_map_key FROM ad_units ORDER BY code').all()});
  // A change made in "another tab": written directly, the open page is not reloaded.
  else if(input.path==='/__fixture/insert-map'&&input.method==='POST'){const row=JSON.parse(input.body);f.sqlite.prepare('INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES(?,?,?,?)').run(row.id,siteId,row.name,JSON.stringify(row.map));response=Response.json({ok:true});}
  else if(input.path==='/__fixture/delete-unit'&&input.method==='POST'){f.sqlite.prepare('DELETE FROM ad_units WHERE publisher_id=? AND id=?').run(siteId,JSON.parse(input.body).id);response=Response.json({ok:true});}
  // P1 as Outstream with map-based player sizing (no saved choices: every current row has one video size).
  else if(input.path==='/__fixture/outstream'&&input.method==='POST'){const c=f.readConfig();f.writeConfig({...c,runtimeControls:{...c.runtimeControls,outstream:{schemaVersion:1,units:{P1:{format:'banner-outstream',playerSizing:'size-map',playerSizes:{}}}}}});response=Response.json({ok:true});}
  else if(input.path==='/__fixture/insert-unit'&&input.method==='POST'){const row=JSON.parse(input.body);f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,sort_order) VALUES(?,?,?,'BTF',?,?)").run(row.id,siteId,row.code,row.sizeMapKey,row.sortOrder);response=Response.json({ok:true});}
  else response=await worker.fetch(new Request(origin+input.path,{method:input.method,headers:{origin,cookie,...(input.body?{'content-type':'application/json'}:{})},body:input.body||undefined}),f.env,ctx);
  console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
 }catch(error){console.log(JSON.stringify({error:error.message}));}
}
f.close();
