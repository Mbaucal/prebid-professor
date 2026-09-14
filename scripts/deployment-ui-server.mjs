// LOCAL test harness, never a Worker entrypoint. Synthetic credentials and jobs.
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import worker from '../worker/test-workspace/index.mjs';
import { deploymentStore } from '../tests/support/deployment-store.mjs';
import { DEPLOY_ORIGIN, dispatchInputs } from '../worker/test-workspace/deployment-contract.mjs';
import { readLedger } from '../worker/test-workspace/deployment-store.mjs';
const [key,cert]=process.argv.slice(2);if(!key||!cert)throw Error('Local TLS files required.');
const fixture=deploymentStore(),token=fixture.env.TEST_GITHUB_ACTIONS_TOKEN;delete fixture.env.TEST_GITHUB_ACTIONS_TOKEN;
let dispatches=0;
globalThis.fetch=async(url,options)=>{
  if(url!=='https://api.github.com/repos/Mbaucal/prebid-professor/actions/workflows/deploy-pages-release.yml/dispatches'||options.method!=='POST')throw Error('External network is blocked.');
  dispatches++;return new Response(null,{status:204});
};
const server=createServer({key:readFileSync(key),cert:readFileSync(cert)},async(req,res)=>{
  try {
    let response;
    // Test controls exist only on this loopback harness, outside the application.
    if(req.method==='POST'&&req.url==='/__fixture/connect'){fixture.env.TEST_GITHUB_ACTIONS_TOKEN=token;response=Response.json({synthetic:true});}
    else if(req.method==='POST'&&req.url==='/__fixture/complete'){
      const run=(await readLedger(fixture.env.BUILDS)).state.runs[0];if(!run)throw Error('No synthetic job.');
      const base=DEPLOY_ORIGIN+'/test-api/deployment-runner/'+run.id;
      const headers={authorization:'Bearer '+fixture.env.TEST_DEPLOY_SECRET,'content-type':'application/json'};
      for(const [path,body] of [['claim',{inputs:dispatchInputs(run),runId:'123456',commit:'a'.repeat(40)}],['report',{runId:'123456',commit:'a'.repeat(40),status:'success',deploymentUrl:'https://1234abcd.tessera-fixture.pages.dev',productionBranch:'main'}]]){
        const r=await worker.fetch(new Request(base+'/'+path,{method:'POST',headers,body:JSON.stringify(body)}),fixture.env);if(!r.ok)throw Error('Synthetic result failed.');
      }
      response=Response.json({synthetic:true,dispatches});
    }else{
      const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>1024*1024)throw Error('Request too large');parts.push(part);}
      response=await worker.fetch(new Request(new URL(req.url,DEPLOY_ORIGIN),{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(parts)}),fixture.env);
    }
    res.writeHead(response.status,{...Object.fromEntries(response.headers),'x-tessera-local-fixture':'delivery-synthetic'});res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500,{'x-tessera-local-fixture':'delivery-synthetic'});res.end('Local fixture failed');}
});
server.listen(8877,'127.0.0.1',()=>console.log('Local delivery UI ready'));
process.on('SIGTERM',()=>server.close(()=>{fixture.close();process.exit(0);}));
