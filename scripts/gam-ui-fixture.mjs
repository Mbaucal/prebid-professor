import {workspaceStore} from '../tests/support/test-workspace-store.mjs';
import {initializeTestSchema} from '../worker/test-workspace/schema.mjs';
import {createServer} from 'node:http';
import {integrationsJs,integrationsCss} from '../.generated/api-integrations.mjs';
import {gamResponse} from '../worker/integrations/gam-service.mjs';
import {trafficFixture} from '../tests/gam/traffic-fixture.mjs';
const f=trafficFixture(),siteDb=workspaceStore();await initializeTestSchema(siteDb.env.DB,'fixture@example.invalid');siteDb.sqlite.prepare("UPDATE publishers SET name='example.invalid',gam_path='/123456/Example/' WHERE id='test-site'").run();f.env.DB=siteDb.env.DB;
const account={type:'service_account',client_email:'fixture@fixture.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\nsynthetic-not-a-real-key\n-----END PRIVATE KEY-----'};
const address='http://127.0.0.1:4178',base='/test-api/integrations/gam';
await gamResponse(new Request(address+base+'/connect',{method:'POST',headers:{origin:address,'content-type':'application/json'},body:JSON.stringify({networkCode:'123456',credentials:account})}),f.env,'fixture@example.invalid',{base,clientFactory:()=>f.client,trafficFactory:()=>f.traffic});
createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,address);let response;
  if(url.pathname===base+'/status'&&url.searchParams.has('disconnected'))response=Response.json({configured:false,connections:[]});
  else if(url.pathname.startsWith(base+'/')){let body='';for await(const chunk of req)body+=chunk;response=await gamResponse(new Request(url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:body}),f.env,'fixture@example.invalid',{base,clientFactory:()=>f.client,trafficFactory:()=>f.traffic});}
  else if(url.pathname==='/api-integrations.js')response=new Response(integrationsJs,{headers:{'content-type':'application/javascript'}});
  else response=new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${integrationsCss}</style></head><body><div style="padding:6px;text-align:center;background:#ffeccf;font:12px system-ui">LOCAL FIXTURE · synthetic GAM · no external requests</div><div id="root"></div><script src="/api-integrations.js"></script></body></html>`,{headers:{'content-type':'text/html; charset=utf-8'}});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('Fixture error');}
}).listen(4178,'0.0.0.0',()=>console.log('GAM UI fixture ready on '+address));
