// Actual production React build and shared TEST UI, backed by local SQLite only.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {workspaceStore,TEST_EMAIL} from '../tests/support/test-workspace-store.mjs';
import {initializeTestSchema} from '../worker/test-workspace/schema.mjs';
import {organizationResponse} from '../worker/organization/service.mjs';
import {agenciesResponse} from '../worker/test-workspace/agencies.mjs';
import {layoutPreviewResponse} from '../worker/test-workspace/layout-preview.mjs';
import {examplePublishers} from '../src/agency-workspace/examples.ts';
const address='http://127.0.0.1:4183',root=resolve('dist/client'),main=workspaceStore(),test=workspaceStore();
main.sqlite.exec('CREATE TABLE publisher_accounts (id TEXT PRIMARY KEY,created_at TEXT NOT NULL)');
for(const p of examplePublishers)main.sqlite.prepare('INSERT INTO publisher_accounts VALUES (?,?)').run(p.id,p.createdAt);
await initializeTestSchema(test.env.DB,TEST_EMAIL);
const headers={'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"};
createServer(async(req,res)=>{try{
  const url=new URL(req.url,address);let body='';for await(const chunk of req)body+=chunk;
  const request=new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body})});let response;
  if(url.pathname.startsWith('/api/organization'))response=await organizationResponse(request,main.env,TEST_EMAIL);
  else if(url.pathname==='/api/publisher-accounts')response=Response.json({publishers:examplePublishers});
  else if(url.pathname==='/api/auth/me')response=Response.json({ok:true,user:{email:TEST_EMAIL}});
  else if(url.pathname==='/api/health')response=Response.json({ok:true,database:'connected'});
  else if(url.pathname.startsWith('/api/'))response=Response.json({error:'Outside fixture'},{status:404});
  else response=await agenciesResponse(request,test.env,{email:TEST_EMAIL},headers)||layoutPreviewResponse(request,headers);
  if(!response){const file=resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(root+'/'))throw Error('Invalid path');response=new Response(readFileSync(file),{headers:{'content-type':{'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png'}[extname(file)]??'application/octet-stream'}});}
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
}catch(error){console.error(error);res.writeHead(500);res.end('Fixture failed');}}).listen(4183,'127.0.0.1',()=>console.log('Agency UI fixture ready'));
