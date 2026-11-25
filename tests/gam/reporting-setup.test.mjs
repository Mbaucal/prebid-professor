import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Optional root only selects the candidate worktree; the same tests run without
// it after integration. Demand, storage and SOAP are always local fixtures.
const root=resolve(process.env.GAM_REPORTING_QA_ROOT??fileURLToPath(new URL('../..',import.meta.url)));
const load=path=>import(pathToFileURL(resolve(root,path)).href);
const {normalizeLinePlan}=await load('shared/gam/line-items.mjs');
const {GamError}=await load('shared/gam/plan.mjs');
const {gamResponse}=await load('worker/integrations/gam-service.mjs');
const {GamTrafficClient}=await load('worker/integrations/gam-traffic-client.mjs');
const {trafficFixture,prebidPlan}=await load('tests/gam/traffic-fixture.mjs');
const {MemoryBucket}=await load('tests/gam/fixture.mjs');

const origin='https://reporting-qa.invalid',base='/api/integrations/gam';
const actor='reporting-qa@example.invalid';
const closed={
  refresh_bucket:['initial','r1_3','r4_plus'],
  refresh_policy:['initial','fresh_auction','gam_only','prebid_fallback'],
  aq_timed_out:['yes','no'],
  aq_bid_origin:['fresh','cached','none'],
  aq_first_request:['lt_500','500_999','1000_1499','1500_1999','2000_2999','3000_plus'],
  aq_consent_wait:['lt_500','500_999','1000_1499','1500_1999','2000_2999','3000_plus','na','timeout'],
  Variant:['A','B'],
};
const open=['refresh_count','refresh_interval','aq_bid_count','aq_bidder_count'];
const reportingInput=()=>({mode:'reporting',networkCode:'123456'});
const reportingKeys=new Set([...Object.keys(closed),'geo_country',...open].map(key=>key.toLowerCase()));
const profile=()=>normalizeLinePlan(prebidPlan()).reporting;
const specs=()=>{const p=profile();assert(p,'new plans must own their reporting requirements');return p.keys;};

