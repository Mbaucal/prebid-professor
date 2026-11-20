/** Real MAIN router + ConfigPanel and the actual isolated TEST workspace. Local SQLite/R2 only. */
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {build} from 'esbuild';
import {mainAbFixture,MAIN_AB_ORIGIN} from '../tests/support/ab-tests-main-fixture.mjs';
import testWorker from '../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../tests/support/test-workspace-store.mjs';
const main=await mainAbFixture(),test=workspaceStore();
const login=await testWorker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),test.env);
const cookie=login.headers.get('set-cookie').split(';')[0];
const testRequest=(path,method='GET',body)=>testWorker.fetch(new Request(ORIGIN+path,{method,headers:{origin:ORIGIN,cookie,...(body?{'content-type':'application/json'}:{})},body:body||undefined}),test.env);
assert.equal((await testRequest('/test-api/setup','POST',JSON.stringify({confirm:'prepare-empty-test-database'}))).status,200);
const bundle=await build({stdin:{contents:`
 import {createRoot} from 'react-dom/client';import {useState} from 'react';
 import ConfigPanel from './src/components/ConfigPanel';import ScriptSetupPanel from './src/components/ScriptSetupPanel';import './src/dashboard-styles';
 function Fixture(){const[view,setView]=useState('timing');return <main style={{maxWidth:1200,margin:'24px auto',padding:16}}><h1>Synthetic MAIN timing editor</h1><nav className="runtime-actions"><button onClick={()=>setView('setup')}>Script setup</button><button onClick={()=>setView('timing')}>Auction timing</button></nav>{view==='setup'?<ScriptSetupPanel publisherId="alpha-site"/>:<ConfigPanel publisherId="alpha-site" initialSection="advanced-rules"/>}</main>}createRoot(document.getElementById('root')).render(<Fixture/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:'.generated/adaptive-timeout-ui/fixture',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
globalThis.fetch=()=>{throw Error('Outbound network forbidden in local timeout UI fixture');};
console.log(JSON.stringify({ready:true,mainOrigin:MAIN_AB_ORIGIN,testOrigin:ORIGIN,scope:'Actual MAIN authenticated router/shared ConfigPanel and actual isolated TEST editor; no generated ads executed'}));
for await(const line of createInterface({input:process.stdin})){
 try{const input=JSON.parse(line);let response;
  if(input.origin===ORIGIN)response=await testRequest(input.path,input.method,input.body);
  else if(input.path==='/')response=new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',{headers:{'content-type':'text/html'}});
  else if(['/fixture.js','/fixture.css'].includes(input.path)){const ext=input.path.endsWith('.js')?'.js':'.css';response=new Response(bundle.outputFiles.find(file=>file.path.endsWith(ext)).text,{headers:{'content-type':ext==='.js'?'application/javascript':'text/css'}});}
  else response=await main.request(input.path,{method:input.method,body:input.body??undefined});
  console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
 }catch(error){console.log(JSON.stringify({error:error.message}));}
}
main.close();test.close();
