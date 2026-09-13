// LOCAL verification harness only. Not a Cloudflare entrypoint; no live credentials.
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import worker from '../worker/test-workspace/index.mjs';
import { workspaceStore, ORIGIN } from '../tests/support/test-workspace-store.mjs';
const [keyPath,certPath]=process.argv.slice(2);
if(!keyPath||!certPath)throw Error('Ephemeral LOCAL TLS files are required.');
const fixture=workspaceStore({prebidFiles:true});
globalThis.fetch=()=>{throw Error('Outbound requests are forbidden in workspace verification');};
const server=createServer({key:readFileSync(keyPath),cert:readFileSync(certPath)},async(req,res)=>{
  try {
    const parts=[];let size=0;
    for await(const part of req){size+=part.length;if(size>8*1024*1024+1024){res.writeHead(413);res.end();return;}parts.push(part);}
    const request=new Request(new URL(req.url,ORIGIN),{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(parts)});
    const response=await worker.fetch(request,fixture.env);
    res.writeHead(response.status,{...Object.fromEntries(response.headers),'x-tessera-local-fixture':'sqlite-fake-r2'});
    res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500,{'x-tessera-local-fixture':'sqlite-fake-r2'});res.end('Local verification harness failed');}
});
server.listen(8877,'127.0.0.1',()=>console.log('Local workspace TLS verification listening on 127.0.0.1:8877'));
process.on('SIGTERM',()=>server.close(()=>{fixture.close();process.exit(0);}));
