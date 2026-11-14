/** TEST login adapter on loopback TLS: real Worker handler + local SQLite. */
import { createInterface } from 'node:readline';
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import worker from '../worker/test-workspace/index.mjs';
import { workspaceStore,ORIGIN } from '../tests/support/test-workspace-store.mjs';
const f=workspaceStore(), healthyDB=f.env.DB;
globalThis.fetch=()=>{throw Error('No external network in TEST login fixture');};
const server=createServer({key:readFileSync(process.argv[2]),cert:readFileSync(process.argv[3])},async(req,res)=>{
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
  // Only our loopback browser origin is mapped to the isolated TEST origin.
  if(headers.get('origin')===`https://127.0.0.1:${server.address().port}`)headers.set('origin',ORIGIN);
  headers.set('cf-connecting-ip','192.0.2.1');
  const response=await worker.fetch(new Request(ORIGIN+req.url,{method:req.method,headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})}),f.env);
  res.writeHead(response.status,{...Object.fromEntries(response.headers),'x-tessera-auth-fixture':'local-sqlite'});res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('Local fixture failure');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
console.log('AUTH_FIXTURE_READY https://127.0.0.1:'+server.address().port);
try{
 for await(const command of createInterface({input:process.stdin})){
  if(command==='expire'&&f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='auth_login_limits'").get())f.sqlite.exec('UPDATE auth_login_limits SET reset_at=unixepoch()-1');
  if(command==='unavailable')f.env.DB={withSession(){throw Error('Fixture database unavailable');}};
  if(command==='recover'){f.env.DB=healthyDB;f.sqlite.exec('DELETE FROM auth_login_limits');}
  console.log('AUTH_COMMAND_DONE '+command);
 }
}finally{server.closeAllConnections();server.close();f.close();}
