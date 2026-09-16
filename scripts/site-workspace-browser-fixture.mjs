import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import worker from '../worker/test-workspace/index.mjs';
import { workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD } from '../tests/support/test-workspace-store.mjs';
const f=workspaceStore();
globalThis.fetch=()=>{throw Error('External network is forbidden in this fixture');};
const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
const cookie=login.headers.get('set-cookie').split(';')[0];
await worker.fetch(new Request(ORIGIN+'/test-api/setup',{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({confirm:'prepare-empty-test-database'})}),f.env);
// Exercise the main Releases wrapper with the same real site services in an
// ephemeral fixture. These routes and synthetic data are never deployed.
const setupMode=process.argv.includes('--release-setup');let harness;
if(setupMode){
 const config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);config.enablePrebid=true;
 f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
 harness=await build({stdin:{contents:`
  import {createRoot} from 'react-dom/client';import {useState} from 'react';
  import ReleasesPanel from './src/components/ReleasesPanel';
  import SiteRuntimePanel from './src/components/SiteRuntimePanel';
  function Fixture(){const [view,setView]=useState('packages');return <main>
   <button onClick={()=>setView('versions')}>Script versions</button>
   {view==='packages'?<ReleasesPanel publisherId="test-site" siteName="Fixture" onNavigate={setView}/>
   :view==='versions'?<SiteRuntimePanel publisherId="test-site" view="versions" onOpenPrebid={()=>setView('prebid')}/>
   :<h2>Prebid.js destination</h2>}</main>}
  createRoot(document.getElementById('root')).render(<Fixture/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:'.generated/release-setup',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
}
console.log(JSON.stringify({ready:true}));
for await(const line of createInterface({input:process.stdin})){
 try{const body=JSON.parse(line);let response;
 if(setupMode&&body.path==='/setup')response=new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/setup.css"><div id="root"></div><script src="/setup.js"></script>',{headers:{'content-type':'text/html'}});
 else if(setupMode&&['/setup.js','/setup.css'].includes(body.path)){const ext=body.path.endsWith('.js')?'.js':'.css';response=new Response(harness.outputFiles.find(f=>f.path.endsWith(ext)).text,{headers:{'content-type':ext==='.js'?'application/javascript':'text/css'}});}
 else {
  const aliases={'/api/publishers/test-site/builtin-site-settings':'/test-api/site-runtime','/api/publishers/test-site/builtin-releases':'/test-api/site-packages'};
  response=await worker.fetch(new Request(ORIGIN+(setupMode?aliases[body.path]??body.path:body.path),{method:body.method,headers:{cookie,origin:ORIGIN,...(body.body?{'content-type':'application/json'}:{})},body:body.body||undefined}),f.env);
 }
 console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));}
 catch(e){console.log(JSON.stringify({error:e.message}));}
}
f.close();
