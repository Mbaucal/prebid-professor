import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from 'acorn';
import {conditionalFixture, mapping} from '../support/conditional-maps-fixture.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {configure} from './artifact-fixture.mjs';
import {previewInput} from '../../worker/runtime-3211/snapshot.mjs';
import {compileRuntime3211} from '../../worker/runtime-3211/compiler.mjs';
import {previewInput as oldInput} from '../../worker/runtime-321/snapshot.mjs';
import {compileRuntime321} from '../../worker/runtime-321/compiler.mjs';
import {descriptor} from '../../.generated/runtime-321-manifest.mjs';
const stamp='20261113_020000';
const functions = new Set(['computePageTypePrefixes','baseUnitConfigById','getUnitConfigById','findExplicitUnit','adConditionalConfig','adGeoSelect','adGeoKeywords','adRuleMatches','adViewportSizes','sizesFromSizeMapName','sizesFromPrebidConfigName','buildPrebidSizeConfigFromName','dedupeSizes','adUnitFromCode']);
const json = value => JSON.parse(JSON.stringify(value));
function run(snapshot, {legacy=false, code='P2', country='RS', settled=true}={}) {
  const input=(legacy?oldInput:previewInput)(snapshot,descriptor,stamp);
  const source=(legacy?compileRuntime321:compileRuntime3211)(input).adsJs, selected=[];
  function visit(node) {
    if(!node||typeof node!=='object')return;
    if(node.type==='FunctionDeclaration'&&functions.has(node.id?.name))selected.push(source.slice(node.start,node.end));
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
  }
  visit(parse(source,{ecmaVersion:2015}));
  const tags={};
  const c=vm.createContext({window:{adsKeywords:{pageType:'Naslovna',category:'Naslovna'},innerWidth:1440,innerHeight:900},document:{documentElement:{clientWidth:1440,clientHeight:900},getElementById:()=>({setAttribute:(key,value)=>tags[key]=value})},
    PAGE_TYPE_KEYS:['pageType'],UNIT_RANGE:null,UNIT_DEFAULTS:null,UNIT_OVERRIDES:{},EXPLICIT_UNITS:input.core.explicitUnits,SIZE_MAPS_RAW:input.core.sizeMapsRaw,PREBID_SIZE_CONFIGS_RAW:input.core.prebidSizeConfigsRaw,
    AD_CONDITIONAL_UNITS:input.conditionalUnits,AD_CONDITIONAL_DECISIONS:Object.create(null),AD_GEO_STATE:{settled,country},AD_VIEWPORT_MAP_NAMES:input.viewportMapNames,
    applyDealParams:unit=>unit,TESSERA_DEALS:{enabled:false},applyOutstreamUnit:unit=>unit,TESSERA_OUTSTREAM:{units:{}},STICKY_TARGET_ID:'',STICKY_TOP_TARGET_ID:'',BIDDERS:input.core.bidders,BIDDER_DEVICE_PARAMS:input.core.bidderDeviceParams,BIDDER_SLOT_PARAMS:input.core.bidderSlotParams,BIDDER_ADUNIT_PARAMS:input.core.bidderAdUnitParams,VIDEO_BIDDERS:[]});
  vm.runInContext(selected.join('\n')+'\nvar PAGE_TYPE_PREFIXES=computePageTypePrefixes();',c);
  return {input,c,tags,code,config:()=>c.getUnitConfigById(code),bid:()=>c.adUnitFromCode(code)};
}
function fixture(scope='P2', kind='nonmatch') {
  const s=conditionalFixture({prebid:true});s.rules=[];
  if(kind!=='no-rule')s.rules=[{rule_key:scope,rule_json:JSON.stringify({conditionalMappings:[mapping({enabled:kind!=='disabled-rule',conditions:[{id:'category',key:'category',operator:'equals',value:kind==='nonmatch'?'Gallery':'Naslovna'}],sizeMapKey:kind==='explicit'?'naslovna_P2':null,slotAction:kind==='enable'?'enable':kind==='explicit'?'inherit':'disable'})]})}];
  return s;
}

