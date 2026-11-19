import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

// The candidate override selects source only. Every credential, GAM response,
// lock and saved job in this suite belongs to isolated in-memory fixtures.
const root=resolve(process.env.GAM_ADD_ONLY_QA_ROOT??fileURLToPath(new URL('../..',import.meta.url)));
const load=path=>import(pathToFileURL(resolve(root,path)).href);
const {normalizeLinePlan}=await load('shared/gam/line-items.mjs');
const {gamResponse}=await load('worker/integrations/gam-service.mjs');
const {trafficFixture,prebidPlan}=await load('tests/gam/traffic-fixture.mjs');
const {MemoryBucket}=await load('tests/gam/fixture.mjs');
const {GamError}=await load('shared/gam/plan.mjs');
const base='/api/integrations/gam',origin='https://add-only-qa.invalid',actor='add-only-qa@example.invalid';
const prefix='api-integrations/gam/line-items/v1/';
const selected=(...rows)=>({mode:'reporting',networkCode:'123456',reportingSelection:rows});
const jobKey=id=>prefix+'jobs/'+id+'.json';
const lockKey=prefix+'locks/123456.json';
const attemptKey=(id,cursor)=>prefix+'attempts/'+id+'/'+cursor+'.json';

async function request(f,path,body,{as=actor,host=origin}={}) {
  const response=await gamResponse(new Request(host+base+path,{
    method:body===undefined?'GET':'POST',headers:{origin:host,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  }),f.env,as,{clientFactory:()=>{f.factories++;return f.client;},trafficFactory:()=>{f.factories++;return f.traffic;}});
  assert(response,'the real GAM handler must own this route');
  return {status:response.status,data:await response.json()};
}
async function setup() {
  const f=trafficFixture();f.writes=[];f.reads=[];f.updateAttempts=0;f.factories=0;
  for(const method of ['network','query','byNames','byIds']) {
    const original=f.traffic[method].bind(f.traffic);
    f.traffic[method]=async(...args)=>{f.reads.push({method,args:structuredClone(args)});return original(...args);};
  }
  f.traffic.update=async()=>{f.updateAttempts++;throw Error('FORBIDDEN: an add-only job attempted to update an existing GAM entity');};
  const create=f.traffic.create.bind(f.traffic);
  f.traffic.create=async(kind,payloads)=>{
    assert(['key','value'].includes(kind),'standalone key-values must not create ad objects');
    for(const payload of payloads) {
      const duplicate=f.db[kind].find(row=>row.name.toLowerCase()===payload.name.toLowerCase()&&
        (kind==='key'||String(row.customTargetingKeyId)===String(payload.customTargetingKeyId)));
      assert.equal(duplicate,undefined,'existing keys and values must never be duplicated');
    }
    f.writes.push({kind,payloads:structuredClone(payloads)});return create(kind,payloads);
  };
  const connected=await request(f,'/connect',{networkCode:'123456',credentials:{type:'service_account',
    client_email:'add-only-qa@fixture.iam.gserviceaccount.com',
    private_key:'-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----'}});
  assert.equal(connected.status,201,JSON.stringify(connected.data));return f;
}
async function action(f,j,verb,extra={}) {
  const r=await request(f,`/line-items/jobs/${j.id}/${verb}`,{cursor:j.cursor,...extra});
  assert.equal(r.status,200,JSON.stringify(r.data));return r.data;
}
async function preview(f,input) {
  const r=await request(f,'/line-items/preview',input);assert.equal(r.status,201,JSON.stringify(r.data));return r.data;
}
async function review(f,j) {
  for(let n=0;j.status==='reviewing'&&!j.error&&n<100;n++)j=await action(f,j,'review');
  return j;
}
async function ready(f,input=selected({key:'aq_bid_origin',values:['cached']})) {
  const j=await review(f,await preview(f,input));assert.equal(j.status,'ready');
  assert.equal(j.canStart,true,JSON.stringify(j));return j;
}
const start=(f,j)=>action(f,j,'start',{confirm:true,confirmNetwork:'123456'});
const close=(f,j,extra={})=>request(f,`/line-items/jobs/${j.id}/close-preview`,
  {cursor:j.cursor,confirm:true,confirmNetwork:'123456',...extra});
async function finish(f,j) {
  for(let n=0;j.status==='creating'&&n<150;n++) {
    j=await action(f,j,j.awaitingCheck?'check':'step');assert.equal(j.error,'',JSON.stringify(j));
  }
  assert.equal(j.status,'completed',JSON.stringify(j));return j;
}
async function readJob(f,id) {return (await (await f.env.BUILDS.get(jobKey(id))).json());}
async function changeJob(f,id,change) {
  const job=await readJob(f,id);change(job);await f.env.BUILDS.put(jobKey(id),JSON.stringify(job));return job;
}
function restart(f) {
  const bucket=new MemoryBucket();bucket.data=new Map([...f.env.BUILDS.data].map(([key,value])=>[key,structuredClone(value)]));
  return {...f,env:{...f.env,BUILDS:bucket}};
}
function row(j,key) {
  const item=j.reporting?.results?.find(item=>item.key===key);assert(item,'a saved job must show each selected key');return item;
}
function seedKey(f,{name='aq_bid_origin',id='9000',type='FREEFORM',reportableType='OFF',values=['cached'],status='ACTIVE'}={}) {
  const key={id,name,displayName:'Existing operator label: '+name,type,reportableType,status};f.db.key.push(key);
  values.forEach((name,index)=>f.db.value.push({id:String(Number(id)+index+1),name,
    displayName:'Existing value '+name,customTargetingKeyId:id,matchType:'EXACT',status:'ACTIVE'}));
  return key;
}
const sameExisting=(f,before)=>{
  for(const kind of ['key','value'])for(const original of before[kind])
    assert.deepEqual(f.db[kind].find(item=>item.id===original.id),original,`${kind} ${original.id} must be unchanged`);
};
const readsNow=f=>({reads:f.reads.length,network:f.counters.reads,factories:f.factories});

test('standalone server defaults to add_only even when a caller omits policy; ordinary ad snapshots retain their contract',()=>{
  assert.equal(normalizeLinePlan(selected({key:'aq_bid_origin'})).reporting.writePolicy,'add_only');
  assert.equal(normalizeLinePlan({mode:'reporting',networkCode:'123456'}).reporting.writePolicy,'add_only');
  assert.equal(normalizeLinePlan(prebidPlan()).reporting.writePolicy,undefined);
});

test('unsafe explicit write policies are rejected before jobs or Google writes',async()=>{
  const f=await setup();
  for(const reportingWritePolicy of [null,false,'','update','overwrite','legacy',{policy:'add_only'}]) {
    const input={...selected({key:'aq_bid_origin'}),reportingWritePolicy};
    assert.throws(()=>normalizeLinePlan(input),{status:422});
    const r=await request(f,'/line-items/preview',input);assert.equal(r.status,422,JSON.stringify(r.data));
  }
  assert.equal(normalizeLinePlan({...selected({key:'aq_bid_origin'}),reportingWritePolicy:'add_only'}).reporting.writePolicy,'add_only');
  assert.equal(f.writes.length,0);assert.equal(f.updateAttempts,0);
  assert.equal([...f.env.BUILDS.data.keys()].some(key=>key.startsWith(prefix+'jobs/')),false);
});

test('an explicit add-only request cannot be silently ignored on a metadata-updating ad plan',async()=>{
  const f=await setup();
  for(const input of [{...prebidPlan(),reportingWritePolicy:'add_only'},
    {...prebidPlan(),mode:'single',name:'Explicit policy single',lineItemType:'PRICE_PRIORITY',
      costType:'CPM',rate:'1.00',creative:{mode:'none'},reportingWritePolicy:'add_only'}]) {
    assert.throws(()=>normalizeLinePlan(input),{status:422});
    const rejected=await request(f,'/line-items/preview',input);assert.equal(rejected.status,422);
  }
  assert.equal(f.writes.length,0);assert.equal(f.updateAttempts,0);
});

test('OFF, ON and CUSTOM_DIMENSION keys keep exact metadata while only a selected missing value is added',async()=>{
  let f=await setup();seedKey(f,{type:'PREDEFINED'});
  seedKey(f,{name:'aq_timed_out',id:'9100',reportableType:'ON',values:['yes']});
  seedKey(f,{name:'Variant',id:'9200',reportableType:'CUSTOM_DIMENSION',values:['A']});
  seedKey(f,{name:'aq_first_request',id:'9300',reportableType:'OFF',values:['lt_500']});
  const before=structuredClone(f.db),input=selected({key:'aq_bid_origin',values:['cached','fresh']},
    {key:'aq_timed_out',values:['yes']},{key:'Variant',values:['A']});
  const j=await ready(f,input);assert.equal(j.reporting.writePolicy,'add_only');
  assert.equal((await readJob(f,j.id)).plan.reporting.writePolicy,'add_only');
  assert.equal(j.counts.key.update,0);assert.equal(row(j,'aq_bid_origin').outcome,'existing');
  assert.equal(row(j,'aq_bid_origin').reportableType,'OFF');assert.equal(f.writes.length,0);
  const done=await finish(f,await start(f,j));assert.equal(f.updateAttempts,0);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].kind,'value');
  assert.deepEqual(f.writes[0].payloads.map(value=>[value.customTargetingKeyId,value.name]),[['9000','fresh']]);
  sameExisting(f,before);assert.deepEqual(f.db.key,before.key);
  assert.equal(row(done,'aq_bid_origin').reportableType,'OFF');assert.equal(row(done,'aq_timed_out').reportableType,'ON');
  assert.equal(row(done,'Variant').reportableType,'CUSTOM_DIMENSION');
  assert(done.reporting.results.every(key=>key.outcome==='existing'));
  assert.equal(done.reporting.outcomes.keys.updated,0);
  const writes=f.writes.length;f=restart(f);const reopened=(await request(f,`/line-items/jobs/${done.id}`)).data;
  assert.equal(reopened.reporting.writePolicy,'add_only');assert.equal(row(reopened,'aq_bid_origin').reportableType,'OFF');
  await finish(f,await start(f,await ready(f,input)));assert.equal(f.writes.length,writes);assert.equal(f.updateAttempts,0);
});

