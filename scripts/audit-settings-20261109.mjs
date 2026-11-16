/**
 * Independent synthetic save/generate observations for MBA-393.
 * Default mode reproduces the known defects on baseline b88a795 only.
 * Use --positive-controls after fixes; new rejection behavior is covered by
 * tests/runtime/generator-guard-audit.test.mjs.
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {parse} from 'acorn';
import {adminAuditStore} from '../tests/support/admin-audit-store.mjs';
import {fixture,configure} from '../tests/runtime/artifact-fixture.mjs';
import {createBidderOverride,updateBidder} from '../worker/bidders.ts';
import {updateAdUnit} from '../worker/ad-units.ts';
import {updateRuntimeControls} from '../worker/runtime-controls.ts';
import {pinRuntime} from '../worker/runtime/version-pin.mjs';
import {readPreviewSnapshot} from '../worker/runtime/builtin-preview-service.mjs';
import {previewInput} from '../worker/runtime-319/snapshot.mjs';
import {compileRuntime319} from '../worker/runtime-319/compiler.mjs';
import {descriptor} from '../.generated/runtime-319-manifest.mjs';
const stamp='20261109_210000',results=[],positiveOnly=process.argv.includes('--positive-controls');
const req=(body,method='POST')=>new Request('https://audit.invalid/api',{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const observe=(id,classification,detail)=>results.push({id,classification,...detail});
const input=s=>previewInput(s,descriptor,stamp);
const generated=s=>compileRuntime319(input(s)).adsJs;
function functionSource(source,name){
 const found=[];function walk(n){if(!n||typeof n!=='object')return;if(n.type==='FunctionDeclaration'&&n.id?.name===name)found.push(n);for(const v of Object.values(n))if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);}
 walk(parse(source,{ecmaVersion:2015}));assert.equal(found.length,1,name);return source.slice(found[0].start,found[0].end);
}
if(!positiveOnly){
for(const disabledBidder of [false,true]){
 const f=adminAuditStore();
 try{
  f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key) VALUES('audit-second','audit-site','P2','BTF','display')").run();
  let response=await createBidderOverride(req({scopeType:'adunit',scopeKey:'P1',params:{publisherId:'123',adSlot:'p1'}}),f.env,'audit-site','audit-bidder');
  assert.equal(response.status,201,await response.clone().text());
  if(disabledBidder){response=await updateBidder(req({enabled:false},'PATCH'),f.env,'audit-site','audit-bidder');assert.equal(response.status,200,await response.clone().text());}
  response=await updateAdUnit(req({enabled:false},'PATCH'),f.env,'audit-site','audit-unit');assert.equal(response.status,200,await response.clone().text());
  const snapshot=await readPreviewSnapshot(f.env.DB,'audit-site');
  assert.equal(snapshot.units.find(u=>u.code==='P1').enabled,0);
  assert.equal(snapshot.overrides.find(o=>o.scope_key==='P1').enabled,1);
  let error;try{generated(snapshot);}catch(e){error=e.message;}
  assert.match(error,/Bidder override references missing unit P1/);
  observe(disabledBidder?'disabled-bidder-and-unit':'disabled-unit-override','defect',{saveStatus:response.status,unit:'P1',otherEnabledUnit:'P2',bidderEnabled:!disabledBidder,error,impact:'An ordinary disabled position retains a valid exact bidder override but blocks generation for other enabled positions.'});
 }finally{f.close();}
}
for(const [id,body,pattern,classification]of[
 ['top-sticky-control',{sticky:{topAdUnitId:'P1'}},/Top sticky is not supported/,'unsupported-control-accepted'],
 ['close-portal-control',{sticky:{allowClosePortal:true}},/Close portal mode/,'unsupported-control-accepted'],
 ['bidder-floor-range',{floors:{bidderFloors:{pubmatic:1001}}},/bidderFloors.pubmatic.*between 0 and 1000/,'defect'],
 ['floor-rule-range',{floors:{rules:{'banner|300x250|desktop|*|*':1001}}},/floorRules.*between 0 and 1000/,'defect'],
]){
 const f=adminAuditStore({config:{builtinRuntimeSelection:pinRuntime(descriptor)}});
 try{
  const response=await updateRuntimeControls(req(body,'PUT'),f.env,'audit-site');assert.equal(response.status,200,await response.clone().text());
  const snapshot=await readPreviewSnapshot(f.env.DB,'audit-site');let error;try{generated(snapshot);}catch(e){error=e.message;}
  assert.match(error,pattern);observe(id,classification,{saveStatus:response.status,error,submitted:body});
 }finally{f.close();}
}
for(const mediaType of ['video','native']){
 const f=adminAuditStore({config:{builtinRuntimeSelection:pinRuntime(descriptor)}});
 try{
  const response=await updateAdUnit(req({mediaType},'PATCH'),f.env,'audit-site','audit-unit');assert.equal(response.status,200,await response.clone().text());
  let error;try{generated(await readPreviewSnapshot(f.env.DB,'audit-site'));}catch(e){error=e.message;}
  assert.match(error,/supports banner units only/);
  observe('raw-media-'+mediaType,'unsupported-control-accepted',{saveStatus:response.status,mediaType,error,detail:'Ad units editor offers this raw media type. Supported Outstream uses Banner → Formats, not raw video.'});
 }finally{f.close();}
}
}
{
 const s=fixture();s.overrides=[{bidder:'ix',scope_type:'adunit',scope_key:'gone',enabled:0,params_json:'{}'}];
 assert.doesNotThrow(()=>generated(s));observe('disabled-override','pass',{detail:'Disabled override rows are ignored during generation.'});
}
{
 const s=fixture();s.rules=[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({timeout:1200})},{rule_key:'__BTF__',rule_json:JSON.stringify({timeout:1800})},{rule_key:'P1',rule_json:JSON.stringify({timeout:2200})}];
 const p=input(s),source=generated(s),ctx=vm.createContext({AD_UNIT_RULES:p.core.adUnitRules,EXPLICIT_UNITS:p.core.explicitUnits.map(u=>({id:u.id,type:u.type})),PREBID_TIMEOUT:p.core.defaultTimeout,PREBID_TIMEOUT_ATF:p.core.atfTimeout,PREBID_TIMEOUT_BTF:p.core.btfTimeout,PREBID_TIMEOUT_STICKY:p.core.stickyTimeout,STICKY_TARGET_ID:'Sticky',STICKY_TOP_TARGET_ID:''});
 vm.runInContext(['_plainMerge','getAdUnitRuntimeRule','getAdUnitTimeoutMs'].map(n=>functionSource(source,n)).join('\n')+'\nfunction getUnitConfigById(id){return EXPLICIT_UNITS.find(function(u){return u.id===id;});}',ctx);
 const values=['Billboard','P1','Sticky'].map(id=>vm.runInContext(`getAdUnitTimeoutMs(${JSON.stringify(id)})`,ctx));assert.deepEqual(values,[1200,2200,1200]);
 observe('timeout-layers','pass',{default:p.core.defaultTimeout,group:p.core.btfTimeout,exact:p.core.adUnitRules.P1.timeout,emittedRuntime:values});
}
{
 const s=fixture();s.rules=[
  {rule_key:'__DEFAULT__',rule_json:JSON.stringify({lazy:{enabled:true,fetchMarginPx:500,renderMarginPx:200}})},
  {rule_key:'__BTF__',rule_json:JSON.stringify({lazy:{enabled:true,fetchMarginPx:900,renderMarginPx:400}})},
  {rule_key:'P1',rule_json:JSON.stringify({lazy:{enabled:false,fetchMarginPx:0,renderMarginPx:0}})},
 ];
 const p=input(s),source=generated(s),ctx=vm.createContext({TESSERA_LAZY:p.lazyRules,units:p.core.explicitUnits});
 vm.runInContext(functionSource(source,'tesseraLazyRule')+'\nfunction getUnitConfigById(id){return units.find(function(u){return u.id===id;});}',ctx);
 const actual=JSON.parse(JSON.stringify(vm.runInContext('[tesseraLazyRule("Billboard"),tesseraLazyRule("P1")]',ctx)));
 assert.deepEqual(actual,[{enabled:true,fetchMarginPx:500,renderMarginPx:200},{enabled:false,fetchMarginPx:0,renderMarginPx:0}]);
 observe('lazy-layers','pass',{actual,detail:'Actual compiled function preserves explicit false/zero over inherited true and margins.'});
}
{
 const s=fixture();s.overrides=[
  {bidder:'ix',scope_type:'device',scope_key:'mobile',enabled:1,params_json:JSON.stringify({siteId:'mobile',deviceKept:1})},
  {bidder:'ix',scope_type:'slot',scope_key:'BTF',enabled:1,params_json:JSON.stringify({siteId:'btf',groupKept:1})},
  {bidder:'ix',scope_type:'adunit',scope_key:'P1',enabled:1,params_json:JSON.stringify({siteId:'exact',exactKept:1})},
 ];
 const p=input(s),source=generated(s),ctx=vm.createContext({window:{innerWidth:390},document:{documentElement:{clientWidth:390}},screen:{width:390},BIDDERS:p.core.bidders,
  BIDDER_DEVICE_PARAMS:p.core.bidderDeviceParams,BIDDER_SLOT_PARAMS:p.core.bidderSlotParams,BIDDER_ADUNIT_PARAMS:p.core.bidderAdUnitParams,
  STICKY_TARGET_ID:'Sticky',STICKY_TOP_TARGET_ID:'',VIDEO_BIDDERS:[],TESSERA_DEALS:{},TESSERA_OUTSTREAM:{units:{}},units:p.core.explicitUnits});
 vm.runInContext(functionSource(source,'adUnitFromCode')+`
  function getUnitConfigById(id){return units.find(function(u){return u.id===id;});}
  function buildPrebidSizeConfigFromName(){return null;}
  function sizesFromPrebidConfigName(){return [[300,250]];}
  function sizesFromSizeMapName(){return [[300,250]];}
  function dedupeSizes(v){return v;}
  function applyDealParams(unit){return unit;}
  function applyOutstreamUnit(unit){return unit;}
 `,ctx);
 const actual=JSON.parse(JSON.stringify(vm.runInContext('[adUnitFromCode("P1").bids,adUnitFromCode("Billboard").bids]',ctx)));
 assert.deepEqual(actual,[[{bidder:'ix',params:{siteId:'exact',deviceKept:1,groupKept:1,exactKept:1}}],[{bidder:'ix',params:{siteId:'mobile',deviceKept:1}}]]);
 observe('bidder-layers','pass',{actual,detail:'Actual compiled adUnitFromCode uses global→device→group→exact merge; unrelated size and revenue hooks are fixture stubs.'});
}
const output={base:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),mode:positiveOnly?'positive-controls':'baseline-defect-reproduction',runtime:descriptor.version,scope:'Synthetic local DB/API save plus actual3.19 adapter/compiler; no hosted data, traffic or mutations.',results};
await mkdir('.generated/qa-settings',{recursive:true});
await writeFile('.generated/qa-settings/'+(positiveOnly?'positive-controls':'observations')+'.json',JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output,null,2));
