import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {workspaceStore} from './support/test-workspace-store.mjs';
import {createBidder,listBidders,updateBidder,duplicateBidder,createBidderOverride} from '../worker/bidders.ts';
import {listPrebidBuilds} from '../worker/prebid-builds.ts';
import {duplicateSite} from '../worker/publishers.ts';
import {applyCsvImport} from '../worker/imports.ts';
const site='account-review-site';
const request=body=>new Request('https://review.fixture.invalid/api/bidders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const fixtures=[];
function setup(){
 const f=workspaceStore();fixtures.push(f);
 for(const name of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort())f.sqlite.exec(readFileSync('migrations/'+name,'utf8'));
 f.sqlite.prepare('INSERT INTO publishers(id,name,domain,gam_path) VALUES(?,?,?,?)').run(site,'Account fixture','account.example.invalid','/123/account/');
 f.sqlite.prepare('INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES(?,?,?)').run('review-config',site,JSON.stringify({enablePrebid:true,builtinRuntimeSelection:{runtime:{runtimeId:'tessera-3.22.1',runtimeVersion:'3.22.1'}}}));
 f.sqlite.prepare('INSERT INTO ad_units(id,publisher_id,code,type,size_map_key) VALUES(?,?,?,?,?)').run('review-unit',site,'P1','BTF','display');
 return f;
}
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
async function value(response,status=200){const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;}
async function create(f,input){return(await value(await createBidder(request(input),f.env,site),201)).bidder;}
async function list(f){return(await value(await listBidders(f.env,site))).bidders;}
const custom={ver:'1.0',complete:1,nodes:[{asi:'agency-seller.example',sid:'agency-upstream-42',hp:1}]};

test('legacy row defaults and account metadata survive independent parameter edits',async()=>{
 const f=setup();f.sqlite.prepare('INSERT INTO bidders(id,publisher_id,bidder,params_json) VALUES(?,?,?,?)').run('legacy',site,'pubmatic','{"publisherId":"legacy"}');
 const legacy=(await list(f))[0];assert.equal(legacy.baseAdapter,'pubmatic');assert.equal(legacy.schain.mode,'inherit');
 const own=await create(f,{bidder:'adf_smn',baseAdapter:'adf',displayName:'SMN Adform',params:{mid:111},schain:{mode:'inherit'}});
 const agency=await create(f,{bidder:'adf_ag',baseAdapter:'adf',displayName:'Agency Adform',params:{mid:222},schain:{mode:'none'}});
 await value(await updateBidder(request({params:{mid:223},expectedUpdatedAt:agency.updatedAt}),f.env,site,agency.id));
 const rows=await list(f),saved=rows.find(row=>row.id===agency.id);
 assert.equal(saved.baseAdapter,'adf');assert.equal(saved.displayName,'Agency Adform');assert.deepEqual(saved.schain,{mode:'none'});assert.deepEqual(saved.params,{mid:223});
 assert.deepEqual(rows.find(row=>row.id===own.id).params,{mid:111});assert.equal(rows.find(row=>row.id===own.id).schain.mode,'inherit');
});

test('duplicate preserves account chain and independent override identities',async()=>{
 const f=setup(),source=await create(f,{bidder:'adf_ag',baseAdapter:'adf',params:{mid:222},schain:{mode:'custom',config:custom}});
 await value(await createBidderOverride(request({scopeType:'adunit',scopeKey:'P1',params:{mid:224}}),f.env,site,source.id),201);
 const copy=(await value(await duplicateBidder(request({bidder:'adf_ag2',copyOverrides:true}),f.env,site,source.id),201)).bidder;
 assert.equal(copy.baseAdapter,'adf');assert.deepEqual(copy.schain,{mode:'custom',config:custom});assert.deepEqual(copy.params,{mid:222});assert.equal(copy.overrides.length,1);assert.equal(copy.overrides[0].bidder,'adf_ag2');
 const saved=(await list(f)).find(row=>row.id===source.id);assert.notEqual(copy.overrides[0].id,saved.overrides[0].id);
 await value(await updateBidder(request({schain:{mode:'none'},params:{mid:333},expectedUpdatedAt:copy.updatedAt}),f.env,site,copy.id));
 const originals=(await list(f)).find(row=>row.id===source.id);assert.deepEqual(originals.schain,{mode:'custom',config:custom});assert.deepEqual(originals.params,{mid:222});
});

test('stale edit cannot restore site chain after another tab selected no upstream chain',async()=>{
 const f=setup();await create(f,{bidder:'adf_ag',baseAdapter:'adf',params:{mid:222},schain:{mode:'inherit'}});
 f.sqlite.prepare('UPDATE bidders SET updated_at=? WHERE publisher_id=?').run('2000-01-01T00:00:00.000Z',site);
 const account=(await list(f))[0];
 await value(await updateBidder(request({schain:{mode:'none'},expectedUpdatedAt:account.updatedAt}),f.env,site,account.id));
 const response=await updateBidder(request({bidder:account.bidder,baseAdapter:account.baseAdapter,params:{mid:223},schain:account.schain,expectedUpdatedAt:account.updatedAt}),f.env,site,account.id);
 const body=await response.json();assert.equal(response.status,409,JSON.stringify(body));
 assert.equal((await list(f)).find(row=>row.id===account.id).schain.mode,'none');
});

test('invalid chain and reserved alias input makes no partial writes',async()=>{
 const f=setup(),before=await list(f);
 for(const input of [
  {bidder:'constructor',baseAdapter:'adf',schain:{mode:'none'}},
  {bidder:'prototype',baseAdapter:'adf',schain:{mode:'none'}},
  {bidder:'adf_bad',baseAdapter:'adf',schain:{mode:'custom',config:{ver:'1.0',complete:1,nodes:[]}}},
  {bidder:'adf_bad',baseAdapter:'adf',schain:{mode:'custom',config:{ver:'1.0',complete:1,nodes:[{asi:'https://seller.example',sid:'x',hp:1}]}}},
  {bidder:'adf_bad',baseAdapter:'adf',schain:{mode:'custom',config:{ver:'1.0',complete:1,nodes:[{asi:'seller.example',sid:'x',hp:0}]}}},
 ]){
  const response=await createBidder(request({...input,params:{mid:222}}),f.env,site);const body=await response.text();assert.equal(response.status,422,body);assert.deepEqual(await list(f),before);
 }
});

test('rejected same-timestamp concurrent rename cannot detach overrides from the saved account',async()=>{
 const f=setup(),account=await create(f,{bidder:'adf_ag',baseAdapter:'adf',params:{mid:222},schain:{mode:'inherit'}});
 await value(await createBidderOverride(request({scopeType:'adunit',scopeKey:'P1',params:{mid:224}}),f.env,site,account.id),201);
 const batch=f.env.DB.batch;
 f.env.DB.batch=async statements=>{
  f.env.DB.batch=batch;
  const update=statements.find(statement=>/^UPDATE bidders\s+SET bidder/.test(statement.sql.trim()));
  assert(update,'Account save must update its bidder row');
  // Another tab commits a different change in the same millisecond between read and batch.
  const timestamp=update.args[4];
  f.sqlite.prepare('UPDATE bidders SET account_json=?,updated_at=? WHERE id=?').run(JSON.stringify({bidder:'adf_ag',baseAdapter:'adf',displayName:'',schain:{mode:'none'}}),timestamp,account.id);
  return batch.call(f.env.DB,statements);
 };
 const response=await updateBidder(request({bidder:'adf_ag2',expectedUpdatedAt:account.updatedAt}),f.env,site,account.id);
 assert.equal(response.status,409,await response.text());
 const rows=await list(f),saved=rows.find(row=>row.id===account.id);
 assert.equal(saved.bidder,'adf_ag');assert.equal(saved.schain.mode,'none');assert.equal(saved.overrides.length,1,'Losing rename must not detach the saved override');
 assert.equal(f.sqlite.prepare('SELECT bidder FROM bidder_overrides WHERE publisher_id=?').get(site).bidder,'adf_ag');
});

test('build planner requires the original adapter once for distinct active accounts',async()=>{
 const f=setup();
 await create(f,{bidder:'adf_smn',baseAdapter:'adf',params:{mid:111},schain:{mode:'inherit'}});
 await create(f,{bidder:'adf_ag',baseAdapter:'adf',params:{mid:222},schain:{mode:'none'}});
 await create(f,{bidder:'ix_disabled',baseAdapter:'ix',params:{siteId:333},enabled:false,schain:{mode:'custom',config:custom}});
 const result=await value(await listPrebidBuilds(f.env,site));assert.deepEqual(result.requiredAdapters,['adfBidAdapter']);
});

test('site duplication preserves independent account paths and creates new override identities',async()=>{
 const f=setup();
 const agency=await create(f,{bidder:'adf_ag',baseAdapter:'adf',displayName:'Agency',params:{mid:222},schain:{mode:'none'}});
 await create(f,{bidder:'adf_smn',baseAdapter:'adf',displayName:'SMN',params:{mid:111},schain:{mode:'custom',config:custom}});
 await value(await createBidderOverride(request({scopeType:'adunit',scopeKey:'P1',params:{mid:224}}),f.env,site,agency.id),201);
 const before=await list(f);f.objects.set('existing-saved-zip',new Uint8Array([1,9,1]));
 await value(await duplicateSite(request({id:'account-review-copy',publisherAccountId:'politika-media',name:'Account copy',domain:'copy.example.invalid',gamPath:'/123/copy/',copyPrebidBuild:false}),f.env,site),201);
 const copies=(await value(await listBidders(f.env,'account-review-copy'))).bidders;
 assert.equal(copies.length,2);
 for(const original of before){const copied=copies.find(row=>row.bidder===original.bidder);assert.notEqual(copied.id,original.id);for(const field of ['baseAdapter','displayName','params','schain','enabled'])assert.deepEqual(copied[field],original[field]);}
 assert.notEqual(copies.find(row=>row.bidder==='adf_ag').overrides[0].id,before.find(row=>row.bidder==='adf_ag').overrides[0].id);
 assert.deepEqual(await list(f),before);assert.deepEqual([...f.objects],[['existing-saved-zip',new Uint8Array([1,9,1])]]);
});

const csvCell=value=>'"'+String(value).replaceAll('"','""')+'"';
test('CSV account import roundtrips metadata and params-only update preserves its selling path',async()=>{
 const f=setup();
 const csv=['bidder,baseAdapter,displayName,schainJson,paramsJson,enabled',['adf_ag','adf','Agency',JSON.stringify({mode:'custom',config:custom}),JSON.stringify({mid:222}),'true'].map(csvCell).join(',')].join('\n');
 await value(await applyCsvImport(request({kind:'bidders',csv}),f.env,site));
 const first=(await list(f))[0];assert.equal(first.baseAdapter,'adf');assert.deepEqual(first.schain,{mode:'custom',config:custom});
 await value(await applyCsvImport(request({kind:'bidders',csv:'bidder,paramsJson,enabled\nadf_ag,'+csvCell('{"mid":333}')+',false'}),f.env,site));
 const saved=(await list(f))[0];assert.equal(saved.baseAdapter,'adf');assert.equal(saved.displayName,'Agency');assert.deepEqual(saved.schain,first.schain);assert.deepEqual(saved.params,{mid:333});assert.equal(saved.enabled,false);
});

test('label-only CSV import cannot restore the site chain after a concurrent account change',async()=>{
 const f=setup(),account=await create(f,{bidder:'adf_ag',baseAdapter:'adf',params:{mid:222},schain:{mode:'inherit'}});
 const batch=f.env.DB.batch;
 f.env.DB.batch=async statements=>{
  f.env.DB.batch=batch;
  f.sqlite.prepare('UPDATE bidders SET account_json=?,updated_at=? WHERE id=?').run(JSON.stringify({bidder:'adf_ag',baseAdapter:'adf',displayName:'Agency',schain:{mode:'none'}}),'2099-01-01T00:00:00.000Z',account.id);
  return batch.call(f.env.DB,statements);
 };
 const response=await applyCsvImport(request({kind:'bidders',csv:'bidder,displayName,paramsJson\nadf_ag,Agency renamed,'+csvCell('{"mid":222}')}),f.env,site);
 assert([200,409].includes(response.status),await response.text());
 const saved=(await list(f))[0];assert.equal(saved.schain.mode,'none','A label-only import must not replace the current selling path');assert.equal(saved.baseAdapter,'adf');
});
