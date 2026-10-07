/** Actual root npm dev/preview smoke: loopback HTML only, no browser or remote requests. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {get} from 'node:http';
assert.equal(process.argv.length,2,'No arguments accepted.');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function freePort(){const server=createServer();await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});const port=server.address().port;await new Promise((yes,no)=>server.close(e=>e?no(e):yes()));return port;}
const delay=ms=>new Promise(yes=>setTimeout(yes,ms));
function readHtml(port){return new Promise((yes,no)=>{
 const request=get({hostname:'127.0.0.1',port,path:'/login',timeout:1000},response=>{
  let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;if(text.length>1024*1024)request.destroy(Error('Unexpected oversized HTML'));});response.on('end',()=>yes({status:response.statusCode,text}));response.on('error',no);
 });request.on('timeout',()=>request.destroy(Error('Local response timed out')));request.on('error',no);
});}
const results=[];
for(const command of ['dev','preview']){
 const port=await freePort();let output='',closed=false;
 const child=spawn('npm',['run',command,'--','--port',String(port)],{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
 const completion=new Promise(yes=>child.once('close',()=>{closed=true;yes();}));
 child.stdout.on('data',bytes=>{output=(output+bytes.toString()).slice(-16000);});child.stderr.on('data',bytes=>{output=(output+bytes.toString()).slice(-16000);});
 child.on('error',error=>{output+=error.message;closed=true;});
 try{
  let matched=false;
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){
   assert(!closed,`${command} exited before a local HTML response:\n${output}`);
   try{const response=await readHtml(port);if(response.status===200&&/<html/i.test(response.text)&&/Tessera/.test(response.text)){matched=true;break;}}catch{}
   await delay(250);
  }
  assert(matched,`${command} did not serve the expected local login HTML:\n${output}`);
  results.push({command,host:'127.0.0.1',html:true,probeTarget:'loopback'});
 }finally{
  if(child.pid){try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}}
  await Promise.race([completion,delay(3000)]);
  if(!closed&&child.pid){try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}await completion;}
 }
}
console.log(JSON.stringify({scope:'Actual local root npm commands; loopback HTML only',results},null,2));
