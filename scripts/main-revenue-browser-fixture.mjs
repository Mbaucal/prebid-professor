// Local-only MAIN Worker + SQLite + in-memory R2. No hosted credentials or traffic.
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import worker from '../worker/app-builtin-runtime-preview.ts';
import {workspaceStore,TEST_EMAIL,TEST_PASSWORD,TEST_SECRET} from '../tests/support/test-workspace-store.mjs';
import {parsePrebidHeader,sha256} from '../worker/runtime/prebid-artifact-check.mjs';
const origin='https://main-revenue.fixture.invalid',siteId='main-site';
const setupScenario=process.argv.find(arg=>arg.startsWith('--script-setup='))?.split('=')[1];
if(setupScenario)assert(['new','legacy','readiness','current'].includes(setupScenario));
const f=workspaceStore();
f.sqlite.exec(readFileSync('migrations/0001_initial.sql','utf8').split('INSERT OR IGNORE INTO publishers')[0]);
f.sqlite.exec(readFileSync('migrations/0003_external_deployments.sql','utf8'));
f.sqlite.prepare('INSERT INTO publishers(id,name,domain,gam_path) VALUES(?,?,?,?)').run(siteId,'Synthetic MAIN site','main.example.invalid','/123/main/');
f.sqlite.prepare('INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES(?,?,?)').run('config',siteId,JSON.stringify({enablePrebid:true,runtimeControls:{sticky:{bottomAdUnitId:''},floors:{enabled:false},output:{cleanComments:true}}}));
f.sqlite.prepare('INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,sort_order) VALUES(?,?,?,?,?,?)').run('unit',siteId,'Billboard','ATF','display',0);
f.sqlite.prepare('INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES(?,?,?,?)').run('map',siteId,'display',JSON.stringify([{minViewPort:[0,0],sizes:[[300,250]]},{minViewPort:[1024,0],sizes:[[640,360]]},{minViewPort:[1600,0],sizes:[]}]));
f.sqlite.prepare('INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES(?,?,?,?)').run('rule',siteId,'__DEFAULT__',JSON.stringify({timeout:1500,refresh:{enabled:false}}));
f.sqlite.prepare('INSERT INTO bidders(id,publisher_id,bidder,params_json,enabled) VALUES(?,?,?,?,1)').run('bidder',siteId,'pubmatic',JSON.stringify({publisherId:'synthetic',adSlot:'synthetic'}));
const objects=new Map(),prebid=new Uint8Array(readFileSync('vendor/prebid/tanjug-11.34.0/prebid.js')),prebidKey='publishers/'+siteId+'/prebid-builds/original/prebid.js';
objects.set(prebidKey,{bytes:prebid,metadata:{sha256:await sha256(prebid)}});
const prebidHeader=parsePrebidHeader(new TextDecoder().decode(prebid));
f.sqlite.prepare("INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES('original',?,?,?,?,'current')").run(siteId,prebidHeader.version,prebidKey,JSON.stringify(prebidHeader.modules));
f.env.BUILDS={
 async get(key){assert(key.startsWith('publishers/'+siteId+'/'));const row=objects.get(key);return row?{size:row.bytes.length,customMetadata:row.metadata,arrayBuffer:async()=>row.bytes.slice().buffer,text:async()=>new TextDecoder().decode(row.bytes)}:null;},
 async put(key,bytes,options){assert(key.startsWith('publishers/'+siteId+'/'));assert.equal(options.onlyIf.get('if-none-match'),'*');if(objects.has(key))return null;objects.set(key,{bytes:new Uint8Array(bytes).slice(),metadata:options.customMetadata});return {};}
};
Object.assign(f.env,{ADMIN_EMAIL:TEST_EMAIL,ADMIN_PASSWORD:TEST_PASSWORD,SESSION_SECRET:TEST_SECRET,ASSETS:{fetch(){throw Error('No remote assets');}}});
globalThis.fetch=()=>{throw Error('Outbound network forbidden in MAIN revenue fixture');};
const ctx={waitUntil(){},passThroughOnException(){}};
const login=await worker.fetch(new Request(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env,ctx);
assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
async function api(path,body){const response=await worker.fetch(new Request(origin+path,{method:body?'POST':'GET',headers:{origin,cookie,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),f.env,ctx);const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
const selection=await api('/api/publishers/'+siteId+'/builtin-site-settings');
const runtime=selection.runtimes.find(r=>r.version==='3.16.0-revenue.preview.3');assert(runtime,'MAIN catalog must include revenue preview.3');
const selectedRuntime=selection.runtimes.find(r=>r.version===(setupScenario==='legacy'?'3.10.0-tessera.preview.1':setupScenario==='readiness'?'3.14.0':runtime.version));
if(setupScenario!=='new')await api('/api/publishers/'+siteId+'/builtin-site-settings',{action:'version',revision:selection.revision,runtime:selectedRuntime.pin,allowPreview:true});
const bundle=await build({stdin:{contents:`
 import {createRoot} from 'react-dom/client';import {useState} from 'react';
 import ConfigPanel from './src/components/ConfigPanel';
 import SitePackagesPanel from './src/components/SitePackagesPanel';
 import './src/dashboard-styles';
 function Fixture(){const[view,setView]=useState('config');return <main style={{maxWidth:1200,margin:'24px auto',padding:16}}>
 <h1>Synthetic MAIN site</h1><nav className="runtime-actions"><button onClick={()=>setView('config')}>Configuration</button><button onClick={()=>setView('packages')}>Generate and releases</button></nav>
 {view==='config'?<ConfigPanel publisherId="main-site" initialSection="${setupScenario?'generator-profiles':'ad-units'}" onOpenPrebid={()=>setView('prebid')}/>:view==='prebid'?<h2>Prebid.js destination</h2>:<SitePackagesPanel publisherId="main-site"/>}</main>}
 createRoot(document.getElementById('root')).render(<Fixture/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:'.generated/main-revenue-fixture',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
console.log(JSON.stringify({ready:true,siteId,runtimeVersion:runtime.version,setupScenario:setupScenario??null}));
for await(const line of createInterface({input:process.stdin})){
 try{
  const input=JSON.parse(line);let response;
  if(input.path==='/')response=new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',{headers:{'content-type':'text/html'}});
  else if(['/fixture.js','/fixture.css'].includes(input.path)){const ext=input.path.endsWith('.js')?'.js':'.css';response=new Response(bundle.outputFiles.find(file=>file.path.endsWith(ext)).text,{headers:{'content-type':ext==='.js'?'application/javascript':'text/css'}});}
  else response=await worker.fetch(new Request(origin+input.path,{method:input.method,headers:{origin,cookie,...(input.body?{'content-type':'application/json'}:{})},body:input.body||undefined}),f.env,ctx);
  console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
 }catch(error){console.log(JSON.stringify({error:error.message}));}
}
f.close();
