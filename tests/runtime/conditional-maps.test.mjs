import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {conditionalFixture,mapping} from '../support/conditional-maps-fixture.mjs';
import {configure,checkedFixture,fixture} from './artifact-fixture.mjs';
import {previewInput} from '../../worker/runtime-317/snapshot.mjs';
import {compileRuntime317} from '../../worker/runtime-317/compiler.mjs';
import {buildArtifactCandidate} from '../../worker/runtime-317/artifact-candidate.mjs';
import {descriptor} from '../../.generated/runtime-317-manifest.mjs';
import {browserSources} from '../../.generated/runtime-317-browser-source.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {previewInput as previousInput} from '../../worker/runtime-3162/snapshot.mjs';
import {descriptor as previousDescriptor} from '../../.generated/runtime-3162-manifest.mjs';
import {buildArtifactCandidate as previousCandidate} from '../../worker/runtime-3162/artifact-candidate.mjs';
import {buildArtifactCandidate as catalogCandidate,previewInput as catalogInput} from '../../worker/test-workspace/runtime-catalog.mjs';
const TS='20261109_120000';
const input=snapshot=>previewInput(snapshot,descriptor,TS);
function page(compiled,keywords={}) {
  const tags={};
  const c=vm.createContext({window:{adsKeywords:keywords},document:{getElementById:id=>({setAttribute:(key,value)=>{tags[id]=value;}})},
    AD_CONDITIONAL_UNITS:compiled.conditionalUnits,AD_CONDITIONAL_DECISIONS:Object.create(null)});
  vm.runInContext(Object.values(browserSources).join('\n'),c);
  return {tags,ctx:c,get:id=>JSON.parse(JSON.stringify(vm.runInContext(`adConditionalConfig(${JSON.stringify(id)},{sizeMapName:'wrongLegacyPrefix',prebidSizeConfigName:'wrongLegacyPrefix'})`,c)))};
}
test('actual 3.16.2 rejects either key; 3.17 preserves the rule without needing page values',()=>{
  const s=conditionalFixture(),before=structuredClone(s);
  assert.throws(()=>previousInput(s,previousDescriptor,TS),/Conditional mapping in P2/);
  const value=input(s);assert.deepEqual(s,before);
  assert.equal(value.conditionalUnits.P2.rules[0].conditions[0].key,'category');
  assert.equal(page(value,{category:'Naslovna',pageType:'home'}).get('P2').sizeMapName,'naslovna_P2');
  for(const keywords of [{},{category:'Kultura',pageType:'article'},{category:'naslovna'}])assert.equal(page(value,keywords).get('P2').sizeMapName,'P2');
  const p=page(value,{category:'Naslovna'});assert.equal(p.get('P2').prebidSizeConfigName,'naslovna_P2');
  p.ctx.window.adsKeywords.category='Kultura';assert.equal(p.get('P2').sizeMapName,'naslovna_P2','the GPT and Prebid map cannot diverge after definition');
  assert.equal(p.tags.P2,'1');
});
test('all six operators, arrays, missing values, booleans and case sensitivity',()=>{
  const c=vm.createContext({});vm.runInContext(browserSources.adRuleMatches,c);
  const check=(operator,value,keywords)=>c.adRuleMatches({key:'category',operator,value},keywords);
  assert(check('equals','Naslovna',{category:['Sport','Naslovna']}));
  assert(check('contains','slov',{category:'Naslovna'}));assert(!check('contains','naslov',{category:'Naslovna'}));
  assert(check('notEquals','Sport',{category:'Naslovna'}));assert(!check('notEquals','Sport',{category:['Naslovna','Sport']}));
  assert(check('notContains','Sport',{category:'Naslovna'}));assert(!check('notContains','slov',{category:'Naslovna'}));
  assert(check('exists','',{category:false}));assert(check('equals','false',{category:false}));
  for(const value of [undefined,null,'',[],{},['']]){
    assert(check('notExists','',{category:value}));assert(!check('exists','',{category:value}));
    assert(!check('notEquals','Naslovna',{category:value}));assert(!check('notContains','Naslovna',{category:value}));
  }
  assert(!check('exists','',Object.create({category:'Naslovna'})));
});
test('ALL/ANY, priority and inherited rules use the same documented order as the UI',()=>{
  const s=conditionalFixture();
  s.rules=[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({conditionalMappings:[mapping({sizeMapKey:'P2',priority:200})]})},
    {rule_key:'P2',rule_json:JSON.stringify({conditionalMappings:[mapping()]})}];
  assert.equal(page(input(s),{category:'Naslovna'}).get('P2').sizeMapName,'P2');
  s.rules[0].rule_json=JSON.stringify({conditionalMappings:[mapping({sizeMapKey:'P2',priority:100})]});
  assert.equal(page(input(s),{category:'Naslovna'}).get('P2').sizeMapName,'P2');
  s.rules=s.rules.slice(1);
  const conditions=[...mapping().conditions,{key:'pageType',operator:'equals',value:'article'}];
  s.rules[0].rule_json=JSON.stringify({conditionalMappings:[mapping({conditions,match:'all'})]});
  assert.equal(page(input(s),{category:'Naslovna',pageType:'home'}).get('P2').sizeMapName,'P2');
  s.rules[0].rule_json=JSON.stringify({conditionalMappings:[mapping({conditions,match:'any'})]});
  assert.equal(page(input(s),{category:'Naslovna',pageType:'home'}).get('P2').sizeMapName,'naslovna_P2');
});
test('disabled mappings do not block; disabling a position produces no unit; advanced empty mapping wins',()=>{
  const s=conditionalFixture();s.rules[1].rule_json=JSON.stringify({conditionalMappings:[mapping({enabled:false,sizeMapKey:'deleted-map',conditions:[]})]});
  assert.deepEqual(Object.keys(input(s).conditionalUnits),[]);
  assert.equal(page(input(conditionalFixture({disabled:true})),{category:'Naslovna'}).get('P2'),null);
  configure(s,c=>c.advancedUnitRules={P2:{conditionalMappings:[]}});
  s.rules[1].rule_json=JSON.stringify({conditionalMappings:[mapping()]});assert.deepEqual(Object.keys(input(s).conditionalUnits),[]);
  assert.doesNotThrow(()=>catalogInput(s,previousDescriptor,TS),'an advanced empty list also clears the old-version preflight');
});
test('invalid map/operator/prototype names still receive actionable configuration validation',()=>{
  for(const patch of [{sizeMapKey:'missing'},{conditions:[{key:'category',operator:'evaluate',value:'x'}]},{conditions:[{key:'__proto__',operator:'exists',value:''}]}]){
    const s=conditionalFixture();s.rules[1].rule_json=JSON.stringify({conditionalMappings:[mapping(patch)]});assert.throws(()=>input(s),/mapping 1/);
  }
});
test('complete readable/minified packages and the catalog include the normalized rules and exact hashes',async()=>{
  for(const prebidEnabled of [false,true]){
    const s=conditionalFixture({prebid:prebidEnabled}),pin=pinRuntime(descriptor),normalized=input(s);
    assert.deepEqual(catalogInput(s,descriptor,TS).conditionalUnits,normalized.conditionalUnits);
    // Prebid module checking is independent of conditional page values.
    const check=structuredClone(s);check.rules=[];
    const prebid=prebidEnabled?await checkedFixture(check):null;
    const args={snapshot:s,pin,buildTimestamp:TS,prebid};
    const result=await buildArtifactCandidate(args),viaCatalog=await catalogCandidate(args);
    assert.deepEqual(result.manifest,viaCatalog.manifest);
    for(const name of ['ads.js','ads.min.js'])parse(new TextDecoder().decode(result.files[name]),{ecmaVersion:2015});
    const config=JSON.parse(new TextDecoder().decode(result.files['config.json']));assert.deepEqual(config.conditionalUnits,JSON.parse(JSON.stringify(normalized.conditionalUnits)));
    for(const [name,entry]of Object.entries(result.manifest.files))assert.equal(createHash('sha256').update(result.files[name]).digest('hex'),entry.sha256);
    const css=new TextDecoder().decode(result.files['min-height.css']);assert.match(css,/#P2\[data-ad-rule-map="1"\]\{min-height:250px;\}/);
  }
});
test('3.16.2 source identity is unchanged and its package has no conditional code',async()=>{
  assert.equal(previousDescriptor.codeSha256,'ee9c0d5bc0a6ca3c4335a41cde4af8f3a7f749875a4965e4c45f70ba6d6a6910');
  const s=configure(fixture(),c=>c.enablePrebid=false);
  const old=await previousCandidate({snapshot:s,pin:pinRuntime(previousDescriptor),buildTimestamp:TS});
  assert.equal(old.manifest.runtime.runtimeVersion,'3.16.2');
  const text=new TextDecoder().decode(old.files['ads.js']);assert(!text.includes('AD_CONDITIONAL_UNITS'));
});
