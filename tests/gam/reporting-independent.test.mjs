import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Source override supports independent worktree review. Storage and every
// Google operation are local synthetic fixtures; no paid ad traffic is sent.
const root=resolve(process.env.GAM_INDEPENDENT_QA_ROOT??fileURLToPath(new URL('../..',import.meta.url)));
const load=path=>import(pathToFileURL(resolve(root,path)).href);
const {gamResponse}=await load('worker/integrations/gam-service.mjs');
const {trafficFixture,prebidPlan}=await load('tests/gam/traffic-fixture.mjs');
const {MemoryBucket}=await load('tests/gam/fixture.mjs');
const {GamError}=await load('shared/gam/plan.mjs');
const origin='https://independent-qa.invalid',actor='independent-qa@example.invalid',base='/api/integrations/gam';
const prefix='api-integrations/gam/line-items/v1/';
const jobKey=id=>prefix+'jobs/'+id+'.json';
const globalLock=prefix+'locks/123456.json';
const targetLock=prefix+'targeting-locks/123456.json';
const attemptKey=(id,cursor)=>prefix+'attempts/'+id+'/'+cursor+'.json';
const report=(...rows)=>({mode:'reporting',networkCode:'123456',reportingWritePolicy:'add_only',reportingSelection:rows});
const newLabels=()=>report({key:'aq_bid_origin'},{key:'aq_first_request'},{key:'aq_consent_wait'});
const tagFor=(f,path,body)=>body?.mode==='prebid'||body?.mode==='single'?'ad':
  f.kinds.get(path.match(/^\/line-items\/jobs\/([^/]+)/)?.[1])==='ad'?'ad':'reporting';

