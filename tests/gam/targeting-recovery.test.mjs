import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Every Google request is a synthetic local fixture. The override also lets
// independent QA demonstrate these regressions against the unchanged base.
const root=resolve(process.env.GAM_RECOVERY_QA_ROOT??fileURLToPath(new URL('../..',import.meta.url)));
const load=path=>import(pathToFileURL(resolve(root,path)).href);
const {gamResponse}=await load('worker/integrations/gam-service.mjs');
const {trafficFixture,prebidPlan}=await load('tests/gam/traffic-fixture.mjs');
const {MemoryBucket}=await load('tests/gam/fixture.mjs');
const {GamError}=await load('shared/gam/plan.mjs');
const {customRules}=await load('shared/gam/line-items.mjs');
const origin='https://recovery.fixture.invalid',actor='recovery@example.invalid',base='/api/integrations/gam';
const prefix='api-integrations/gam/line-items/v1/';
const key=id=>prefix+'jobs/'+id+'.json';
const attemptKey=j=>prefix+'attempts/'+j.id+'/'+j.cursor+'.json';
const targeting=prefix+'targeting-locks/123456.json';
const report=(...keys)=>({mode:'reporting',networkCode:'123456',reportingSelection:keys.map(key=>typeof key==='string'?{key,values:[]}:key)});
async function req(f,path,body,context={}) {
 const r=await gamResponse(new Request(origin+base+path,{method:body===undefined?'GET':'POST',headers:{origin:context.origin??origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),f.env,context.actor??actor,{clientFactory:()=>f.client,trafficFactory:()=>f.traffic});
 return {status:r.status,data:await r.json()};
}
async function setup(){const f=trafficFixture();const r=await req(f,'/connect',{networkCode:'123456',credentials:{type:'service_account',client_email:'recovery@fixture.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----'}});assert.equal(r.status,201);return f;}
async function act(f,j,action,extra={}){const r=await req(f,`/line-items/jobs/${j.id}/${action}`,{cursor:j.cursor,...extra});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
async function ready(f,plan){let r=await req(f,'/line-items/preview',plan);assert.equal(r.status,201,JSON.stringify(r.data));let j=r.data;for(let i=0;j.status==='reviewing'&&!j.error&&i<100;i++)j=await act(f,j,'review');assert.equal(j.status,'ready',JSON.stringify(j));assert.equal(j.canStart,true);return j;}
const start=(f,j)=>act(f,j,'start',{confirm:true,confirmNetwork:'123456'});
async function finish(f,j){for(let i=0;j.status==='creating'&&i<150;i++){assert(!j.awaitingCheck,JSON.stringify(j));j=await act(f,j,'step');assert.equal(j.error,'');}assert.equal(j.status,'completed');return j;}
async function age(f,j,elapsed=90001,patch={}){const a=await(await f.env.BUILDS.get(attemptKey(j))).json();await f.env.BUILDS.put(attemptKey(j),JSON.stringify({...a,startedAt:Date.now()-elapsed,...patch}));}
async function saved(f,j){return(await f.env.BUILDS.get(key(j.id))).json();}
const restart=f=>{const bucket=new MemoryBucket();bucket.data=new Map([...f.env.BUILDS.data].map(([k,v])=>[k,structuredClone(v)]));return {...f,env:{...f.env,BUILDS:bucket}};};
const seedKey=(f,name='aq_bid_origin',id='8000')=>{const k={id,name,displayName:'Existing '+name,type:'PREDEFINED',reportableType:'ON',status:'ACTIVE'};f.db.key.push(k);return k;};

test('rejected key creation stays fenced before the deadline, then explicit complete Check permits retry or stop',async()=>{
 for(const recovery of ['retry','stop']){
  const f=await setup();let j=await start(f,await ready(f,report('aq_bid_origin')));f.failNext('key',false);j=await act(f,j,'step');
  assert(j.awaitingCheck);const writes=f.calls.length,held=structuredClone(f.env.BUILDS.data.get(targeting));
  j=await act(f,j,'check');assert(j.awaitingCheck);assert.equal(Boolean(j.canCancel),false);assert.equal(f.calls.length,writes);assert.deepEqual(f.env.BUILDS.data.get(targeting),held);
  await age(f,j);const cursor=j.cursor;j=await act(f,j,'check');assert.equal(j.awaitingCheck,false);assert.equal(j.cursor,cursor+1);assert.equal(j.canCancel,true);assert.match(j.recoveryMessage,/1 nedostaje/);assert.equal(f.calls.length,writes);assert.deepEqual(f.env.BUILDS.data.get(targeting),held);
  if(recovery==='retry'){await finish(f,j);assert.equal(f.db.key.length,1);assert.equal(f.calls.length,writes+1);}
  else{j=await act(f,j,'cancel',{confirm:true,confirmNetwork:'123456'});assert.equal(j.status,'cancelled');assert.equal((await(await f.env.BUILDS.get(targeting)).json()).owner,null);assert.equal(f.calls.length,writes);await finish(f,await start(f,await ready(f,report('aq_bid_origin'))));assert.equal(f.db.key.length,1);}
 }
});

test('partial value creation survives restart and retries only missing names, preserving parent metadata and confirmed IDs',async()=>{
 let f=await setup();const parent=seedKey(f);const parentBefore=structuredClone(parent),create=f.traffic.create.bind(f.traffic);let partial=true;
 f.traffic.create=async(kind,payloads)=>{if(kind==='value'&&partial){partial=false;await create(kind,payloads.slice(0,1));throw new GamError('QUOTA',429);}return create(kind,payloads);};
 let j=await start(f,await ready(f,report({key:'aq_bid_origin',values:['fresh','cached','none']})));j=await act(f,j,'step');j=await act(f,j,'step');assert(j.awaitingCheck);assert.equal(f.db.value.length,1);const original=structuredClone(f.db.value[0]);
 j=await act(f,j,'check');assert(j.awaitingCheck);await age(f,j);f=restart(f);j=(await req(f,`/line-items/jobs/${j.id}`)).data;const before=f.calls.length;j=await act(f,j,'check');assert(!j.awaitingCheck);assert.equal(f.calls.length,before);await finish(f,j);
 assert.equal(f.db.value.length,3);assert.deepEqual(f.db.value.find(v=>v.id===original.id),original);assert.deepEqual(parent,parentBefore);
 assert.deepEqual(f.calls.filter(c=>c.kind==='value').map(c=>c.payloads.map(v=>v.name)),[['fresh'],['cached','none']]);
});

test('ordinary Prebid key failure can recover without discarding advertiser/order progress',async()=>{
 const f=await setup();let j=await start(f,await ready(f,{...prebidPlan(),ranges:[{from:'0.01',to:'0.01',step:'0.01'}]}));
 while(j.phase!=='Key-value ključevi')j=await act(f,j,'step');const refs=structuredClone((await saved(f,j)).refs);f.failNext('key',false);j=await act(f,j,'step');await age(f,j);j=await act(f,j,'check');assert(!j.awaitingCheck);await finish(f,j);
 for(const ref of ['advertiser:0','order:0'])assert.equal((await saved(f,j)).refs[ref].id,refs[ref].id);
 assert.equal(new Set(f.db.key.map(k=>k.name.toLowerCase())).size,f.db.key.length);
});

test('a case-folded late key after empty Check is reused by the next fresh inspection',async()=>{
 const f=await setup();let j=await start(f,await ready(f,report('aq_bid_origin')));f.failNext('key',false);j=await act(f,j,'step');await age(f,j);j=await act(f,j,'check');
 const late=seedKey(f,'AQ_BID_ORIGIN','9876'),before=f.calls.length;await finish(f,j);assert.equal(f.calls.length,before);assert.equal(f.db.key.length,1);assert.equal((await saved(f,j)).refs['key:aq_bid_origin'].id,late.id);
});

test('a late apply between retry inspection and create is rejected as duplicate and reconciled, never duplicated',async()=>{
 const f=await setup();let j=await start(f,await ready(f,report('aq_bid_origin')));f.failNext('key',false);j=await act(f,j,'step');await age(f,j);j=await act(f,j,'check');
 const create=f.traffic.create.bind(f.traffic);let race=true,duplicateRejections=0;
 f.traffic.create=async(kind,payloads)=>{if(kind==='key'&&race){race=false;seedKey(f,'AQ_BID_ORIGIN','9876');}for(const p of payloads)if(f.db[kind].some(row=>row.name.toLowerCase()===p.name.toLowerCase())){duplicateRejections++;throw new GamError('CustomTargetingError.DUPLICATE_KEY',409);}return create(kind,payloads);};
 j=await act(f,j,'step');assert(j.awaitingCheck);assert.equal(duplicateRejections,1);assert.equal(f.db.key.length,1);j=await act(f,j,'check');assert.equal(j.status,'completed');assert.equal(f.db.key.length,1);assert.equal((await saved(f,j)).refs['key:aq_bid_origin'].id,'9876');
});

test('a late old create cannot overwrite a cancelled job or release another job targeting token',async()=>{
 const f=await setup();let j=await start(f,await ready(f,report('aq_bid_origin')));const create=f.traffic.create.bind(f.traffic);let release,entered;const gate=new Promise(r=>release=r),waiting=new Promise(r=>entered=r);let pause=true;
 f.traffic.create=async(kind,payloads)=>{if(pause&&kind==='key'){pause=false;entered();await gate;}return create(kind,payloads);};
 const late=req(f,`/line-items/jobs/${j.id}/step`,{cursor:j.cursor});await waiting;await age(f,j);j=await act(f,j,'check');assert(!j.awaitingCheck);j=await act(f,j,'cancel',{confirm:true,confirmNetwork:'123456'});const before=await saved(f,j);
 const next=await start(f,await ready(f,report('aq_first_request'))),token=await(await f.env.BUILDS.get(targeting)).json();assert.equal(token.owner,next.id);release();await late;
 assert.deepEqual(await saved(f,j),before);assert.deepEqual(await(await f.env.BUILDS.get(targeting)).json(),token);await finish(f,next);assert.equal(f.db.key.length,2);
});

test('incomplete, failed, duplicate or wrong-parent reads never retire an uncertain create',async()=>{
 for(const mode of ['truncated','wrong-total','read-fails','duplicate','wrong-parent']){
  const f=await setup();if(mode==='wrong-parent')seedKey(f);let j=await start(f,await ready(f,mode==='wrong-parent'?report({key:'aq_bid_origin',values:['cached']}):report('aq_bid_origin')));if(mode==='wrong-parent')j=await act(f,j,'step');f.failNext(mode==='wrong-parent'?'value':'key',false);j=await act(f,j,'step');await age(f,j);
  const query=f.traffic.query.bind(f.traffic);f.traffic.query=async(kind,...args)=>{const v=await query(kind,...args);if(kind!==(mode==='wrong-parent'?'value':'key'))return v;if(mode==='read-fails')throw Error('unavailable');if(mode==='truncated')return {...v,more:true};if(mode==='wrong-total')return {...v,total:v.total+1};if(mode==='duplicate'){const row={id:'9000',name:'aq_bid_origin',type:'PREDEFINED',reportableType:'ON',status:'ACTIVE'};return {rows:[row,{...row,id:'9001',name:'AQ_BID_ORIGIN'}],total:2,more:false};}return {rows:[{id:'9000',name:'cached',matchType:'EXACT',status:'ACTIVE',customTargetingKeyId:'9999'}],total:1,more:false};};
  const before=f.calls.length,cursor=j.cursor;j=await act(f,j,'check');assert(j.awaitingCheck,mode);assert.equal(j.cursor,cursor);assert.equal(Boolean(j.canCancel),false);assert.equal(f.calls.length,before);
 }
});

test('malformed or future attempt metadata cannot authorize retry or stop',async()=>{
 for(const patch of [{startedAt:null},{startedAt:'0'},{startedAt:Date.now()+3600000},{operation:'delete'},{operation:'update'},{keys:['key:other']},{keys:['key:aq_bid_origin','key:aq_bid_origin']}]){
  const f=await setup();let j=await start(f,await ready(f,report({key:'aq_bid_origin',values:['cached']})));j=await act(f,j,'step');f.failNext('value',false);j=await act(f,j,'step');await age(f,j,90001,patch);
  const before=f.calls.length,cursor=j.cursor,r=await req(f,`/line-items/jobs/${j.id}/check`,{cursor:j.cursor});assert.notEqual(r.status,200,JSON.stringify(patch));const current=(await req(f,`/line-items/jobs/${j.id}`)).data;assert(current.awaitingCheck);assert.equal(current.cursor,cursor);assert.equal(Boolean(current.canCancel),false);assert.equal(f.calls.length,before);
 }
});

test('legacy create journals without operation recover only after the same complete read and deadline',async()=>{
 const f=await setup();let j=await start(f,await ready(f,report('aq_bid_origin')));f.failNext('key',false);j=await act(f,j,'step');await age(f,j);const a=await(await f.env.BUILDS.get(attemptKey(j))).json();delete a.operation;delete a.dispatchToken;await f.env.BUILDS.put(attemptKey(j),JSON.stringify(a));j=await act(f,j,'check');assert(!j.awaitingCheck);await finish(f,j);assert.equal(f.db.key.length,1);
});

test('explicit Stop refuses stale cursor, wrong network, or missing confirmation without changing the job',async()=>{
 const f=await setup();let j=await start(f,await ready(f,report('aq_bid_origin')));f.failNext('key',false);j=await act(f,j,'step');await age(f,j);const old=j.cursor;j=await act(f,j,'check');const before=await saved(f,j);
 for(const input of [{cursor:old,confirm:true,confirmNetwork:'123456'},{cursor:j.cursor,confirm:true,confirmNetwork:'999'},{cursor:j.cursor,confirm:false,confirmNetwork:'123456'},{confirm:true,confirmNetwork:'123456'}]){const r=await req(f,`/line-items/jobs/${j.id}/cancel`,input);assert.notEqual(r.status,200);assert.deepEqual(await saved(f,j),before);}
 const foreign=await req(f,`/line-items/jobs/${j.id}/cancel`,{cursor:j.cursor,confirm:true,confirmNetwork:'123456'},{actor:'foreign@example.invalid'});assert.equal(foreign.status,404);assert.deepEqual(await saved(f,j),before);
});

test('changed credentials permit same-network read-only recovery, but require Stop and a new immutable plan',async()=>{
 for(const swap of ['before-check','during-check','after-check']){
  const f=await setup();let j=await start(f,await ready(f,report('aq_bid_origin')));f.failNext('key',false);j=await act(f,j,'step');await age(f,j);
  const original=await saved(f,j),connectionKey='api-integrations/gam/v1/connections/123456.json';
  const change=async()=>{const c=await(await f.env.BUILDS.get(connectionKey)).json();c.revision=crypto.randomUUID();await f.env.BUILDS.put(connectionKey,JSON.stringify(c));};
  if(swap==='before-check')await change();
  if(swap==='during-check'){const query=f.traffic.query.bind(f.traffic);let once=true;f.traffic.query=async(...args)=>{const result=await query(...args);if(once){once=false;await change();}return result;};}
  j=await act(f,j,'check');assert(!j.awaitingCheck);assert.equal(j.requiresNewPreview,swap!=='after-check');assert.equal(j.canCancel,true);
  if(swap==='after-check')await change();
  const writes=f.calls.length,denied=await req(f,`/line-items/jobs/${j.id}/step`,{cursor:j.cursor});assert.equal(denied.status,409);assert.equal(f.calls.length,writes);
  const unchanged=await saved(f,j);assert.equal(unchanged.connectionRevision,original.connectionRevision);assert.deepEqual(unchanged.plan,original.plan);
  j=await act(f,j,'cancel',{confirm:true,confirmNetwork:'123456'});assert.equal(j.status,'cancelled');await finish(f,await start(f,await ready(f,report('aq_bid_origin'))));assert.equal(f.db.key.length,1);
 }
});

test('changed-credential recovery rejects a different network or unreadable network identity',async()=>{
 for(const response of ['wrong-network','read-denied']){
  const f=await setup();let j=await start(f,await ready(f,report('aq_bid_origin')));f.failNext('key',false);j=await act(f,j,'step');await age(f,j);
  const path='api-integrations/gam/v1/connections/123456.json',c=await(await f.env.BUILDS.get(path)).json();c.revision=crypto.randomUUID();await f.env.BUILDS.put(path,JSON.stringify(c));
  f.traffic.network=async()=>{if(response==='read-denied')throw new GamError('PERMISSION_DENIED',403);return {...f.network,networkCode:'999'};};
  const before=await saved(f,j),r=await req(f,`/line-items/jobs/${j.id}/check`,{cursor:j.cursor});assert.notEqual(r.status,200);assert.deepEqual(await saved(f,j),before);assert.equal(Boolean((await req(f,`/line-items/jobs/${j.id}`)).data.canCancel),false);
 }
});

test('reserved GAM EXACT value characters fail before a job or Google mutation, while spaces and ordinary punctuation survive',async()=>{
 const f=await setup();for(const char of ['"',"'",'=', '!', '+', '#', '*', '~', ';', '^', '(', ')', '<', '>', '[', ']', ',', '&']){
  const input={...prebidPlan(),customTargeting:'section=bad'+char+'value'};assert.throws(()=>customRules(input.customTargeting),{status:422});const r=await req(f,'/line-items/preview',input);assert.equal(r.status,422,char);
 }
 assert.equal(f.calls.length,0);assert.equal([...f.env.BUILDS.data.keys()].some(k=>k.startsWith(prefix+'jobs/')),false);
 assert.deepEqual(customRules('section=good value|news:world/v1.2-_'),[{key:'section',values:['good value','news:world/v1.2-_']}]);
});
