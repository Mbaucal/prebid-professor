// Actual dashboard + authenticated MAIN router. Original bytes are offline fixtures and never executed.
import {readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {build} from 'esbuild';
import {mainAbFixture,MAIN_AB_ORIGIN} from '../tests/support/ab-tests-main-fixture.mjs';
import {ORIGINAL_SOURCES} from '../worker/experiments/original-source-catalog.mjs';
let sourceReads=0;
globalThis.fetch=async(url,options)=>{
  const source=ORIGINAL_SOURCES.find(s=>s.url===url);if(!source||options.redirect!=='manual')throw Error('Unexpected outbound request');
  sourceReads++;return new Response(readFileSync(`tests/fixtures/politika-originals/${source.side}.js`));
};
const h=await mainAbFixture({seed:false});await h.addSite('politika');
const baseline=h.persistent();
const publishers=[{id:'politika',name:'Politika Online',status:'active',sitesCount:1,notes:'',sites:[{
  id:'politika',publisherAccountId:'politika',name:'politika.rs',domain:'politika.rs',gamPath:'/23339552141/Politika.rs/',status:'draft',
  currentVersion:'draft',adsTxtUrl:'https://example.invalid/ads.txt',updatedAt:'2026-11-27T00:00:00Z',lastPublishedAt:null,adUnitsCount:1,biddersCount:0}]}];
const bundle=await build({stdin:{contents:`import {createRoot} from 'react-dom/client';import App from './src/App';import './src/dashboard-styles';createRoot(document.getElementById('root')).render(<App/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:'.generated/original-sources-fixture',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
console.log(JSON.stringify({ready:true,origin:MAIN_AB_ORIGIN}));
for await(const line of createInterface({input:process.stdin})){
  try{
    const input=JSON.parse(line),url=new URL(input.path,MAIN_AB_ORIGIN);let response;
    if(url.pathname==='/')response=new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',{headers:{'content-type':'text/html'}});
    else if(['/fixture.js','/fixture.css'].includes(url.pathname)){const ext=url.pathname.endsWith('.js')?'.js':'.css';response=new Response(bundle.outputFiles.find(f=>f.path.endsWith(ext)).text,{headers:{'content-type':ext==='.js'?'application/javascript':'text/css'}});}
    else if(url.pathname==='/tessera-logo.png')response=new Response(readFileSync('public/tessera-logo.png'),{headers:{'content-type':'image/png'}});
    else if(url.pathname==='/api/publisher-accounts')response=Response.json({publishers});
    else if(url.pathname==='/api/organization')response=Response.json({agencies:[],memberships:[]});
    else if(url.pathname==='/api/auth/me')response=Response.json({ok:true,user:{email:'original-sources-qa@example.invalid'}});
    else if(url.pathname==='/api/health')response=Response.json({ok:true,database:'connected',storage:'connected',service:'Synthetic QA'});
    else if(url.pathname==='/__qa/inspect')response=Response.json({sqlUnchanged:h.persistent()===baseline,sourceReads,
      sourceObjects:[...h.r2.objects.keys()].filter(k=>k.startsWith('original-script-sources/'))});
    else if(!url.pathname.startsWith('/api/'))response=new Response('Not found',{status:404});
    else response=await h.request(input.path,{method:input.method,body:input.body??undefined});
    console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
  }catch(error){console.log(JSON.stringify({error:error.message,stack:error.stack}));}
}
h.close();
