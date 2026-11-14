// Native React and authenticated Worker with synthetic SQLite/R2. No remote traffic.
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {build} from 'esbuild';
import worker from '../worker/app-builtin-runtime-preview.ts';
import {adminAuditStore} from '../tests/support/admin-audit-store.mjs';
import {TEST_EMAIL,TEST_PASSWORD,TEST_SECRET} from '../tests/support/test-workspace-store.mjs';
const origin='https://contextual.fixture.invalid',siteId='audit-site';
const f=adminAuditStore();
f.sqlite.prepare("INSERT INTO bidders(id,publisher_id,bidder,params_json) VALUES('openx-bidder','audit-site','openx','{}')").run();
Object.assign(f.env,{ADMIN_EMAIL:TEST_EMAIL,ADMIN_PASSWORD:TEST_PASSWORD,SESSION_SECRET:TEST_SECRET,ASSETS:{fetch(){throw Error('No remote assets');}}});
globalThis.fetch=()=>{throw Error('Outbound requests forbidden');};
const ctx={waitUntil(){},passThroughOnException(){}};
const login=await worker.fetch(new Request(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env,ctx);
assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
const bundle=await build({stdin:{contents:`import{createRoot}from'react-dom/client';import ConfigPanel from'./src/components/ConfigPanel';import'./src/dashboard-styles';createRoot(document.getElementById('root')).render(<main style={{maxWidth:1200,margin:'24px auto',minWidth:0}}><h1 style={{padding:'0 24px'}}>Contextual signal fixture</h1><ConfigPanel publisherId="audit-site" initialSection="contextual-signals"/></main>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:'.generated/contextual-signals-fixture',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
console.log(JSON.stringify({ready:true,siteId}));
for await(const line of createInterface({input:process.stdin})){
  try{
    const input=JSON.parse(line);let response;
    if(input.path==='/')response=new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',{headers:{'content-type':'text/html'}});
    else if(['/fixture.js','/fixture.css'].includes(input.path)){
      const ext=input.path.endsWith('.js')?'.js':'.css';response=new Response(bundle.outputFiles.find(file=>file.path.endsWith(ext)).text,{headers:{'content-type':ext==='.js'?'application/javascript':'text/css'}});
    }else if(input.path==='/__fixture/snapshot')response=Response.json({config:f.readConfig(),audits:f.sqlite.prepare('SELECT action FROM audit_log ORDER BY created_at,id').all()});
    else if(input.path==='/__fixture/modules'){
      const mode=JSON.parse(input.body||'{}').mode;
      assert(['missing','present','unknown'].includes(mode));
      if(mode==='unknown')f.sqlite.prepare("UPDATE prebid_builds SET modules_json='broken' WHERE publisher_id='audit-site'").run();
      else f.setPrebid(mode==='present'?['pubmaticBidAdapter','openxBidAdapter','consentManagementTcf','rtdModule','contextualSignalsRtdProvider']:['pubmaticBidAdapter','openxBidAdapter','consentManagementTcf']);
      response=Response.json({ok:true});
    }else if(input.path==='/__fixture/stale'){
      f.writeConfig({...f.readConfig(),otherTabChange:true});response=Response.json({ok:true});
    }else response=await worker.fetch(new Request(origin+input.path,{method:input.method,headers:{origin,cookie,...input.headers,...(input.body?{'content-type':'application/json'}:{})},body:input.body||undefined}),f.env,ctx);
    console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
  }catch(error){console.log(JSON.stringify({error:error.message}));}
}
f.close();