async function request(f,path,body,{as=actor,host=origin,tag=tagFor(f,path,body)}={}) {
  const traffic=Object.fromEntries(['network','query','byIds','byNames','create','update'].map(method=>[method,async(...args)=>{
    if(['create','update'].includes(method)) {
      const [kind,payloads]=args;
      if(tag==='reporting')assert(['key','value'].includes(kind),'standalone must never write ad objects');
      if(method==='update') {
        f.updateAttempts.push({tag,kind,payloads:structuredClone(payloads)});
        if(tag==='reporting')throw Error('FORBIDDEN standalone metadata update');
      } else {
        f.writes.push({tag,kind,payloads:structuredClone(payloads)});
        if(f.beforeCreate)await f.beforeCreate({tag,kind,payloads});
        for(const payload of payloads)if(['key','value'].includes(kind)) {
          const duplicate=f.db[kind].find(row=>row.name.toLowerCase()===payload.name.toLowerCase()&&
            (kind==='key'||String(row.customTargetingKeyId)===String(payload.customTargetingKeyId)));
          if(duplicate){f.duplicates++;throw new GamError('CustomTargetingError.DUPLICATE_NAME',409);}
        }
      }
    }else {
      f.reads.push({tag,method,args:structuredClone(args)});
      if(f.beforeRead)await f.beforeRead({tag,method,args});
    }
    return f.traffic[method](...args);
  }]));
  const response=await gamResponse(new Request(host+base+path,{
    method:body===undefined?'GET':'POST',headers:{origin:host,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  }),f.env,as,{clientFactory:()=>f.client,trafficFactory:()=>traffic});
  assert(response);const value=await response.json();
  if(value.id&&value.mode)f.kinds.set(value.id,value.mode==='reporting'?'reporting':'ad');
  return {status:response.status,data:value};
}
async function setup() {
  const f=trafficFixture();Object.assign(f,{writes:[],reads:[],updateAttempts:[],duplicates:0,kinds:new Map(),beforeCreate:null,beforeRead:null});
  const r=await request(f,'/connect',{networkCode:'123456',credentials:{type:'service_account',
    client_email:'independent-qa@fixture.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----'}});
  assert.equal(r.status,201);return f;
}
async function preview(f,input,options) {
  const r=await request(f,'/line-items/preview',input,options);assert.equal(r.status,201,JSON.stringify(r.data));return r.data;
}
async function action(f,j,verb,extra={}) {
  const r=await request(f,`/line-items/jobs/${j.id}/${verb}`,{cursor:j.cursor,...extra});
  assert.equal(r.status,200,JSON.stringify(r.data));return r.data;
}
async function review(f,j) {
  for(let n=0;j.status==='reviewing'&&!j.error&&n<100;n++)j=await action(f,j,'review');return j;
}
async function ready(f,input) {
  const j=await review(f,await preview(f,input));assert.equal(j.status,'ready');assert.equal(j.canStart,true,JSON.stringify(j));return j;
}
const start=(f,j)=>action(f,j,'start',{confirm:true,confirmNetwork:'123456'});
async function finish(f,j) {
  for(let n=0;j.status==='creating'&&n<150;n++) {
    j=await action(f,j,j.awaitingCheck?'check':'step');assert.equal(j.error,'',JSON.stringify(j));
  }
  assert.equal(j.status,'completed',JSON.stringify(j));return j;
}
async function saved(f,id){return (await (await f.env.BUILDS.get(jobKey(id))).json());}
async function change(f,id,fn){const j=await saved(f,id);fn(j);await f.env.BUILDS.put(jobKey(id),JSON.stringify(j));return j;}
function snapshot(f){return {bucket:structuredClone(f.env.BUILDS.data),db:structuredClone(f.db)};}
function unchanged(f,before) {
  for(const [key,value] of before.bucket)assert.deepEqual(f.env.BUILDS.data.get(key),value,'existing R2 record changed: '+key);
  for(const kind of Object.keys(before.db))for(const original of before.db[kind])
    assert.deepEqual(f.db[kind].find(row=>row.id===original.id),original,'existing GAM row changed: '+kind+' '+original.id);
  for(const kind of ['advertiser','order','creative','lineItem','association'])assert.deepEqual(f.db[kind],before.db[kind]);
}
function unchangedAd(f,before,id) {
  for(const [key,value] of before.bucket)if(key===globalLock||key===jobKey(id)||
    key.startsWith(prefix+'attempts/'+id+'/')||key.endsWith('-'+id+'.json'))
    assert.deepEqual(f.env.BUILDS.data.get(key),value,'old ad record changed: '+key);
  for(const kind of ['advertiser','order','creative','lineItem','association'])assert.deepEqual(f.db[kind],before.db[kind]);
}
const tinyAd=()=>{const plan=prebidPlan();return {...plan,ranges:[{from:'0.01',to:'0.01',step:'0.01'}],creative:{...plan.creative,copies:1}};};
function restart(f) {
  const bucket=new MemoryBucket();bucket.data=new Map([...f.env.BUILDS.data].map(([key,value])=>[key,structuredClone(value)]));
  return {...f,env:{...f.env,BUILDS:bucket}};
}
function seedKey(f,{name='aq_bid_origin',id='8500',values=[],reportableType='OFF'}={}) {
  const key={id,name,displayName:'Original '+name,type:'FREEFORM',reportableType,status:'ACTIVE'};f.db.key.push(key);
  values.forEach((name,index)=>f.db.value.push({id:String(Number(id)+index+1),name,displayName:'Original '+name,
    customTargetingKeyId:id,matchType:'EXACT',status:'ACTIVE'}));return key;
}
async function oldCreative(f,{pending=false,as=actor,host=origin}={}) {
  const plan=prebidPlan();
  const j=await preview(f,{...plan,order:{mode:'new',name:'Old 40k batch',traffickerId:'30'},
    ranges:[{from:'0.01',to:'20.00',step:'0.01'}],creative:{...plan.creative,layout:'per-price',copies:20}}, {as,host,tag:'ad'});
  seedKey(f,{name:'hb_pb',id:'8000',values:['0.01','0.02'],reportableType:'ON'});
  seedKey(f,{name:'hb_bidder',id:'8100',values:['example'],reportableType:'ON'});
  f.db.creative.push({id:'60000',advertiserId:'10',name:'Existing creative 19700',size:{width:1,height:1},snippet:'<script>old();</script>'});
  const old=await change(f,j.id,job=>{
    delete job.plan.reporting;
    // This is a saved synthetic snapshot, not 40,000 newly generated creatives.
    job.status='creating';job.phase='creative';job.offset=19700;job.cursor=240;
    job.executionStartedAt='2026-11-18T10:00:00.000Z';
    job.refs={'advertiser:0':{state:'existing',id:'10'},'order:0':{state:'existing',id:'20'},
      'key:hb_pb':{state:'created',id:'8000'},'creative:19699':{state:'created',id:'60000'}};
  });
  await f.env.BUILDS.put(globalLock,JSON.stringify({owner:j.id,actor:as,createdAt:Date.now()-600000}));
  if(pending)await f.env.BUILDS.put(attemptKey(j.id,old.cursor),
    JSON.stringify({startedAt:Date.now(),keys:['creative:19700'],operation:'create'}));
  return {...j,status:'creating',cursor:old.cursor,mode:'prebid'};
}

test('a 19700/40000 legacy creative job does not block confirmed add-only keys or change any old record',async()=>{
  const f=await setup(),ad=await oldCreative(f),before=snapshot(f);
  assert.equal((await saved(f,ad.id)).plan.counts.creatives,40000);
  assert.equal((await saved(f,ad.id)).offset,19700);
  const j=await ready(f,newLabels());assert.equal(f.writes.length,0);
  assert.equal((await saved(f,j.id)).executionLane,'reporting_add_only_v1');
  const done=await finish(f,await start(f,j));assert.equal(done.reporting.writePolicy,'add_only');
  assert.deepEqual(f.db.key.filter(key=>!before.db.key.some(old=>old.id===key.id)).map(key=>key.name),
    ['aq_bid_origin','aq_first_request','aq_consent_wait']);
  assert.equal(f.db.value.length-before.db.value.length,17);unchanged(f,before);
  assert.equal(f.duplicates,0);assert.equal(f.updateAttempts.filter(item=>item.tag==='reporting').length,0);
  assert(f.writes.every(item=>item.tag==='reporting'&&['key','value'].includes(item.kind)));
});

test('a disjoint uncertain creative write remains untouched while reporting completes',async()=>{
  const f=await setup();await oldCreative(f,{pending:true});const before=snapshot(f);
  await finish(f,await start(f,await ready(f,report({key:'aq_bid_origin',values:['cached']}))));
  unchanged(f,before);assert.equal(f.duplicates,0);assert.equal(f.updateAttempts.length,0);
});

test('reporting review, history, same-plan reopen, close and cancel never release the old ad lease',async()=>{
  const f=await setup();await oldCreative(f);const before=snapshot(f);
  const first=await ready(f,report({key:'aq_bid_origin',values:['cached']}));
  const history=await request(f,'/line-items/jobs?network=123456');assert.equal(history.status,200);unchanged(f,before);
  const closed=await request(f,`/line-items/jobs/${first.id}/close-preview`,
    {cursor:first.cursor,confirm:true,confirmNetwork:'123456'});assert.equal(closed.status,200);unchanged(f,before);
  const second=await start(f,await ready(f,report({key:'aq_first_request',values:[]})));
  const reopened=await request(f,'/line-items/preview',report({key:'aq_first_request',values:[]}));
  assert.equal(reopened.status,200);assert.equal(reopened.data.id,second.id);assert.equal(reopened.data.resumed,true);
  await action(f,second,'cancel');unchanged(f,before);assert.equal(f.writes.length,0);
});

test('an existing OFF key remains identical while a missing selected value is added alongside an old ad job',async()=>{
  const f=await setup();await oldCreative(f);seedKey(f,{values:['cached']});const before=snapshot(f);
  const done=await finish(f,await start(f,await ready(f,report({key:'aq_bid_origin',values:['cached','fresh']}))));
  unchanged(f,before);assert.equal(f.writes.length,1);assert.equal(f.writes[0].kind,'value');
  assert.deepEqual(f.writes[0].payloads.map(row=>row.name),['fresh']);assert.equal(f.updateAttempts.length,0);
  assert.equal(done.reporting.results[0].reportableType,'OFF');
});

test('only one reporting admission is active per network and its failure never changes an ad lease',async()=>{
  const f=await setup();await oldCreative(f);const before=snapshot(f);
  const a=await ready(f,report({key:'aq_bid_origin',values:['cached']}));
  const b=await ready(f,report({key:'aq_first_request',values:['lt_500']}));
  const active=await start(f,a),blocked=await request(f,`/line-items/jobs/${b.id}/start`,{confirm:true,confirmNetwork:'123456'});
  assert.equal(blocked.status,409);assert.equal((await saved(f,b.id)).status,'ready');unchanged(f,before);
  await finish(f,active);await finish(f,await start(f,b));unchanged(f,before);assert.equal(f.duplicates,0);
});

test('foreign ad context is never disclosed by an independent reporting request',async()=>{
  const f=await setup(),ad=await oldCreative(f,{as:'foreign@example.invalid',host:'https://foreign.invalid'}),before=snapshot(f);
  const r=await request(f,'/line-items/preview',report({key:'aq_bid_origin',values:[]}));
  assert([201,409].includes(r.status));assert.equal(JSON.stringify(r.data).includes(ad.id),false);
  assert.equal(JSON.stringify(r.data).includes('foreign@example.invalid'),false);unchanged(f,before);assert.equal(f.writes.length,0);
});

test('a pre-upgrade reporting job keeps its global lane and cannot be bypassed by a second reporting plan',async()=>{
  const f=await setup(),input=report({key:'aq_bid_origin',values:['cached']});
  const j=await ready(f,input);
  await change(f,j.id,job=>{
    for(const key of Object.keys(job))if(!['id','actor','origin','connectionRevision','network','plan','labels','refs','status','phase',
      'offset','cursor','createdAt','updatedAt','expiresAt','error','verificationResults','associationCounts','executionStartedAt'].includes(key))delete job[key];
    job.status='creating';job.phase='key';job.offset=0;job.cursor++;
    job.executionStartedAt='2026-11-18T10:00:00.000Z';
  });
  await f.env.BUILDS.put(globalLock,JSON.stringify({owner:j.id,actor,createdAt:Date.now()-3600000}));
  const before=snapshot(f),same=await request(f,'/line-items/preview',input);
  assert.equal(same.status,200);assert.equal(same.data.id,j.id);assert.equal(same.data.resumed,true);unchanged(f,before);
  const other=await request(f,'/line-items/preview',report({key:'Variant',values:['A']}));
  assert.equal(other.status,409);unchanged(f,before);assert.equal(f.writes.length,0);
});

test('concurrent ad and reporting starts serialize the same missing key or value and later reuse fresh state',async()=>{
  for(const existingParent of [false,true]) {
    const f=await setup();if(existingParent)seedKey(f,{values:['fresh','none'],reportableType:'ON'});
    const ad=await ready(f,tinyAd()),kv=await ready(f,report({key:'aq_bid_origin',values:['cached']}));
    assert.equal((await saved(f,kv.id)).executionLane,'reporting_add_only_v1');
    const replies=await Promise.all([request(f,`/line-items/jobs/${ad.id}/start`,{confirm:true,confirmNetwork:'123456'}),
      request(f,`/line-items/jobs/${kv.id}/start`,{confirm:true,confirmNetwork:'123456'})]);
    assert.deepEqual(replies.map(reply=>reply.status).sort(),[200,409]);
    const winner=replies.find(reply=>reply.status===200).data,loser=winner.id===ad.id?kv:ad;
    await finish(f,winner);await finish(f,await start(f,loser));
    const keys=f.db.key.filter(key=>key.name.toLowerCase()==='aq_bid_origin');assert.equal(keys.length,1);
    assert.equal(f.db.value.filter(value=>value.customTargetingKeyId===keys[0].id&&value.name.toLowerCase()==='cached').length,1);
    assert.equal(f.duplicates,0);assert.equal(f.updateAttempts.filter(item=>item.tag==='reporting').length,0);
    const overlap=f.writes.flatMap(write=>write.kind==='key'?write.payloads.filter(key=>key.name.toLowerCase()==='aq_bid_origin'):
      write.kind==='value'?write.payloads.filter(value=>value.customTargetingKeyId===keys[0].id&&value.name.toLowerCase()==='cached'):[]);
    assert.equal(overlap.length,existingParent?1:2,'only one key create and one value create may target the overlap');
  }
});

test('two first starts of the same reporting job cannot reuse one reservation and release the winner token',async()=>{
  const f=await setup();await oldCreative(f);const before=snapshot(f),j=await ready(f,report({key:'aq_bid_origin',values:['cached']}));
  assert.equal((await saved(f,j.id)).executionLane,'reporting_add_only_v1');
  let release,markBoth,arrivals=0;const gate=new Promise(resolve=>release=resolve),both=new Promise(resolve=>markBoth=resolve);
  f.beforeRead=async({method})=>{if(method==='network'&&arrivals<2){arrivals++;if(arrivals===2)markBoth();await gate;}};
  const first=request(f,`/line-items/jobs/${j.id}/start`,{confirm:true,confirmNetwork:'123456'});
  const second=request(f,`/line-items/jobs/${j.id}/start`,{confirm:true,confirmNetwork:'123456'});
  await both;release();const replies=await Promise.all([first,second]);
  assert.deepEqual(replies.map(reply=>reply.status).sort(),[200,409]);
  const held=await (await f.env.BUILDS.get(targetLock)).json();assert.equal(held.owner,j.id);assert(held.token);
  await finish(f,(await request(f,`/line-items/jobs/${j.id}`)).data);unchanged(f,before);assert.equal(f.duplicates,0);
});

test('a blocked new ad admission cannot poison a free targeting reservation for reporting',async()=>{
  const f=await setup(),waitingAd=await ready(f,tinyAd()),old=await oldCreative(f),before=snapshot(f);
  const blocked=await request(f,`/line-items/jobs/${waitingAd.id}/start`,{confirm:true,confirmNetwork:'123456'});
  assert.equal(blocked.status,409);assert.equal((await saved(f,waitingAd.id)).status,'ready');
  await finish(f,await start(f,await ready(f,report({key:'aq_bid_origin',values:['cached']}))));
  unchangedAd(f,before,old.id);assert.equal(f.duplicates,0);
});

test('a legacy key/value attempt without a new reservation remains a barrier even after its deadline',async()=>{
  for(const phase of ['key','value']) {
    const f=await setup(),kv=await ready(f,report({key:'aq_bid_origin',values:['cached']})),ad=await oldCreative(f);
    await change(f,ad.id,job=>{job.phase=phase;job.offset=0;job.refs['key:hb_pb']={state:'new'};});
    if(phase==='key')f.db.key=f.db.key.filter(key=>key.name!=='hb_pb');
    f.db.value=f.db.value.filter(value=>value.name!=='0.03');
    await f.env.BUILDS.put(attemptKey(ad.id,ad.cursor),JSON.stringify({startedAt:Date.now()-3600000,
      keys:[phase==='key'?'key:hb_pb':'value:hb_pb:0.03'],operation:'create'}));
    const before=snapshot(f),blocked=await request(f,`/line-items/jobs/${kv.id}/start`,{confirm:true,confirmNetwork:'123456'});
    assert.equal(blocked.status,409,phase);assert.equal(f.writes.length,0);unchangedAd(f,before,ad.id);
    const gate=f.env.BUILDS.data.get(targetLock);
    assert.equal(gate?Boolean(JSON.parse(gate.body).owner):false,false,'a refused first start must not leak a targeting reservation');
  }
});

test('unknown old phases or malformed creative-attempt metadata do not prove safe resource separation',async()=>{
  for(const mode of ['unknown-phase','malformed-attempt','wrong-kind-attempt']) {
    const f=await setup(),kv=await ready(f,report({key:'aq_bid_origin',values:[]})),ad=await oldCreative(f);
    if(mode==='unknown-phase')await change(f,ad.id,job=>{job.phase='unknown-phase';});
    else await f.env.BUILDS.put(attemptKey(ad.id,ad.cursor),JSON.stringify({startedAt:Date.now(),operation:'create',
      keys:mode==='malformed-attempt'?null:['key:aq_bid_origin']}));
    const before=snapshot(f),blocked=await request(f,`/line-items/jobs/${kv.id}/start`,{confirm:true,confirmNetwork:'123456'});
    assert.equal(blocked.status,409,mode);assert.equal(f.writes.length,0);unchangedAd(f,before,ad.id);
  }
});

test('an uncertain reporting create keeps the targeting fence after 90 seconds and blocks an ad writer until reconciliation',async()=>{
  const f=await setup(),ad=await ready(f,tinyAd()),kv=await ready(f,report({key:'aq_bid_origin',values:[]}));
  assert.equal((await saved(f,kv.id)).executionLane,'reporting_add_only_v1');
  let j=await start(f,kv);f.failNext('key');j=await action(f,j,'step');assert.equal(j.awaitingCheck,true);
  const gateBefore=structuredClone(f.env.BUILDS.data.get(targetLock));assert(gateBefore);
  const pending=await (await f.env.BUILDS.get(attemptKey(j.id,j.cursor))).json();pending.startedAt-=3600000;
  await f.env.BUILDS.put(attemptKey(j.id,j.cursor),JSON.stringify(pending));
  const writes=f.writes.length,cancelled=await request(f,`/line-items/jobs/${j.id}/cancel`,{});
  assert.equal(cancelled.status,409);assert.equal((await saved(f,j.id)).status,'creating');
  assert.deepEqual(f.env.BUILDS.data.get(targetLock),gateBefore);
  const blocked=await request(f,`/line-items/jobs/${ad.id}/start`,{confirm:true,confirmNetwork:'123456'});
  assert.equal(blocked.status,409);assert.equal(f.writes.length,writes);
  j=await action(f,j,'check');assert.equal(j.status,'completed');assert.equal(f.writes.length,writes);
  await finish(f,await start(f,ad));assert.equal(f.duplicates,0);
});

test('an unpersisted uncertain targeting write cannot be escaped by ageing, checking or cancelling it',async()=>{
  const f=await setup(),ad=await ready(f,tinyAd()),kv=await ready(f,report({key:'aq_bid_origin',values:[]}));
  assert.equal((await saved(f,kv.id)).executionLane,'reporting_add_only_v1');
  let j=await start(f,kv);f.failNext('key',false);j=await action(f,j,'step');assert.equal(j.awaitingCheck,true);
  const pending=await (await f.env.BUILDS.get(attemptKey(j.id,j.cursor))).json();pending.startedAt-=3600000;
  await f.env.BUILDS.put(attemptKey(j.id,j.cursor),JSON.stringify(pending));
  j=await action(f,j,'check');assert.equal(j.awaitingCheck,true);assert.equal(j.status,'creating');
  const before=structuredClone(f.env.BUILDS.data.get(targetLock)),writes=f.writes.length;
  assert.equal((await request(f,`/line-items/jobs/${j.id}/cancel`,{})).status,409);
  assert.equal((await request(f,`/line-items/jobs/${ad.id}/start`,{confirm:true,confirmNetwork:'123456'})).status,409);
  assert.deepEqual(f.env.BUILDS.data.get(targetLock),before);assert.equal(f.writes.length,writes);assert.equal(f.db.key.length,0);
});

test('missing or unreadable targeting owner state is unknown, never an expired free reservation',async()=>{
  for(const brokenRead of [false,true]) {
    const f=await setup(),kv=await ready(f,report({key:'aq_bid_origin',values:[]}));
    assert.equal((await saved(f,kv.id)).executionLane,'reporting_add_only_v1');
    const missing='12345678-1234-4234-8234-123456789abc';
    await f.env.BUILDS.put(targetLock,JSON.stringify({owner:missing,token:crypto.randomUUID(),createdAt:Date.now()-86400000}));
    if(brokenRead){const get=f.env.BUILDS.get.bind(f.env.BUILDS);f.env.BUILDS.get=async key=>{
      if(key===jobKey(missing))throw Error('Synthetic owner read unavailable');return get(key);
    };}
    const before=structuredClone(f.env.BUILDS.data.get(targetLock)),blocked=await request(f,`/line-items/jobs/${kv.id}/start`,{confirm:true,confirmNetwork:'123456'});
    assert.notEqual(blocked.status,200);assert.deepEqual(f.env.BUILDS.data.get(targetLock),before);assert.equal(f.writes.length,0);
  }
});

test('a foreign reporting or targeting owner is protected without exposing its job ID to another actor',async()=>{
  const f=await setup(),ad=await ready(f,tinyAd()),kv=await start(f,await ready(f,report({key:'aq_bid_origin',values:[]})));
  assert.equal((await saved(f,kv.id)).executionLane,'reporting_add_only_v1');
  await change(f,kv.id,job=>{job.actor='foreign@example.invalid';job.origin='https://foreign.invalid';});
  const before=structuredClone(f.env.BUILDS.data.get(targetLock)),oldJob=structuredClone(f.env.BUILDS.data.get(jobKey(kv.id)));
  for(const response of [await request(f,'/line-items/preview',report({key:'Variant',values:['A']})),
    await request(f,`/line-items/jobs/${ad.id}/start`,{confirm:true,confirmNetwork:'123456'})]) {
    assert.equal(response.status,409);assert.equal(JSON.stringify(response.data).includes(kv.id),false);
    assert.equal(response.data.activeJobId,undefined);assert.equal(response.data.activeJob,undefined);
  }
  assert.deepEqual(f.env.BUILDS.data.get(targetLock),before);assert.deepEqual(f.env.BUILDS.data.get(jobKey(kv.id)),oldJob);
  assert.equal(f.writes.length,0);
});

test('late completed-segment cleanup cannot clear another job targeting reservation',async()=>{
  const f=await setup(),first=await ready(f,report({key:'aq_bid_origin',values:[]}));
  assert.equal((await saved(f,first.id)).executionLane,'reporting_add_only_v1');
  let j=await start(f,first);const bucket=f.env.BUILDS,put=bucket.put.bind(bucket);
  let release,markEntered,held=false;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>markEntered=resolve);
  bucket.put=async(key,body,options)=>{
    if(key===targetLock&&JSON.parse(body).owner===null&&!held){held=true;markEntered();await gate;}
    return put(key,body,options);
  };
  const finishing=request(f,`/line-items/jobs/${j.id}/step`,{cursor:j.cursor});await entered;
  const second=await ready(f,report({key:'aq_first_request',values:[]}));
  const active=await start(f,second),current=await (await bucket.get(targetLock)).json();
  assert.equal(current.owner,second.id);release();const finished=await finishing;
  assert.equal(finished.status,200);assert.equal(finished.data.status,'completed');
  assert.equal((await (await bucket.get(targetLock)).json()).owner,second.id);
  await finish(f,active);assert.equal(f.duplicates,0);
});

