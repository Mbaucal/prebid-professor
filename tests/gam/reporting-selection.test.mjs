import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Candidate override is only for independent worktree review. All storage,
// credentials and Google traffic in these public-handler checks are synthetic.
const root=resolve(process.env.GAM_SELECTION_QA_ROOT??fileURLToPath(new URL('../..',import.meta.url)));
const load=path=>import(pathToFileURL(resolve(root,path)).href);
const {normalizeLinePlan}=await load('shared/gam/line-items.mjs');
const {gamResponse}=await load('worker/integrations/gam-service.mjs');
const {GamError}=await load('shared/gam/plan.mjs');
const {trafficFixture,prebidPlan}=await load('tests/gam/traffic-fixture.mjs');
const {MemoryBucket}=await load('tests/gam/fixture.mjs');
const base='/api/integrations/gam',origin='https://selection-qa.invalid',actor='selection-qa@example.invalid';
const jobPrefix='api-integrations/gam/line-items/v1/jobs/';
const knownKeys=['refresh_count','refresh_bucket','refresh_interval','refresh_policy','aq_bidder_count',
  'aq_bid_count','aq_timed_out','aq_bid_origin','aq_first_request','aq_consent_wait','geo_country','Variant'];
const timeValues=['lt_500','500_999','1000_1499','1500_1999','2000_2999','3000_plus'];
const selection=(...rows)=>({mode:'reporting',networkCode:'123456',reportingSelection:rows});

