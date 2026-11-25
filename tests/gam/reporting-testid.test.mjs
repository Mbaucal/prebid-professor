import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLinePlan} from '../../shared/gam/line-items.mjs';
import {OPEN_REPORTING_KEYS} from '../../shared/gam/reporting-catalog.mjs';
import {gamResponse} from '../../worker/integrations/gam-service.mjs';
import {trafficFixture} from './traffic-fixture.mjs';
import {MemoryBucket} from './fixture.mjs';

const origin='https://testid-gam.invalid',base='/api/integrations/gam',actor='testid@example.invalid';
const selected=(...reportingSelection)=>({mode:'reporting',networkCode:'123456',reportingSelection});
const plan=(...rows)=>normalizeLinePlan(selected(...rows));
async function request(f,path,body){
  const response=await gamResponse(new Request(origin+base+path,{method:body===undefined?'GET':'POST',
    headers:{origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),
    f.env,actor,{clientFactory:()=>f.client,trafficFactory:()=>f.traffic});
  return {status:response.status,data:await response.json()};
}
async function setup(){
  const f=trafficFixture();f.writes=[];
  f.traffic.update=async()=>assert.fail('TestId add-only preparation must never update metadata');
  const create=f.traffic.create.bind(f.traffic);
  f.traffic.create=async(kind,payloads)=>{
    assert(['key','value'].includes(kind));
    for(const payload of payloads)assert(!f.db[kind].some(row=>row.name.toLowerCase()===payload.name.toLowerCase()&&
      (kind==='key'||String(row.customTargetingKeyId)===String(payload.customTargetingKeyId))),'No duplicate identity');
    f.writes.push({kind,payloads:structuredClone(payloads)});return create(kind,payloads);
  };
  const response=await request(f,'/connect',{networkCode:'123456',credentials:{type:'service_account',
    client_email:'testid@fixture.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----'}});
  assert.equal(response.status,201);return f;
}
async function action(f,j,name,extra={}){
  const response=await request(f,`/line-items/jobs/${j.id}/${name}`,{cursor:j.cursor,...extra});
  assert.equal(response.status,200,JSON.stringify(response.data));return response.data;
}
async function ready(f,input){
  const response=await request(f,'/line-items/preview',input);assert.equal(response.status,201,JSON.stringify(response.data));
  let j=response.data;
  for(let n=0;j.status==='reviewing'&&n<20;n++)j=await action(f,j,'review');
  assert.equal(j.status,'ready');assert.equal(j.canStart,true,JSON.stringify(j));return j;
}
async function finish(f,j){
  j=await action(f,j,'start',{confirm:true,confirmNetwork:'123456'});
  for(let n=0;j.status==='creating'&&n<20;n++)j=await action(f,j,j.awaitingCheck?'check':'step');
  assert.equal(j.status,'completed',JSON.stringify(j));return j;
}
function seed(f,{name='TestId',id='9000',reportableType='OFF',values=['main_ab_1']}={}){
  const key={id,name,displayName:'Publisher label',type:'FREEFORM',status:'ACTIVE',reportableType};
  f.db.key.push(key);
  values.forEach((name,index)=>f.db.value.push({id:String(Number(id)+index+1),customTargetingKeyId:id,
    name,displayName:'Publisher '+name,matchType:'EXACT',status:'ACTIVE'}));return key;
}
const result=(j,key)=>j.reporting.results.find(row=>row.key===key);
const savedKey=id=>`api-integrations/gam/line-items/v1/jobs/${id}.json`;

test('catalog exposes selectable predefined TestId without fake/default values or another numeric open key',async()=>{
  const f=trafficFixture();f.client.network=async()=>assert.fail('Catalog is read-only and needs no Google connection');
  const response=await request(f,'/key-values/catalog');assert.equal(response.status,200);
  assert.equal(response.data.keys.length,14);
  assert.deepEqual(response.data.keys.find(row=>row.key==='TestId'),{
    key:'TestId',type:'PREDEFINED',reportableType:'ON',values:[],openDomain:false,valueInput:'test-id'});
  assert.deepEqual(OPEN_REPORTING_KEYS,['refresh_count','refresh_interval','aq_bid_count','aq_bidder_count']);
  assert.deepEqual(plan({key:'TestId'}).reporting.keys[0].values,[]);
});

test('TestId explicit values keep exact loader-compatible identity and are selected only through row values',()=>{
  const p=plan({key:'variant',values:['B']},{key:'testid',values:['a','main_ab_1','a','x'.repeat(24)]});
  assert.equal(p.reporting.writePolicy,'add_only');
  assert.deepEqual(p.reporting.keys.map(row=>[row.key,row.values]),[
    ['Variant',['B']],['TestId',['a','main_ab_1','x'.repeat(24)]]]);
  assert.throws(()=>normalizeLinePlan({...selected({key:'TestId'}),reportingValues:{TestId:['main_ab_1']}}),{status:422});
  assert.throws(()=>plan({key:'arbitrary_key',values:['main_ab_1']}),{status:422});
});

test('invalid TestId values and oversized explicit lists fail before creating jobs or Google writes',async()=>{
  const f=await setup();
  for(const value of ['', 'A', 'Mixed_case', 'with-dash', 'with space', 'x'.repeat(25), 'é', 7, null, {}]){
    const response=await request(f,'/line-items/preview',selected({key:'TestId',values:[value]}));
    assert.equal(response.status,422,JSON.stringify(value));
  }
  const values=Array.from({length:1000},(_,index)=>'test_'+index);
  assert.equal(plan({key:'TestId',values}).reporting.keys[0].values.length,1000);
  assert.throws(()=>plan({key:'TestId',values:[...values,'over_limit']}),{status:422});
  assert.equal(f.writes.length,0);
  assert(![...f.env.BUILDS.data.keys()].some(key=>key.startsWith('api-integrations/gam/line-items/v1/jobs/')));
});

test('key-only TestId preparation creates one ON predefined key and no invented values',async()=>{
  const f=await setup(),j=await ready(f,selected({key:'TestId',values:[]}));assert.equal(f.writes.length,0);
  const done=await finish(f,j);
  assert.deepEqual(f.writes,[{kind:'key',payloads:[{name:'TestId',displayName:'TestId',type:'PREDEFINED',reportableType:'ON'}]}]);
  assert.equal(result(done,'TestId').outcome,'created');assert.deepEqual(result(done,'TestId').values,[]);
});

test('existing OFF TestId keeps all metadata and values while only a missing selected value is added under its ID',async()=>{
  const f=await setup(),key=seed(f,{name:'TESTID',values:['MAIN_AB_1']});
  seed(f,{name:'unrelated',id:'9100',values:['main_ab_2']});
  const before=structuredClone({keys:f.db.key,values:f.db.value});
  const j=await ready(f,selected({key:'TestId',values:['main_ab_1','main_ab_2']}));
  assert.equal(j.counts.key.update,0);assert.equal(j.counts.value.existing,1);assert.equal(j.counts.value.new,1);
  const done=await finish(f,j);
  assert.deepEqual(f.db.key,before.keys);assert.deepEqual(f.db.value.slice(0,before.values.length),before.values);
  assert.deepEqual(f.writes,[{kind:'value',payloads:[{customTargetingKeyId:key.id,name:'main_ab_2',displayName:'main_ab_2',matchType:'EXACT'}]}]);
  assert.equal(result(done,'TestId').reportableType,'OFF');assert(result(done,'TestId').message);
  assert.deepEqual(result(done,'TestId').values.map(row=>row.outcome),['existing','created']);
});

test('existing selected Variant/TestId finish without writes and unselected TestId stays untouched',async()=>{
  const f=await setup();seed(f);seed(f,{name:'Variant',id:'9100',reportableType:'CUSTOM_DIMENSION',values:['A','B']});
  const before=structuredClone(f.db);
  const done=await finish(f,await ready(f,selected({key:'Variant',values:['B']},{key:'TestId',values:['main_ab_1']})));
  assert.deepEqual(f.db,before);assert.equal(f.writes.length,0);assert.equal(done.reporting.outcomes.keys.existing,2);
  await finish(f,await ready(f,selected({key:'Variant',values:['A']})));
  assert.deepEqual(f.db,before);assert.equal(f.writes.length,0);
});

test('uncertain TestId value creation is checked after restart and never replayed',async()=>{
  let f=await setup();seed(f,{values:[]});
  let j=await ready(f,selected({key:'TestId',values:['main_ab_1']}));
  j=await action(f,j,'start',{confirm:true,confirmNetwork:'123456'});j=await action(f,j,'step');
  f.failNext('value');j=await action(f,j,'step');assert.equal(j.awaitingCheck,true);
  const writes=f.writes.length,bucket=new MemoryBucket();bucket.data=structuredClone(f.env.BUILDS.data);
  f={...f,env:{...f.env,BUILDS:bucket}};
  j=(await request(f,`/line-items/jobs/${j.id}`)).data;
  j=await action(f,j,'step');assert.equal(f.writes.length,writes);
  j=await action(f,j,'check');assert.equal(j.status,'completed');assert.equal(f.writes.length,writes);
  assert.equal(result(j,'TestId').values[0].outcome,'existing');assert.equal(result(j,'TestId').values[0].reconciled,true);
});

test('old materialized jobs are not upgraded when the current catalog adds TestId',async()=>{
  const f=await setup(),response=await request(f,'/line-items/preview',{mode:'reporting',networkCode:'123456'});
  assert.equal(response.status,201);let j=response.data;
  const key=savedKey(j.id),raw=JSON.parse(f.env.BUILDS.data.get(key).body);
  raw.plan.reporting.keys=raw.plan.reporting.keys.filter(row=>!['TestId','VersionId'].includes(row.key));
  const before=JSON.stringify(raw.plan);await f.env.BUILDS.put(key,JSON.stringify(raw));
  j=(await request(f,`/line-items/jobs/${j.id}`)).data;
  for(let n=0;j.status==='reviewing'&&n<20;n++)j=await action(f,j,'review');
  assert.equal(j.reporting.keyCount,12);assert(!result(j,'TestId'));assert.equal(f.writes.length,0);
  assert.equal(JSON.stringify(JSON.parse(f.env.BUILDS.data.get(key).body).plan),before);
});