test('an uncertain ad targeting write blocks reporting until the entire ad targeting segment is acknowledged',async()=>{
  const f=await setup(),ad=await ready(f,tinyAd()),kv=await ready(f,report({key:'aq_bid_origin',values:['cached']}));
  assert.equal((await saved(f,kv.id)).executionLane,'reporting_add_only_v1');
  let active=await start(f,ad);
  for(let n=0;active.phase!=='Key-value ključevi'&&n<8;n++)active=await action(f,active,'step');
  assert.equal(active.phase,'Key-value ključevi');f.failNext('key');active=await action(f,active,'step');
  assert.equal(active.awaitingCheck,true);const writes=f.writes.length;
  const pending=await (await f.env.BUILDS.get(attemptKey(active.id,active.cursor))).json();pending.startedAt-=3600000;
  await f.env.BUILDS.put(attemptKey(active.id,active.cursor),JSON.stringify(pending));
  assert.equal((await request(f,`/line-items/jobs/${active.id}/cancel`,{})).status,409);
  assert.equal((await request(f,`/line-items/jobs/${kv.id}/start`,{confirm:true,confirmNetwork:'123456'})).status,409);
  assert.equal(f.writes.length,writes);
  active=await action(f,active,'check');assert.equal(active.awaitingCheck,false);
  assert.equal((await request(f,`/line-items/jobs/${kv.id}/start`,{confirm:true,confirmNetwork:'123456'})).status,409);
  for(let n=0;['Key-value ključevi','Key-value vrednosti'].includes(active.phase)&&n<30;n++)active=await action(f,active,'step');
  assert.equal(active.status,'creating');assert.equal(active.phase,'Kreativi');
  const before=snapshot(f),beforeWrites=f.writes.length;await finish(f,await start(f,kv));
  assert.equal(f.writes.length,beforeWrites,'the second writer must reread and reuse the first writer values');
  unchangedAd(f,before,ad.id);assert.equal(f.duplicates,0);
});

