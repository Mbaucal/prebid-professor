import { createInterface } from 'node:readline';
import worker from '../worker/test-workspace/index.mjs';
import { workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD } from '../tests/support/test-workspace-store.mjs';
const f=workspaceStore();
globalThis.fetch=()=>{throw Error('External network is forbidden in this fixture');};
const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
const cookie=login.headers.get('set-cookie').split(';')[0];
await worker.fetch(new Request(ORIGIN+'/test-api/setup',{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({confirm:'prepare-empty-test-database'})}),f.env);
console.log(JSON.stringify({ready:true}));
for await(const line of createInterface({input:process.stdin})){
 try{const body=JSON.parse(line);const response=await worker.fetch(new Request(ORIGIN+body.path,{method:body.method,headers:{cookie,origin:ORIGIN,...(body.body?{'content-type':'application/json'}:{})},body:body.body||undefined}),f.env);
 console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));}
 catch(e){console.log(JSON.stringify({error:e.message}));}
}
f.close();
