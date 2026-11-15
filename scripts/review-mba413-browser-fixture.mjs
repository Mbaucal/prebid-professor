// Independent QA: actual React/Worker with in-memory SQLite, no external traffic.
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {readFileSync,readdirSync} from 'node:fs';
import {build} from 'esbuild';
import worker from '../worker/app-builtin-runtime-preview.ts';
import {workspaceStore,TEST_EMAIL,TEST_PASSWORD,TEST_SECRET} from '../tests/support/test-workspace-store.mjs';
const origin='https://accounts-review.fixture.invalid',siteId='account-review-site';
const f=workspaceStore();
for(const name of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort())f.sqlite.exec(readFileSync('migrations/'+name,'utf8'));
f.sqlite.prepare('INSERT INTO publishers(id,name,domain,gam_path) VALUES(?,?,?,?)').run(siteId,'Account review fixture','accounts.example.invalid','/123/accounts/');
f.sqlite.prepare('INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES(?,?,?)').run('account-review-config',siteId,JSON.stringify({enablePrebid:false,runtimeControls:{schain:{enabled:true,version:'1.0',complete:1,nodes:[{asi:'site-seller.example',sid:'site-account',hp:1}]}}}));
f.sqlite.prepare('INSERT INTO ad_units(id,publisher_id,code,type,size_map_key) VALUES(?,?,?,?,?)').run('review-p1',siteId,'P1','BTF','display');
f.sqlite.prepare('INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES(?,?,?,?)').run('review-map',siteId,'display',JSON.stringify([{minViewPort:[0,0],sizes:[[300,250]]}]));
f.sqlite.prepare('INSERT INTO bidders(id,publisher_id,bidder,params_json) VALUES(?,?,?,?)').run('legacy-bidder',siteId,'pubmatic','{"publisherId":"legacy","adSlot":"P1"}');
Object.assign(f.env,{ADMIN_EMAIL:TEST_EMAIL,ADMIN_PASSWORD:TEST_PASSWORD,SESSION_SECRET:TEST_SECRET,ASSETS:{fetch(){throw Error('Remote assets are forbidden');}}});
globalThis.fetch=()=>{throw Error('Outbound requests are forbidden');};
const ctx={waitUntil(){},passThroughOnException(){}};
const login=await worker.fetch(new Request(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env,ctx);
assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
async function api(path,method='GET',body){return worker.fetch(new Request(origin+path,{method,headers:{origin,cookie,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),f.env,ctx);}
const endpoint=`/api/publishers/${siteId}/builtin-site-settings`,state=await(await api(endpoint)).json();
const requested=process.argv.find(arg=>arg.startsWith('--runtime='))?.split('=')[1]??'3.22.1';
const selected=state.runtimes.find(row=>row.version===requested);assert(selected,'Missing requested runtime '+requested);
const selection=await api(endpoint,'POST',{action:'version',revision:state.revision,runtime:selected.pin,allowPreview:selected.channel!=='stable'});assert.equal(selection.status,200,await selection.text());
const contents=`import{createRoot}from'react-dom/client';import{useState}from'react';import BiddersPanel from'./src/components/BiddersPanel';import ScriptSetupPanel from'./src/components/ScriptSetupPanel';import'./src/dashboard-styles';function Fixture(){const[view,setView]=useState('demand');return<main style={{maxWidth:1200,margin:'24px auto',padding:16}}><h1>Account review fixture</h1><nav className="runtime-actions"><button onClick={()=>setView('demand')}>Demand</button><button onClick={()=>setView('setup')}>Script setup</button></nav>{view==='demand'?<BiddersPanel publisherId="${siteId}"/>:<ScriptSetupPanel publisherId="${siteId}"/>}</main>}createRoot(document.getElementById('root')).render(<Fixture/>);`;
const bundle=await build({stdin:{contents,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:'.generated/review-mba413-fixture',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
console.log(JSON.stringify({ready:true,siteId,runtime:requested}));
for await(const line of createInterface({input:process.stdin})){
 try{
  const input=JSON.parse(line);let response;
  if(input.path==='/')response=new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',{headers:{'content-type':'text/html'}});
  else if(['/fixture.js','/fixture.css'].includes(input.path)){const ext=input.path.endsWith('.js')?'.js':'.css';response=new Response(bundle.outputFiles.find(file=>file.path.endsWith(ext)).text,{headers:{'content-type':ext==='.js'?'application/javascript':'text/css'}});}
  else if(input.path==='/__fixture/snapshot')response=Response.json({bidders:f.sqlite.prepare('SELECT * FROM bidders WHERE publisher_id=? ORDER BY bidder').all(siteId),overrides:f.sqlite.prepare('SELECT * FROM bidder_overrides WHERE publisher_id=? ORDER BY bidder,scope_type,scope_key').all(siteId),config:JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id=?').get(siteId).config_json)});
  else response=await api(input.path,input.method,input.body?JSON.parse(input.body):undefined);
  console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
 }catch(error){console.log(JSON.stringify({error:error.message}));}
}
f.close();