async function request(f,path,body,as=actor,source=origin) {
  const response=await gamResponse(new Request(origin+base+path,{
    method:body===undefined?'GET':'POST',headers:{origin:source,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  }),f.env,as,{clientFactory:()=>f.client,trafficFactory:()=>f.traffic});
  assert(response,'the public GAM handler must own this route');
  return {status:response.status,data:await response.json()};
}
async function setup(connect=true) {
  const f=trafficFixture();f.writes=[];f.reads=[];
  for(const method of ['network','query','byNames','byIds']) {
    const original=f.traffic[method].bind(f.traffic);
    f.traffic[method]=async(...args)=>{f.reads.push({method,args:structuredClone(args)});return original(...args);};
  }
  for(const method of ['create','update']) {
    const original=f.traffic[method].bind(f.traffic);
    f.traffic[method]=async(kind,payloads)=>{
      if(method==='create'&&['key','value'].includes(kind))for(const payload of payloads) {
        const duplicate=f.db[kind].find(row=>row.name.toLowerCase()===payload.name.toLowerCase()&&
          (kind==='key'||String(row.customTargetingKeyId)===String(payload.customTargetingKeyId)));
        assert.equal(duplicate,undefined,'GAM case-insensitive names must not be blindly recreated');
      }
      f.writes.push({method,kind,payloads:structuredClone(payloads)});
      return original(kind,payloads);
    };
  }
  if(connect) {
    const r=await request(f,'/connect',{networkCode:'123456',credentials:{type:'service_account',
      client_email:'selection-qa@fixture.iam.gserviceaccount.com',
      private_key:'-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----'}});
    assert.equal(r.status,201,JSON.stringify(r.data));
  }
  return f;
}
async function preview(f,input) {
  const r=await request(f,'/line-items/preview',input);assert.equal(r.status,201,JSON.stringify(r.data));return r.data;
}
async function action(f,j,verb,extra={}) {
  const r=await request(f,`/line-items/jobs/${j.id}/${verb}`,{cursor:j.cursor,...extra});
  assert.equal(r.status,200,JSON.stringify(r.data));return r.data;
}
async function review(f,j) {
  for(let n=0;j.status==='reviewing'&&!j.error&&n<100;n++)j=await action(f,j,'review');
  return j;
}
async function ready(f,input) {
  const j=await review(f,await preview(f,input));assert.equal(j.status,'ready');
  assert.equal(j.canStart,true,JSON.stringify(j));return j;
}
const start=(f,j)=>action(f,j,'start',{confirm:true,confirmNetwork:'123456'});
async function finish(f,j) {
  for(let n=0;j.status==='creating'&&n<150;n++) {
    j=await action(f,j,j.awaitingCheck?'check':'step');assert.equal(j.error,'',JSON.stringify(j));
  }
  assert.equal(j.status,'completed',JSON.stringify(j));return j;
}
function stored(f,id) {
  const entry=f.env.BUILDS.data.get(jobPrefix+id+'.json');assert(entry);return JSON.parse(entry.body);
}
function restart(f) {
  const bucket=new MemoryBucket();bucket.data=new Map([...f.env.BUILDS.data].map(([key,value])=>[key,structuredClone(value)]));
  return {...f,env:{...f.env,BUILDS:bucket}};
}
function result(j,key) {
  assert(Array.isArray(j.reporting?.results),'saved reporting jobs must expose per-key results');
  const row=j.reporting.results.find(row=>row.key===key);assert(row,key);return row;
}
function assertOutcomes(j) {
  for(const kind of ['keys','values']) {
    const counts=j.reporting?.outcomes?.[kind];assert(counts,'outcome aggregates must be available');
    assert.equal(Object.entries(counts).filter(([key])=>key!=='total').reduce((n,[,count])=>n+count,0),counts.total,
      'per-kind outcome categories must partition selected entities');
  }
}
function seedKey(f,{name='aq_bid_origin',reportableType='ON',values=['cached'],id='9000'}={}) {
  const key={id,name,displayName:'Original operator label',type:'FREEFORM',reportableType,status:'ACTIVE'};
  f.db.key.push(key);
  values.forEach((name,index)=>f.db.value.push({id:String(Number(id)+index+1),name,displayName:'Original '+name,
    customTargetingKeyId:id,matchType:'EXACT',status:'ACTIVE'}));
  return key;
}
const shape=plan=>plan.reporting.keys.map(row=>({key:row.key,values:row.values}));

test('read-only key-values catalog is available without a GAM connection or Google reads',async()=>{
  const f=await setup(false),before=structuredClone(f.env.BUILDS.data);
  f.client.network=async()=>assert.fail('catalog cannot call Google');
  const r=await request(f,'/key-values/catalog');assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(r.data.profile,'ads-js-3.25');assert.deepEqual(r.data.keys.map(row=>row.key),knownKeys);
  assert.equal(r.data.keys.reduce((n,row)=>n+row.values.length,0),283);
  assert.deepEqual(r.data.keys.find(row=>row.key==='aq_bid_origin').values,['fresh','cached','none']);
  assert.deepEqual(r.data.keys.find(row=>row.key==='aq_first_request').values,timeValues);
  assert.deepEqual(r.data.keys.find(row=>row.key==='aq_consent_wait').values,[...timeValues,'na','timeout']);
  assert.equal(f.reads.length,0);assert.equal(f.writes.length,0);assert.deepEqual(f.env.BUILDS.data,before);
});

test('no explicit selection retains the complete existing default and ordinary-ad contract',()=>{
  for(const input of [{mode:'reporting',networkCode:'123456'},prebidPlan()]) {
    const p=normalizeLinePlan(input);assert.equal(p.reporting.keys.length,12);
    assert.equal(p.reporting.keys.reduce((n,key)=>n+key.values.length,0),283);
  }
});

test('selection is canonical, detached and contains only chosen keys and finite values',()=>{
  const input=selection({key:'VARIANT',values:['b','A','A']},{key:'AQ_BID_ORIGIN',values:['CACHED','fresh']});
  const before=structuredClone(input),p=normalizeLinePlan(input);assert.deepEqual(input,before);
  assert.deepEqual(shape(p),[{key:'aq_bid_origin',values:['fresh','cached']},{key:'Variant',values:['A','B']}]);
  assert.deepEqual(p.rules,[]);assert.deepEqual(p.rows,[]);assert.deepEqual(p.orders,[]);
  p.reporting.keys[0].values.push('mutated');
  assert.deepEqual(shape(normalizeLinePlan(before)),[{key:'aq_bid_origin',values:['fresh','cached']},{key:'Variant',values:['A','B']}]);
  assert.deepEqual(shape(normalizeLinePlan(selection({key:'geo_country',values:['rs','XK']}))),[{key:'geo_country',values:['RS','XK']}]);
});

test('omitted values choose only that key preset; an empty values list explicitly prepares only its key',()=>{
  assert.deepEqual(shape(normalizeLinePlan(selection({key:'aq_bid_origin'}))),[{key:'aq_bid_origin',values:['fresh','cached','none']}]);
  assert.deepEqual(shape(normalizeLinePlan(selection({key:'aq_bid_origin',values:[]}))),[{key:'aq_bid_origin',values:[]}]);
});

test('open numeric selections support canonical explicit values without silently adding defaults',()=>{
  const p=normalizeLinePlan(selection({key:'refresh_count',values:[2,'1.0',1]},
    {key:'refresh_interval',values:['UNSCHEDULED','30.000000',0.5]}));
  assert.deepEqual(shape(p),[{key:'refresh_count',values:['1','2']},
    {key:'refresh_interval',values:['unscheduled','0.5','30']}]);
  const additions=normalizeLinePlan({...selection({key:'aq_bid_count'}),reportingValues:{aq_bid_count:[2,1]}});
  assert.deepEqual(shape(additions),[{key:'aq_bid_count',values:['0','1','2']}]);
});

test('invalid selections fail before a job or a Google write is created',async()=>{
  const invalid=[null,[],{},'all',[null],[{}],[{key:'unknown'}],[{key:'hb_adid'}],
    [{key:'aq_bid_origin'},{key:'AQ_BID_ORIGIN'}],[{key:'aq_bid_origin',values:'cached'}],
    [{key:'aq_bid_origin',values:[true]}],[{key:'aq_bid_origin',values:['not-a-runtime-value']}],
    [{key:'geo_country',values:['XX']}],[{key:'aq_bid_count',values:[-1]}],
    [{key:'aq_bid_count',values:['1.5']}],[{key:'refresh_interval',values:[0]}],
    [{key:'aq_bid_count',values:['1e3']}],[{key:'aq_bid_count',values:Array.from({length:1001},(_,n)=>n)}]];
  const f=await setup();
  for(const reportingSelection of invalid) {
    const input={mode:'reporting',networkCode:'123456',reportingSelection};
    assert.throws(()=>normalizeLinePlan(input),{status:422},JSON.stringify(reportingSelection).slice(0,80));
    const r=await request(f,'/line-items/preview',input);assert.equal(r.status,422,JSON.stringify(r.data));
  }
  assert.equal(f.writes.length,0);assert.equal([...f.env.BUILDS.data.keys()].some(key=>key.startsWith(jobPrefix)),false);
});

test('selection cannot affect ad-mode plans or smuggle additions for an unselected key',async()=>{
  const f=await setup();
  for(const input of [{...prebidPlan(),reportingSelection:[{key:'aq_bid_origin'}]},
    {...selection({key:'aq_bid_origin'}),reportingValues:{aq_bid_count:[1]}}]) {
    assert.throws(()=>normalizeLinePlan(input),{status:422});
    const r=await request(f,'/line-items/preview',input);assert.equal(r.status,422,JSON.stringify(r.data));
  }
  assert.equal(f.writes.length,0);
});

test('a chosen one-value subset writes no unselected key, value or ad object',async()=>{
  const f=await setup(),input=selection({key:'aq_bid_origin',values:['cached']});
  const j=await ready(f,input);assert.equal(j.counts.key.total,1);assert.equal(j.counts.value.total,1);
  assert.equal(f.writes.length,0);assert.equal(j.status,'ready');assert.equal(result(j,'aq_bid_origin').outcome,'new');
  const snapshot=stored(f,j.id).plan;assert.deepEqual(shape(snapshot),[{key:'aq_bid_origin',values:['cached']}]);
  const done=await finish(f,await start(f,j));
  assert.deepEqual(f.db.key.map(row=>row.name),['aq_bid_origin']);assert.deepEqual(f.db.value.map(row=>row.name),['cached']);
  assert(f.writes.every(write=>['key','value'].includes(write.kind)));
  assert.equal(result(done,'aq_bid_origin').outcome,'created');assert.equal(result(done,'aq_bid_origin').values[0].outcome,'created');
  assert.match(result(done,'aq_bid_origin').id,/^[1-9]\d*$/);assert.match(result(done,'aq_bid_origin').values[0].id,/^[1-9]\d*$/);
  assertOutcomes(done);
});

test('a selected key with zero values completes with exactly one key mutation',async()=>{
  const f=await setup(),j=await ready(f,selection({key:'aq_bid_origin',values:[]}));
  assert.equal(j.counts.key.total,1);assert.equal(j.counts.value.total,0);assert.equal(f.writes.length,0);
  const done=await finish(f,await start(f,j));assert.equal(f.db.key.length,1);assert.equal(f.db.value.length,0);
  assert.equal(f.writes.length,1);assert.deepEqual(result(done,'aq_bid_origin').values,[]);assertOutcomes(done);
});

test('all-existing subset is completed without writes and reports existing IDs',async()=>{
  const f=await setup();const key=seedKey(f,{name:'AQ_BID_ORIGIN',values:['CACHED']});
  const before=structuredClone(f.db),j=await ready(f,selection({key:'aq_bid_origin',values:['cached']}));
  const done=await finish(f,await start(f,j));assert.equal(f.writes.length,0);assert.deepEqual(f.db,before);
  assert.equal(result(done,'aq_bid_origin').id,key.id);assert.equal(result(done,'aq_bid_origin').outcome,'existing');
  assert.equal(result(done,'aq_bid_origin').values[0].outcome,'existing');assertOutcomes(done);
});

test('selected OFF key is updated rather than created, while an unselected OFF key remains untouched',async()=>{
  let f=await setup();const selected=seedKey(f,{reportableType:'OFF'});
  const unselected=seedKey(f,{name:'aq_first_request',reportableType:'OFF',values:['lt_500'],id:'9100'});
  const unselectedBefore=structuredClone(unselected),j=await ready(f,selection({key:'aq_bid_origin',values:['cached']}));
  assert.equal(result(j,'aq_bid_origin').outcome,'update');assert.equal(f.writes.length,0);
  const done=await finish(f,await start(f,j));assert.equal(result(done,'aq_bid_origin').outcome,'updated');
  assert.equal(result(done,'aq_bid_origin').id,selected.id);assert.equal(result(done,'aq_bid_origin').values[0].outcome,'existing');
  assert.deepEqual(unselected,unselectedBefore);assert.equal(f.writes.length,1);assert.equal(f.writes[0].method,'update');
  f=restart(f);const reopened=(await request(f,`/line-items/jobs/${done.id}`)).data;
  assert.equal(result(reopened,'aq_bid_origin').outcome,'updated');assertOutcomes(reopened);
});

test('mixed outcomes remain truthful after later phases and reopening the saved completed job',async()=>{
  let f=await setup();seedKey(f,{reportableType:'OFF'});
  seedKey(f,{name:'Variant',values:['A'],id:'9100'});
  const input=selection({key:'Variant',values:['A']},{key:'aq_bid_origin',values:['cached']},
    {key:'aq_first_request',values:['lt_500']});
  const done=await finish(f,await start(f,await ready(f,input)));
  assert.equal(result(done,'Variant').outcome,'existing');assert.equal(result(done,'aq_bid_origin').outcome,'updated');
  assert.equal(result(done,'aq_first_request').outcome,'created');
  assert.equal(result(done,'aq_first_request').values[0].outcome,'created');assertOutcomes(done);
  const writes=f.writes.length;f=restart(f);const again=(await request(f,`/line-items/jobs/${done.id}`)).data;
  assert.deepEqual(again.reporting.results,done.reporting.results);assert.equal(f.writes.length,writes);
  const replay=await finish(f,await start(f,await ready(f,input)));assert.equal(f.writes.length,writes);
  assert(replay.reporting.results.every(row=>row.outcome==='existing'),'a new no-write job reports reuse, not historical creation');
});

test('uncertain key creation remains honest about attribution and is reconciled without replay',async()=>{
  let f=await setup();seedKey(f,{name:'Variant',values:['A'],id:'9100'});
  const input=selection({key:'aq_bid_origin',values:['cached']},{key:'Variant',values:['A']});
  let j=await start(f,await ready(f,input));f.failNext('key');j=await action(f,j,'step');
  assert.equal(j.status,'creating');assert.equal(j.awaitingCheck,true);assert.notEqual(result(j,'aq_bid_origin').outcome,'created');
  const writes=f.writes.length,id=j.id;f=restart(f);j=(await request(f,`/line-items/jobs/${id}`)).data;
  assert.equal(j.status,'creating');assert.equal(j.awaitingCheck,true);
  j=await action(f,j,'step');assert.equal(f.writes.length,writes);
  j=await action(f,j,'check');assert.equal(j.awaitingCheck,false);assert.equal(f.writes.length,writes);
  const done=await finish(f,j);assert.equal(result(done,'aq_bid_origin').outcome,'existing');
  assert.equal(result(done,'aq_bid_origin').reconciled,true);
  assert(result(done,'aq_bid_origin').message,'the outcome explains that read-only reconciliation confirmed existence');
  assert.equal(result(done,'Variant').outcome,'existing');assert.notEqual(result(done,'Variant').reconciled,true);assertOutcomes(done);
});

test('uncertain metadata update survives restart and is reported as updated after read-only reconciliation',async()=>{
  let f=await setup();seedKey(f,{reportableType:'OFF'});seedKey(f,{name:'Variant',values:['A'],id:'9100'});
  let j=await start(f,await ready(f,selection({key:'aq_bid_origin',values:['cached']},{key:'Variant',values:['A']})));
  f.failNextUpdate('key');j=await action(f,j,'step');assert.equal(j.status,'creating');assert.equal(j.awaitingCheck,true);
  assert.notEqual(result(j,'aq_bid_origin').outcome,'updated');const writes=f.writes.length,id=j.id;
  f=restart(f);j=(await request(f,`/line-items/jobs/${id}`)).data;j=await action(f,j,'step');assert.equal(f.writes.length,writes);
  j=await action(f,j,'check');assert.equal(j.awaitingCheck,false);assert.equal(f.writes.length,writes);
  const done=await finish(f,j);assert.equal(result(done,'aq_bid_origin').outcome,'updated');
  assert.equal(result(done,'aq_bid_origin').reconciled,true);
  assert.equal(result(done,'Variant').outcome,'existing');assert.equal(f.writes.filter(write=>write.method==='update').length,1);
  assertOutcomes(done);
});

test('partial uncertain update keeps acknowledged progress and retries only the unresolved ID after the guard',async()=>{
  const f=await setup();const first=seedKey(f,{reportableType:'OFF'});
  const second=seedKey(f,{name:'aq_first_request',reportableType:'OFF',values:['lt_500'],id:'9100'});
  const update=f.traffic.update.bind(f.traffic),sends=[];let once=true;
  f.traffic.update=async(kind,payloads)=>{
    sends.push(payloads.map(payload=>payload.id));
    if(once){once=false;await update(kind,payloads.slice(0,1));throw new GamError('Synthetic partial update reply lost',502);}
    return update(kind,payloads);
  };
  let j=await start(f,await ready(f,selection({key:'aq_bid_origin',values:['cached']},
    {key:'aq_first_request',values:['lt_500']})));
  j=await action(f,j,'step');assert.equal(j.awaitingCheck,true);assert.equal(first.reportableType,'ON');assert.equal(second.reportableType,'OFF');
  const writes=f.writes.length;j=await action(f,j,'check');assert.equal(j.status,'creating');assert.equal(j.awaitingCheck,true);
  assert.equal(result(j,'aq_bid_origin').outcome,'updated');assert.equal(result(j,'aq_bid_origin').reconciled,true);
  assert.notEqual(result(j,'aq_first_request').outcome,'updated');assert.equal(f.writes.length,writes);
  const attemptKey=`api-integrations/gam/line-items/v1/attempts/${j.id}/${j.cursor}.json`;
  const attempt=await (await f.env.BUILDS.get(attemptKey)).json();attempt.startedAt-=91000;
  await f.env.BUILDS.put(attemptKey,JSON.stringify(attempt));
  j=await action(f,j,'check');assert.equal(j.awaitingCheck,false);assert.equal(f.writes.length,writes);
  const done=await finish(f,j);assert.equal(result(done,'aq_bid_origin').outcome,'updated');
  assert.equal(result(done,'aq_first_request').outcome,'updated');assert.deepEqual(sends,[[first.id,second.id],[second.id]]);
  assert.equal(f.writes.filter(write=>write.method==='create').length,0);assertOutcomes(done);
});

test('an unpersisted update stays uncertain until the guard and later retries only after another explicit step',async()=>{
  const f=await setup();seedKey(f,{reportableType:'OFF'});let j=await start(f,await ready(f,selection({key:'aq_bid_origin',values:['cached']})));
  f.failNextUpdate('key',false);j=await action(f,j,'step');const writes=f.writes.length;
  j=await action(f,j,'check');assert.equal(j.awaitingCheck,true);assert.equal(j.status,'creating');
  assert.notEqual(result(j,'aq_bid_origin').outcome,'updated');assert.equal(f.writes.length,writes);
  const attemptKey=`api-integrations/gam/line-items/v1/attempts/${j.id}/${j.cursor}.json`;
  const attempt=await (await f.env.BUILDS.get(attemptKey)).json();attempt.startedAt-=91000;
  await f.env.BUILDS.put(attemptKey,JSON.stringify(attempt));
  j=await action(f,j,'check');assert.equal(j.awaitingCheck,false);assert.equal(f.writes.length,writes);
  assert.equal(result(j,'aq_bid_origin').outcome,'update');
  const done=await finish(f,j);assert.equal(result(done,'aq_bid_origin').outcome,'updated');
  assert.equal(f.writes.filter(write=>write.method==='update').length,2);assert.equal(f.db.key.length,1);
});

test('a pending transport response exposes creating/awaiting-check, never completed',async()=>{
  const f=await setup();let j=await start(f,await ready(f,selection({key:'aq_bid_origin',values:[]})));
  let release,markStarted;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>markStarted=resolve);
  const original=f.traffic.create.bind(f.traffic);f.traffic.create=async(...args)=>{markStarted();await gate;return original(...args);};
  const pending=action(f,j,'step');await entered;
  const peek=(await request(f,`/line-items/jobs/${j.id}`)).data;
  assert.equal(peek.status,'creating');assert.equal(peek.awaitingCheck,true);assert.notEqual(result(peek,'aq_bid_origin').outcome,'created');
  release();j=await pending;assert.equal(j.status,'completed');assert.equal(result(j,'aq_bid_origin').outcome,'created');
});