test('missing keys use reporting ON while an existing selected OFF key and all ad objects remain untouched',async()=>{
  const f=await setup();seedKey(f);const before=structuredClone(f.db);
  const done=await finish(f,await start(f,await ready(f,selected({key:'aq_bid_origin',values:['cached']},
    {key:'aq_first_request',values:['lt_500']}))));
  sameExisting(f,before);assert.equal(f.updateAttempts,0);
  assert.equal(f.db.key.length,2);const created=f.db.key.find(key=>key.name==='aq_first_request');
  assert.equal(created.reportableType,'ON');assert.equal(created.type,'PREDEFINED');
  assert.equal(row(done,'aq_first_request').outcome,'created');assert.equal(row(done,'aq_first_request').reportableType,'ON');
  for(const kind of ['advertiser','order','creative','lineItem','association'])assert.deepEqual(f.db[kind],before[kind]);
});

test('a new key response that returns OFF is uncertain rather than confirmed as a newly reportable key',async()=>{
  const f=await setup(),create=f.traffic.create.bind(f.traffic);
  f.traffic.create=async(kind,payloads)=>{
    const rows=await create(kind,payloads);
    if(kind==='key')for(const key of rows){key.reportableType='OFF';f.db.key.find(item=>item.id===key.id).reportableType='OFF';}
    return rows;
  };
  let j=await start(f,await ready(f,selected({key:'aq_bid_origin',values:[]})));j=await action(f,j,'step');
  assert.equal(j.status,'creating');assert.equal(j.awaitingCheck,true);
  assert.notEqual(row(j,'aq_bid_origin').outcome,'created');assert.equal(f.updateAttempts,0);
});