async function request(f,path,body,as=actor,source=origin) {
  const response=await gamResponse(new Request(origin+base+path,{
    method:body===undefined?'GET':'POST',headers:{origin:source,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  }),f.env,as,{clientFactory:()=>f.client,trafficFactory:()=>f.traffic});
  return {status:response.status,data:await response.json()};
}
async function setup() {
  const f=trafficFixture();
  const connected=await request(f,'/connect',{networkCode:'123456',credentials:{type:'service_account',
    client_email:'reporting-qa@fixture.iam.gserviceaccount.com',
    private_key:'-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----'}});
  assert.equal(connected.status,201);
  f.writes=[];
  for(const method of ['create','update']) {
    const original=f.traffic[method]?.bind(f.traffic);
    if(!original)continue;
    f.traffic[method]=async(kind,payloads)=>{
      if(method==='create'&&['key','value'].includes(kind))for(const p of payloads) {
        const duplicate=f.db[kind].find(row=>row.name.toLowerCase()===p.name.toLowerCase()&&
          (kind==='key'||String(row.customTargetingKeyId)===String(p.customTargetingKeyId)));
        if(duplicate)throw new GamError('CustomTargetingError.DUPLICATE_NAME',409);
        if(kind==='value') {
          const parent=f.db.key.find(row=>String(row.id)===String(p.customTargetingKeyId));
          assert(parent,'a value may only be created below its verified key ID');
          if(reportingKeys.has(parent.name.toLowerCase()))assert(['ON','CUSTOM_DIMENSION','OFF'].includes(parent.reportableType),
            'reporting values require a verified key with a known reporting mode');
        }
      }
      f.writes.push({method,kind,payloads:structuredClone(payloads)});
      return original(kind,payloads);
    };
  }
  return f;
}
async function action(f,j,name,extra={}) {
  const r=await request(f,`/line-items/jobs/${j.id}/${name}`,{cursor:j.cursor,...extra});
  assert.equal(r.status,200,JSON.stringify(r.data));return r.data;
}
async function preview(f,input=reportingInput()) {
  const r=await request(f,'/line-items/preview',input);
  assert.equal(r.status,201,JSON.stringify(r.data));return r.data;
}
async function review(f,j) {
  for(let n=0;j.status==='reviewing'&&!j.error&&n<100;n++)j=await action(f,j,'review');
  return j;
}
async function ready(f,input=reportingInput()) {
  const j=await review(f,await preview(f,input));assert.equal(j.status,'ready');assert.equal(j.canStart,true,JSON.stringify(j));return j;
}
const start=(f,j)=>action(f,j,'start',{confirm:true,confirmNetwork:'123456'});
async function finish(f,j) {
  for(let n=0;j.status==='creating'&&n<200;n++) {
    j=await action(f,j,j.awaitingCheck?'check':'step');
    assert.equal(j.error,'',JSON.stringify(j));
  }
  assert.equal(j.status,'completed',JSON.stringify(j));return j;
}
// Metadata updates remain supported by ordinary ad setup, while standalone
// preparation is add-only. Seed that ad through the real handler, then restore
// the externally supplied key/value state before exercising metadata recovery.
async function metadataReady(f) {
  const input={...prebidPlan(),mode:'single',name:'Ordinary metadata QA',lineItemType:'PRICE_PRIORITY',
    rate:'1.00',costType:'CPM',creative:{mode:'none'}};
  const keys=[...f.db.key],snapshots=keys.map(key=>structuredClone(key)),values=[...f.db.value];
  const writes=f.writes.length,calls=f.calls.length;
  for(const key of keys)key.reportableType='ON';
  await finish(f,await start(f,await ready(f,input)));
  for(let i=0;i<keys.length;i++){
    for(const field of Object.keys(keys[i]))delete keys[i][field];
    Object.assign(keys[i],snapshots[i]);
  }
  f.db.key=keys;f.db.value=values;f.writes.length=writes;f.calls.length=calls;
  return ready(f,input);
}
async function startMetadata(f,j) {
  j=await start(f,j);
  for(let n=0;j.status==='creating'&&j.phase!=='Key-value ključevi'&&n<10;n++)j=await action(f,j,'step');
  assert.equal(j.phase,'Key-value ključevi');return j;
}
function storedJob(f,id) {
  const key=`api-integrations/gam/line-items/v1/jobs/${id}.json`,entry=f.env.BUILDS.data.get(key);
  assert(entry);return {key,entry,value:JSON.parse(entry.body)};
}
function restart(f) {
  const bucket=new MemoryBucket();bucket.data=new Map([...f.env.BUILDS.data].map(([key,value])=>[key,structuredClone(value)]));
  return {...f,env:{...f.env,BUILDS:bucket}};
}
function seedReporting(f,{fold=false,off=null,custom=null,omitValue=null}={}) {
  let next=5000;
  for(const spec of specs()) {
    const key={id:String(next++),name:fold?spec.key.toUpperCase():spec.key,
      displayName:'Operator label for '+spec.key,type:'FREEFORM',status:'ACTIVE',
      reportableType:off===spec.key?'OFF':custom===spec.key?'CUSTOM_DIMENSION':'ON'};
    f.db.key.push(key);
    for(const name of spec.values)if(omitValue!==`${spec.key}:${name}`)f.db.value.push({
      customTargetingKeyId:key.id,id:String(next++),name:fold?name.toUpperCase():name,
      displayName:'Original value '+name,matchType:'EXACT',status:'ACTIVE',
    });
  }
}

test('all current reporting keys and finite values are materialized independently of line-item rules',()=>{
  const p=normalizeLinePlan(prebidPlan()),r=p.reporting;
  assert(r);assert.equal(p.schemaVersion,2);assert.equal(r.schemaVersion,1);assert.equal(r.profile,'ads-js-3.25');
  assert.deepEqual(p.rules,[],'reporting must not add ad targeting predicates');
  assert.equal(r.keys.length,14);assert.equal(r.keys.reduce((n,key)=>n+key.values.length,0),283);
  assert.deepEqual(r.keys.find(key=>key.key==='TestId').values,[],'TestId has no invented/default identifiers');
  for(const [key,values] of Object.entries(closed)) {
    const found=r.keys.find(row=>row.key===key);assert(found,key);assert.deepEqual(found.values,values,key);
    assert.equal(found.type,'PREDEFINED');assert.equal(found.reportableType,'ON');assert.equal(found.openDomain,false);
  }
  const countries=r.keys.find(row=>row.key==='geo_country');assert.equal(countries.values.length,250);
  assert.equal(new Set(countries.values).size,250);assert(countries.values.includes('RS'));assert(countries.values.includes('XK'));
  assert(countries.values.includes('US'));assert(!countries.values.includes('XX'));assert(!countries.values.includes('T1'));
  assert.deepEqual(new Set(r.keys.filter(row=>row.openDomain).map(row=>row.key)),new Set(open));
  for(const key of open) {
    const found=r.keys.find(row=>row.key===key);assert.equal(found.type,'FREEFORM');assert.equal(found.reportableType,'ON');
    assert.deepEqual(found.values,key==='refresh_interval'?['initial','unscheduled']:['0']);
  }
});

test('reporting numeric additions are explicit, bounded, canonical and cannot override finite domains',()=>{
  const input={...prebidPlan(),reportingValues:{refresh_count:['2',1,'1.0'],refresh_interval:['30','0.5'],aq_bid_count:[20],aq_bidder_count:[3]}};
  const before=structuredClone(input),p=normalizeLinePlan(input);assert.deepEqual(input,before);
  assert.deepEqual(p.reporting.keys.find(row=>row.key==='refresh_count').values,['0','1','2']);
  assert.deepEqual(p.reporting.keys.find(row=>row.key==='refresh_interval').values,['initial','unscheduled','0.5','30']);
  p.reporting.keys[0].values.push('untrusted');assert(!profile().keys[0].values.includes('untrusted'),'snapshots must not mutate shared defaults');
  for(const reportingValues of [null,[],{aq_bid_origin:['cached']},{TestId:['experiment']},{aq_bid_count:[-1]},
    {aq_bid_count:['1.5']},{refresh_interval:[0]},{aq_bidder_count:[true]},{refresh_count:['NaN']},
    {refresh_count:['1e3']},{refresh_count:Array.from({length:1001},(_,i)=>i)}])
    assert.throws(()=>normalizeLinePlan({...prebidPlan(),reportingValues}),{status:422},JSON.stringify(reportingValues).slice(0,100));
});

test('standalone reporting plan has no advertiser, order, inventory or creative work',()=>{
  const p=normalizeLinePlan(reportingInput());assert.equal(p.mode,'reporting');assert.equal(p.schemaVersion,2);
  assert.deepEqual(p.orders,[]);assert.deepEqual(p.rows,[]);assert.deepEqual(p.rules,[]);
  assert.equal(p.creative.mode,'none');assert.deepEqual(p.counts,{lineItems:0,orders:0,creatives:0,associations:0});
  assert.equal(p.reporting.keys.length,14);
  for(const networkCode of ['',123,'0','bad'])assert.throws(()=>normalizeLinePlan({mode:'reporting',networkCode}),{status:422});
});

test('standalone preview/history/review are read-only, then only key/value writes run once',async()=>{
  const f=await setup(),j=await ready(f);
  assert.equal(j.mode,'reporting');assert.equal(j.counts.key.total,14);assert.equal(j.counts.value.total,283);
  for(const kind of ['advertiser','order','creative','lineItem','association'])assert.equal(j.counts[kind].total,0);
  assert.equal(f.writes.length,0);assert.equal(f.db.key.length,0);
  const history=await request(f,'/line-items/jobs?network=123456');assert.equal(history.status,200);
  assert(history.data.jobs.some(row=>row.id===j.id),'a key-only job must be reachable through history');
  const done=await finish(f,await start(f,j));assert.equal(done.counts.key.done,14);assert.equal(done.counts.value.done,283);
  assert.equal(f.db.key.length,14);assert.equal(f.db.value.length,283);
  assert(f.writes.every(write=>['key','value'].includes(write.kind)));
  const writes=f.writes.length,again=await ready(f);assert.equal(again.counts.key.existing,14);assert.equal(again.counts.value.existing,283);
  await finish(f,await start(f,again));assert.equal(f.writes.length,writes,'repeat preparation must not create or update anything');
});

test('case-insensitive reporting reuse preserves original labels, key types and custom dimensions',async()=>{
  const f=await setup();seedReporting(f,{fold:true,custom:'Variant'});
  const before=structuredClone({keys:f.db.key,values:f.db.value}),j=await ready(f);
  assert.equal(j.counts.key.existing,14);assert.equal(j.counts.value.existing,283);assert.equal(j.counts.key.update,0);
  await finish(f,await start(f,j));assert.equal(f.writes.length,0);
  assert.deepEqual({keys:f.db.key,values:f.db.value},before);
});

test('OFF metadata is a reviewed update, not Done; execution preserves identity/name/displayName/type',async()=>{
  const f=await setup();seedReporting(f,{off:'aq_bid_origin'});
  const key=f.db.key.find(row=>row.name==='aq_bid_origin'),before=structuredClone(key),j=await metadataReady(f);
  assert.equal(j.counts.key.update,1);assert.equal(j.counts.key.done,13);assert.equal(j.counts.value.existing,283);
  assert.equal(j.reporting.needsUpdate,1);assert.equal(f.writes.length,0);assert.deepEqual(key,before);
  const done=await finish(f,await startMetadata(f,j));assert.equal(done.counts.key.update,0);assert.equal(done.counts.key.done,14);
  const writes=f.writes.filter(write=>write.method==='update');assert.equal(writes.length,1);assert.equal(writes[0].kind,'key');
  const payload=writes[0].payloads[0];assert.deepEqual(Object.keys(payload),['id','name','displayName','type','reportableType']);
  assert.deepEqual(payload,{id:before.id,name:before.name,displayName:before.displayName,type:before.type,reportableType:'ON'});
  assert.equal(key.reportableType,'ON');assert.equal(f.db.key.length,14);assert.equal(f.db.value.length,283);
  assert.equal(f.writes.filter(write=>write.method==='create').length,0);
});

test('inactive or unknown reporting keys remain conflicts without reactivation or blind update',async()=>{
  for(const change of [{status:'INACTIVE'},{reportableType:'UNKNOWN'}]) {
    const f=await setup();seedReporting(f);Object.assign(f.db.key.find(row=>row.name==='aq_bid_origin'),change);
    const j=await review(f,await preview(f));assert.equal(j.canStart,false);assert(j.conflictCount>0,JSON.stringify(j));
    assert.equal(f.writes.length,0);
  }
});

test('explicit UNKNOWN activation status blocks reporting key updates/reuse and value reuse',async()=>{
  for(const [kind,reportableType] of [['key','OFF'],['key','ON'],['value','ON']]) {
    const f=await setup();seedReporting(f);
    const parent=f.db.key.find(row=>row.name==='aq_bid_origin');parent.reportableType=reportableType;
    const row=kind==='key'?parent:f.db.value.find(row=>row.customTargetingKeyId===parent.id&&row.name==='cached');
    row.status='UNKNOWN';
    const j=await review(f,await preview(f));
    assert.equal(j.canStart,false,`${kind} ${reportableType} cannot be proven active`);
    assert(j.counts[kind].conflict>0,JSON.stringify(j));assert.equal(f.writes.length,0);
    const started=await request(f,`/line-items/jobs/${j.id}/start`,{cursor:j.cursor,confirm:true,confirmNetwork:'123456'});
    assert.notEqual(started.status,200);assert.equal(f.writes.length,0);
  }
});

test('duplicate case-folded key identities never authorize a duplicate create',async()=>{
  const f=await setup();seedReporting(f);
  f.db.key.push({...f.db.key.find(row=>row.name==='aq_bid_origin'),id:'900000',name:'AQ_BID_ORIGIN'});
  const j=await review(f,await preview(f));assert.equal(j.canStart,false);assert(j.conflictCount>0);
  assert.equal(f.writes.length,0);
});

test('value discovery is parent-scoped, so the same name under another key is not reused',async()=>{
  const f=await setup();seedReporting(f,{omitValue:'aq_bid_origin:cached'});
  const parent=f.db.key.find(row=>row.name==='aq_bid_origin');
  f.db.key.push({id:'900001',name:'unrelated',type:'FREEFORM',status:'ACTIVE'});
  f.db.value.push({customTargetingKeyId:'900001',id:'900002',name:'cached',displayName:'Foreign cached',matchType:'EXACT',status:'ACTIVE'});
  const query=f.traffic.query.bind(f.traffic);f.traffic.query=async(kind,where,bindings,options)=>{
    if(kind==='value')assert(/customTargetingKeyId\s*=/.test(where),'CustomTargetingService requires a key-ID AND predicate');
    return query(kind,where,bindings,options);
  };
  const byNames=f.traffic.byNames.bind(f.traffic);f.traffic.byNames=async(kind,names,where,bindings)=>{
    if(kind==='value')assert(/customTargetingKeyId\s*=/.test(where),'value names must be looked up below one key');
    return byNames(kind,names,where,bindings);
  };
  const j=await ready(f);assert.equal(j.counts.value.new,1);await finish(f,await start(f,j));
  const matches=f.db.value.filter(row=>row.name.toLowerCase()==='cached');assert.equal(matches.length,2);
  assert.equal(matches.filter(row=>String(row.customTargetingKeyId)===parent.id).length,1);
});

test('failed or incomplete reporting scans remain unknown and never prove absence',async()=>{
  for(const broken of ['throw','partial']) {
    const f=await setup(),query=f.traffic.query.bind(f.traffic),byNames=f.traffic.byNames.bind(f.traffic);let unavailable=true;
    const unavailableResult=()=>{
      if(broken==='throw')throw new GamError('Synthetic incomplete reporting read',502);
      return {rows:[],total:501,more:true};
    };
    f.traffic.query=async(kind,...args)=>{
      if(kind==='key'&&unavailable)return unavailableResult();
      return query(kind,...args);
    };
    f.traffic.byNames=async(kind,...args)=>kind==='key'&&unavailable?unavailableResult():byNames(kind,...args);
    let j=await review(f,await preview(f));assert.equal(j.canStart,false);assert(j.verificationCount>0,JSON.stringify(j));
    assert.equal(j.counts.key.new,0);assert.equal(f.writes.length,0);
    unavailable=false;j=await review(f,await action(f,j,'review',{retry:true}));assert.equal(j.canStart,true,JSON.stringify(j));
    await finish(f,await start(f,j));assert.equal(f.db.key.length,14);assert.equal(f.db.value.length,283);
  }
});

test('a malformed value response from another parent is unknown, not a missing value',async()=>{
  const f=await setup();seedReporting(f);const query=f.traffic.query.bind(f.traffic),byNames=f.traffic.byNames.bind(f.traffic);
  f.traffic.query=async(kind,...args)=>{
    const result=await query(kind,...args);
    if(kind==='value'&&result.rows.length)return {...result,rows:result.rows.map(row=>({...row,customTargetingKeyId:'999999'}))};
    return result;
  };
  f.traffic.byNames=async(kind,...args)=>{
    const rows=await byNames(kind,...args);
    return kind==='value'?rows.map(row=>({...row,customTargetingKeyId:'999999'})):rows;
  };
  const j=await review(f,await preview(f));assert.equal(j.canStart,false);assert(j.verificationCount>0,JSON.stringify(j));
  assert.equal(j.counts.value.new,0);assert.equal(f.writes.length,0);
});

test('reporting overlaps merge without extra targeting predicates or deadlocked references',async()=>{
  const f=await setup(),input={...prebidPlan(),customTargeting:'VARIANT=A\nAQ_BID_ORIGIN=FRESH'};
  const j=await ready(f,input);await finish(f,await start(f,j));
  assert.equal(f.db.key.length,15,'one price key plus the fourteen reporting keys');
  assert.equal(new Set(f.db.key.map(row=>row.name.toLowerCase())).size,15);
  const byName=name=>f.db.key.find(row=>row.name.toLowerCase()===name.toLowerCase());
  for(const row of f.db.lineItem) {
    const children=row.targeting.customTargeting.children;assert.equal(children.length,3,'price and exactly the two selected targeting predicates');
    assert.deepEqual(new Set(children.map(child=>String(child.keyId))),new Set(['hb_pb','Variant','aq_bid_origin'].map(name=>byName(name).id)));
    for(const name of ['Variant','aq_bid_origin']) {
      const predicate=children.find(child=>String(child.keyId)===byName(name).id);assert.equal(predicate.valueIds.length,1);
      const value=f.db.value.find(value=>String(value.id)===String(predicate.valueIds[0]));
      assert.equal(value.name.toLowerCase(),name==='Variant'?'a':'fresh');assert.equal(predicate.operator,'IS');
    }
  }
});

test('lost key create response survives storage restart and is verified without replaying creation',async()=>{
  let f=await setup(),j=await start(f,await ready(f));f.failNext('key');j=await action(f,j,'step');
  assert.equal(j.awaitingCheck,true);assert.equal(f.db.key.length,14);const writes=f.writes.length,id=j.id;
  f=restart(f);j=(await request(f,`/line-items/jobs/${id}`)).data;j=await action(f,j,'step');assert.equal(f.writes.length,writes);
  j=await action(f,j,'check');assert.equal(j.awaitingCheck,false);assert.equal(f.writes.length,writes);
  await finish(f,j);assert.equal(f.db.key.length,14);assert.equal(f.db.value.length,283);
  assert.equal(f.writes.filter(write=>write.method==='create'&&write.kind==='key').length,1);
});

test('lost reporting metadata update response is reconciled by ID without a second update',async()=>{
  const f=await setup();seedReporting(f,{off:'aq_bid_origin'});assert.equal(typeof f.traffic.update,'function');
  const update=f.traffic.update.bind(f.traffic);let once=true;
  f.traffic.update=async(...args)=>{const result=await update(...args);if(once){once=false;throw new GamError('Synthetic lost update response',502);}return result;};
  let j=await startMetadata(f,await metadataReady(f));j=await action(f,j,'step');assert.equal(j.awaitingCheck,true);
  const writes=f.writes.length;j=await action(f,j,'step');assert.equal(f.writes.length,writes);
  j=await action(f,j,'check');assert.equal(j.awaitingCheck,false);assert.equal(f.writes.length,writes);
  await finish(f,j);assert.equal(f.writes.filter(write=>write.method==='update').length,1);assert.equal(f.db.key.length,14);
});

test('an external OFF change after key verification cannot authorize reporting value writes',async()=>{
  const f=await setup();seedReporting(f,{omitValue:'aq_bid_origin:cached'});
  let j=await startMetadata(f,await metadataReady(f));j=await action(f,j,'step');assert.equal(j.phase,'Key-value vrednosti');
  const parent=f.db.key.find(row=>row.name==='aq_bid_origin');parent.reportableType='OFF';
  const writes=f.writes.length;j=await action(f,j,'step');
  assert.equal(f.writes.slice(writes).some(write=>write.kind==='value'),false,'parent metadata must be revalidated before value creation');
  j=await finish(f,j);assert.equal(parent.reportableType,'ON');
  assert.equal(f.db.value.filter(row=>String(row.customTargetingKeyId)===parent.id&&row.name.toLowerCase()==='cached').length,1);
});

test('legacy active snapshots reopen unchanged while explicit reporting additions remain a different plan',async()=>{
  const f=await setup(),input=prebidPlan();let j=await preview(f,input);
  const stored=storedJob(f,j.id);delete stored.value.plan.reporting;
  f.env.BUILDS.data.set(stored.key,{...stored.entry,body:JSON.stringify(stored.value)});
  j=(await request(f,`/line-items/jobs/${j.id}`)).data;j=await review(f,j);j=await start(f,j);
  const before=structuredClone(f.env.BUILDS.data),writes=f.writes.length;
  const reopened=await request(f,'/line-items/preview',input);assert.equal(reopened.status,200,JSON.stringify(reopened.data));
  assert.equal(reopened.data.id,j.id);assert.equal(reopened.data.resumed,true);assert.deepEqual(f.env.BUILDS.data,before);assert.equal(f.writes.length,writes);
  assert.equal(storedJob(f,j.id).value.plan.reporting,undefined);
  const explicit=await request(f,'/line-items/preview',{...input,reportingValues:{}});assert.equal(explicit.status,409);assert.equal(explicit.data.activeJobId,j.id);
  const changed=await request(f,'/line-items/preview',{...input,namePrefix:'Different'});assert.equal(changed.status,409);assert.equal(changed.data.activeJobId,j.id);
  await finish(f,j);assert.equal(f.db.key.length,1,'continuing an old plan must not silently insert the new reporting profile');
});

test('reporting-only setup retains actor/origin and explicit network confirmation checks',async()=>{
  const f=await setup(),j=await ready(f);
  const wrongNetwork=await request(f,`/line-items/jobs/${j.id}/start`,{cursor:j.cursor,confirm:true,confirmNetwork:'999'});
  assert.notEqual(wrongNetwork.status,200);
  const otherActor=await request(f,`/line-items/jobs/${j.id}/start`,{cursor:j.cursor,confirm:true,confirmNetwork:'123456'},'other@example.invalid');
  assert.notEqual(otherActor.status,200);
  const wrongOrigin=await request(f,`/line-items/jobs/${j.id}/start`,{cursor:j.cursor,confirm:true,confirmNetwork:'123456'},actor,'https://other.invalid');
  assert.notEqual(wrongOrigin.status,200);assert.equal(f.writes.length,0);
});

test('key metadata update SOAP uses the documented operation and field sequence',async()=>{
  const calls=[],payload={id:'5000',name:'VARIANT',displayName:'Operator name',type:'FREEFORM',reportableType:'ON'};
  const traffic=new GamTrafficClient({call:async(service,operation,xml,options)=>{calls.push({service,operation,xml,options});return payload;}});
  const rows=await traffic.update('key',[payload]);assert.equal(rows.length,1);assert.equal(rows[0].id,'5000');
  assert.equal(calls.length,1);assert.equal(calls[0].service,'CustomTargetingService');assert.equal(calls[0].operation,'updateCustomTargetingKeys');
  assert.equal(calls[0].xml,'<keys><id>5000</id><name>VARIANT</name><displayName>Operator name</displayName><type>FREEFORM</type><reportableType>ON</reportableType></keys>');
  assert.equal(calls[0].options.entityCount,1);assert(!calls[0].xml.includes('<status>'),'read-only status must not be mutated');
});

test('real traffic lookup proves alphabetic absence through a complete case-folded scope, with required value parent',async()=>{
  const traffic=new GamTrafficClient({}),queries=[];
  traffic.query=async(kind,where='',bindings={})=>{
    queries.push({kind,where,bindings:structuredClone(bindings)});
    if(where.includes('name IN'))return {rows:[],total:0,more:false};
    if(kind==='key')return {rows:[{id:'17',name:'variant'},{id:'18',name:'other'}],total:2,more:false};
    assert.equal(where,'customTargetingKeyId = 17');
    return {rows:[{id:'19',name:'CACHED',customTargetingKeyId:'17'}],total:1,more:false};
  };
  assert.deepEqual((await traffic.byNames('key',['Variant'])).map(row=>row.id),['17']);
  assert.equal(queries.at(-1).where,'','a case-sensitive PQL miss is not proof that the key is absent');
  assert.deepEqual((await traffic.byNames('value',['cached'],'customTargetingKeyId = :parent',{parent:'17'})).map(row=>row.id),['19']);
  assert.equal(queries.at(-1).where,'customTargetingKeyId = 17');
  const before=queries.length;
  await assert.rejects(()=>traffic.byNames('value',['cached']),{status:422});assert.equal(queries.length,before);
  await traffic.byNames('advertiser',['Prebid']);
  assert(queries.at(-1).where.includes('name IN'),'ad-object matching must retain its original exact-name query');
  assert.equal(queries.at(-1).bindings.name0,'Prebid');
});

test('a reporting key already upgraded after review is reused without another metadata write',async()=>{
  const f=await setup();seedReporting(f,{off:'aq_bid_origin'});const j=await metadataReady(f);assert.equal(j.counts.key.update,1);
  f.db.key.find(row=>row.name==='aq_bid_origin').reportableType='ON';
  await finish(f,await startMetadata(f,j));assert.equal(f.writes.length,0);
});

test('a disappeared OFF key keeps its reviewed ID and is never recreated under the same name',async()=>{
  const f=await setup();seedReporting(f,{off:'aq_bid_origin'});const j=await ready(f);
  const old=f.db.key.find(row=>row.name==='aq_bid_origin');f.db.key.splice(f.db.key.indexOf(old),1);
  let current=await start(f,j);current=await action(f,current,'step');
  assert(current.conflictCount>0||current.verificationCount>0,JSON.stringify(current));
  assert.equal(f.writes.length,0);assert.equal(f.db.key.some(row=>row.name==='aq_bid_origin'),false);
});

test('a lost update in a mixed update/create batch resumes the remaining creation at a new cursor',async()=>{
  const f=await setup();seedReporting(f,{off:'aq_bid_origin'});
  const missing=f.db.key.find(row=>row.name==='aq_first_request');
  f.db.key.splice(f.db.key.indexOf(missing),1);
  f.db.value=f.db.value.filter(row=>String(row.customTargetingKeyId)!==missing.id);
  const update=f.traffic.update.bind(f.traffic);let once=true;
  f.traffic.update=async(...args)=>{const rows=await update(...args);if(once){once=false;throw new GamError('Synthetic mixed update response lost',502);}return rows;};
  let j=await metadataReady(f);assert.equal(j.counts.key.update,1);assert.equal(j.counts.key.new,1);assert.equal(j.counts.value.new,6);
  j=await startMetadata(f,j);const cursor=j.cursor;j=await action(f,j,'step');assert.equal(j.awaitingCheck,true);
  assert.equal(f.db.key.some(row=>row.name==='aq_first_request'),false,'one durable attempt must not hide a second write');
  j=await action(f,j,'check');assert.equal(j.awaitingCheck,false);assert.equal(j.phase,'Key-value ključevi');
  assert(j.cursor>cursor);assert.equal(j.offset,0,'remaining uncreated keys keep this phase unfinished');
  const done=await finish(f,j);assert.equal(done.counts.key.done,14);assert.equal(done.counts.value.done,283);
  assert.equal(f.writes.filter(write=>write.method==='update').length,1);
  const creates=f.writes.filter(write=>write.method==='create'&&write.kind==='key');assert.equal(creates.length,1);
  assert.deepEqual(creates[0].payloads.map(row=>row.name),['aq_first_request']);
});

test('malformed update confirmations cannot turn a key into Done before a read verifies its original ID and metadata',async()=>{
  for(const corrupt of [row=>({...row,id:'999999'}),row=>({...row,reportableType:'OFF'}),row=>({...row,type:'PREDEFINED'})]) {
    const f=await setup();seedReporting(f,{off:'aq_bid_origin'});const update=f.traffic.update.bind(f.traffic);
    f.traffic.update=async(...args)=>(await update(...args)).map(corrupt);
    let j=await startMetadata(f,await metadataReady(f));j=await action(f,j,'step');assert.equal(j.awaitingCheck,true);
    const count=f.writes.length;j=await action(f,j,'check');assert.equal(j.awaitingCheck,false);assert.equal(f.writes.length,count);
    await finish(f,j);assert.equal(f.writes.filter(write=>write.method==='update').length,1);
  }
});

test('an unapplied metadata update waits 90 seconds, then only an explicit step retries its original ID using fresh metadata',async t=>{
  const f=await setup();seedReporting(f,{off:'aq_bid_origin'});
  const parent=f.db.key.find(row=>row.name==='aq_bid_origin'),id=parent.id;
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  let j=await startMetadata(f,await metadataReady(f));f.failNextUpdate('key',false);
  j=await action(f,j,'step');assert.equal(j.awaitingCheck,true);assert.equal(parent.reportableType,'OFF');
  assert.equal(f.writes.length,1);const attemptCursor=j.cursor;
  now+=89999;j=await action(f,j,'check');assert.equal(j.awaitingCheck,true);
  assert.equal(j.cursor,attemptCursor);assert.equal(f.writes.length,1,'an early check cannot replay an uncertain write');
  parent.displayName='Fresh operator label';parent.type='PREDEFINED';
  now++;j=await action(f,j,'check');assert.equal(j.awaitingCheck,false);
  assert(j.cursor>attemptCursor);assert.equal(j.offset,0);assert.equal(parent.reportableType,'OFF');
  assert.equal(f.writes.length,1,'closing the expired attempt is read-only');
  j=await action(f,j,'step');assert.equal(parent.reportableType,'ON');
  const updates=f.writes.filter(write=>write.method==='update');assert.equal(updates.length,2);
  assert.deepEqual(updates[1].payloads,[{id,name:'aq_bid_origin',displayName:'Fresh operator label',type:'PREDEFINED',reportableType:'ON'}]);
  await finish(f,j);assert.equal(f.db.key.length,14);assert.equal(f.db.value.length,283);
  assert.equal(f.writes.some(write=>write.method==='create'),false,'retry must never replace the owned key');
});

test('malformed scanned key/value names or missing settings remain unverified, then recover without writes',async()=>{
  for(const [kind,field,value] of [['key','name',''],['key','type',undefined],['value','name',7],['value','matchType',undefined]]) {
    const f=await setup();seedReporting(f);
    const parent=f.db.key.find(row=>row.name==='aq_bid_origin');
    const row=kind==='key'?parent:f.db.value.find(row=>row.customTargetingKeyId===parent.id&&row.name==='cached');
    const original=row[field];row[field]=value;
    let j=await review(f,await preview(f));assert.equal(j.canStart,false,`${kind}.${field}`);
    assert(j.verificationCount>0,JSON.stringify(j));assert.equal(f.writes.length,0);
    assert.equal(j.counts[kind].new,0,'incomplete identity/settings cannot prove absence');
    row[field]=original;j=await review(f,await action(f,j,'review',{retry:true}));assert.equal(j.canStart,true,JSON.stringify(j));
    await finish(f,await start(f,j));assert.equal(f.writes.length,0);
  }
});

test('known value IDs are rechecked below their exact parent in the API and real traffic transport',async()=>{
  const f=await setup();seedReporting(f);const byIds=f.traffic.byIds.bind(f.traffic);let valueReads=0;
  f.traffic.byIds=async(kind,ids,options)=>{
    if(kind==='value') {
      valueReads++;assert(options?.parentId,'known IDs need a parent even after the review found them');
      for(const id of ids)assert.equal(f.db.value.find(row=>row.id===String(id)).customTargetingKeyId,String(options.parentId));
    }
    return byIds(kind,ids,options);
  };
  await finish(f,await start(f,await ready(f)));assert(valueReads>0);assert.equal(f.writes.length,0);
  const traffic=new GamTrafficClient({}),queries=[];
  traffic.query=async(kind,where)=>{queries.push({kind,where});return {rows:[],total:0,more:false};};
  await traffic.byIds('value',['19','20'],{parentId:'17'});
  assert.deepEqual(queries,[{kind:'value',where:'customTargetingKeyId = 17 AND id IN (19,20)'}]);
  for(const options of [{},{parentId:'17 OR 1=1'},{parentId:'0'}])
    await assert.rejects(()=>traffic.byIds('value',['19'],options),{status:422});
  assert.equal(queries.length,1,'unscoped or invalid parent IDs never reach SOAP');
});
