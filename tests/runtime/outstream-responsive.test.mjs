import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {normalizeOutstream,buildOutstreamInput,playerSizeMaps} from '../../shared/outstream/settings-v3.mjs';
import {normalizeOutstream as normalizeSelected,outstreamContext} from '../../shared/outstream/selected-settings.mjs';
import {outstreamPlayerSize,applyOutstreamUnit,installOutstreamRenderGuard} from '../../worker/runtime-outstream-v2/browser-functions.mjs';
import {assertRevenueDraftPreserved} from '../../worker/test-workspace/revenue-draft-guard.mjs';
import {workspaceStore} from '../support/test-workspace-store.mjs';
import {initializeRevenueWorkspace,revenueJson,revenueRequest,revenueOutstream} from '../support/revenue-workspace-fixture.mjs';
const fixed=revenueOutstream.units.Billboard;
const {playerSize,...common}=fixed;
const responsive={...common,playerSizing:'size-map',playerSizes:{}};
const rows=[{viewport:[0,0],sizes:[[300,250]]},{viewport:[768,0],sizes:[[728,90],[640,360]]},{viewport:[1600,0],sizes:[]}];
const context=()=>({units:[{code:'Billboard',media_type:'banner',type:'BTF',enabled:1,size_map_key:'display'}],maps:[{name:'display',map_json:JSON.stringify(rows)}],bidders:[{bidder:'pubmatic',enabled:1}],enablePrebid:true,prebidVersion:'11.34.0',modules:['pubmaticBidAdapter']});
const value=setting=>({schemaVersion:1,units:{Billboard:structuredClone(setting)}});
function snapshot(setting=responsive){const ctx=context();return {...ctx,prebidBuilds:[{version:'11.34.0',modules_json:'["pubmaticBidAdapter"]'}],config:{config_json:JSON.stringify({enablePrebid:true,runtimeControls:{outstream:value(setting)}})}};}

test('responsive intent derives sole eligible map sizes and freezes resolved snapshot without changing banners',()=>{
 const ctx=context(),before=structuredClone(ctx),normalized=normalizeOutstream(value(responsive),ctx);
 assert.deepEqual(normalized,value(responsive));assert.deepEqual(ctx,before);
 const built=buildOutstreamInput(snapshot());
 assert.deepEqual(built.units.Billboard.playerSizeMaps,[{name:'display',rows:[{viewport:[0,0],playerSize:[300,250]},{viewport:[768,0],playerSize:[640,360]},{viewport:[1600,0],playerSize:null}]}]);
 assert.deepEqual(built.disabledRefreshCodes,['Billboard']);
});
test('multiple eligible dimensions require an explicit map choice; stale choices are actionable',()=>{
 const ctx=context(),map=structuredClone(rows);map[1].sizes.push([800,450]);ctx.maps[0].map_json=JSON.stringify(map);
 assert.throws(()=>normalizeOutstream(value(responsive),ctx),/minimum width 768px: choose/);
 const settings={...responsive,playerSizes:{'display@768x0':[800,450]}};
 assert.deepEqual(normalizeOutstream(value(settings),ctx),value(settings));
 assert.throws(()=>normalizeOutstream(value({...settings,playerSizes:{'display@768x0':[728,90]}}),ctx),/no longer in this map/);
 assert.throws(()=>normalizeOutstream(value({...settings,playerSizes:{...settings.playerSizes,'removed@0x0':[300,250]}}),ctx),/breakpoints changed/);
});
test('fluid and thin banner-only breakpoints give actionable errors; an empty row stays disabled',()=>{
 for(const sizes of [['fluid'],[[728,90]],[[728,100]]]){const ctx=context();ctx.maps[0].map_json=JSON.stringify([{viewport:[0,0],sizes}]);assert.throws(()=>normalizeOutstream(value(responsive),ctx),/no supported video size.*144 and 1920px.*728×90 and fluid/);}
 const ctx=context();ctx.maps[0].map_json=JSON.stringify([{viewport:[0,0],sizes:[]}]);assert.throws(()=>normalizeOutstream(value(responsive),ctx),/enable at least one/);
});
test('page-type maps are independently resolved and exposed for operator choices',()=>{
 const ctx=context();ctx.maps.push({name:'article_display',map_json:JSON.stringify([{viewport:[0,0],sizes:[[320,180]]}])});
 assert.equal(playerSizeMaps('Billboard',ctx)[1].rows[0].key,'article_display@0x0');
 const s=snapshot();s.maps=ctx.maps;assert.deepEqual(buildOutstreamInput(s).units.Billboard.playerSizeMaps[1].rows[0].playerSize,[320,180]);
});
test('old fixed intent and old pins remain fixed; new intent needs the explicit new version',()=>{
 const ctx=context();ctx.maps[0].map_json=JSON.stringify([{viewport:[0,0],sizes:[[300,250]]}]);
 assert.deepEqual(normalizeOutstream(value(fixed),ctx),value(fixed));
 const s=snapshot(),config=JSON.parse(s.config.config_json);config.builtinRuntimeSelection={runtime:{runtimeId:'tessera-revenue-preview-2',runtimeVersion:'3.16.0-revenue.preview.2'}};s.config.config_json=JSON.stringify(config);
 assert.throws(()=>normalizeSelected(value(responsive),outstreamContext(s)),/Script version 3\.16\.0.*Use current version/);
});
test('active viewport chooses concrete video size, preserves banner params and disables empty rows',()=>{
 const settings=buildOutstreamInput(snapshot()).units.Billboard;
 const unit={code:'Billboard',mediaTypes:{banner:{sizes:[[728,90],[640,360]]}},bids:[{bidder:'pubmatic',params:{publisherId:'1',adSlot:'banner'}},{bidder:'teads',params:{placementId:123}}]};
 const before=structuredClone(unit),old=globalThis.window;globalThis.window={innerWidth:390,innerHeight:844};
 try{
  assert.deepEqual(outstreamPlayerSize(settings,'display'),[300,250]);
  window.innerWidth=1440;const result=applyOutstreamUnit(unit,settings,'display');
  assert.deepEqual(result.mediaTypes.video.playerSize,[[640,360]]);assert.deepEqual(result.mediaTypes.banner,unit.mediaTypes.banner);
  assert.deepEqual(result.bids[1],{...unit.bids[1],mediaTypes:{banner:unit.mediaTypes.banner}});assert.equal(result.bids[0].params.adSlot,'banner');assert.deepEqual(unit,before);
  window.innerWidth=1920;assert.equal(applyOutstreamUnit(unit,settings,'display'),null);
 }finally{globalThis.window=old;}
});
test('native queued renderer cannot execute after its active dimensions change',()=>{
 let listener,queued,plays=0,size=[300,250];const pb={onEvent:(_,fn)=>listener=fn,offEvent(){},renderAd(){queued?.();},getBidResponses:()=>({})};
 installOutstreamRenderGuard(pb,{codes:['Billboard'],consent:()=>({ready:true,epoch:1}),authorized:()=>true,sizeMatches:(_,bidSize)=>bidSize.every((n,i)=>n===size[i])});
 const bid={adId:'video',adUnitCode:'Billboard',mediaType:'video',width:300,height:250,ttl:30,responseTimestamp:Date.now(),renderer:{push(fn){queued=fn;}}};
 listener(bid);bid.renderer.push(()=>plays++);size=[640,360];pb.renderAd({},'video');queued();assert.equal(plays,0);
});