test('an external ON to OFF change before selected value creation does not cause an update or rewind loop',async()=>{
  const f=await setup();const key=seedKey(f,{reportableType:'ON',values:[]});
  let j=await start(f,await ready(f));j=await action(f,j,'step');assert.equal(j.phase,'Key-value vrednosti');
  key.reportableType='OFF';const before=structuredClone(key);const done=await finish(f,j);
  assert.deepEqual(key,before);assert.equal(f.updateAttempts,0);assert.equal(f.db.value.length,1);
  assert.equal(row(done,'aq_bid_origin').reportableType,'OFF');assert.equal(row(done,'aq_bid_origin').outcome,'existing');
});

test('unknown/inactive/duplicate identities fail closed without updating or creating duplicates',async()=>{
  for(const mode of ['UNKNOWN','INACTIVE','UNKNOWN_REPORTABLE','duplicate','inactive-value']) {
    const f=await setup(),key=seedKey(f),before=structuredClone(f.db);
    if(mode==='UNKNOWN'||mode==='INACTIVE')key.status=mode;
    if(mode==='UNKNOWN_REPORTABLE')key.reportableType='UNKNOWN';
    if(mode==='duplicate')f.db.key.push({...key,id:'9100',name:'AQ_BID_ORIGIN'});
    if(mode==='inactive-value')f.db.value[0].status='INACTIVE';
    const seeded=structuredClone(f.db),j=await review(f,await preview(f,selected({key:'aq_bid_origin',values:['cached']})));
    assert.equal(j.canStart,false,mode);assert.notEqual(j.status,'completed');
    const denied=await request(f,`/line-items/jobs/${j.id}/start`,{confirm:true,confirmNetwork:'123456'});
    assert.notEqual(denied.status,200);assert.equal(f.writes.length,0);assert.equal(f.updateAttempts,0);assert.deepEqual(f.db,seeded);
    assert.equal(before.key.length,1);
  }
});

