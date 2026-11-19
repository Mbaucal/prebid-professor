// Actual production React bundle; local synthetic GAM/storage only.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {gamResponse} from '../worker/integrations/gam-service.mjs';
import {trafficFixture} from '../tests/gam/traffic-fixture.mjs';
const fixture=trafficFixture(),root=resolve('dist/client');
const origin='http://127.0.0.1:4187',base='/api/integrations/gam';
const options={base,clientFactory:()=>fixture.client,trafficFactory:()=>fixture.traffic};
const credentials={type:'service_account',client_email:'main-ui@fixture.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----'};
const connected=await gamResponse(new Request(origin+base+'/connect',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({networkCode:'123456',credentials})}),fixture.env,'main-ui@example.invalid',options);
if(connected.status!==201)throw Error('Synthetic GAM connection failed');
createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);let response;
    if(url.pathname.startsWith(base+'/')){
      let body='';for await(const chunk of req)body+=chunk;
      response=await gamResponse(new Request(url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:body}),fixture.env,'main-ui@example.invalid',options);
    }else if(url.pathname==='/__fixture__/state'&&req.method==='GET'){
      response=Response.json({keys:fixture.db.key,values:fixture.db.value,writes:fixture.calls});
    }else if(req.method!=='GET')response=Response.json({error:'Not part of the synthetic MAIN fixture'},{status:405});
    else if(url.pathname==='/api/organization')response=Response.json({agencies:[],memberships:[]});
    else if(url.pathname==='/api/publisher-accounts')response=Response.json({publishers:[]});
    else if(url.pathname==='/api/auth/me')response=Response.json({ok:true,user:{email:'main-ui@example.invalid'}});
    else if(url.pathname==='/api/health')response=Response.json({ok:true,database:'connected',service:'Synthetic MAIN UI fixture'});
    else if(url.pathname.startsWith('/api/'))response=Response.json({error:'Not part of the synthetic MAIN fixture'},{status:404});
    else{
      const file=resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
      if(!file.startsWith(root+'/'))throw Error('Invalid asset path');
      response=new Response(await readFile(file),{headers:{'content-type':{'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.ico':'image/x-icon'}[extname(file)]??'application/octet-stream'}});
    }
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){res.writeHead(500,{'content-type':'text/plain'});res.end('Synthetic MAIN fixture failed');console.error(error.message);}
}).listen(4187,'127.0.0.1',()=>console.log('Synthetic MAIN GAM UI fixture ready'));
