/** Real App and MAIN measurement router; synthetic accounts/SQLite/R2, no ad execution. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {mainAbFixture,MAIN_AB_ORIGIN} from '../tests/support/ab-tests-main-fixture.mjs';

let outbound=0;
globalThis.fetch=()=>{outbound++;throw Error('Outbound traffic forbidden in navigation fixture');};
const h=await mainAbFixture(),experiments={};
await h.addSite('empty-site');await h.addSite('legacy-site');
for(const site of ['alpha-site','beta-site']){
  experiments[site]=[];
  for(const suffix of site==='alpha-site'?['one','two']:['one']){
    const result=await h.json(`/api/publishers/${site}/ab-tests`,{method:'POST',body:{
      a:h.versions[site][0],b:h.versions[site][1],name:`${site} measurement ${suffix}`,
      testId:`${site==='alpha-site'?'alpha':'beta'}_${suffix}`,trafficBPercent:50}},201);
    experiments[site].push({id:result.record.id,testId:result.record.testId,name:result.record.name});
  }
}
// This reproduces the previously hidden path without migrating the site's workflow.
for(const site of ['alpha-site','legacy-site']){
  const row=h.f.sqlite.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id=?').get(site);
  const config=JSON.parse(row.config_json);delete config.builtinRuntimeSelection;config.generatorProfileId='earlier-pilot-profile';
  h.f.sqlite.prepare('UPDATE publisher_configs SET config_json=? WHERE publisher_id=?').run(JSON.stringify(config),site);
}
const baseline=h.persistent();
const originalObjects=new Map([...h.r2.objects].map(([key,row])=>[key,createHash('sha256').update(row.bytes).digest('hex')]));
const publishers=[{id:'measurement-publisher',name:'Measurement Publisher',status:'active',sitesCount:4,notes:'',
  sites:['alpha-site','beta-site','empty-site','legacy-site'].map(site=>({id:site,publisherAccountId:'measurement-publisher',name:site+'.example.invalid',domain:site+'.example.invalid',
    gamPath:'/999/'+site+'/',status:'draft',currentVersion:'draft',adsTxtUrl:'https://example.invalid/ads.txt',updatedAt:'2026-11-23T00:00:00Z',lastPublishedAt:null,adUnitsCount:1,biddersCount:0}))}];
// Optional synthetic Politika route for CSV UI QA; no real publisher data is embedded.
if(process.argv.includes('--gam-reports')){
  const rows=publishers[0].sites;
  Object.assign(rows.find(site=>site.id==='alpha-site'),{name:'politika.rs',domain:'politika.rs',gamPath:'/22852026051/Politika.rs-Display/'});
  Object.assign(rows.find(site=>site.id==='beta-site'),{name:'tanjug.rs',domain:'tanjug.rs',gamPath:'/22852026051/Tanjug.rs-Display/'});
  Object.assign(rows.find(site=>site.id==='empty-site'),{name:'direktno.rs',domain:'direktno.rs',gamPath:'/22038436483/direktno/'});
}
if(process.argv.includes('--politika')){
  const site=publishers[0].sites.find(site=>site.id==='alpha-site');site.name='politika.rs';site.domain='politika.rs';
}
const bundle=await build({stdin:{contents:`
  import {createRoot} from 'react-dom/client';import App from './src/App';import './src/dashboard-styles';
  createRoot(document.getElementById('root')).render(<App/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,
  outdir:'.generated/measurement-navigation-fixture',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
const contextBundle=process.argv.includes('--gam-reports')?await build({stdin:{contents:`
  import {createRoot} from 'react-dom/client';import {useState} from 'react';import GamCsvImportPanel from './src/components/GamCsvImportPanel';import './src/dashboard-styles';
  function ContextFixture(){const [context,setContext]=useState({siteId:'same-site',siteName:'Context QA',siteDomain:'context.example.invalid',gamPath:'/999/context/'});window.__setGamContext=setContext;return <GamCsvImportPanel {...context}/>;}
  createRoot(document.getElementById('root')).render(<ContextFixture/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,
  outdir:'.generated/gam-csv-context-fixture',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}}):null;
console.log(JSON.stringify({ready:true,origin:MAIN_AB_ORIGIN,experiments,scope:'Real App and MAIN router; synthetic hierarchy, SQLite/R2, no ad or external traffic'}));
for await(const line of createInterface({input:process.stdin})){
  try{
    const input=JSON.parse(line),url=new URL(input.path,MAIN_AB_ORIGIN);let response;
    if(url.pathname==='/')response=new Response('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',{headers:{'content-type':'text/html'}});
    else if(url.pathname==='/__qa/gam-csv-context'&&contextBundle)response=new Response('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/context.css"></head><body><div id="root"></div><script src="/context.js"></script></body></html>',{headers:{'content-type':'text/html'}});
    else if(['/context.js','/context.css'].includes(url.pathname)&&contextBundle){
      const extension=url.pathname.endsWith('.js')?'.js':'.css';response=new Response(contextBundle.outputFiles.find(file=>file.path.endsWith(extension)).text,{headers:{'content-type':extension==='.js'?'application/javascript':'text/css'}});
    }
    else if(['/fixture.js','/fixture.css'].includes(url.pathname)){
      const extension=url.pathname.endsWith('.js')?'.js':'.css';response=new Response(bundle.outputFiles.find(file=>file.path.endsWith(extension)).text,{headers:{'content-type':extension==='.js'?'application/javascript':'text/css'}});
    }else if(url.pathname==='/tessera-logo.png')response=new Response(readFileSync('public/tessera-logo.png'),{headers:{'content-type':'image/png'}});
    else if(url.pathname==='/api/publisher-accounts')response=Response.json({publishers});
    else if(url.pathname==='/api/organization')response=Response.json({agencies:[],memberships:[]});
    else if(url.pathname==='/api/auth/me')response=Response.json({ok:true,user:{email:'measurement-qa@example.invalid'}});
    else if(url.pathname==='/api/health')response=Response.json({ok:true,database:'connected',storage:'connected',service:'Synthetic QA'});
    else if(url.pathname==='/__qa/inspect')response=Response.json({sqlUnchanged:h.persistent()===baseline,outboundRequests:outbound,
      originalObjectsUnchanged:[...originalObjects].every(([key,sha])=>h.r2.objects.has(key)&&createHash('sha256').update(h.r2.objects.get(key).bytes).digest('hex')===sha),
      addedObjectKeys:[...h.r2.objects.keys()].filter(key=>!originalObjects.has(key)),
      financialDataPersisted:[...h.r2.objects.values()].some(row=>new TextDecoder().decode(row.bytes).includes('9876.543219'))});
    else if(!url.pathname.startsWith('/api/'))response=new Response('Not found',{status:404});
    else response=await h.request(input.path,{method:input.method,body:input.body??undefined});
    assert(response instanceof Response);
    console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
  }catch(error){console.log(JSON.stringify({error:error.message,stack:error.stack}));}
}
h.close();