test('a wrong-parent value response is unverified rather than evidence for a new value',async()=>{
  const f=await setup();seedKey(f);const query=f.traffic.query.bind(f.traffic);
  f.traffic.query=async(kind,...args)=>{
    const found=await query(kind,...args);
    return kind==='value'?{...found,rows:found.rows.map(value=>({...value,customTargetingKeyId:'9999'}))}:found;
  };
  const j=await review(f,await preview(f,selected({key:'aq_bid_origin',values:['cached']})));
  assert.equal(j.canStart,false);assert(j.verificationCount>0);assert.equal(f.writes.length,0);assert.equal(f.updateAttempts,0);
});

test('lost create responses reconcile existing IDs without duplicate writes or updates to existing OFF parents',async()=>{
  let f=await setup();seedKey(f);const before=structuredClone(f.db);
  const input=selected({key:'aq_bid_origin',values:['cached']},{key:'aq_first_request',values:['lt_500']});
  let j=await start(f,await ready(f,input));f.failNext('key');j=await action(f,j,'step');
  assert.equal(j.awaitingCheck,true);assert.equal(j.status,'creating');const writes=f.writes.length,id=j.id;
  sameExisting(f,before);f=restart(f);j=(await request(f,`/line-items/jobs/${id}`)).data;
  j=await action(f,j,'step');assert.equal(f.writes.length,writes);
  j=await action(f,j,'check');assert.equal(f.writes.length,writes);assert.equal(j.awaitingCheck,false);
  const done=await finish(f,j);assert.equal(f.db.key.filter(key=>key.name==='aq_first_request').length,1);
  assert.equal(row(done,'aq_first_request').reconciled,true);assert.equal(f.updateAttempts,0);sameExisting(f,before);
});

test('lost selected-value creation under an OFF parent is reconciled without enabling or duplicating anything',async()=>{
  const f=await setup();const key=seedKey(f,{values:[]}),before=structuredClone(key);
  let j=await start(f,await ready(f));j=await action(f,j,'step');assert.equal(j.phase,'Key-value vrednosti');
  f.failNext('value');j=await action(f,j,'step');assert.equal(j.awaitingCheck,true);
  const writes=f.writes.length;j=await action(f,j,'check');assert.equal(f.writes.length,writes);
  assert.equal(j.status,'completed');assert.equal(row(j,'aq_bid_origin').reportableType,'OFF');
  assert.equal(row(j,'aq_bid_origin').values[0].reconciled,true);assert.equal(f.db.value.length,1);
  assert.deepEqual(key,before);assert.equal(f.updateAttempts,0);
});

test('concurrent same-cursor create steps preserve one write sequence',async()=>{
  const f=await setup();seedKey(f);const before=structuredClone(f.db);
  const j=await start(f,await ready(f,selected({key:'aq_bid_origin',values:['cached']},
    {key:'aq_first_request',values:['lt_500']})));
  const responses=await Promise.all([request(f,`/line-items/jobs/${j.id}/step`,{cursor:j.cursor}),
    request(f,`/line-items/jobs/${j.id}/step`,{cursor:j.cursor})]);
  assert(responses.every(response=>[200,409].includes(response.status)));
  const latest=(await request(f,`/line-items/jobs/${j.id}`)).data;await finish(f,latest);
  assert.equal(f.writes.filter(write=>write.kind==='key').length,1);assert.equal(f.updateAttempts,0);sameExisting(f,before);
});