test('failed selected-key verification remains visibly unverified and writes nothing',async()=>{
  const f=await setup(),query=f.traffic.query.bind(f.traffic);let unavailable=true;
  f.traffic.query=async(kind,...args)=>{if(kind==='key'&&unavailable)throw new GamError('Synthetic scoped key read failed',502);return query(kind,...args);};
  let j=await review(f,await preview(f,selection({key:'aq_bid_origin',values:['cached']})));
  assert.equal(j.canStart,false);assert.notEqual(j.status,'completed');assert.equal(result(j,'aq_bid_origin').outcome,'unverified');
  assert.equal(f.writes.length,0);unavailable=false;j=await review(f,await action(f,j,'review',{retry:true}));
  assert.equal(j.canStart,true);await finish(f,await start(f,j));assert.equal(f.db.key.length,1);
});

test('selected identities survive conflict and no historical success masks a current UNKNOWN status',async()=>{
  const f=await setup();const key=seedKey(f);let j=await start(f,await ready(f,selection({key:'aq_bid_origin',values:['cached']})));
  key.status='UNKNOWN';j=await action(f,j,'step');assert.notEqual(j.status,'completed');
  assert(j.conflictCount>0||j.verificationCount>0);assert(['conflict','unverified','blocked'].includes(result(j,'aq_bid_origin').outcome));
  assert.equal(f.writes.length,0);
});

