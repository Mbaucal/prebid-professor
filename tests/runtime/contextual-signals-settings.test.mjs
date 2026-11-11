import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTEXTUAL_TAXONOMIES} from '../../shared/contextual-signals/catalog.mjs';
import {defaultContextualSignals, normalizeContextualSignals, contextualSignalsInput, requireContextualRuntime} from '../../shared/contextual-signals/settings.mjs';

const settings = () => ({...defaultContextualSignals(),enabled:true,gam:{enabled:true},bidders:[{bidder:'openx',taxonomy:'iab-content-3.0'}],mappings:[{value:'Sport',taxonomies:{'iab-content-2.2':['483'],'iab-content-3.0':['483']}}]});
test('versions use separate pinned catalogs, including alphanumeric3.0 IDs',()=>{
  const [old,current]=CONTEXTUAL_TAXONOMIES;
  assert.equal(old.categories.length,1196);assert.equal(current.categories.length,703);
  assert(current.categories.some(category=>category.id==='VK7KD0'));
  assert(!old.categories.some(category=>category.id==='VK7KD0'));
  const value=settings();value.mappings[0].taxonomies['iab-content-3.0']=['VK7KD0'];
  assert.equal(normalizeContextualSignals(value).mappings[0].taxonomies['iab-content-3.0'][0],'VK7KD0');
  value.mappings[0].taxonomies['iab-content-2.2']=['VK7KD0'];assert.throws(()=>normalizeContextualSignals(value),/not an ID in iab-content-2.2/);
});
test('defaults are off, duplicates normalize without mutating input, missingfuturepagevalue never required',()=>{
  assert.deepEqual(normalizeContextualSignals(),defaultContextualSignals());
  const value=settings();value.mappings[0].taxonomies['iab-content-2.2'].push('483');
  const before=structuredClone(value), result=normalizeContextualSignals(value);
  assert.deepEqual(result.mappings[0].taxonomies['iab-content-2.2'],['483']);assert.deepEqual(value,before);
  value.mappings=[];assert.deepEqual(normalizeContextualSignals(value).mappings,[]);
});
test('unknown taxonomy, oldIABlabels, duplicate routes and categories have actionableerrors',()=>{
  for(const mutate of [v=>v.bidders.push({...v.bidders[0]}),v=>v.bidders[0].taxonomy='iab-content-9',v=>v.mappings.push({...v.mappings[0]}),v=>v.mappings[0].taxonomies['iab-content-2.2']=['IAB17'],v=>v.sourceKey='',v=>v.gam.enabled='yes',v=>v.enabled=1]){
    const value=settings();mutate(value);assert.throws(()=>normalizeContextualSignals(value),{status:422});
  }
  assert.throws(()=>normalizeContextualSignals({...settings(),user:{data:[]}}),/displayed fields/);
});
test('literal source values and prototype-shaped metadata do not affect object prototypes',()=>{
  const value=settings();value.sourceKey='__proto__';value.mappings[0].value=' constructor ';
  const result=normalizeContextualSignals(value);assert.equal(result.sourceKey,'__proto__');assert.equal(result.mappings[0].value,' constructor ');
  value.mappings[0].taxonomies=JSON.parse('{"__proto__":["483"]}');assert.throws(()=>normalizeContextualSignals(value),/displayed fields/);
  assert.equal(Object.prototype.polluted,undefined);
});
test('removed/disabled bidders retain savedsettings butonlyactivePrebidroutescompile',()=>{
  const value=settings();value.bidders.push({bidder:'pubmatic',taxonomy:'iab-content-2.2'});
  const snap={site:{id:'news',domain:'news.example'},config:{config_json:JSON.stringify({enablePrebid:true,runtimeControls:{contextualSignals:value}})},bidders:[{bidder:'openx',enabled:0},{bidder:'pubmatic',enabled:1}],prebidBuilds:[{status:'current',version:'11.34.0'}]};
  const input=contextualSignalsInput(snap);assert.deepEqual(input.bidders,[value.bidders[1]]);assert.equal(input.providerName,'news.example');assert.equal(input.prebidVersion,'11.34.0');
  snap.config.config_json=JSON.stringify({enablePrebid:false,runtimeControls:{contextualSignals:value}});assert.deepEqual(contextualSignalsInput(snap).bidders,[]);assert.deepEqual(value.bidders.length,2);
});
test('onlyenablednewbehaviorrequiresnewruntime;invalidpagecontextcannotblockgeneration',()=>{
  requireContextualRuntime({},null);requireContextualRuntime({runtimeControls:{contextualSignals:defaultContextualSignals()}},null);
  assert.throws(()=>requireContextualRuntime({runtimeControls:{contextualSignals:settings()}},{capabilities:[]}),/script 3.21.0/);
  requireContextualRuntime({runtimeControls:{contextualSignals:settings()}},{capabilities:['contextual-signals']});
});
