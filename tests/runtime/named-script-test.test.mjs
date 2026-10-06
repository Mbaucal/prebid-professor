import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
const fixtures=[];
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
const base='/api/publishers/test-named-script';
async function fixture(){
  const f=workspaceStore();fixtures.push(f);
  const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
  assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
  async function call(path,method='GET',body,headers={}){
    const response=await worker.fetch(new Request(ORIGIN+path,{method,headers:{cookie,...(method!=='GET'?{origin:ORIGIN,'content-type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)}),f.env);
    const data=await response.json();return {status:response.status,data};
  }
  assert.equal((await call('/test-api/setup','POST',{confirm:'prepare-empty-test-database'})).status,200);
  return {...f,call};
}
const prepare=f=>f.call('/test-api/named-scripts/prepare','POST',{confirm:'prepare-named-script-test-copy'});
const snapshot=f=>JSON.stringify(f.sqlite.prepare("SELECT p.*,c.config_json FROM publishers p JOIN publisher_configs c ON p.id=c.publisher_id WHERE p.id='test-site'").get());
test('GET is read-only; explicit setup is atomic and idempotent without changing the existing TEST site',async()=>{
  const f=await fixture(),before=snapshot(f),batches=f.log.batches;
  assert.deepEqual((await f.call('/test-api/named-scripts/status')).data,{ready:false,siteId:'test-named-script'});
  assert.equal(f.log.batches,batches);assert.equal((await f.call('/test-api/named-scripts/prepare')).status,405);
  assert.equal((await prepare(f)).data.created,true);assert.equal(f.log.batches,batches+1);
  assert.equal((await prepare(f)).data.created,false);assert.equal(f.log.batches,batches+1);
  assert.equal(snapshot(f),before);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ad_units WHERE publisher_id='test-named-script'").get().n,19);
  assert.equal(f.objects.size,0);
});
test('partial setup rolls back; incomplete existing fixture is refused rather than repaired',async()=>{
  const f=await fixture();f.faults.batchAt=3;
  assert.equal((await prepare(f)).status,409);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM publishers WHERE id='test-named-script'").get().n,0);
  f.faults.batchAt=-1;assert.equal((await prepare(f)).status,200);
  f.sqlite.prepare("DELETE FROM ad_units WHERE publisher_id='test-named-script' AND code='Sticky'").run();
  const batches=f.log.batches;assert.equal((await prepare(f)).status,409);assert.equal((await f.call(base+'/prebid-mode')).status,409);assert.equal(f.log.batches,batches);
});
test('Tanjug domain collision preserves the existing draft and never creates a substitute fixture',async()=>{
  const f=await fixture();
  for(const domain of ['tanjug.rs','WWW.TANJUG.RS','https://www.tanjug.rs/',' http://TANJUG.rs/ ']){
    f.sqlite.prepare("UPDATE publishers SET domain=? WHERE id='test-site'").run(domain);
    const before=snapshot(f),batches=f.log.batches;
    assert.equal((await f.call('/test-api/named-scripts/status')).status,409);assert.equal((await prepare(f)).status,409);
    assert.equal(snapshot(f),before);assert.equal(f.log.batches,batches);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM publishers').get().n,1);
  }
});
test('transaction-time alias collision aborts preparation after an earlier clear status read',async()=>{
  const f=await fixture(),batch=f.env.DB.batch.bind(f.env.DB);let interleaved=false;
  f.env.DB.batch=async items=>{
    if(!interleaved&&items.some(item=>item.sql.startsWith('INSERT INTO publishers'))){
      interleaved=true;f.sqlite.prepare("UPDATE publishers SET domain='www.tanjug.rs' WHERE id='test-site'").run();
    }
    return batch(items);
  };
  assert.equal((await prepare(f)).status,409);assert.equal(interleaved,true);
  assert.equal(f.sqlite.prepare("SELECT domain FROM publishers WHERE id='test-site'").get().domain,'www.tanjug.rs');
  for(const table of ['publishers','publisher_configs','ad_units','audit_log']){
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM '+table+" WHERE id LIKE 'test-named-script%'").get().n,0,table+' must rollback');
  }
  assert.equal(f.objects.size,0);
});
test('new routes preserve authentication, Origin, schema, method and fixed-site boundaries',async()=>{
  const f=await fixture();await prepare(f);const mode=(await f.call(base+'/prebid-mode')).data;
  const body={enabled:true,revision:mode.revision,bidCache:{enabled:true,maxBidAgeSeconds:60}};
  const before=f.log.batches;
  assert.equal((await f.call(base+'/prebid-mode','PUT',body,{cookie:''})).status,401);
  assert.equal((await f.call(base+'/prebid-mode','PUT',body,{origin:'https://other.invalid'})).status,403);
  assert.equal((await f.call('/api/publishers/test-site/prebid-mode','PUT',body)).status,405);
  assert.equal((await f.call(base+'/ad-units','POST',{})).status,404);
  assert.equal((await f.call(base+'/script-library','DELETE')).status,405);
  assert.equal((await f.call(base+'/prebid-mode','PUT',{...body,sql:'ignored injection'})).status,422);
  assert.equal((await f.call(base+'/prebid-mode','PUT',{...body,revision:'x'.repeat(5000)})).status,413);
  assert.equal(f.log.batches,before);
  f.sqlite.exec('CREATE TABLE unexpected_table(id TEXT)');
  assert.equal((await f.call(base+'/prebid-mode')).status,409);assert.equal((await prepare(f)).status,409);
});
test('reused cache writer attributes the authenticated actor and rejects stale forms',async()=>{
  const f=await fixture();await prepare(f);const before=snapshot(f),mode=(await f.call(base+'/prebid-mode')).data;
  const body={enabled:true,revision:mode.revision,bidCache:{enabled:false,maxBidAgeSeconds:60,positionOverrides:{Sticky:true,Billboard:false}}};
  const saved=await f.call(base+'/prebid-mode','PUT',body,{'x-authenticated-user':'forged@example.invalid','cf-access-authenticated-user-email':'forged@example.invalid'});
  assert.equal(saved.status,200);assert.deepEqual(saved.data.prebidMode.bidCache.positionOverrides,{Billboard:false,Sticky:true});
  assert.equal(f.sqlite.prepare("SELECT actor FROM audit_log WHERE action='prebid_mode.updated'").get().actor,TEST_EMAIL);
  assert.equal((await f.call(base+'/prebid-mode','PUT',body)).status,409);assert.equal(snapshot(f),before);
});