test('same active selected plan reopens unchanged; a different subset cannot replace it',async()=>{
  const f=await setup(),input=selection({key:'Variant',values:['B','A']},{key:'aq_bid_origin',values:['cached','fresh']});
  const j=await start(f,await ready(f,input)),before=structuredClone(f.env.BUILDS.data);
  const equivalent=selection({key:'AQ_BID_ORIGIN',values:['FRESH','CACHED']},{key:'variant',values:['A','B']});
  const reopened=await request(f,'/line-items/preview',equivalent);assert.equal(reopened.status,200,JSON.stringify(reopened.data));
  assert.equal(reopened.data.id,j.id);assert.equal(reopened.data.resumed,true);assert.deepEqual(f.env.BUILDS.data,before);
  const other=await request(f,'/line-items/preview',selection({key:'aq_bid_origin',values:['cached']}));
  assert.equal(other.status,409);assert.equal(other.data.activeJobId,j.id);assert.deepEqual(f.env.BUILDS.data,before);
  assert.equal(f.writes.length,0);
});

test('an active ad job keeps its shared lock and cannot be replaced by key-only preparation',async()=>{
  const f=await setup(),ad=await start(f,await ready(f,prebidPlan()));
  const before=structuredClone(f.env.BUILDS.data),snapshot=structuredClone(stored(f,ad.id));
  const attempted=await request(f,'/line-items/preview',selection({key:'aq_bid_origin',values:['cached']}));
  assert.equal(attempted.status,409);assert.equal(attempted.data.activeJobId,ad.id);
  assert.deepEqual(f.env.BUILDS.data,before);assert.deepEqual(stored(f,ad.id),snapshot);
  assert.equal(f.writes.length,0);
  const opened=await request(f,`/line-items/jobs/${ad.id}`);assert.equal(opened.data.mode,'prebid');
  assert.equal(opened.data.status,'creating');assert.equal(f.writes.length,0);
});