test('an explicitly requested ad creative step can proceed while an independent targeting reply is uncertain',async()=>{
  const f=await setup(),ad=await oldCreative(f),kv=await ready(f,report({key:'aq_bid_origin',values:[]}));
  let active=await start(f,kv);f.failNext('key');active=await action(f,active,'step');assert.equal(active.awaitingCheck,true);
  const gate=structuredClone(f.env.BUILDS.data.get(targetLock)),writes=f.writes.length;
  const progressed=await action(f,ad,'step');assert.equal(progressed.status,'creating');assert.equal(progressed.phase,'Kreativi');
  assert((await saved(f,ad.id)).offset>19700);assert(f.writes.slice(writes).every(write=>write.tag==='ad'&&write.kind==='creative'));
  assert.deepEqual(f.env.BUILDS.data.get(targetLock),gate,'creative work must not claim or release the targeting reservation');
  const before=snapshot(f);active=await action(f,active,'check');assert.equal(active.status,'completed');
  unchangedAd(f,before,ad.id);assert.equal(f.duplicates,0);
});

test('client lane fields cannot redirect an ad plan or move an old ad lease into the reporting lane',async()=>{
  const f=await setup(),ad=await oldCreative(f),before=snapshot(f);
  const forged=await request(f,'/line-items/preview',{...tinyAd(),executionLane:'reporting_add_only_v1'});
  assert.equal(forged.status,409);unchanged(f,before);
  const replay=await request(f,`/line-items/jobs/${ad.id}/start`,{confirm:true,confirmNetwork:'123456',executionLane:'reporting_add_only_v1'});
  assert.equal(replay.status,200);unchanged(f,before);assert.equal(f.writes.length,0);
  const candidate=await request(f,'/line-items/preview',{...report({key:'aq_bid_origin',values:[]}),executionLane:'global'});
  assert([201,422].includes(candidate.status));
  if(candidate.status===201)assert.equal((await saved(f,candidate.data.id)).executionLane,'reporting_add_only_v1');
  unchanged(f,before);
});