test('actual HTTP API saves/reopens responsive choices, preserves map edits and freezes package sizing',async()=>{
 const f=workspaceStore({prebidFiles:true});
 try{
  const {cookie}=await initializeRevenueWorkspace(f,{runtimeId:'tessera-revenue-preview-3'});
  const json=(path,body)=>revenueJson(f,cookie,path,body),request=(path,body)=>revenueRequest(f,cookie,path,body);
  let site=await json('/test-api/site-settings');const unit=site.draft.units.find(u=>u.code==='Billboard');
  const map=site.draft.maps.find(m=>m.name===unit.sizeMap);map.breakpoints=[{minWidth:0,sizes:[[300,250]]},{minWidth:768,sizes:[[728,90],[640,360]]},{minWidth:1600,sizes:[]}];
  await json('/test-api/site-settings',{expectedRevision:site.revision,acknowledge:true,draft:site.draft});
  const before=await json('/test-api/outstream-settings');assert.equal(before.responsiveSizing,true);assert.deepEqual(before.sizeMaps.Billboard.maps[0].rows[1].sizes,[[640,360]]);
  await json('/test-api/outstream-settings',{revision:before.revision,outstream:value(responsive)});
  assert.deepEqual((await json('/test-api/outstream-settings')).outstream,value(responsive));
  assert.equal((await request('/test-api/outstream-settings',{revision:before.revision,outstream:value(responsive)})).status,409);
  site=await json('/test-api/site-settings');site.draft.maps.find(m=>m.name===unit.sizeMap).breakpoints[1].sizes=[[728,90],[800,450]];
  await json('/test-api/site-settings',{expectedRevision:site.revision,acknowledge:true,draft:site.draft});
  const generated=await json('/test-api/generate',{acknowledge:true});const saved=await json('/test-api/save',{acknowledge:true,receipt:generated.receipt,note:'Responsive fixture'});
  const reopened=await json('/test-api/releases/'+saved.draft.id);assert.equal(reopened.verified,true);assert.equal(reopened.draft.runtime.runtimeVersion,'3.16.0-revenue.preview.3');
  const download=await request('/test-api/releases/'+saved.draft.id+'/download');assert.equal(download.status,200);
  const files=unzipSync(new Uint8Array(await download.arrayBuffer())),config=JSON.parse(new TextDecoder().decode(files['config.json']));
  assert.deepEqual(config.outstream.units.Billboard.playerSizes,{});assert.deepEqual(config.outstream.units.Billboard.playerSizeMaps[0].rows[1].playerSize,[800,450]);
  const frozen=saved.draft.packageSha256;
  site=await json('/test-api/site-settings');site.draft.maps.find(m=>m.name===unit.sizeMap).breakpoints[1].sizes.push([640,360]);
  const edited=await json('/test-api/site-settings',{expectedRevision:site.revision,acknowledge:true,draft:site.draft});
  assert.equal(edited.formatReviewRequired[0].code,'Billboard');assert.match(edited.formatReviewRequired[0].message,/choose one of the available video sizes/);
  assert.equal((await json('/test-api/site-settings')).formatReviewRequired.length,1);
  const blocked=await request('/test-api/generate',{acknowledge:true});assert.equal(blocked.status,422);assert.match((await blocked.json()).error,/choose one of the available video sizes/);
  const review=await json('/test-api/outstream-settings');assert.equal(review.formatReviewRequired.length,1);
  const mapKey=review.sizeMaps.Billboard.maps.find(m=>m.name===unit.sizeMap).rows.find(r=>r.viewport[0]===768).key;
  await json('/test-api/outstream-settings',{revision:review.revision,outstream:value({...responsive,playerSizes:{[mapKey]:[640,360]}})});
  assert.deepEqual((await json('/test-api/site-settings')).formatReviewRequired,[]);
  assert.equal((await json('/test-api/generate',{acknowledge:true})).descriptor.runtime.runtimeVersion,'3.16.0-revenue.preview.3');
  assert.equal((await json('/test-api/releases/'+saved.draft.id)).draft.packageSha256,frozen);
 }finally{f.close();}
});