test('history and selected job reopen are read-only; confirmation/actor/origin remain enforced',async()=>{
  const f=await setup(),j=await ready(f,selection({key:'aq_bid_origin',values:['cached']}));
  for(const [who,source,confirmNetwork] of [[actor,origin,'999'],['other@example.invalid',origin,'123456'],
    [actor,'https://other.invalid','123456']]) {
    const denied=await request(f,`/line-items/jobs/${j.id}/start`,{cursor:j.cursor,confirm:true,confirmNetwork},who,source);
    assert.notEqual(denied.status,200);assert.equal(f.writes.length,0);
  }
  const history=await request(f,'/line-items/jobs?network=123456');assert.equal(history.status,200);
  assert(history.data.jobs.some(row=>row.id===j.id&&row.mode==='reporting'));
  const before=structuredClone(f.env.BUILDS.data),reopened=await request(f,`/line-items/jobs/${j.id}`);
  assert.equal(reopened.status,200);assert.equal(reopened.data.status,'ready');assert.equal(f.writes.length,0);
  assert.deepEqual(f.env.BUILDS.data,before);
});

test('review retry progress uses the new pass cursor instead of retained successful references',async()=>{
  const f=await setup();seedKey(f);seedKey(f,{name:'aq_first_request',values:['lt_500'],id:'9100'});
  const input=selection({key:'aq_bid_origin',values:['cached']},{key:'aq_first_request',values:['lt_500']});
  let j=await preview(f,input);assert.deepEqual(j.reporting.reviewProgress,{processed:0,total:4});
  j=await review(f,j);assert.deepEqual(j.reporting.reviewProgress,{processed:4,total:4});
  const byIds=f.traffic.byIds.bind(f.traffic);let unavailable=true;
  f.traffic.byIds=async(kind,...args)=>{
    if(kind==='key'&&unavailable)throw new GamError('Synthetic retry read unavailable',502);
    return byIds(kind,...args);
  };
  j=await action(f,j,'review',{retry:true});assert.equal(j.status,'reviewing');
  assert.equal(stored(f,j.id).refs['value:aq_bid_origin:cached'].state,'existing','old successful references remain available');
  assert.deepEqual(j.reporting.reviewProgress,{processed:0,total:4},'failed first read must not reuse the old 100% count');
  unavailable=false;j=await action(f,j,'review');assert.equal(j.status,'reviewing');
  assert.deepEqual(j.reporting.reviewProgress,{processed:2,total:4});
  j=await action(f,j,'review');assert.equal(j.status,'ready');assert.deepEqual(j.reporting.reviewProgress,{processed:4,total:4});
  j=await action(f,j,'cancel');assert.equal(j.status,'cancelled');assert.deepEqual(j.reporting.reviewProgress,{processed:0,total:4});
  assert.equal(f.writes.length,0);
});

