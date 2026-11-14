import test from 'node:test';
import assert from 'node:assert/strict';
import {createContextualSignals} from '../../worker/runtime-3211/browser-contextual.mjs';
import {contextualPrebidStatus} from '../../worker/site-runtime/contextual-prebid-status.mjs';

const settings = {enabled:true,sourceKey:'category',gam:{enabled:false},bidders:[{bidder:'openx',taxonomy:'iab-content-2.2'}],mappings:[]};
function harness(initial,modules=['rtdModule','contextualSignalsRtdProvider']) {
  const listeners=new Set(),writes=[],warnings=[],win={console:{warn:message=>warnings.push(message)}};
  let stored=initial,requests=0;
  const pb={version:'11.34.0',installedModules:modules,
    getConfig(key,listener){assert.equal(key,'realTimeData');if(listener){listeners.add(listener);return()=>listeners.delete(listener);}return stored;},
    setConfig(value){writes.push(value);stored=value.realTimeData;for(const listener of listeners)listener({realTimeData:stored});}};
  const helper=createContextualSignals(win,settings,{request(_pb,input){requests++;input.bidsBackHandler();},dispatch(){},code:()=>''});
  return {pb,helper,writes,listeners,warnings,requests:()=>requests};
}
test('existing RTD including empty provider list stays byte-exact and conflict is visible',()=>{
  for(const providers of [[],[{name:'publisher',waitForIt:true,params:{key:'keep'}}]]){
    const existing={auctionDelay:30,dataProviders:providers},before=structuredClone(existing),f=harness(existing);
    f.helper.configurePrebid(f.pb);f.helper.configurePrebid(f.pb);
    assert.deepEqual(existing,before);assert.deepEqual(f.writes,[]);assert.equal(f.listeners.size,1);
    assert.equal(f.helper.snapshot().rtd.status,'rtd-config-preexisting');assert.equal(f.warnings.length,1);
    f.helper.request(f.pb,{auctionId:'blocked-context',adUnits:[{code:'P1'}],bidsBackHandler(){}});
    assert.equal(f.requests(),1,'optional integration conflict must not block ads');
  }
});
test('combined initial config remains publisher-owned without replacement',()=>{
  const existing={auctionDelay:25,dataProviders:[{name:'publisher'},{name:'contextualSignals',waitForIt:false}]},f=harness(existing);
  f.helper.configurePrebid(f.pb);assert.deepEqual(f.writes,[]);
  assert.deepEqual(f.helper.snapshot().rtd,{status:'configured',owner:'publisher',configuredProviders:['publisher','contextualSignals'],providerObserved:false});
});
test('sole wrapper config is initialized once; later writer is diagnosed without intercepting it',()=>{
  const f=harness(undefined),original=f.pb.setConfig;
  f.helper.configurePrebid(f.pb);f.helper.configurePrebid(f.pb);
  assert.equal(f.writes.length,1);assert.equal(f.listeners.size,1);assert.equal(f.pb.setConfig,original);
  const foreign={dataProviders:[{name:'publisher'}]};f.pb.setConfig({realTimeData:foreign});
  assert.equal(f.pb.getConfig('realTimeData'),foreign);assert.equal(f.writes.length,2);
  assert.equal(f.helper.snapshot().rtd.status,'rtd-config-changed-after-initialization');
  assert.deepEqual(f.helper.snapshot().rtd.configuredProviders,['contextualSignals']);
  assert.equal(f.warnings.length,1);
});
test('new Prebid instance releases the old listener and initializes new state',()=>{
  const f=harness(),other=harness();f.helper.configurePrebid(f.pb);f.helper.configurePrebid(other.pb);
  assert.equal(f.listeners.size,0);assert.equal(other.listeners.size,1);assert.equal(other.writes.length,1);
});
test('known missing modules are diagnosed without configuring RTD or blocking request callbacks',()=>{
  for(const modules of [[],['rtdModule'],['contextualSignalsRtdProvider']]){
    const f=harness(undefined,modules);f.helper.configurePrebid(f.pb);let completed=0;
    f.helper.request(f.pb,{auctionId:'missing',adUnits:[{code:'P1'}],bidsBackHandler(){completed++;}});
    assert.equal(completed,1);assert.deepEqual(f.writes,[]);assert.equal(f.helper.snapshot().rtd.status,'prebid-modules-missing');
  }
});
test('configured but unobserved provider is distinguished from successful auction enrichment',()=>{
  const f=harness();f.helper.configurePrebid(f.pb);
  f.helper.request(f.pb,{auctionId:'missing',adUnits:[{code:'P1'}],bidsBackHandler(){}});
  assert.equal(f.helper.snapshot().rtd.status,'provider-not-observed');assert.equal(f.helper.snapshot().rtd.providerObserved,false);
});
test('stored module status handles missing, malformed and valid metadata without coercion',()=>{
  assert.equal(contextualPrebidStatus([]).status,'no-build');
  for(const builds of [[null],[[]],[{},{}]])assert.equal(contextualPrebidStatus(builds).status,'unknown');
  for(const modules_json of ['broken','{}','[{}]','["rtdModule",null]'])assert.equal(contextualPrebidStatus([{id:'build',modules_json}]).status,'unknown');
  assert.deepEqual(contextualPrebidStatus([{id:'build',modules_json:'["rtdModule"]'}],'build'),{status:'modules-missing',buildId:'build',selectedBuildId:'build',selectionMatches:true,missingModules:['contextualSignalsRtdProvider'],evidence:'current-build-metadata'});
  const present=contextualPrebidStatus([{id:'new',modules_json:'["rtdModule","contextualSignalsRtdProvider"]'}],'old');
  assert.equal(present.status,'modules-present');assert.equal(present.selectionMatches,false);assert.equal(present.selectedBuildId,'old');
});
