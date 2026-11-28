import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {createBidderOverride,updateBidder} from '../../worker/bidders.ts';
import {updateAdUnit} from '../../worker/ad-units.ts';
import {siteRuntimeSettings,changeSiteRuntime} from '../../worker/site-runtime/service.mjs';
import {packageResponse,readPackage} from '../../worker/site-runtime/releases.mjs';
import {readPreviewSnapshot} from '../../worker/runtime/builtin-preview-service.mjs';
import {previewInput,runtimeCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';

const active=[];
test.before(()=>{globalThis.fetch=()=>assert.fail('No external requests in synthetic package QA');});
test.afterEach(()=>{while(active.length)active.pop().close();});
const req=(body,method='POST')=>new Request('https://qa.invalid/api/packages',{
  method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),
});
async function jsonResponse(response,status){
  const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;
}
async function fixture(){
  const f=adminAuditStore({config:{runtimeControls:{sticky:{bottomAdUnitId:''},floors:{enabled:false}}}});active.push(f);
  const key='publishers/audit-site/prebid-builds/audit-prebid/prebid.js';
  f.objects.set(key,f.objects.get('audit/prebid.js'));f.metadata.set(key,f.metadata.get('audit/prebid.js'));
  f.sqlite.prepare("UPDATE prebid_builds SET file_key=? WHERE publisher_id='audit-site'").run(key);
  f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key) VALUES('audit-second','audit-site','P2','BTF','display')").run();
  f.sqlite.prepare("UPDATE bidders SET params_json=? WHERE id='audit-bidder'").run(JSON.stringify({publisherId:'synthetic',adSlot:'base'}));
  const settings=await siteRuntimeSettings(f.env,'audit-site'),runtime=settings.runtimes.find(r=>r.version==='3.20.0');assert(runtime);
  await changeSiteRuntime(f.env,'audit-site','qa',{action:'version',revision:settings.revision,runtime:runtime.pin,allowPreview:true});
  await jsonResponse(await createBidderOverride(req({scopeType:'adunit',scopeKey:'P1',params:{adSlot:'p1-specific'}}),f.env,'audit-site','audit-bidder'),201);
  f.savedOverrides=()=>JSON.stringify(f.sqlite.prepare("SELECT * FROM bidder_overrides WHERE publisher_id='audit-site' ORDER BY id").all());
  f.package=body=>packageResponse(req(body,body===undefined?'GET':'POST'),f.env,'audit-site','qa');
  return f;
}
async function generateAndOpen(f,note){
  const state=await jsonResponse(await f.package(),200);assert.equal(state.ready,true,JSON.stringify(state));
  const configBefore=JSON.stringify(f.readConfig()),overridesBefore=f.savedOverrides();
  const saved=await jsonResponse(await f.package({action:'generate',revision:state.revision,notes:note}),201);
  const release=await readPackage(f.env,'audit-site',saved.release.id);
  assert.equal(release.manifest.runtime.runtimeVersion,'3.20.0');
  const download=await f.package({action:'download',releaseId:saved.release.id});assert.equal(download.status,200);
  const files=unzipSync(new Uint8Array(await download.arrayBuffer()));
  for(const name of ['ads.js','ads.min.js','config.json','prebid.js'])assert.deepEqual(files[name],release.files[name]);
  assert.equal(JSON.stringify(f.readConfig()),configBefore);assert.equal(f.savedOverrides(),overridesBefore);
  assert.equal(f.sqlite.prepare("SELECT current_release_id FROM publishers WHERE id='audit-site'").get().current_release_id,null);
  return {config:JSON.parse(new TextDecoder().decode(files['config.json'])),release};
}
for(const state of ['disabled','draft','disabled-bidder-and-unit'])test(`3.20 actual Generate/reopen/download retains ${state} override and restores it on reactivation`,async()=>{
  const f=await fixture();
  if(state==='disabled-bidder-and-unit')await jsonResponse(await updateBidder(req({enabled:false},'PATCH'),f.env,'audit-site','audit-bidder'),200);
  await jsonResponse(await updateAdUnit(req(state==='draft'?{type:'DRAFT'}:{enabled:false},'PATCH'),f.env,'audit-site','audit-unit'),200);
  const retained=f.savedOverrides(),inactive=await generateAndOpen(f,'Inactive position QA');
  assert.deepEqual(inactive.config.core.explicitUnits.map(u=>u.id),['P2']);
  assert.equal(inactive.config.core.bidderAdUnitParams.pubmatic?.P1,undefined);
  assert.equal(f.savedOverrides(),retained);

  if(state==='disabled-bidder-and-unit')await jsonResponse(await updateBidder(req({enabled:true},'PATCH'),f.env,'audit-site','audit-bidder'),200);
  await jsonResponse(await updateAdUnit(req(state==='draft'?{type:'BTF'}:{enabled:true},'PATCH'),f.env,'audit-site','audit-unit'),200);
  const active=await generateAndOpen(f,'Reactivated position QA');
  assert.deepEqual(active.config.core.explicitUnits.map(u=>u.id),['P1','P2']);
  assert.deepEqual(active.config.core.bidderAdUnitParams.pubmatic.P1,{adSlot:'p1-specific'});
  assert.notEqual(active.release.release.id,inactive.release.release.id);
  assert.deepEqual((await readPackage(f.env,'audit-site',inactive.release.release.id)).files,inactive.release.files,'Previously generated package stays immutable');
});
test('3.20 still rejects a genuinely missing override target before artifact or release writes',async()=>{
  const f=await fixture();
  // Simulate imported/legacy corruption. Public create correctly requires an existing target.
  f.sqlite.prepare("UPDATE bidder_overrides SET scope_key='Missing' WHERE publisher_id='audit-site'").run();
  const configBefore=JSON.stringify(f.readConfig()),overridesBefore=f.savedOverrides(),puts=f.log.puts.length;
  const snapshot=await readPreviewSnapshot(f.env.DB,'audit-site');
  assert.throws(()=>previewInput(snapshot,runtimeCatalog.find(r=>r.version==='3.20.0'),'20261109_210000'),/missing unit Missing/);
  const state=await jsonResponse(await f.package(),200);assert.equal(state.ready,false);assert.match(state.error,/settings are not supported|missing unit Missing/);
  const result=await jsonResponse(await f.package({action:'generate',revision:state.revision,notes:'Invalid target QA'}),422);assert.match(result.error,/settings are not supported|missing unit Missing/);
  assert.equal(f.log.puts.length,puts);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM releases WHERE publisher_id='audit-site'").get().n,0);
  assert.equal(JSON.stringify(f.readConfig()),configBefore);assert.equal(f.savedOverrides(),overridesBefore);
});
