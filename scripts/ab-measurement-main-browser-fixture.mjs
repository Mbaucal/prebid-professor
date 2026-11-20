/** Actual MAIN router and React, local SQLite/fake R2, no ad execution or outbound traffic. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {build} from 'esbuild';
import {mainAbFixture,MAIN_AB_ORIGIN} from '../tests/support/ab-tests-main-fixture.mjs';

let outbound=0;
globalThis.fetch=()=>{outbound++;throw Error('Outbound traffic forbidden in measurement fixture');};
const h=await mainAbFixture(),experiments={};
for(const site of ['alpha-site','beta-site']){
  const result=await h.json(`/api/publishers/${site}/ab-tests`,{method:'POST',body:{a:h.versions[site][0],b:h.versions[site][1],
    name:site==='alpha-site'?'Alpha measurement experiment':'Beta measurement experiment',testId:site==='alpha-site'?'measure_alpha':'measure_beta',trafficBPercent:50}},201);
  experiments[site]={id:result.record.id,testId:result.record.testId,name:result.record.name};
}
const baseline=h.persistent();let removed=null;
const bundle=await build({stdin:{contents:`
  import {createRoot} from 'react-dom/client';import {useState} from 'react';
  import SitePackagesPanel from './src/components/SitePackagesPanel';import './src/dashboard-styles';
  function Fixture(){const[site,setSite]=useState('alpha-site');return <main data-site={site} style={{maxWidth:1200,margin:'24px auto',padding:16}}>
    <h1>MAIN measurement fixture</h1><nav aria-label="Fixture site selection"><button onClick={()=>setSite('alpha-site')}>Alpha site</button><button onClick={()=>setSite('beta-site')}>Beta site</button></nav>
    <SitePackagesPanel key={site} publisherId={site}/></main>}
  createRoot(document.getElementById('root')).render(<Fixture/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,
  outdir:'.generated/ab-measurement-main-fixture',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
console.log(JSON.stringify({ready:true,origin:MAIN_AB_ORIGIN,experiments,scope:'Actual MAIN router/React and synthetic GAM-only saved packages, SQLite and strict fake R2; no ad scripts or live GAM'}));
for await(const line of createInterface({input:process.stdin})){
  try{
    const input=JSON.parse(line);let response;
    if(input.path==='/')response=new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',{headers:{'content-type':'text/html'}});
    else if(['/fixture.js','/fixture.css'].includes(input.path)){
      const extension=input.path.endsWith('.js')?'.js':'.css';response=new Response(bundle.outputFiles.find(file=>file.path.endsWith(extension)).text,{headers:{'content-type':extension==='.js'?'application/javascript':'text/css'}});
    }else if(input.path==='/__qa/inspect'){
      const rawMarker='9876.543219';
      response=Response.json({unchanged:h.persistent()===baseline,outboundRequests:outbound,puts:h.r2.log.puts,
        financialDataPersisted:[...h.r2.objects.values()].some(row=>new TextDecoder().decode(row.bytes).includes(rawMarker)),
        persistentSha256:createHash('sha256').update(h.persistent()).digest('hex')});
    }else if(input.path==='/__qa/source-off'){
      // A known missing draft source (404), not an uncertain R2 read fault. Stored plans keep their own scope copy.
      const id=h.versions['alpha-site'][1];removed??=h.f.sqlite.prepare('SELECT * FROM releases WHERE id=?').get(id);
      h.f.sqlite.prepare('DELETE FROM releases WHERE id=?').run(id);response=Response.json({removed:id});
    }else if(input.path==='/__qa/source-on'){
      if(removed){const keys=Object.keys(removed);h.f.sqlite.prepare(`INSERT INTO releases(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>removed[key]));removed=null;}
      response=Response.json({restored:true});
    }else response=await h.request(input.path,{method:input.method,body:input.body??undefined});
    assert(response instanceof Response);
    console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
  }catch(error){console.log(JSON.stringify({error:error.message,stack:error.stack}));}
}
h.close();