test('legacy standalone start and step are server-blocked even when request body claims add_only',async()=>{
  for(const status of ['ready','creating','completed']) {
    const f=await setup();seedKey(f);const j=await ready(f);
    await changeJob(f,j.id,job=>{delete job.plan.reporting.writePolicy;job.status=status;});
    const before=structuredClone(f.env.BUILDS.data),reads=readsNow(f);
    const loaded=await request(f,`/line-items/jobs/${j.id}`);assert.equal(loaded.status,200);
    assert.equal(loaded.data.executionAllowed,false);assert.equal(loaded.data.canStart,false);
    for(const verb of ['start','step']) {
      const blocked=await request(f,`/line-items/jobs/${j.id}/${verb}`,{cursor:j.cursor,confirm:true,
        confirmNetwork:'123456',reportingWritePolicy:'add_only'});
      assert.equal(blocked.status,409,status+' '+verb);assert(blocked.data.error);
    }
    assert.equal(f.writes.length,0);assert.equal(f.updateAttempts,0);assert.deepEqual(f.env.BUILDS.data,before);
    assert.deepEqual(readsNow(f),reads,'legacy write guard runs before Google client work');
  }
});

test('legacy standalone GET, review, check and cancel remain read-only',async()=>{
  const f=await setup();seedKey(f);let j=await ready(f);
  await changeJob(f,j.id,job=>{delete job.plan.reporting.writePolicy;});
  j=(await request(f,`/line-items/jobs/${j.id}`)).data;assert.equal(j.executionAllowed,false);
  j=await action(f,j,'review',{retry:true});j=await review(f,j);
  j=await action(f,j,'check');assert.equal(f.writes.length,0);assert.equal(f.updateAttempts,0);
  j=await action(f,j,'cancel');assert.equal(j.status,'cancelled');assert.equal(f.writes.length,0);
});

test('a legacy uncertain update can be checked but cannot resume its old mutation policy',async()=>{
  const f=await setup(),key=seedKey(f);let j=await start(f,await ready(f));
  await changeJob(f,j.id,job=>{delete job.plan.reporting.writePolicy;job.refs['key:aq_bid_origin'].state='update';job.refs['key:aq_bid_origin'].verifiedId=true;});
  key.reportableType='ON';
  await f.env.BUILDS.put(attemptKey(j.id,j.cursor),JSON.stringify({startedAt:Date.now(),keys:['key:aq_bid_origin'],operation:'update'}));
  const before=structuredClone(f.db);j=(await request(f,`/line-items/jobs/${j.id}`)).data;
  assert.equal(j.executionAllowed,false);assert.equal(j.awaitingCheck,true);
  const checked=await request(f,`/line-items/jobs/${j.id}/check`,{cursor:j.cursor});assert.equal(checked.status,200);
  const denied=await request(f,`/line-items/jobs/${j.id}/step`,{cursor:checked.data.cursor,reportingWritePolicy:'add_only'});
  assert.equal(denied.status,409);assert.deepEqual(f.db,before);assert.equal(f.updateAttempts,0);assert.equal(f.writes.length,0);
});

test('a blocking own unstarted preview is summarized but never automatically closed or started',async()=>{
  const f=await setup();seedKey(f);const j=await ready(f);
  await f.env.BUILDS.put(lockKey,JSON.stringify({owner:j.id,actor,createdAt:Date.now()}));
  const before=structuredClone(f.env.BUILDS.data),blocked=await request(f,'/line-items/preview',selected({key:'Variant',values:['A']}));
  assert.equal(blocked.status,409);assert.equal(blocked.data.activeJobId,j.id);
  assert.equal(blocked.data.activeJob.id,j.id);assert.equal(blocked.data.activeJob.mode,'reporting');
  assert.equal(blocked.data.activeJob.status,'ready');assert.equal(blocked.data.activeJob.canClosePreview,true);
  assert.deepEqual(f.env.BUILDS.data,before);assert.equal(f.writes.length,0);assert.equal(f.updateAttempts,0);
});

test('foreign actor or origin receives no active job ID or summary',async()=>{
  const f=await setup();const j=await ready(f);
  await f.env.BUILDS.put(lockKey,JSON.stringify({owner:j.id,actor,createdAt:Date.now()}));
  for(const context of [{as:'foreign@example.invalid'},{host:'https://foreign-qa.invalid'}]) {
    const blocked=await request(f,'/line-items/preview',selected({key:'Variant',values:['A']}),context);
    assert.equal(blocked.status,409);assert.equal(blocked.data.activeJob,undefined);assert.equal(blocked.data.activeJobId,undefined);
  }
  assert.equal(f.writes.length,0);
});

