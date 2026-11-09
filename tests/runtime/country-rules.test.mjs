import test from 'node:test';import assert from 'node:assert/strict';
import vm from 'node:vm';
import {browserSources} from '../../.generated/runtime-319-browser-source.mjs';
import {adRuleMatches} from '../../worker/runtime-317/browser-functions.mjs';
import {descriptor} from '../../.generated/runtime-319-manifest.mjs';
import {previewInput} from '../../worker/runtime-319/snapshot.mjs';
import {previewInput as catalogInput,runtimeCatalog,buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {countryRulesFixture,onlySerbia} from '../support/country-rules-fixture.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
const stamp='20261109_190000';
test('country rules normalize reserved ISO values, retain page rules and never need visitor data',()=>{
 const s=countryRulesFixture(),before=structuredClone(s);const input=previewInput(s,descriptor,stamp);
 assert.deepEqual(s,before);assert.equal(input.conditionalUnits.P2.usesGeo,true);assert.equal(input.conditionalUnits.P4.usesGeo,false);assert.equal(input.conditionalUnits.P1,undefined);
 assert.equal(input.countrySignal.targetingKey,'geo_country');
 const rule=JSON.parse(s.rules[1].rule_json);rule.conditionalMappings[0].conditions[0].value='de';s.rules[1].rule_json=JSON.stringify(rule);
 assert.equal(previewInput(s,descriptor,stamp).conditionalUnits.P2.rules[0].conditions[0].value,'DE');
 for(const value of ['ZZ','Serbia','RS,DE']){rule.conditionalMappings[0].conditions[0].value=value;s.rules[1].rule_json=JSON.stringify(rule);assert.throws(()=>previewInput(s,descriptor,stamp),/two-letter/);}
});
test('old versions cannot silently ignore active country/fallback rules; disabled rules remain harmless',()=>{
 const s=countryRulesFixture();for(const old of runtimeCatalog.filter(d=>!d.capabilities.includes('country-rules')))assert.throws(()=>catalogInput(s,old,stamp),/Country.*3.19.0/);
 const old=runtimeCatalog.find(d=>d.version==='3.18.0');s.rules=s.rules.map(r=>{const rule=JSON.parse(r.rule_json);rule.conditionalMappings?.forEach(m=>m.enabled=false);return {...r,rule_json:JSON.stringify(rule)};});
 assert.doesNotThrow(()=>catalogInput(s,old,stamp));
 s.rules.push({rule_key:'__INTERSTITIAL__',rule_json:JSON.stringify({conditionalMappings:[onlySerbia()]})});assert.throws(()=>catalogInput(s,old,stamp),/3.19.0/);
});
test('fallback is mapping-only and does not create an ordinary Interstitial inventory unit',()=>{
 const s=countryRulesFixture();s.rules.push({rule_key:'__INTERSTITIAL__',rule_json:JSON.stringify({conditionalMappings:[onlySerbia()]})});
 const input=previewInput(s,descriptor,stamp);assert(input.interstitialRules.usesGeo);assert(!input.core.explicitUnits.some(u=>u.id==='__INTERSTITIAL__'||u.id==='Interstitial'));
 for(const key of ['lazy','refresh','timeout']){s.rules.at(-1).rule_json=JSON.stringify({[key]:key==='timeout'?2000:{enabled:true},conditionalMappings:[onlySerbia()]});assert.throws(()=>previewInput(s,descriptor,stamp),/conditional slot actions/);}
 s.rules.at(-1).rule_json=JSON.stringify({conditionalMappings:[{...onlySerbia(),sizeMapKey:'P2'}]});assert.throws(()=>previewInput(s,descriptor,stamp),/responsive sizes/);
});
test('generated saved package exposes rules and one deployment-specific country endpoint',async()=>{
 const r=await buildArtifactCandidate({snapshot:countryRulesFixture(),pin:pinRuntime(descriptor),buildTimestamp:stamp,countryTarget:'test'}),d=new TextDecoder();
 const config=JSON.parse(d.decode(r.files['config.json']));assert.equal(config.runtime.runtimeVersion,'3.19.0');assert.equal(config.conditionalUnits.P2.usesGeo,true);assert.equal(config.countrySignal.targetingKey,'geo_country');
 for(const name of ['ads.js','ads.min.js']){const js=d.decode(r.files[name]);assert(js.includes('https://prebid-professor-test.mbaucal.workers.dev/geo/v1/country'));assert(!js.includes('https://prebid-professor.mbaucal.workers.dev/geo/v1/country'));assert(js.includes('geo_country'));}
 assert(d.decode(r.files['README.txt']).includes('Country rules in 3.19.0'));
 const reporting=JSON.parse(d.decode(r.files['gam-reporting.json']));assert.equal(reporting.keys.geo_country.scope,'page');assert.equal(reporting.keys.refresh_count.scope,'slot');
});


test('foreign async GEO snapshot accessors cannot leave dependent positions waiting',async()=>{
 for(const field of ['version','status','source','country']){
  const snapshot={version:1,status:'known',source:'cloudflare',country:'RS'};
  Object.defineProperty(snapshot,field,{get(){throw Error(`foreign ${field} getter`);}});
  const setting={baseMap:'P2',maps:['P2','naslovna_P2'],usesGeo:true,rules:[{match:'all',conditions:[{key:'geo_country',operator:'equals',value:'RS'}],sizeMapKey:'naslovna_P2',slotAction:'inherit'}]};
  const ctx=vm.createContext({
   Promise,window:{__AD_GEO:{getSnapshot:()=>({status:'pending'}),ready:()=>Promise.resolve(snapshot)}},
   document:{getElementById:()=>null},
   AD_GEO_STATE:{settled:false,country:null,initialized:true,fallbackReason:'empty',fallbackAllowed:null,stickyCheck:null},
   AD_CONDITIONAL_UNITS:{P2:setting,P3:{...setting,rules:[onlySerbia()]}},
   AD_CONDITIONAL_DECISIONS:Object.create(null),AD_INTERSTITIAL_RULES:{usesGeo:true,rules:[onlySerbia()]},
   _takeOver:{},resumes:0,targeting:null,fallback:null,clears:0,
  });
  vm.runInContext(Object.values(browserSources).join('\n')+'\n'+adRuleMatches.toString()+`
   var timer;
   function setTimeout(callback){timer=callback;return 1;}
   function clearTimeout(){clears++;}
   var googletag={cmd:{push:function(callback){callback();}},setConfig:function(config){targeting=config.targeting;}};
   function defineAllSlots(){resumes++; P2=adConditionalConfig('P2',{sizeMapName:'P2'}); P3=adConditionalConfig('P3',{sizeMapName:'P2'});}
   function takeOverReleaseCodelessSuppression(reason){fallback=adGeoFallbackAllowed(reason);}
   adGeoStart();`,ctx);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ctx.AD_GEO_STATE.settled,true,field);
  assert.equal(ctx.AD_GEO_STATE.country,null,field);
  assert.equal(ctx.resumes,1,field);
  assert.equal(ctx.P2.sizeMapName,'P2',field);
  assert.equal(ctx.P3,null,field);
  assert.equal(ctx.targeting.geo_country,null,field);
  assert.equal(ctx.fallback,false,field);
  assert.equal(ctx.clears,1,field);
  // A timer already queued before cancellation cannot dispatch a second scan.
  vm.runInContext('timer()',ctx);
  assert.equal(ctx.resumes,1,field);
 }
});
