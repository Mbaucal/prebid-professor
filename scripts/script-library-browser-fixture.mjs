import {createInterface} from 'node:readline';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {randomBytes} from 'node:crypto';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {seedScriptLibrary} from './script-library-test-db.mjs';
const directory=await mkdtemp(join(tmpdir(),'demand-library-ui-'));
const origin='https://tessera.fixture.invalid',password=randomBytes(20).toString('hex');
const mf=new Miniflare({modules:true,script:await readFile('dist/prebid_professor/index.js','utf8'),
  compatibilityDate:'2026-07-15',compatibilityFlags:['nodejs_compat'],cf:false,resourcePersistencePath:directory,
  d1Databases:{DB:'demand-ui-d1'},r2Buckets:{BUILDS:'demand-ui-r2'},
  bindings:{ADMIN_EMAIL:'tester@example.invalid',ADMIN_PASSWORD:password,SESSION_SECRET:randomBytes(40).toString('hex')},
  serviceBindings:{ASSETS:()=>new Response('fixture asset',{status:404})},
  outboundService:()=>{throw Error('External network forbidden in this fixture');}});
await mf.ready;await seedScriptLibrary(await mf.getD1Database('DB'));
const login=await mf.dispatchFetch(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:'tester@example.invalid',password}),redirect:'manual'});
const cookie=login.headers.get('set-cookie').split(';')[0];
const harness=await build({stdin:{contents:`
  import {useState} from 'react';import {createRoot} from 'react-dom/client';
  import ScriptLibraryPanel from './src/components/ScriptLibraryPanel';
  import AdUnitsPanel from './src/components/AdUnitsPanel';
  import './src/ad-units.css';
  import PrebidModePanel from './src/components/PrebidModePanel';
  import './src/styles.css';import './src/site-workspace/runtime.css';import './src/prebid-mode.css';
  function App(){const [tab,setTab]=useState('releases');return <main className="site-runtime-panel" style={{maxWidth:1100,margin:'auto',padding:16}}>
    <nav><button onClick={()=>setTab('positions')}>Ad positions</button><button onClick={()=>setTab('demand')}>Demand → Prebid</button><button onClick={()=>setTab('releases')}>Releases</button></nav>
    {tab==='positions'?<AdUnitsPanel publisherId="tanjug"/>:tab==='demand'?<PrebidModePanel publisherId="tanjug"/>:<ScriptLibraryPanel publisherId="tanjug" onOpenDemand={()=>setTab('demand')}/>}
  </main>;}createRoot(document.getElementById('root')).render(<App/>);
`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:'.generated/ab-ui',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
console.log(JSON.stringify({ready:true}));
try {
 for await(const line of createInterface({input:process.stdin})) {
  try {
    const input=JSON.parse(line);let response;
    if(input.path==='/')response=new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',{headers:{'content-type':'text/html'}});
    else if(['/fixture.js','/fixture.css'].includes(input.path)) {
      const ext=input.path.endsWith('.js')?'.js':'.css';
      response=new Response(harness.outputFiles.find(f=>f.path.endsWith(ext)).text,{headers:{'content-type':ext==='.js'?'application/javascript':'text/css'}});
    } else {
      if(!input.path.startsWith('/api/publishers/tanjug/'))throw Error('Unknown fixture route');
      response=await mf.dispatchFetch(origin+input.path,{method:input.method,
        headers:{cookie,origin,...(input.body?{'content-type':'application/json'}:{})},body:input.body||undefined});
    }
    console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
  }catch(e){console.log(JSON.stringify({error:e.message}));}
 }
}finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