test('an old global reporting owner completes in its old lane rather than leaving its global lease orphaned',async()=>{
  const f=await setup(),j=await ready(f,report({key:'aq_bid_origin',values:['cached']}));
  await change(f,j.id,job=>{
    delete job.executionLane;job.status='creating';job.phase='key';job.offset=0;job.cursor++;
    job.executionStartedAt='2026-11-18T10:00:00.000Z';
  });
  await f.env.BUILDS.put(globalLock,JSON.stringify({owner:j.id,actor,createdAt:Date.now()-3600000}));
  const opened=(await request(f,`/line-items/jobs/${j.id}`)).data;await finish(f,opened);
  assert.equal((await (await f.env.BUILDS.get(globalLock)).json()).owner,null);
  assert.equal((await saved(f,j.id)).executionLane,undefined);assert.equal(f.duplicates,0);
});

test('active reporting and ad owners remain visible after more than one hundred newer read-only previews',async()=>{
  const f=await setup(),ad=await oldCreative(f),first=await ready(f,report({key:'aq_bid_origin',values:[]}));
  assert.equal((await saved(f,first.id)).executionLane,'reporting_add_only_v1');
  for(let n=0;n<105;n++)await preview(f,report({key:'aq_first_request',values:[]}));
  const active=await start(f,first),before=snapshot(f),history=await request(f,'/line-items/jobs?network=123456');
  assert.equal(history.status,200);assert(history.data.jobs.some(job=>job.id===ad.id),'active global ad owner must remain reachable');
  assert(history.data.jobs.some(job=>job.id===active.id),'active independent reporting owner must remain reachable');
  assert.equal(new Set(history.data.jobs.map(job=>job.id)).size,history.data.jobs.length);
  assert.equal(f.writes.length,0);unchangedAd(f,before,ad.id);
});

