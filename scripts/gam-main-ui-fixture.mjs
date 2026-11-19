// Actual production React bundle; local synthetic GAM/storage only.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {gamResponse} from '../worker/integrations/gam-service.mjs';
import {trafficFixture,prebidPlan} from '../tests/gam/traffic-fixture.mjs';
const fixture=trafficFixture(),root=resolve('dist/client');
const origin='http://127.0.0.1:4187',base='/api/integrations/gam';
const options={base,clientFactory:()=>fixture.client,trafficFactory:()=>fixture.traffic};
const credentials={type:'service_account',client_email:'main-ui@fixture.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----'};
const connected=await gamResponse(new Request(origin+base+'/connect',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({networkCode:'123456',credentials})}),fixture.env,'main-ui@example.invalid',options);
if(connected.status!==201)throw Error('Synthetic GAM connection failed');
if(process.env.GAM_MAIN_SEED_OFF==='1'){
  fixture.db.key.push({id:'9000001',name:'aq_bid_origin',displayName:'Existing operator label',type:'FREEFORM',status:'ACTIVE',reportableType:'OFF'});
  fixture.db.value.push({id:'9000002',customTargetingKeyId:'9000001',name:'fresh',displayName:'Existing fresh label',matchType:'EXACT',status:'ACTIVE'});
}
let blockerId;
async function localAction(path,body){
  const response=await gamResponse(new Request(origin+base+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}),fixture.env,'main-ui@example.invalid',options);
  if(!response.ok)throw Error('Synthetic blocker setup failed: '+await response.text());
  return response.json();
}
if(['preview','creating','creative'].includes(process.env.GAM_MAIN_BLOCKER)){
  const draft=prebidPlan();
  if(process.env.GAM_MAIN_BLOCKER==='creative'){
    draft.ranges=[{from:'0.01',to:'0.10',step:'0.01'}];
    draft.creative={...draft.creative,layout:'per-price',copies:20};
  }
  let job=await localAction('/line-items/preview',draft);
  if(process.env.GAM_MAIN_BLOCKER==='creative'){
    // Historical ad snapshots predate automatic reporting materialization.
    // Model one locally, then use the real handler for every review/write.
    const key=`api-integrations/gam/line-items/v1/jobs/${job.id}.json`;
    const saved=await(await fixture.env.BUILDS.get(key)).json();
    delete saved.plan.reporting;
    await fixture.env.BUILDS.put(key,JSON.stringify(saved));
  }
  while(job.status==='reviewing')job=await localAction(`/line-items/jobs/${job.id}/review`,{cursor:job.cursor});
  if(['creating','creative'].includes(process.env.GAM_MAIN_BLOCKER))job=await localAction(`/line-items/jobs/${job.id}/start`,{confirm:true,confirmNetwork:'123456'});
  if(process.env.GAM_MAIN_BLOCKER==='creative'){
    for(let i=0;job.phase!=='Kreativi'&&i<30;i++)job=await localAction(`/line-items/jobs/${job.id}/step`,{cursor:job.cursor});
    if(job.phase!=='Kreativi')throw Error('Historical job did not reach creatives: '+JSON.stringify({status:job.status,phase:job.phase,error:job.error,awaitingCheck:job.awaitingCheck,counts:job.counts}));
    job=await localAction(`/line-items/jobs/${job.id}/step`,{cursor:job.cursor});
    if(job.phase!=='Kreativi'||job.counts.creative.created<=0||job.counts.creative.created>=job.counts.creative.total)throw Error('Historical job must remain partially complete in creatives');
  }
  blockerId=job.id;
  // Only execution normally claims this lease. The preview case deliberately
  // models a historical held lease and must require explicit safe closure.
  if(process.env.GAM_MAIN_BLOCKER==='preview')await fixture.env.BUILDS.put('api-integrations/gam/line-items/v1/locks/123456.json',JSON.stringify({owner:job.id,actor:'main-ui@example.invalid',createdAt:Date.now()}));
}
createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);let response;
    if(url.pathname.startsWith(base+'/')){
      let body='';for await(const chunk of req)body+=chunk;
      response=await gamResponse(new Request(url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:body}),fixture.env,'main-ui@example.invalid',options);
    }else if(url.pathname==='/__fixture__/state'&&req.method==='GET'){
      const blockerRaw=blockerId?fixture.env.BUILDS.data.get(`api-integrations/gam/line-items/v1/jobs/${blockerId}.json`)?.body??null:null;
      const blocker=blockerRaw?JSON.parse(blockerRaw):null;
      const lock=fixture.env.BUILDS.data.get('api-integrations/gam/line-items/v1/locks/123456.json');
      response=Response.json({keys:fixture.db.key,values:fixture.db.value,writes:fixture.calls,blocker:blocker?{id:blocker.id,status:blocker.status,cursor:blocker.cursor}:null,
        blockerRaw,networkLock:lock?.body??null,adObjects:Object.fromEntries(['advertiser','order','creative','lineItem','association'].map(kind=>[kind,fixture.db[kind]]))});
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