test('a creating ad job stays locked and cannot be safely closed as a preview',async()=>{
  const f=await setup(),r=await request(f,'/line-items/preview',prebidPlan());assert.equal(r.status,201);
  const ad=await start(f,await review(f,r.data)),before=structuredClone(f.env.BUILDS.data);
  const blocked=await request(f,'/line-items/preview',selected({key:'aq_bid_origin',values:['cached']}));
  assert.equal(blocked.status,409);assert.equal(blocked.data.activeJob.mode,'prebid');
  assert.equal(blocked.data.activeJob.status,'creating');assert.equal(blocked.data.activeJob.canClosePreview,false);
  const denied=await close(f,ad);assert.equal(denied.status,409);assert.deepEqual(f.env.BUILDS.data,before);
  assert.equal(f.writes.length,0);assert.equal(f.updateAttempts,0);
});

test('close-preview explicitly closes reviewing or ready jobs and releases only their lock without Google work',async()=>{
  for(const phase of ['reviewing','ready']) {
    const f=await setup();seedKey(f);let j=await preview(f,selected({key:'aq_bid_origin',values:['cached']}));
    if(phase==='ready')j=await review(f,j);
    assert.equal(j.canClosePreview,true);await f.env.BUILDS.put(lockKey,JSON.stringify({owner:j.id,actor}));
    const before=structuredClone(f.db),reads=readsNow(f),closed=await close(f,j);
    assert.equal(closed.status,200,JSON.stringify(closed.data));assert.equal(closed.data.status,'cancelled');
    assert.equal((await readJob(f,j.id)).status,'cancelled');assert.equal((await (await f.env.BUILDS.get(lockKey)).json()).owner,null);
    assert.deepEqual(readsNow(f),reads);assert.deepEqual(f.db,before);assert.equal(f.writes.length,0);assert.equal(f.updateAttempts,0);
    const fresh=await preview(f,selected({key:'Variant',values:['A']}));assert.notEqual(fresh.id,j.id);
  }
});

test('legacy unstarted preview can be closed safely without accepting its unsafe write policy',async()=>{
  const f=await setup();seedKey(f);const j=await ready(f);
  await changeJob(f,j.id,job=>{delete job.plan.reporting.writePolicy;job.refs['key:aq_bid_origin'].state='update';job.refs['key:aq_bid_origin'].verifiedId=true;});
  await f.env.BUILDS.put(lockKey,JSON.stringify({owner:j.id,actor}));
  const shown=(await request(f,`/line-items/jobs/${j.id}`)).data;
  assert.equal(shown.executionAllowed,false);assert.equal(shown.canClosePreview,true);
  const before=structuredClone(f.db),reads=readsNow(f),closed=await close(f,shown);
  assert.equal(closed.status,200);assert.equal(closed.data.status,'cancelled');assert.deepEqual(readsNow(f),reads);
  assert.deepEqual(f.db,before);assert.equal(f.updateAttempts,0);assert.equal(f.writes.length,0);
});

test('closing an unstarted preview does not depend on still-available GAM credentials or connection',async()=>{
  const f=await setup(),j=await ready(f);assert.equal(j.canClosePreview,true);
  f.env.GAM_CREDENTIALS_KEY='';f.env.BUILDS.data.delete('api-integrations/gam/v1/connections/123456.json');
  const reads=readsNow(f),closed=await close(f,j);assert.equal(closed.status,200);
  assert.equal(closed.data.status,'cancelled');assert.deepEqual(readsNow(f),reads);assert.equal(f.writes.length,0);
});

test('close-preview strictly checks confirmation, exact network, cursor, actor and origin',async()=>{
  const f=await setup(),j=await ready(f);assert.equal(j.canClosePreview,true);
  const before=structuredClone(f.env.BUILDS.data);
  for(const extra of [{confirm:false},{confirm:'true'},{confirm:undefined},{confirmNetwork:'999'},
    {confirmNetwork:123456},{cursor:j.cursor-1},{cursor:String(j.cursor)},{cursor:undefined}]) {
    const denied=await close(f,j,extra);assert.notEqual(denied.status,200,JSON.stringify(extra));
    assert.deepEqual(f.env.BUILDS.data,before);
  }
  for(const context of [{as:'foreign@example.invalid'},{host:'https://foreign-qa.invalid'}]) {
    const denied=await request(f,`/line-items/jobs/${j.id}/close-preview`,
      {confirm:true,confirmNetwork:'123456',cursor:j.cursor},context);
    assert.equal(denied.status,404);assert.deepEqual(f.env.BUILDS.data,before);
  }
  assert.equal(f.writes.length,0);
});

