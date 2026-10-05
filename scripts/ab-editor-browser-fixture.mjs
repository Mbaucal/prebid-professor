import {createInterface} from 'node:readline';
import {build} from 'esbuild';
import {abEditorResponse} from '../worker/site-runtime/ab-editor.mjs';
const objects=new Map();
const env={DB:{withSession:()=>({prepare:()=>({bind:id=>({first:async()=>({id,name:'Tanjug',domain:'tanjug.rs',gam_path:'/22852026051/Tanjug.rs-Display/'})})})})},BUILDS:{
  get:async key=>objects.get(key)||null,
  list:async({prefix})=>({objects:[...objects].filter(([key])=>key.startsWith(prefix)).map(([key,o])=>({key,customMetadata:o.customMetadata})),truncated:false}),
  put:async(key,bytes,options)=>{if(objects.has(key))return null;const data=Uint8Array.from(bytes);objects.set(key,{size:data.length,customMetadata:options.customMetadata,arrayBuffer:async()=>data.slice().buffer});return {};},
}};
const harness=await build({stdin:{contents:`
  import {createRoot} from 'react-dom/client';
  import AbExperimentPanel from './src/components/AbExperimentPanel';
  import './src/styles.css';import './src/site-workspace/runtime.css';
  createRoot(document.getElementById('root')).render(<main style={{maxWidth:1100,margin:'auto',padding:16}}><AbExperimentPanel publisherId="tanjug"/></main>);
`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:'.generated/ab-ui',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
globalThis.fetch=()=>{throw Error('External network forbidden in this fixture');};
console.log(JSON.stringify({ready:true}));
for await(const line of createInterface({input:process.stdin})) {
  try {
    const input=JSON.parse(line);let response;
    if(input.path==='/')response=new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',{headers:{'content-type':'text/html'}});
    else if(['/fixture.js','/fixture.css'].includes(input.path)) {
      const ext=input.path.endsWith('.js')?'.js':'.css';
      response=new Response(harness.outputFiles.find(f=>f.path.endsWith(ext)).text,{headers:{'content-type':ext==='.js'?'application/javascript':'text/css'}});
    } else {
      const resource=input.path.match(/\/ab-experiments\/(.+)\.zip$/)?.[1]??null;
      response=await abEditorResponse(new Request('https://tessera.fixture.invalid'+input.path,{method:input.method,
        headers:input.body?{'content-type':'application/json'}:{},body:input.body||undefined}),env,'tanjug',resource,'fixture@example.invalid');
    }
    console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
  }catch(e){console.log(JSON.stringify({error:e.message}));}
}
