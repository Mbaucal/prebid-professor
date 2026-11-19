// MAIN API/React fixture only: SQLite + strict fake R2, no external assets or ads.
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {build} from 'esbuild';
import {mainAbFixture,MAIN_AB_ORIGIN} from '../tests/support/ab-tests-main-fixture.mjs';
import {createHash} from 'node:crypto';
const h=await mainAbFixture();
globalThis.fetch=()=>{throw Error('Outbound traffic forbidden in MAIN A/B fixture');};
await h.json('/api/publishers/beta-site/ab-tests',{method:'POST',body:{a:h.versions['beta-site'][0],b:h.versions['beta-site'][1],name:'Beta existing test',testId:'beta_existing',trafficBPercent:50}},201);
const initial=h.persistent();
const bundle=await build({stdin:{contents:`
 import {createRoot} from 'react-dom/client';import {useState} from 'react';
 import SitePackagesPanel from './src/components/SitePackagesPanel';import './src/dashboard-styles';
 function Fixture(){const[site,setSite]=useState('alpha-site');return <main data-site={site} style={{maxWidth:1200,margin:'24px auto',padding:16}}>
 <h1>MAIN A/B fixture</h1><nav aria-label="Fixture site selection"><button onClick={()=>setSite('alpha-site')}>Alpha site</button><button onClick={()=>setSite('beta-site')}>Beta site</button></nav>
 <SitePackagesPanel publisherId={site}/></main>}
 createRoot(document.getElementById('root')).render(<Fixture/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:'.generated/ab-tests-main-fixture',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
console.log(JSON.stringify({ready:true,origin:MAIN_AB_ORIGIN,versions:h.versions,scope:'Actual MAIN router and React; local SQLite and fake R2 only'}));
for await(const line of createInterface({input:process.stdin})){
 try{
  const input=JSON.parse(line);let response;
  if(input.path==='/')response=new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',{headers:{'content-type':'text/html'}});
  else if(['/fixture.js','/fixture.css'].includes(input.path)){const extension=input.path.endsWith('.js')?'.js':'.css';response=new Response(bundle.outputFiles.find(file=>file.path.endsWith(extension)).text,{headers:{'content-type':extension==='.js'?'application/javascript':'text/css'}});}
  else if(input.path==='/__qa/inspect')response=Response.json({unchanged:h.persistent()===initial,persistentSha256:createHash('sha256').update(h.persistent()).digest('hex'),puts:h.r2.log.puts,sites:h.versions});
  else response=await h.request(input.path,{method:input.method,body:input.body??undefined});
  assert(response instanceof Response);
  console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
 }catch(error){console.log(JSON.stringify({error:error.message,stack:error.stack}));}
}
h.close();