test('close-preview refuses active, completed or already closed jobs',async()=>{
  for(const status of ['creating','completed','cancelled']) {
    const f=await setup(),j=await ready(f);await changeJob(f,j.id,job=>{job.status=status;});
    const shown=(await request(f,`/line-items/jobs/${j.id}`)).data;assert.equal(shown.canClosePreview,false);
    const before=structuredClone(f.env.BUILDS.data),denied=await close(f,shown);
    assert.equal(denied.status,409);assert.deepEqual(f.env.BUILDS.data,before);assert.equal(f.writes.length,0);
  }
});

test('any durable attempt, including an old cursor or expired deadline, prevents closing a preview',async()=>{
  for(const current of [true,false]) {
    const f=await setup(),j=await ready(f);
    await f.env.BUILDS.put(attemptKey(j.id,current?j.cursor:j.cursor-1),
      JSON.stringify({startedAt:Date.now()-180000,keys:['key:aq_bid_origin'],operation:'create'}));
    const shown=(await request(f,`/line-items/jobs/${j.id}`)).data;assert.equal(shown.canClosePreview,false);
    const before=structuredClone(f.env.BUILDS.data),denied=await close(f,shown);
    assert.equal(denied.status,409);assert.deepEqual(f.env.BUILDS.data,before);assert.equal(f.writes.length,0);
  }
});

test('historical created, updated or reconciled reference provenance prevents closing a preview',async()=>{
  for(const provenance of [{state:'created'},{state:'existing',createdByJob:true},
    {state:'unverified',reportingUpdated:true},{state:'conflict',reportingReconciled:true}]) {
    const f=await setup();seedKey(f);const j=await ready(f);
    await changeJob(f,j.id,job=>{Object.assign(job.refs['key:aq_bid_origin'],provenance);});
    const shown=(await request(f,`/line-items/jobs/${j.id}`)).data;assert.equal(shown.canClosePreview,false);
    const before=structuredClone(f.env.BUILDS.data),denied=await close(f,shown);
    assert.equal(denied.status,409);assert.deepEqual(f.env.BUILDS.data,before);assert.equal(f.writes.length,0);
  }
});

test('saved execution markers prevent closing even a superficially ready job',async()=>{
  for(const marker of ['executionStartedAt','startedAt']) {
    const f=await setup(),j=await ready(f);
    await changeJob(f,j.id,job=>{job[marker]=new Date().toISOString();});
    const shown=(await request(f,`/line-items/jobs/${j.id}`)).data;assert.equal(shown.canClosePreview,false);
    const before=structuredClone(f.env.BUILDS.data),denied=await close(f,shown);
    assert.equal(denied.status,409);assert.deepEqual(f.env.BUILDS.data,before);assert.equal(f.writes.length,0);
  }
});

test('failed, truncated or malformed attempt-list reads cannot prove a preview is safe to close',async()=>{
  for(const mode of ['throw','truncated','malformed']) {
    const f=await setup(),j=await ready(f),list=f.env.BUILDS.list.bind(f.env.BUILDS);
    f.env.BUILDS.list=async options=>{
      if(options.prefix.startsWith(prefix+'attempts/'+j.id+'/')) {
        if(mode==='throw')throw Error('Synthetic attempt-history read unavailable');
        if(mode==='truncated')return {objects:[],truncated:true};
        return {objects:null,truncated:false};
      }
      return list(options);
    };
    const reads=readsNow(f),denied=await close(f,j);assert.notEqual(denied.status,200,mode);
    assert.equal((await readJob(f,j.id)).status,'ready');assert.deepEqual(readsNow(f),reads);assert.equal(f.writes.length,0);
  }
});

