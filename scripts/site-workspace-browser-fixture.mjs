import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import worker from '../worker/test-workspace/index.mjs';
import { siteRuntimeResponse } from '../worker/site-runtime/service.mjs';
import { packageResponse } from '../worker/site-runtime/releases.mjs';
import { workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD } from '../tests/support/test-workspace-store.mjs';
const revenueMode=process.argv.includes('--revenue');
const f=workspaceStore({prebidFiles:revenueMode});
if(process.argv.includes('--cleanup')){
 f.env.BUILDS.delete=async keys=>{for(const key of keys)f.objects.delete(key);};
 f.env.BUILDS.head=async key=>f.objects.has(key)?{key}:null;
}
globalThis.fetch=()=>{throw Error('External network is forbidden in this fixture');};
let cookie;
if(revenueMode){({cookie}=await(await import('../tests/support/revenue-workspace-fixture.mjs')).initializeRevenueWorkspace(f,{runtimeId:'tessera-revenue-preview-2',legacyTakeOver:true}));}
else {
const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
cookie=login.headers.get('set-cookie').split(';')[0];
await worker.fetch(new Request(ORIGIN+'/test-api/setup',{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({confirm:'prepare-empty-test-database'})}),f.env);
}
// Exercise the main Releases wrapper with the same real site services in an
// ephemeral fixture. These routes and synthetic data are never deployed.
const setupMode=process.argv.includes('--release-setup');let harness;
if(setupMode){
 const config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);config.enablePrebid=true;
 f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
 harness=await build({stdin:{contents:`
  import {createRoot} from 'react-dom/client';import {useState} from 'react';
  import ReleasesPanel from './src/components/ReleasesPanel';
  import ScriptSetupPanel from './src/components/ScriptSetupPanel';
  function Fixture(){const [view,setView]=useState('packages');return <main>
   <button onClick={()=>setView('versions')}>Script setup</button>
   {view==='packages'?<ReleasesPanel publisherId="test-site" siteName="Fixture" onNavigate={setView}/>
   :view==='versions'?<ScriptSetupPanel publisherId="test-site" onOpenPrebid={()=>setView('prebid')}/>
   :<h2>Prebid.js destination</h2>}</main>}
  createRoot(document.getElementById('root')).render(<Fixture/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:'.generated/release-setup',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
}
async function dispatch(body){
 let response;
 if(setupMode&&body.path==='/setup')response=new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/setup.css"><div id="root"></div><script src="/setup.js"></script>',{headers:{'content-type':'text/html'}});
 else if(setupMode&&['/setup.js','/setup.css'].includes(body.path)){const ext=body.path.endsWith('.js')?'.js':'.css';response=new Response(harness.outputFiles.find(f=>f.path.endsWith(ext)).text,{headers:{'content-type':ext==='.js'?'application/javascript':'text/css'}});}
 else {
  const request=new Request(ORIGIN+body.path,{method:body.method,headers:{cookie,origin:ORIGIN,...(body.body?{'content-type':'application/json'}:{})},body:body.body||undefined});
  // The main imported-site scenario uses its shared service handlers directly.
  // TEST's editor-completion prerequisite is not part of the main site flow.
  if(setupMode&&body.path==='/api/publishers/test-site/builtin-site-settings')response=await siteRuntimeResponse(request,f.env,'test-site',TEST_EMAIL);
  else if(setupMode&&body.path==='/api/publishers/test-site/builtin-releases')response=await packageResponse(request,f.env,'test-site',TEST_EMAIL,{testOnly:true});
  else response=await worker.fetch(request,f.env);
 }
 return response;
}
// Native anchor downloads may bypass Playwright page routing. The optional
// loopback server exercises those downloads against this same ephemeral Worker.
const httpRequests=[];let server;
if(process.argv.includes('--http')){
 server=createServer(async(req,res)=>{
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const response=await dispatch({path:req.url,method:req.method,body:chunks.length?Buffer.concat(chunks).toString():null});
   httpRequests.push({path:req.url,method:req.method,status:response.status});
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
}
console.log(JSON.stringify({ready:true,...(server?{origin:`http://127.0.0.1:${server.address().port}`}:{})}));
for await(const line of createInterface({input:process.stdin})){
 try{
  const body=JSON.parse(line);
  if(body.inspectHttpRequests){console.log(JSON.stringify({httpRequests}));continue;}
  const response=await dispatch(body);
  console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
 }catch(e){console.log(JSON.stringify({error:e.message}));}
}
if(server)await new Promise(resolve=>server.close(resolve));
f.close();