test('present null or primitive legacy attempt records are unknown, not proof that no targeting write exists',async()=>{
  for(const value of [null,false,0]) {
    const f=await setup(),kv=await ready(f,report({key:'aq_bid_origin',values:[]})),ad=await oldCreative(f);
    await f.env.BUILDS.put(attemptKey(ad.id,ad.cursor),JSON.stringify(value));
    const before=snapshot(f),blocked=await request(f,`/line-items/jobs/${kv.id}/start`,{confirm:true,confirmNetwork:'123456'});
    assert.equal(blocked.status,409,JSON.stringify(value));assert.equal(f.writes.length,0);unchangedAd(f,before,ad.id);
  }
});

test('a cancel winning before the dispatch CAS leaves no leaked fence for a provably unsent attempt',async()=>{
  const f=await setup(),ad=await oldCreative(f),before=snapshot(f),kv=await start(f,await ready(f,report({key:'aq_bid_origin',values:[]})));
  const bucket=f.env.BUILDS,get=bucket.get.bind(bucket),put=bucket.put.bind(bucket);
  let releaseCancel,releaseStep,markCancel,markStep,holdCancel=true;
  const cancelGate=new Promise(resolve=>releaseCancel=resolve),cancelRead=new Promise(resolve=>markCancel=resolve);
  const stepGate=new Promise(resolve=>releaseStep=resolve),stepSave=new Promise(resolve=>markStep=resolve);
  bucket.get=async key=>{
    const value=await get(key);
    if(key===attemptKey(kv.id,kv.cursor)&&holdCancel){holdCancel=false;markCancel();await cancelGate;}
    return value;
  };
  bucket.put=async(key,body,options)=>{
    if(key===jobKey(kv.id)&&JSON.parse(body).status==='creating') {markStep();await stepGate;}
    return put(key,body,options);
  };
  const cancelling=request(f,`/line-items/jobs/${kv.id}/cancel`,{});await cancelRead;
  const stepping=request(f,`/line-items/jobs/${kv.id}/step`,{cursor:kv.cursor});await stepSave;
  assert(bucket.data.has(attemptKey(kv.id,kv.cursor)),'step has durably prepared its attempt, but has not won the dispatch CAS');
  releaseCancel();const cancelled=await cancelling;assert.equal(cancelled.status,200);assert.equal(cancelled.data.status,'cancelled');
  releaseStep();const stopped=await stepping;assert([200,409].includes(stopped.status));
  assert.equal(f.writes.length,0,'the cancelled stale step must never call Google');unchangedAd(f,before,ad.id);
  const next=await ready(f,report({key:'aq_first_request',values:[]}));
  await finish(f,await start(f,next));assert.equal(f.duplicates,0);unchangedAd(f,before,ad.id);
});