test('regression control: frozen 3.21 loses a real prefixed map with an unmatched rule',()=>{
  const page=run(fixture(),{legacy:true});
  assert.equal(page.c.baseUnitConfigById('P2').sizeMapName,'naslovna_P2');
  assert.equal(page.config().sizeMapName,'P2');
  assert(page.bid().mediaTypes.banner.sizes.some(size=>size[0]===300&&size[1]===600));
});
for(const scope of ['__DEFAULT__','__ATF__','P2'])for(const kind of ['no-rule','disabled-rule','nonmatch','enable','explicit']) {
  test(`3.21.1 real page map survives ${scope} / ${kind}`,()=>{
    const saved=fixture(scope,kind),before=structuredClone(saved),page=run(saved);
    assert.deepEqual(saved,before,'no saved config mutation');
    assert.equal(page.c.baseUnitConfigById('P2').sizeMapName,'naslovna_P2');
    assert.equal(page.config().sizeMapName,'naslovna_P2');
    assert.equal(page.config().prebidSizeConfigName,'naslovna_P2');
    assert.deepEqual(json(page.bid().mediaTypes.banner.sizes),[[300,250],[250,250]]);
    assert.equal(page.tags['data-ad-size-map'],String(page.input.viewportMapNames.indexOf('naslovna_P2')));
    assert.match(page.input.conditionalCss,/data-ad-size-map="1"/);
    // A refresh keeps the original map decision. Resize only changes its row.
    page.c.window.adsKeywords={pageType:'Article',category:'Gallery'};
    page.c.PAGE_TYPE_PREFIXES=[];
    if(kind==='nonmatch'||kind==='enable'||kind==='explicit')assert.equal(page.config().sizeMapName,'naslovna_P2');
    page.c.window.innerWidth=390;
    if(kind==='nonmatch'||kind==='enable'||kind==='explicit')assert.deepEqual(json(page.bid().mediaTypes.banner.sizes),json(page.input.core.sizeMapsRaw.naslovna_P2[0].sizes));
  });
}
test('no-map decisions retain a separate Prebid map and lock both names across refresh',()=>{
  const page=run(fixture());
  const first=page.c.adConditionalConfig('P2',{sizeMapName:'naslovna_P2',prebidSizeConfigName:'prebid-home'});
  assert.equal(first.sizeMapName,'naslovna_P2');assert.equal(first.prebidSizeConfigName,'prebid-home');
  const later=page.c.adConditionalConfig('P2',{sizeMapName:'P2',prebidSizeConfigName:'prebid-article'});
  assert.equal(later.sizeMapName,'naslovna_P2');assert.equal(later.prebidSizeConfigName,'prebid-home');
});
test('explicit map changes both names; disabled and GEO-pending positions produce no bidder unit',()=>{
  const explicit=run(fixture('P2','explicit'));
  const result=explicit.c.adConditionalConfig('P2',{sizeMapName:'P2',prebidSizeConfigName:'different-prebid-map'});
  assert.equal(result.sizeMapName,'naslovna_P2');assert.equal(result.prebidSizeConfigName,'naslovna_P2');
  const disabled=run(fixture('P2','disable'));assert.equal(disabled.config(),null);assert.equal(disabled.bid(),null);assert.equal(disabled.tags['data-ad-rule-map'],'disabled');
  const s=fixture();s.rules[0].rule_json=JSON.stringify({conditionalMappings:[mapping({conditions:[{key:'geo_country',operator:'equals',value:'DE'}],slotAction:'disable',sizeMapKey:null})]});
  const waiting=run(s,{settled:false,country:null});assert.equal(waiting.config(),null);assert.equal(waiting.bid(),null);assert.equal(Object.keys(waiting.c.AD_CONDITIONAL_DECISIONS).length,0);
  waiting.c.AD_GEO_STATE.settled=true;assert.equal(waiting.config().sizeMapName,'naslovna_P2');
});
test('literal punctuated position identity is retained through the new snapshot and selection',()=>{
  const s=fixture('P2','nonmatch');s.units[0].code='m.box_1';s.rules[0].rule_key='m.box_1';
  const page=run(s,{code:'m.box_1'});assert.equal(page.config().id,'m.box_1');assert.equal(page.bid().code,'m.box_1');assert.equal(page.config().sizeMapName,'naslovna_P2');
});
function broadRule(scope) { return {rule_key:scope,rule_json:JSON.stringify({conditionalMappings:[mapping({sizeMapKey:null,slotAction:'disable',conditions:[{key:'geo_country',operator:'notEquals',value:'RS'}]})]})}; }
for(const scope of ['__DEFAULT__','__ATF__'])test(`inherited ${scope} rule excludes TakeOver explicitly instead of blocking Generate`,()=>{
  const s=positionFixture(false);s.rules=[broadRule(scope)];
  assert.throws(()=>oldInput(s,descriptor,stamp),/Overlay: key-value rules/);
  const input=previewInput(s,descriptor,stamp),output=compileRuntime3211(input);
  assert.equal(input.conditionalUnits.Overlay,undefined);assert(input.conditionalUnits.Billboard);
  assert.deepEqual(input.conditionalRuleExclusions,[{code:'Overlay',format:'TakeOver',scopes:[scope]}]);
  assert(output.warnings.some(w=>w.includes('Overlay')&&w.includes(scope)&&w.includes('Banner and Sticky')));
});
test('exact active TakeOver rule reports its target; disabled exact draft does not block',()=>{
  const s=positionFixture(false);s.rules=[broadRule('Overlay')];
  assert.throws(()=>previewInput(s,descriptor,stamp),/Overlay: conditional rules on this TakeOver position/);
  const rule=JSON.parse(s.rules[0].rule_json);rule.conditionalMappings[0].enabled=false;s.rules[0].rule_json=JSON.stringify(rule);
  assert.doesNotThrow(()=>previewInput(s,descriptor,stamp));
});
function outstreamFixture(scope){
 const s=conditionalFixture({prebid:true});
 s.bidders=[{bidder:'pubmatic',enabled:1,params_json:'{"publisherId":"fixture","adSlot":"fixture"}'}];
 s.prebidBuilds=[{version:'11.34.0',modules_json:'["pubmaticBidAdapter"]'}];
 configure(s,c=>{c.runtimeControls.outstream={schemaVersion:1,units:{P2:{format:'banner-outstream',playerSize:[300,250],minDuration:1,maxDuration:30,playbackMethod:2,placement:3,plcmt:4,partner:{bidder:'pubmatic',adapter:'pubmatic',outstreamAU:'fixture',activationConfirmed:true},cacheUrl:'https://prebid.adnxs.com/pbc/v1/cache'}}};});
 s.rules=[broadRule(scope)];return s;
}
test('Outstream exclusions are explicit and exact Outstream rules remain actionable',()=>{
 const s=outstreamFixture('__DEFAULT__');assert.throws(()=>oldInput(s,descriptor,stamp),/P2: key-value map rules/);
 const input=previewInput(s,descriptor,stamp);assert.equal(input.conditionalUnits.P2,undefined);assert.deepEqual(input.conditionalRuleExclusions,[{code:'P2',format:'Outstream',scopes:['__DEFAULT__']}]);
 assert(compileRuntime3211(input).warnings.some(w=>w.includes('Outstream')));
 assert.throws(()=>previewInput(outstreamFixture('P2'),descriptor,stamp),/P2: conditional rules on this Outstream position/);
});
