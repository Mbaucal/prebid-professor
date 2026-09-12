// LOCAL verification harness only. Not a Cloudflare entrypoint; no live credentials.
import { createServer } from 'node:http';
import worker from '../worker/test-workspace/index.mjs';
import { workspaceStore, ORIGIN } from '../tests/support/test-workspace-store.mjs';
const fixture=workspaceStore();
globalThis.fetch=()=>{throw Error('Outbound requests are forbidden in workspace verification');};
const server=createServer(async(req,res)=>{
  try {
    const parts=[];let size=0;
    for await(const part of req){size+=part.length;if(size>20000){res.writeHead(413);res.end();return;}parts.push(part);}
    const request=new Request(new URL(req.url,ORIGIN),{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(parts)});
    const response=await worker.fetch(request,fixture.env);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500);res.end('Local verification harness failed');}
});
server.listen(8877,'127.0.0.1',()=>console.log('Local workspace verification listening on 127.0.0.1:8877'));
process.on('SIGTERM',()=>server.close(()=>{fixture.close();process.exit(0);}));