test('map-review draft allowance never bypasses partner, display or later-unit checks',()=>{
 const before=snapshot(),config=JSON.parse(before.config.config_json);
 config.builtinRuntimeSelection={runtime:{runtimeId:'tessera-revenue-preview-3',runtimeVersion:'3.16.0-revenue.preview.3'}};
 config.runtimeControls.outstream.units.P1=structuredClone(responsive);
 before.units.push({...before.units[0],code:'P1'});before.config.config_json=JSON.stringify(config);
 function changed(){const after=structuredClone(before),map=JSON.parse(after.maps[0].map_json);map[1].sizes.push([800,450]);after.maps[0].map_json=JSON.stringify(map);return after;}
 assert.equal(assertRevenueDraftPreserved(before,changed(),{allowResponsiveMapReview:true}).length,2);
 const partner=changed();partner.bidders[0].enabled=0;
 assert.throws(()=>assertRevenueDraftPreserved(before,partner,{allowResponsiveMapReview:true}),/enable the verified PubMatic/);
 const display=changed(),next=JSON.parse(display.config.config_json);next.runtimeControls.sticky={topAdUnitId:'P1'};display.config.config_json=JSON.stringify(next);
 assert.throws(()=>assertRevenueDraftPreserved(before,display,{allowResponsiveMapReview:true}),/P1: this position is configured as top Sticky/);
 const disabled=changed();disabled.units[1].enabled=0;
 assert.throws(()=>assertRevenueDraftPreserved(before,disabled,{allowResponsiveMapReview:true}),/before renaming, disabling or changing/);
 assert.throws(()=>assertRevenueDraftPreserved(before,changed()),/choose one of the available video sizes/);
});
test('legacy minViewPort map form resolves with the same precedence as the runtime bridge',()=>{
 const ctx=context();ctx.maps[0].map_json=JSON.stringify([{minViewPort:[0,0],sizes:[[300,250]]}]);
 assert.deepEqual(playerSizeMaps('Billboard',ctx)[0].rows[0].viewport,[0,0]);
 assert.deepEqual(normalizeOutstream(value(responsive),ctx),value(responsive));
});

test('responsive pilot rejects height breakpoints and tied widths instead of mismatching native banner/video sizes',()=>{
 for(const map of [
  [{viewport:[0,700],sizes:[[640,360]]}],
  [{viewport:[0,0],sizes:[[300,250]]},{viewport:[0,700],sizes:[[640,360]]}],
 ]){
  const ctx=context();ctx.maps[0].map_json=JSON.stringify(map);
  assert.throws(()=>normalizeOutstream(value(responsive),ctx),/width breakpoints only.*minimum height to 0/);
  assert.throws(()=>playerSizeMaps('Billboard',ctx),/width breakpoints only/);
 }
 const ctx=context();ctx.maps[0].map_json=JSON.stringify([{viewport:[0,0],sizes:[[300,250]]},{viewport:[0,0],sizes:[[640,360]]}]);
 assert.throws(()=>normalizeOutstream(value(responsive),ctx),/duplicate breakpoint/);
 // No implicit migration or changed validation for the old fixed intent.
 ctx.maps[0].map_json=JSON.stringify([{viewport:[0,700],sizes:[[300,250]]}]);
 assert.deepEqual(normalizeOutstream(value(fixed),ctx),value(fixed));
});
