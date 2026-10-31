import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {outstreamContext,normalizeOutstream,buildOutstreamInput} from '../../shared/outstream/settings-v2.mjs';
import {buildOutstreamInput as inputV1} from '../../shared/outstream/settings.mjs';
import {workspaceStore} from '../support/test-workspace-store.mjs';
import {initializeRevenueWorkspace,revenueJson,revenueRequest,revenueOutstream} from '../support/revenue-workspace-fixture.mjs';
import {runtimeCatalog,previewInput} from '../../worker/test-workspace/runtime-catalog.mjs';
import {readPreviewSnapshot} from '../../worker/runtime/builtin-preview-service.mjs';
const video=revenueOutstream.units.Billboard;
function snapshot(runtime,code='Billboard'){
  return {config:{config_json:JSON.stringify({enablePrebid:true,runtimeControls:runtime})},
    units:[{code,enabled:1,media_type:'banner',type:'BTF',size_map_key:'display'}],
    maps:[{name:'display',map_json:JSON.stringify([{viewport:[0,0],sizes:[[300,250]]}])}],
    bidders:[{bidder:'pubmatic',enabled:1}],prebidBuilds:[{version:'11.34.0',modules_json:'["pubmaticBidAdapter"]'}]};
}
test('Standard positions coexist with global TakeOver; frozen preview.1 retains its behavior',()=>{
  const s=snapshot({takeOver:{enabled:true,adUnitCode:'Overlay'},outstream:revenueOutstream});
  assert.deepEqual(buildOutstreamInput(s).disabledRefreshCodes,['Billboard']);
  assert.throws(()=>inputV1(s),/sticky or TakeOver/);
});
test('explicit Sticky OFF permits the same code; implicit or actual Sticky and TakeOver reject precisely',()=>{
  const value=code=>({schemaVersion:1,units:{[code]:video}});
  assert.deepEqual(normalizeOutstream(value('Sticky'),outstreamContext(snapshot({sticky:{bottomAdUnitId:''}},'Sticky'))),value('Sticky'));
  for(const [runtime,code,reason] of [
    [{},'Sticky','bottom Sticky'],
    [{sticky:{bottomAdUnitId:'Billboard'}},'Billboard','bottom Sticky'],
    [{sticky:{topAdUnitId:'Billboard'}},'Billboard','top Sticky'],
    [{adPositions:{Billboard:{}}},'Billboard','TakeOver'],
    [{takeOver:{enabled:true,adUnitCode:'Billboard'}},'Billboard','legacy TakeOver'],
    [{takeOver:{enabled:true}},'TakeOver','legacy TakeOver'],
    [{takeOver:{enabled:true,adUnitCode:'Overlay'}},'Interstitial','Interstitial fallback'],
  ])assert.throws(()=>normalizeOutstream(value(code),outstreamContext(snapshot(runtime,code))),new RegExp(reason));
  const s=snapshot({adPositions:{Overlay:{}}},'Interstitial');s.units.push({code:'Overlay',enabled:1});
  assert.throws(()=>normalizeOutstream(value('Interstitial'),outstreamContext(s)),/Interstitial fallback/);
  assert.deepEqual(normalizeOutstream(value('Billboard'),outstreamContext(snapshot({takeOver:{enabled:false,adUnitCode:'Billboard'}}))),value('Billboard'));
});
const active=[];test.before(()=>{globalThis.fetch=()=>assert.fail('No external demand');});test.afterEach(()=>{while(active.length)active.pop().close();});
async function ready(runtimeId='tessera-revenue-preview-2'){
  const f=workspaceStore({prebidFiles:true});active.push(f);
  Object.assign(f,await initializeRevenueWorkspace(f,{runtimeId,legacyTakeOver:true}));
  f.json=(path,body)=>revenueJson(f,f.cookie,path,body);
  f.request=(path,body)=>revenueRequest(f,f.cookie,path,body);
  return f;
}
test('actual HTTP save/reload, unrelated edits and generate/save/reopen/download retain Standard video plus TakeOver',async()=>{
  const f=await ready(),selection=await f.json('/test-api/runtime-selection');
  const before=await f.json('/test-api/outstream-settings');
  await f.json('/test-api/outstream-settings',{revision:before.revision,outstream:revenueOutstream});
  assert.deepEqual((await f.json('/test-api/outstream-settings')).outstream,revenueOutstream);
  const site=await f.json('/test-api/site-settings');site.draft.site.name='Standard with separate TakeOver';
  await f.json('/test-api/site-settings',{expectedRevision:site.revision,acknowledge:true,draft:site.draft});
  const pb=await f.json('/test-api/prebid-settings');
  await f.json('/test-api/prebid-settings',{expectedRevision:pb.revision,acknowledge:true,draft:pb.draft});
  assert.deepEqual((await f.json('/test-api/runtime-selection')).selected,selection.selected);
  const generated=await f.json('/test-api/generate',{acknowledge:true});
  const saved=await f.json('/test-api/save',{acknowledge:true,receipt:generated.receipt,note:'Synthetic position scope'});
  const opened=await f.json('/test-api/releases/'+saved.draft.id);assert.equal(opened.verified,true);
  assert.equal(opened.draft.runtime.runtimeVersion,'3.16.0-revenue.preview.2');
  assert.equal(opened.draft.packageSha256,saved.draft.packageSha256);
  const download=await f.request('/test-api/releases/'+saved.draft.id+'/download');assert.equal(download.status,200,download.ok?'':await download.text());
  const files=unzipSync(new Uint8Array(await download.arrayBuffer()));
  const config=JSON.parse(new TextDecoder().decode(files['config.json']));
  assert.equal(config.options.takeOver.enabled,true);assert.equal(config.options.takeOver.adUnitCode,'TakeOver');
  assert.deepEqual(config.outstream.disabledRefreshCodes,['Billboard']);assert.deepEqual(config.outstream.units,revenueOutstream.units);
  assert(files['deals-plan.json']);
  const state=await f.json('/test-api/site-settings');state.draft.bottomStickyId='Billboard';state.draft.units.find(u=>u.code==='Billboard').display='sticky';
  const rejected=await f.request('/test-api/site-settings',{expectedRevision:state.revision,acknowledge:true,draft:state.draft});
  assert.equal(rejected.status,422);assert.match((await rejected.json()).error,/bottom Sticky/);
  assert.equal((await f.json('/test-api/site-settings')).revision,state.revision);
});
test('old selection explains explicit upgrade without saving or changing its pin',async()=>{
  const f=await ready('tessera-revenue-preview-1'),selection=await f.json('/test-api/runtime-selection');
  const before=await f.json('/test-api/outstream-settings');
  const rejected=await f.request('/test-api/outstream-settings',{revision:before.revision,outstream:revenueOutstream});
  assert.equal(rejected.status,422);assert.match((await rejected.json()).error,/Use current version.*Script version 3\.16\.0/);
  assert.deepEqual(await f.json('/test-api/outstream-settings'),before);
  assert.deepEqual((await f.json('/test-api/runtime-selection')).selected,selection.selected);
});
test('actual display change from Sticky to Standard clears the block through Save and generation',async()=>{
  const f=await ready();let site=await f.json('/test-api/site-settings');
  // Rename the ordinary fixture position to the legacy Sticky code without enabling sticky.
  const unit=site.draft.units.find(u=>u.code==='Billboard');unit.code='Sticky';unit.display='standard';site.draft.bottomStickyId='';
  site.draft.units=site.draft.units.filter(u=>u===unit||u.code!=='Sticky');
  await f.json('/test-api/site-settings',{expectedRevision:site.revision,acknowledge:true,draft:site.draft});
  const value={schemaVersion:1,units:{Sticky:video}},before=await f.json('/test-api/outstream-settings');
  await f.json('/test-api/outstream-settings',{revision:before.revision,outstream:value});
  const s=await readPreviewSnapshot(f.env.DB,'test-site',{includePrebid:true});
  const input=previewInput(s,runtimeCatalog.find(r=>r.id==='tessera-revenue-preview-2'),'20261011_220000');
  assert.equal(input.options.sticky.bottomAdUnitId,'');assert.deepEqual(input.outstream.disabledRefreshCodes,['Sticky']);
  const generated=await f.json('/test-api/generate',{acknowledge:true});assert.equal(generated.descriptor.runtime.runtimeVersion,'3.16.0-revenue.preview.2');
});
