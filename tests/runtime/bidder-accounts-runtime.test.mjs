import test from 'node:test';
import assert from 'node:assert/strict';
import {createBidderAccounts} from '../../shared/bidder-accounts/browser.mjs';
const chain = sid => ({ver:'1.0',complete:1,nodes:[{asi:'seller.invalid',sid,hp:1}]});
const clone = value => structuredClone(value);
function merge(target, source) {
  for (const [key,value] of Object.entries(source)) {
    if (Array.isArray(value)) target[key] = [...(Array.isArray(target[key]) ? target[key] : []), ...clone(value)];
    else if (value && typeof value==='object') { if (!target[key] || typeof target[key]!=='object') target[key]={}; merge(target[key],value); }
    else target[key]=value;
  }
  return target;
}
function fixture(overrides={}) {
  const global={ortb2:{site:{content:{data:[{name:'foreign',segment:[{id:'keep'}]}]}}}}, bidder={adf_ag:{ortb2:{source:{ext:{preserve:true,schain:chain('old')}},site:{name:'private'}}}}, requests=[], aliases=[], writes=[];
  const pb={version:'v11.11.0',aliasRegistry:{},aliasBidder(base,alias,options){aliases.push({base,alias,options});this.aliasRegistry[alias]=base;},
    getConfig(key){return global[key];},setBidderConfig(value){writes.push(value);for(const name of value.bidders) merge(bidder[name]||(bidder[name]={}),value.config);},
    requestBids(input){assert.equal(this,pb);requests.push(input);return 'requested';},...overrides};
  const settings=[{bidder:'adf_smn',baseAdapter:'adf',displayName:'SMN',schain:{mode:'inherit'}},{bidder:'adf_ag',baseAdapter:'adf',displayName:'Agency',schain:{mode:'none'}},{bidder:'ix',baseAdapter:'ix',displayName:'IX',schain:{mode:'custom',config:chain('ix-own')}}];
  const win={},api=createBidderAccounts(win,settings,chain('site'),{request(pb,input){return pb.requestBids(input);}});
  const input=()=>({auctionId:'a',adUnits:[{code:'P1',bids:[{bidder:'adf_smn',params:{mid:1}},{bidder:'adf_ag',params:{mid:2}},{bidder:'ix',params:{siteId:3}}]}]});
  return {api,win,pb,global,bidder,requests,aliases,writes,input};
}
test('aliases inherit vendor consent, distinct chains replace old chain while other FPD survives',()=>{
  const f=fixture();f.api.preparePrebid(f.pb);f.api.configurePrebid(f.pb);
  assert.deepEqual(f.aliases.map(a=>a.options),[{useBaseGvlid:true},{useBaseGvlid:true}]);
  assert.deepEqual(f.bidder.adf_smn.ortb2.source.schain,chain('site'));
  assert.equal(f.bidder.adf_ag.ortb2.source.schain,undefined);assert.equal(f.bidder.adf_ag.ortb2.source.ext.schain,undefined);
  assert.equal(f.bidder.adf_ag.ortb2.source.ext.preserve,true);assert.equal(f.bidder.adf_ag.ortb2.site.name,'private');
  assert.deepEqual(f.bidder.ix.ortb2.source.schain,chain('ix-own'));assert.equal(f.global.ortb2.site.content.data[0].segment[0].id,'keep');
  assert.equal(f.api.request(f.pb,f.input()),'requested');
  const count=f.writes.length;f.api.request(f.pb,{...f.input(),auctionId:'overlapping'});assert.equal(f.writes.length,count);
  assert.equal(f.requests.length,2);assert.equal(f.aliases.length,2);
});
test('external global and request chains are detected; all-empty filtering returns one callback',()=>{
  for(const scope of ['global-current','global-ext','global-legacy','request-current','request-ext']) {
    const f=fixture();f.api.configurePrebid(f.pb);let callbacks=0;const input=f.input();input.bidsBackHandler=()=>callbacks++;
    if(scope==='global-current')f.global.ortb2.source={schain:chain('wrong')};
    if(scope==='global-ext')f.global.ortb2.source={ext:{schain:chain('wrong')}};
    if(scope==='global-legacy')f.global.schain={config:chain('wrong')};
    if(scope==='request-current')input.ortb2={source:{schain:chain('wrong')}};
    if(scope==='request-ext')input.ortb2={source:{ext:{schain:chain('wrong')}}};
    f.api.request(f.pb,input);assert.equal(f.requests.length,0,scope);assert.equal(callbacks,1,scope);
    assert(f.api.snapshot().events.some(e=>e.kind==='external-global-schain-conflict'));
  }
});
test('conflicting or hidden alias registry blocks only aliases and leaves valid demand untouched',()=>{
  for(const registry of [{adf_ag:'openx'},undefined]){
    const f=fixture({aliasRegistry:registry});f.api.request(f.pb,f.input());
    assert.equal(f.requests.length,1);
    assert.equal(f.requests[0].adUnits[0].bids.some(b=>b.bidder==='adf_ag'),false);
    assert.equal(f.requests[0].adUnits[0].bids.some(b=>b.bidder==='ix'),true);
  }
});
test('no mutation of caller requests or account diagnostics; per-bid and unknown accounts are isolated',()=>{
  const f=fixture(),input=f.input();input.adUnits[0].bids[1].ortb2={source:{schain:chain('wrong')}};
  input.adUnits[0].bids.push({bidder:'unknown',params:{}});const before=clone(input);f.api.request(f.pb,input);
  assert.deepEqual(input,before);assert.deepEqual(f.requests[0].adUnits[0].bids.map(b=>b.bidder),['adf_smn','ix']);
  const snap=f.api.snapshot();snap.accounts[0].schain.nodes[0].sid='changed';assert.equal(f.api.snapshot().accounts[0].schain.nodes[0].sid,'site');
});
test('external bidder writes retain FPD while managed chain remains exact, without affecting other accounts',()=>{
  const f=fixture();f.api.configurePrebid(f.pb);const before=f.writes.length;
  f.pb.setBidderConfig({bidders:['adf_ag','foreign'],config:{ortb2:{source:{schain:chain('leak'),ext:{custom:'keep'}},site:{content:{title:'Article'}}}}},true);
  assert.equal(f.bidder.adf_ag.ortb2.source.schain,undefined);assert.equal(f.bidder.adf_ag.ortb2.source.ext.custom,'keep');
  assert.equal(f.bidder.adf_ag.ortb2.site.content.title,'Article');assert.deepEqual(f.bidder.foreign.ortb2.source.schain,chain('leak'));
  assert.equal(f.api.request(f.pb,f.input()),'requested');assert(f.writes.length>before);
  assert(f.api.snapshot().events.some(e=>e.kind==='managed-schain-preserved'));
  f.pb.setBidderConfig({bidders:['adf_smn'],config:{ortb2:null}});
  assert.deepEqual(f.bidder.adf_smn.ortb2.source.schain,chain('site'));
});
test('repeated configure does not stack guards; replacing configuration APIs is diagnosed before sending',()=>{
  const f=fixture();f.api.configurePrebid(f.pb);const guarded=f.pb.setBidderConfig;
  f.api.configurePrebid(f.pb);assert.equal(f.pb.setBidderConfig,guarded);
  f.pb.setBidderConfig=function(){};let callbacks=0;
  f.api.request(f.pb,{...f.input(),bidsBackHandler(){callbacks++;}});
  assert.equal(callbacks,1);assert.equal(f.requests.length,0);assert(f.api.snapshot().events.some(e=>e.kind==='configuration-guard-replaced'));
});

test('managed chain survives option-only and empty bidder writes as well as mergeBidderConfig',()=>{
  const f=fixture();f.pb.mergeBidderConfig=function(value){return f.pb.setBidderConfig(value,true);};f.api.configurePrebid(f.pb);
  for(const value of [{someOtherOption:true},{}]) {
    f.pb.setBidderConfig({bidders:['adf_smn'],config:value});
    assert.deepEqual(f.bidder.adf_smn.ortb2.source.schain,chain('site'));
  }
  f.pb.mergeBidderConfig({bidders:['adf_ag'],config:{ortb2:{source:{schain:chain('leak')},site:{name:'merge-preserved'}}}});
  assert.equal(f.bidder.adf_ag.ortb2.source.schain,undefined);assert.equal(f.bidder.adf_ag.ortb2.site.name,'merge-preserved');
  assert(f.writes.length<30,'nested public methods must not recurse');
});
