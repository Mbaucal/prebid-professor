import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
import {organizationResponse} from '../../worker/organization/service.mjs';
import {organizationDdl} from '../../worker/organization/schema.mjs';
import {initializeTestSchema,inspectTestSchema} from '../../worker/test-workspace/schema.mjs';
import worker from '../../worker/test-workspace/index.mjs';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
function setup(){const f=workspaceStore();f.sqlite.exec("CREATE TABLE publisher_accounts (id TEXT PRIMARY KEY,created_at TEXT NOT NULL); INSERT INTO publisher_accounts VALUES ('example-publisher','first'),('another-publisher','first')");return f;}
async function call(f,path='',body,options={}){
  const request=new Request(ORIGIN+'/api/organization'+path,{method:body===undefined?'GET':'POST',headers:{origin:ORIGIN,'content-type':'application/json',...options.headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const response=await organizationResponse(request,f.env,options.actor===undefined?TEST_EMAIL:options.actor);
  return {status:response.status,data:await response.json()};
}
async function create(f,name='Example Agency',logo=null){const result=await call(f,'/agencies',{name,logo});assert.equal(result.status,201,JSON.stringify(result.data));return result.data.agencies.find(a=>a.name===name);}
const move=(f,id,agency,expected)=>call(f,`/publishers/${id}/agency`,{agencyId:agency,expectedRevision:expected});
test('legacy read is side-effect free; agencies and logos persist; publisher moves preserve site settings and release bytes',async()=>{
  const f=setup();try{
    f.sqlite.exec("CREATE TABLE publishers (id TEXT PRIMARY KEY,publisher_account_id TEXT,config TEXT); INSERT INTO publishers VALUES ('site-a','example-publisher','{\"gamPath\":\"/123/example/\"}'); CREATE TABLE releases(id TEXT PRIMARY KEY,bytes BLOB); INSERT INTO releases VALUES('saved',X'000102FF')");
    const preserved=()=>JSON.stringify([f.sqlite.prepare('SELECT * FROM publishers').all(),f.sqlite.prepare('SELECT * FROM releases').all(),f.sqlite.prepare('SELECT * FROM publisher_accounts').all()]);const before=preserved();
    assert.deepEqual((await call(f)).data,{agencies:[],memberships:[]});assert.equal(f.log.batches,0);
    const a=await create(f,'Example Agency',png),b=await create(f,'Other Agency');assert.equal(a.logo,png);
    assert.equal((await move(f,'example-publisher',a.id,0)).status,200);
    assert.equal((await move(f,'example-publisher',b.id,1)).status,200);
    const data=(await call(f)).data;assert.equal(data.memberships[0].agencyId,b.id);assert.equal(data.memberships[0].revision,2);
    assert.equal((await call(f,'/agencies/'+b.id,{name:'Renamed Agency',logo:png,expectedRevision:1})).status,200);
    assert.equal((await call(f,'/agencies/'+b.id,{name:'Renamed Agency',logo:null,expectedRevision:2})).status,200);
    assert.equal((await move(f,'example-publisher',null,2)).status,200);assert.equal((await call(f)).data.memberships[0].agencyId,null);
    assert.equal(preserved(),before);assert.equal(f.objects.size,0);
    const events=f.sqlite.prepare('SELECT * FROM organization_events').all();assert.equal(events.length,7);assert.ok(events.every(e=>e.actor===TEST_EMAIL));assert.ok(events.every(e=>!e.details_json.includes('base64')));
  }finally{f.close();}
});
test('stale updates and assignments cannot overwrite; deleted and recreated publisher does not inherit old agency',async()=>{
  const f=setup();try{
    const a=await create(f),b=await create(f,'Second');
    assert.equal((await move(f,'example-publisher',a.id,0)).status,200);
    assert.equal((await move(f,'example-publisher',b.id,0)).status,409);
    assert.equal((await move(f,'another-publisher',b.id,9)).status,409);
    assert.equal((await call(f,'/agencies/'+a.id,{name:'Bad stale name',logo:null,expectedRevision:0})).status,409);
    assert.equal((await call(f)).data.agencies.find(x=>x.id===a.id).name,a.name);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM organization_events').get().n,3);
    f.sqlite.exec("DELETE FROM publisher_accounts WHERE id='example-publisher'; INSERT INTO publisher_accounts VALUES ('example-publisher','second')");
    assert.deepEqual((await call(f)).data.memberships,[]);
    assert.equal((await move(f,'example-publisher',a.id,1)).status,409);
    assert.equal((await move(f,'example-publisher',b.id,0)).status,200);assert.equal((await call(f)).data.memberships[0].revision,1);
  }finally{f.close();}
});
test('invalid input, missing login, cross-origin, duplicate names and unsupported methods are rejected',async()=>{
  const f=setup();try{
    assert.equal((await call(f,'',undefined,{actor:null})).status,401);
    assert.equal((await call(f,'/agencies',{name:'Example',logo:null},{headers:{origin:'https://evil.example'}})).status,403);
    for(const body of [{name:''},{name:'A',logo:'https://example.com/logo.svg'},{name:'A',logo:'data:image/svg+xml;base64,PHN2Zz4='},{name:'A',logo:'data:image/png;base64,YWJjZA=='},{name:'A',unexpected:true}])assert.equal((await call(f,'/agencies',body)).status,422);
    assert.equal(f.log.batches,0);
    const a=await create(f);assert.equal((await call(f,'/agencies',{name:a.name.toUpperCase(),logo:null})).status,409);
    assert.equal((await move(f,'missing',a.id,0)).status,404);assert.equal((await move(f,'example-publisher','missing',0)).status,404);
    assert.equal((await organizationResponse(new Request(ORIGIN+'/api/organization',{method:'DELETE'}),f.env,TEST_EMAIL)).status,405);
  }finally{f.close();}
});
test('agency mutation and audit commit atomically',async()=>{
  const f=setup();try{await create(f);f.faults.batchAt=1;assert.equal((await call(f,'/agencies',{name:'Rolled back',logo:null})).status,503);f.faults.batchAt=-1;assert.equal((await call(f)).data.agencies.length,1);assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM organization_events').get().n,1);}finally{f.close();}
});
test('TEST accepts only the exact complete optional agency extension and retains all original guards',async()=>{
  for(const mutation of [null,'DROP TABLE organization_events','ALTER TABLE organization_agencies ADD COLUMN unexpected TEXT','CREATE TABLE organization_unknown(id TEXT)','DROP TRIGGER test_no_promotion']){
    const f=workspaceStore();try{
      await initializeTestSchema(f.env.DB,TEST_EMAIL);await f.env.DB.batch(organizationDdl.map(sql=>f.env.DB.prepare(sql)));
      if(mutation){f.sqlite.exec(mutation);await assert.rejects(()=>inspectTestSchema(f.env.DB));}else assert.equal((await inspectTestSchema(f.env.DB)).ready,true);
    }finally{f.close();}
  }
});
test('TEST HTTP stays isolated and authenticated; real create/assign/reload works without runtime changes',async()=>{
  const f=workspaceStore();try{
    const req=(path,cookie,body,origin=ORIGIN)=>worker.fetch(new Request(ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{...(cookie?{cookie}:{}),origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),f.env);
    assert.equal((await req('/test-api/organization')).status,401);
    const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);const cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await req('/test-api/organization/agencies',cookie,{name:'Example',logo:null})).status,409);
    assert.equal((await req('/test-api/setup',cookie,{confirm:'prepare-empty-test-database'})).status,200);
    const before=f.sqlite.prepare('SELECT * FROM publisher_configs').all();
    const created=await req('/test-api/organization/agencies',cookie,{name:'Test Agency',logo:png});assert.equal(created.status,201);const id=(await created.json()).agencies[0].id;
    assert.equal((await req('/test-api/organization/publishers/example-publisher/agency',cookie,{agencyId:id,expectedRevision:0})).status,200);
    assert.equal((await req('/test-api/organization/publishers/real-site/agency',cookie,{agencyId:id,expectedRevision:0})).status,404);
    assert.equal((await req('/test-api/organization/agencies',cookie,{name:'Cross origin',logo:null},'https://evil.example')).status,403);
    assert.equal((await req('/api/organization',cookie)).status,404);
    assert.equal((await req('/test-api/status',cookie)).status,200);
    assert.equal((await (await req('/test-api/organization',cookie)).json()).memberships[0].agencyId,id);
    assert.deepEqual(f.sqlite.prepare('SELECT * FROM publisher_configs').all(),before);assert.equal(f.objects.size,0);
    const page=await req('/agencies',cookie);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/img-src 'self' data:/);
  }finally{f.close();}
});