test('a current inspection overlay preserves good same-ID creation/update provenance while another key conflicts',async()=>{
  const f=await setup();seedKey(f,{reportableType:'OFF'});
  const other=seedKey(f,{name:'aq_timed_out',values:['yes'],id:'9100'});
  const rewind=seedKey(f,{name:'Variant',values:['A'],id:'9200'});
  const input=selection({key:'aq_bid_origin',values:['cached']},{key:'aq_first_request',values:['lt_500']},
    {key:'aq_timed_out',values:['yes']},{key:'Variant',values:['A']});
  let j=await start(f,await ready(f,input));
  for(let n=0;j.phase!=='Key-value vrednosti'&&n<8;n++)j=await action(f,j,'step');
  assert.equal(j.phase,'Key-value vrednosti');assert.equal(result(j,'aq_bid_origin').outcome,'updated');
  assert.equal(result(j,'aq_first_request').outcome,'created');
  rewind.reportableType='OFF';j=await action(f,j,'step');assert.equal(j.phase,'Key-value ključevi');
  other.status='UNKNOWN';const writes=f.writes.length;j=await action(f,j,'step');
  assert.notEqual(j.status,'completed');assert.equal(f.writes.length,writes);
  const saved=stored(f,j.id);assert.equal(saved.verificationResults['key:aq_bid_origin'].state,'existing');
  assert.equal(saved.verificationResults['key:aq_first_request'].state,'existing');
  assert.equal(result(j,'aq_bid_origin').outcome,'updated');assert.equal(result(j,'aq_first_request').outcome,'created');
  assert.equal(result(j,'aq_timed_out').outcome,'conflict');assert.equal(result(j,'Variant').outcome,'update');
  assertOutcomes(j);
});
