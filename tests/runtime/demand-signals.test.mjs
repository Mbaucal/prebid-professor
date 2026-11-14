import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from 'acorn';
import {readFileSync} from 'node:fs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {previewInput,normalizeGpid} from '../../worker/runtime-demand-v1/snapshot.mjs';
import {prebidRequirements} from '../../worker/runtime-demand-v1/requirements.mjs';
import {tesseraDemandUnit} from '../../worker/runtime-demand-v1/browser-demand.mjs';
import {compileDemand} from '../../worker/runtime-demand-v1/compiler.mjs';
import {compileReporting} from '../../worker/runtime-reporting-v1/compiler.mjs';
import {buildArtifactCandidate} from '../../worker/runtime-demand-v1/artifact-candidate.mjs';
import {inspectPrebidArtifact,sha256} from '../../worker/runtime/prebid-artifact-check.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {describeCandidate} from '../../worker/runtime/draft-release-store.mjs';
import {descriptor} from '../../.generated/runtime-demand-manifest.mjs';
import {demandInspectCommand} from '../../src/debug/demand-inspect.mjs';
const stamp='20260923_230000';
const input=(s=positionFixture())=>previewInput(s,descriptor,stamp);
const configure=(s,fn)=>{const c=JSON.parse(s.config.config_json);fn(c);s.config.config_json=JSON.stringify(c);return s;};

