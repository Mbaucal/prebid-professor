import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultBidderRules,normalizeBidderRules,evaluateBidderRule,requireBidderRulesRuntime,bidderRulesInput} from '../../shared/bidder-rules/settings.mjs';
const rule=(patch={})=>({id:'rs',name:'Serbia',enabled:true,bidder:'pubmatic',positions:[],countries:{mode:'include',values:['RS'],unknown:'skip'},devices:['mobile','tablet','desktop'],...patch});
const settings=(rules=[rule()])=>({schemaVersion:1,enabled:true,rules});
const context=(patch={})=>({bidder:'pubmatic',code:'m.box_1',country:'RS',width:1200,...patch});
const decide=(value,patch={})=>evaluateBidderRule(normalizeBidderRules(value),context(patch));

test('off and unmatched policies pass through; exact aliases and position codes remain distinct',()=>{
  assert.equal(decide(defaultBidderRules()).reason,'disabled');
  assert.equal(decide(settings(),{bidder:'pubmaticAlias',country:'DE'}).reason,'no-rule');
  const value=settings([rule({positions:['m.box_1']})]);
  assert.equal(decide(value,{country:'DE'}).allowed,false);
  assert.equal(decide(value,{code:'m_box_1',country:'DE'}).allowed,true);
  assert.equal(decide(value,{code:'M.box_1',country:'DE'}).allowed,true);
});

test('country allow/exclude and unknown policies are explicit; all countries ignores unknown',()=>{
  for(const mode of ['include','exclude'])for(const unknown of ['allow','skip']){
    const value=settings([rule({countries:{mode,unknown,values:['RS','DE']}})]);
    assert.equal(decide(value,{country:'RS'}).allowed,mode==='include');
    assert.equal(decide(value,{country:'FR'}).allowed,mode==='exclude');
    for(const country of [null,'','rs','invalid'])assert.equal(decide(value,{country}).allowed,unknown==='allow');
  }
  assert.equal(decide(settings([rule({countries:{mode:'all',values:[],unknown:'skip'}})]),{country:null}).allowed,true);
});

test('specific positions override default policy independently of rule order',()=>{
  const fallback=rule({countries:{mode:'exclude',values:['RS'],unknown:'skip'}}),specific=rule({id:'specific',positions:['m.box_1']});
  for(const rules of [[fallback,specific],[specific,fallback]]){
    assert.equal(decide(settings(rules)).ruleId,'specific');
    assert.equal(decide(settings(rules)).allowed,true);
    assert.equal(decide(settings(rules),{code:'P2'}).allowed,false);
  }
  specific.enabled=false;assert.equal(decide(settings([specific,fallback])).ruleId,'rs');
});

test('viewport boundaries are deterministic and combined with country selection',()=>{
  for(const [width,device] of [[1,'mobile'],[767,'mobile'],[768,'tablet'],[1023,'tablet'],[1024,'desktop'],[1600,'desktop']]){
    const value=settings([rule({devices:[device]})]);
    assert.equal(decide(value,{width}).allowed,true);assert.equal(decide(value,{width}).device,device);
    assert.equal(decide(value,{width,country:'DE'}).allowed,false);
  }
  const mobile=settings([rule({devices:['mobile']})]);
  assert.equal(decide(mobile,{width:768}).reason,'layout-excluded');
  for(const width of [null,0,-1,NaN,Infinity,'390']){
    assert.equal(decide(mobile,{width}).reason,'layout-unknown');
    assert.equal(decide(settings(),{width}).allowed,true);
  }
});

test('normalization validates policy rather than requiring future visitor data',()=>{
  const value=settings([rule({positions:['m.box_1','constructor','m.box_1'],countries:{mode:'include',values:[' rs ','DE','rs','XK'],unknown:'allow'},devices:['desktop','mobile','desktop']})]);
  const before=structuredClone(value),normalized=normalizeBidderRules(value);
  assert.deepEqual(normalized.rules[0].countries.values,['DE','RS','XK']);
  assert.deepEqual(normalized.rules[0].devices,['mobile','desktop']);assert.deepEqual(normalized.rules[0].positions,['m.box_1','constructor']);
  assert.deepEqual(value,before);
  for(const patch of [{countries:{mode:'include',values:[],unknown:'skip'}},{countries:{mode:'include',values:['ZZ'],unknown:'allow'}},{devices:[]},{bidder:'bad bidder'},{positions:['/bad-position']},{name:''}])assert.throws(()=>normalizeBidderRules(settings([rule(patch)])),{status:422});
  assert.throws(()=>normalizeBidderRules({...settings(),other:true}),{status:422});
  assert.throws(()=>normalizeBidderRules(settings([rule({countries:{mode:'include',values:[{toString:'invalid'}],unknown:'allow'}})])),{status:422});
  assert.throws(()=>normalizeBidderRules(settings([rule(),rule({id:'two'})])),/All positions/);
  assert.throws(()=>normalizeBidderRules(settings([rule({positions:['P1','P2']}),rule({id:'two',positions:['P2']})])),/two enabled rules/);
  assert.doesNotThrow(()=>normalizeBidderRules(settings([rule(),rule({id:'two',enabled:false})])));
});

test('older scripts cannot silently omit enabled rules; GAM only retains inactive settings',()=>{
  const config={enablePrebid:true,runtimeControls:{bidderRules:settings()}};
  assert.throws(()=>requireBidderRulesRuntime(config,null),/3.22.0/);
  assert.throws(()=>requireBidderRulesRuntime(config,{capabilities:['config-preview']}),/3.22.0/);
  assert.doesNotThrow(()=>requireBidderRulesRuntime(config,{capabilities:['bidder-rules']}));
  config.enablePrebid=false;assert.doesNotThrow(()=>requireBidderRulesRuntime(config,null));
  const input=bidderRulesInput({config:{config_json:JSON.stringify(config)}});assert.equal(input.enabled,false);assert.equal(input.rules.length,1);
});