test('concurrent start and close-preview have one CAS winner and preserve the winner state',async()=>{
  const f=await setup(),j=await ready(f);assert.equal(j.canClosePreview,true);
  const bucket=f.env.BUILDS,get=bucket.get.bind(bucket);let arrivals=0,release,markReady;
  const gate=new Promise(resolve=>release=resolve),both=new Promise(resolve=>markReady=resolve);
  bucket.get=async key=>{const found=await get(key);if(key===jobKey(j.id)&&arrivals<2){arrivals++;if(arrivals===2)markReady();await gate;}return found;};
  const closing=close(f,j),starting=request(f,`/line-items/jobs/${j.id}/start`,{confirm:true,confirmNetwork:'123456'});
  let deadline;
  try{await Promise.race([both,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Both operations must read the job')),5000);})]);}
  finally{clearTimeout(deadline);release();}
  const responses=await Promise.all([closing,starting]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  const final=await readJob(f,j.id);assert(['creating','cancelled'].includes(final.status));
  if(final.status==='creating')assert.equal((await (await bucket.get(lockKey)).json()).owner,j.id);
  assert.equal(f.writes.length,0);assert.equal(f.updateAttempts,0);
});

test('a start winning the saved-state CAS prevents a waiting close from releasing its active lock',async()=>{
  const f=await setup(),j=await ready(f);assert.equal(j.canClosePreview,true);
  const bucket=f.env.BUILDS,put=bucket.put.bind(bucket);let release,markEntered;
  const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>markEntered=resolve);
  bucket.put=async(key,body,options)=>{
    if(key===jobKey(j.id)&&JSON.parse(body).status==='cancelled'){markEntered();await gate;}
    return put(key,body,options);
  };
  const closing=close(f,j);await entered;
  const started=await request(f,`/line-items/jobs/${j.id}/start`,{confirm:true,confirmNetwork:'123456'});
  release();const closed=await closing;
  assert.equal(started.status,200);assert.equal(started.data.status,'creating');assert.equal(closed.status,409);
  assert.equal((await readJob(f,j.id)).status,'creating');assert.equal((await (await bucket.get(lockKey)).json()).owner,j.id);
  assert.equal(f.writes.length,0);assert.equal(f.updateAttempts,0);
});

test('a close winning before a pending start cannot be overwritten by the stale start',async()=>{
  const f=await setup(),j=await ready(f);assert.equal(j.canClosePreview,true);
  const network=f.traffic.network.bind(f.traffic);let release,markEntered;
  const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>markEntered=resolve);
  f.traffic.network=async()=>{markEntered();await gate;return network();};
  const starting=request(f,`/line-items/jobs/${j.id}/start`,{confirm:true,confirmNetwork:'123456'});await entered;
  const closed=await close(f,j);release();const started=await starting;
  assert.equal(closed.status,200);assert.equal(closed.data.status,'cancelled');assert.equal(started.status,409);
  assert.equal((await readJob(f,j.id)).status,'cancelled');assert.equal(f.writes.length,0);assert.equal(f.updateAttempts,0);
  const next=await preview(f,selected({key:'Variant',values:['A']}));assert.notEqual(next.id,j.id);
});

test('closing a preview wins against a review read already in flight',async()=>{
  const f=await setup();seedKey(f);const j=await ready(f);assert.equal(j.canClosePreview,true);
  const byIds=f.traffic.byIds.bind(f.traffic);let release,markEntered;
  const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>markEntered=resolve);
  f.traffic.byIds=async(kind,...args)=>{if(kind==='key'){markEntered();await gate;}return byIds(kind,...args);};
  const reviewing=request(f,`/line-items/jobs/${j.id}/review`,{cursor:j.cursor,retry:true});
  await entered;const closed=await close(f,j);release();const reviewed=await reviewing;
  assert.equal(closed.status,200);assert.equal(reviewed.status,409);assert.equal((await readJob(f,j.id)).status,'cancelled');
  assert.equal(f.writes.length,0);assert.equal(f.updateAttempts,0);
});

test('late lock release from a closed preview cannot clear a newly started different job',async()=>{
  const f=await setup(),j=await ready(f);assert.equal(j.canClosePreview,true);
  await f.env.BUILDS.put(lockKey,JSON.stringify({owner:j.id,actor}));
  const bucket=f.env.BUILDS,put=bucket.put.bind(bucket);let release,markEntered;
  const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>markEntered=resolve);
  bucket.put=async(key,body,options)=>{
    if(key===lockKey&&JSON.parse(body).owner===null){markEntered();await gate;}
    return put(key,body,options);
  };
  const closing=close(f,j);await entered;
  const second=await start(f,await ready(f,selected({key:'Variant',values:['A']})));
  release();const closed=await closing;assert.equal(closed.status,200);assert.equal(second.status,'creating');
  assert.equal((await (await bucket.get(lockKey)).json()).owner,second.id);
  assert.equal((await readJob(f,second.id)).status,'creating');assert.equal(f.writes.length,0);
});
