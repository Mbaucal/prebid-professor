import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {inspectIdentity,identityInspectCommand} from '../../src/debug/identity-inspect.mjs';

const eid=id=>[{source:'id5-sync.com',uids:[{id,atype:1,ext:{secret:'DO-NOT-EXPORT'}}]}];
const request=(auction,id,bidder='pubmatic')=>({eventType:'bidRequested',args:{auctionId:auction,bidderCode:bidder,secret:'DO-NOT-EXPORT',bids:[{adUnitCode:'P1',userIdAsEids:eid(id),userId:{raw:'DO-NOT-EXPORT'},ortb2:{user:{ext:{eids:eid(id)}}}}]}});
function fixture(){return {pbjs:{installedModules:['userId','id5IdSystem'],getConfig:()=>({auctionDelay:50,userIds:[{name:'id5Id',storage:{type:'html5',refreshInSeconds:28800},params:{pd:'DO-NOT-EXPORT',externalModuleUrl:'https://example.invalid/DO-NOT-EXPORT'}}]}),getUserIdsAsEids:()=>eid('DO-NOT-EXPORT'),getEvents:()=>[request('initial','0'),request('refresh','DO-NOT-EXPORT'),request('other','DO-NOT-EXPORT','ix')]}};}
test('current, first-retained and latest identity counts expose late arrival without leaking IDs',()=>{
 const r=inspectIdentity(fixture(),{bidder:'pubmatic'});
 assert.equal(r.current.sources[0].usableIds,1);
 assert.equal(r.firstRetainedRequests[0].eidMetadata.sources[0].usableIds,0);
 assert.equal(r.firstRetainedRequests[0].eidMetadata.sources[0].placeholderIds,1);
 assert.equal(r.latestRequests[0].eidMetadata.sources[0].usableIds,1);
 assert.equal(r.latestRequests[0].ortbMetadata.sources[0].usableIds,1);
 assert.equal(r.retainedRequestCount,2);assert.equal(r.modules[0].id5RefreshWarning,true);
 assert(!JSON.stringify(r).includes('DO-NOT-EXPORT'));
});
test('copied console command is executable and respects unit/bidder scope',()=>{
 const logs=[];const result=vm.runInNewContext(identityInspectCommand({adUnit:'P1',bidder:'ix'}),{window:fixture(),console:{info:()=>{},log:r=>logs.push(r)}});
 assert.equal(result.latestRequests.length,1);assert.equal(result.latestRequests[0].bidder,'ix');
 assert(!JSON.stringify(logs).includes('DO-NOT-EXPORT'));
});
test('missing APIs, empty IDs, malformed sources and missing history are reported honestly',()=>{
 assert.match(inspectIdentity({}).status,/not active/);
 const w=fixture();w.pbjs.getEvents=()=>[];delete w.pbjs.getUserIdsAsEids;
 assert.equal(inspectIdentity(w).current.observable,false);assert.equal(inspectIdentity(w).latestRequests.length,0);
 w.pbjs.getUserIdsAsEids=()=>[{source:'secret?raw=DO-NOT-EXPORT',uids:[{id:''},{id:'0'},{id:null}]}];
 const r=inspectIdentity(w);assert.equal(r.current.sources[0].source,'(unrecognized source)');assert.equal(r.current.sources[0].usableIds,0);
 assert(!JSON.stringify(r).includes('DO-NOT-EXPORT'));
});