test('GPID is deterministic across generation, device, refresh and variant; complete MCM path retained',()=>{
 const s=positionFixture();s.site.gam_path='/123,456/example/';const before=JSON.stringify(s);
 const a=input(s).demandSignals;
 configure(s,c=>{c.Variant='B';});
 const b=previewInput(s,descriptor,'20260924_000000').demandSignals;
 assert.deepEqual(a,b);assert.equal(a.placements.Billboard.gpid,'/123,456/example/Billboard#Billboard');
 assert.notEqual(a.placements.Billboard.gpid,a.placements.P1.gpid);
 assert.equal(input(JSON.parse(before)).demandSignals.placements.Overlay.adslot,'/123,456/example/Overlay');
});
test('saved overrides round-trip, empty uses automatic; duplicate or invalid IDs are rejected',()=>{
 const s=configure(positionFixture(),c=>c.runtimeControls.demandSignals={gpidOverrides:{Billboard:'publisher/position-1',P1:''}});
 assert.equal(input(s).demandSignals.placements.Billboard.gpid,'publisher/position-1');
 assert.equal(input(s).demandSignals.placements.P1.gpid,'/123/test/P1#P1');
 configure(s,c=>c.runtimeControls.demandSignals.gpidOverrides.P1='publisher/position-1');
 assert.throws(()=>input(s),/distinct GPID/);
 for(const v of [null,[],{},'has space','x'.repeat(513),'line\nbreak'])assert.throws(()=>normalizeGpid(v));
});
test('enrichment preserves explicit GPID, schain, contextual data and bidder params without alias dependence',()=>{
 const nested={gpid:'publisher-explicit',data:{category:'news',adserver:{custom:true}},other:{value:1}};
 const u={code:'A',ortb2Imp:{instl:0,ext:nested},bids:[{bidder:'alias',params:{id:42}}]};
 const original=structuredClone(u);tesseraDemandUnit(u,{A:{gpid:'auto',adslot:'/123/shared'}});
 assert.equal(u.ortb2Imp.ext.gpid,'publisher-explicit');assert.equal(u.ortb2Imp.ext.data.category,'news');
 assert.deepEqual(u.ortb2Imp.ext.data.adserver,{custom:true,name:'gam',adslot:'/123/shared'});
 assert.deepEqual(nested,original.ortb2Imp.ext);assert.deepEqual(u.bids,original.bids);assert.equal(u.ortb2Imp.instl,0);
 const second=tesseraDemandUnit({code:'B'},{B:{gpid:'/123/shared#B',adslot:'/123/shared'}});
 assert.notEqual(second.ortb2Imp.ext.gpid,u.ortb2Imp.ext.gpid);
});
test('module requirement is scoped to the new Prebid runtime, preserves identity/schain; GAM-only has none',()=>{
 const i=input();i.core.userSync={userIds:[{name:'id5Id'}]};i.options.schain={nodes:[{}]};
 const r=prebidRequirements(i);assert(r.modules.includes('gptPreAuction'));assert(r.modules.includes('id5IdSystem'));assert(r.modules.includes('schain'));
 const old={...i};delete old.demandSignals;assert(!prebidRequirements(old).modules.includes('gptPreAuction'));
 assert.deepEqual(prebidRequirements(input(positionFixture(false))),{required:false,modules:[],issues:[]});
 i.core.bidders=[{bidder:'rubicon',params:{accountId:1,siteId:2,zoneId:3}}];assert.deepEqual(prebidRequirements(i).issues,[]);assert(prebidRequirements(i).modules.includes('rubiconBidAdapter'));
});
test('a stored build without GPID support is blocked by the normal byte-verification flow',async()=>{
 const bytes=new TextEncoder().encode('/* prebid.js v11.34.0\nModules: consentManagementTcf, pubmaticBidAdapter, tcfControl */');
 const report=await inspectPrebidArtifact({siteId:'test-site',requirements:prebidRequirements(input()),builds:[{id:'pb',publisher_id:'test-site',status:'current',version:'11.34.0',modules_json:JSON.stringify(['consentManagementTcf','pubmaticBidAdapter','tcfControl']),file_key:'publishers/test-site/prebid-builds/pb/prebid.js'}]},
 {get:async()=>({size:bytes.length,customMetadata:{sha256:await sha256(bytes)},arrayBuffer:async()=>bytes.buffer})});
 assert.equal(report.status,'blocked');assert.deepEqual(report.missingModules,['gptPreAuction']);
});
test('new compiler changes the intended config once; archived engine output stays byte-identical',()=>{
 const i=input(),old=compileReporting(i).adsJs,source=compileDemand(i).adsJs;
 assert.match(source,/enableSendAllBids: true/);assert.match(source,/alwaysIncludeDeals: true/);
 assert.match(source,/return tesseraDemandUnit\(unit,TESSERA_PLACEMENTS\)/);
 assert.equal(compileReporting(i).adsJs,old);assert.match(old,/enableSendAllBids: false/);
 const gam=input(positionFixture(false));assert.equal(compileDemand(gam).adsJs,compileReporting(gam).adsJs);assert.equal(gam.demandSignals,null);
});
test('actual generated targeting functions retain all bidder maps and clear stale bidder/deal keys',()=>{
 const source=compileDemand(input()).adsJs,names=['applyTargetingMapToSlot','clearPrebidTargetingFromSlot','applyPrebidTargetingToSlots'];const fns=[];
 function visit(n){if(!n||typeof n!=='object')return;if(n.type==='FunctionDeclaration'&&names.includes(n.id.name))fns.push(source.slice(n.start,n.end));for(const v of Object.values(n))if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')visit(v);}
 visit(parse(source,{ecmaVersion:'latest'}));assert.equal(fns.length,3);
 const targeting={Variant:'B',refresh_bucket:'r1_3',hb_pb_old:'9.00',hb_deal_old:'expired'};
 const slot={getConfig:()=>({targeting}),getTargetingKeys:()=>Object.keys(targeting),clearTargeting:k=>delete targeting[k],setConfig:({targeting:t})=>Object.assign(targeting,t)};
 let result={hb_pb:'1.20',hb_adid:'a',hb_pb_pubmatic:'1.20',hb_adid_pubmatic:'a',hb_pb_openx:'0.95',hb_deal_openx:'deal',hb_adid_openx:'b',hb_pb_ix:'0.80',hb_adid_ix:'c'};
 const ctx=vm.createContext({window:{adSlots:{Billboard:slot}},pbjs:{getAdserverTargetingForAdUnitCode:()=>result}});
 vm.runInContext(fns.join('\n')+'\napplyPrebidTargetingToSlots(["Billboard"]);',ctx);
 assert.deepEqual(targeting,{Variant:'B',refresh_bucket:'r1_3',...result});
 result={};vm.runInContext('applyPrebidTargetingToSlots(["Billboard"]);',ctx);assert.deepEqual(targeting,{Variant:'B',refresh_bucket:'r1_3'});
});
test('package exposes exact GPIDs, targeting contract and checked module; works with immutable storage validation',async()=>{
 const s=positionFixture(),requirements=prebidRequirements(input(s));
 const bytes=new TextEncoder().encode(`/* prebid.js v11.34.0\nModules: ${requirements.modules.join(',')} */`);
 const prebid={bytes:bytes.buffer,report:{status:'checked',siteId:'test-site',requiredModules:requirements.modules,declaredModules:requirements.modules,build:{id:'fixture',version:'11.34.0',sha256:await sha256(bytes),byteSize:bytes.length}}};
 const result=await buildArtifactCandidate({snapshot:s,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:stamp,prebid});
 const c=JSON.parse(new TextDecoder().decode(result.files['config.json'])),r=JSON.parse(new TextDecoder().decode(result.files['gam-reporting.json']));
 assert.deepEqual(c.demandSignals,input(s).demandSignals);assert(r.prebid.enableSendAllBids);assert.equal(r.prebid.bidders[0].keys[0].key,'hb_pb_pubmatic');
 assert.equal((await describeCandidate('test-site',result)).descriptor.runtime.runtimeVersion,'3.15.0');
 const gam=await buildArtifactCandidate({snapshot:positionFixture(false),pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:stamp});
 assert(!gam.files['prebid.js']);assert.equal(JSON.parse(new TextDecoder().decode(gam.files['config.json'])).demandSignals,null);
});
test('GPID Debug reads only metadata, includes latest bidder request, and never exposes identity values',()=>{
 const logs=[];const args={bidderCode:'partner',auctionId:'auction',bids:[{adUnitCode:'P1',userId:{id5id:'SECRET'},ortb2Imp:{ext:{gpid:'position',data:{adserver:{adslot:'/123/P1'}}}}}]};
 vm.runInNewContext(demandInspectCommand,{window:{pbjs:{getConfig:()=>true,getEvents:()=>[{eventType:'bidRequested',args}]}},console:{info:x=>logs.push(x),table:x=>logs.push(x)}});
 assert(JSON.stringify(logs).includes('position'));assert(!JSON.stringify(logs).includes('SECRET'));
});

test('complete generated script retains MCM GPT path for Prebid and GAM-only, while invalid paths stay rejected',()=>{
 for(const enabled of [true,false]){
  const s=positionFixture(enabled);s.site.gam_path='/123,456/example/';
  const source=compileDemand(input(s)).adsJs;
  assert.match(source,/var adUnitPath = "\/123,456\/example\/"/);
  assert.doesNotMatch(source,/\/123_456\/example\//);
 }
 for(const bad of ['/123,456//example/','/123,456/../example/','/123,bad/example/']){
  const s=positionFixture();s.site.gam_path=bad;
  assert.throws(()=>compileDemand(input(s)),/GAM path/);
 }
});
