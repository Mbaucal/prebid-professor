import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {parse} from 'acorn';
import {unzipSync} from 'fflate';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore, ORIGIN, TEST_EMAIL, TEST_PASSWORD} from '../support/test-workspace-store.mjs';
import {defaultOverlay} from '../../worker/site-runtime/position-settings.mjs';
import {getContextualSignalSettings, contextualSignalSettingsResponse} from '../../worker/site-runtime/contextual-signals-settings.mjs';

// Actual authenticated TEST HTTP handlers with in-memory SQLite/R2. Supplemental
// contextual settings use their real production HTTP handler because the legacy
// TEST router has no contextual-settings route. No ad library or SSP is loaded.
const fixtures=[], originalFetch=globalThis.fetch, decoder=new TextDecoder();
test.before(()=>{globalThis.fetch=()=>assert.fail('Package QA must not fetch external resources');});
test.after(()=>{globalThis.fetch=originalFetch;});
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
async function req(f,path,cookie,body,method=body===undefined?'GET':'POST') {
  const response=await worker.fetch(new Request(ORIGIN+path,{method,headers:{cookie,...(method==='GET'?{}:{origin:ORIGIN,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}),f.env);
  return {response,data:response.headers.get('content-type')?.includes('json')?await response.json():null};
}
function ok(result,status=200){assert.equal(result.response.status,status,JSON.stringify(result.data));return result.data;}
const settings=async(f,cookie)=>ok(await req(f,'/test-api/site-settings',cookie));
const save=(f,cookie,state)=>req(f,'/test-api/site-settings',cookie,{expectedRevision:state.revision,acknowledge:true,draft:state.draft});
async function select(f,cookie,version) {
  const state=ok(await req(f,'/test-api/runtime-selection',cookie));
  const runtime=state.runtimes.find(item=>item.version===version);assert(runtime,`Runtime ${version} must be registered`);
  ok(await req(f,'/test-api/runtime-selection',cookie,{expectedRevision:state.revision,selection:{runtime:runtime.pin,allowPreview:true,enablePrebid:state.enablePrebid,prebidBuildId:state.prebidBuildId}}));
  return runtime.pin;
}
async function ready() {
  const f=workspaceStore();fixtures.push(f);
  const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
  assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
  ok(await req(f,'/test-api/setup',cookie,{confirm:'prepare-empty-test-database'}));
  return {f,cookie};
}
function rows(f) {
  return JSON.stringify(Object.fromEntries(['publisher_configs','ad_units','size_maps','unit_rules','bidder_overrides','audit_log'].map(table=>[table,f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])));
}
async function download(f,cookie,path) {
  const result=await req(f,path,cookie);assert.equal(result.response.status,200);
  const bytes=new Uint8Array(await result.response.arrayBuffer()),files=unzipSync(bytes);
  return {bytes,files,config:JSON.parse(decoder.decode(files['config.json'])),manifest:JSON.parse(decoder.decode(files['manifest.json']))};
}
async function packageFromSaved(f,cookie,note) {
  const before=rows(f),objects=f.objects.size;
  const generated=ok(await req(f,'/test-api/generate',cookie,{acknowledge:true}));
  assert.equal(rows(f),before,'Generate does not rewrite saved site settings');assert.equal(f.objects.size,objects,'Generate creates no stored package');
  const stored=ok(await req(f,'/test-api/save',cookie,{receipt:generated.receipt,acknowledge:true,note}));
  const base='/test-api/releases/'+stored.draft.id;
  const index=ok(await req(f,base+'/index',cookie));assert(index,'Stored package reopens through its actual index endpoint');
  const result=await download(f,cookie,base+'/download');
  assert.equal(decoder.decode(result.files['ads.js']),generated.adsJs);
  for(const name of ['ads.js','ads.min.js'])assert.doesNotThrow(()=>parse(decoder.decode(result.files[name]),{ecmaVersion:2015}));
  return {...result,path:base+'/download',id:stored.draft.id};
}
async function saveContextual(f) {
  const state=await getContextualSignalSettings(f.env,'test-site');
  const value={schemaVersion:1,enabled:true,sourceKey:'category',gam:{enabled:true},bidders:[],mappings:[{value:'Naslovna',taxonomies:{'iab-content-2.2':['48'],'iab-content-3.0':[]}}]};
  const response=await contextualSignalSettingsResponse(new Request(ORIGIN+'/api/publishers/test-site/contextual-signals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:state.revision,settings:value})}),f.env,'test-site',TEST_EMAIL);
  assert.equal(response.status,200,await response.clone().text());
  return (await response.json()).settings;
}

// Execute the selection functions from the downloaded readable bundle. The
// environment is synthetic; this checks packaged behavior, not browser/network
// delivery. Window pageType supplies the existing prefix while category drives
// the saved conditional rule and contextual mapping independently.
function assertPackagedMap(result) {
  const source=decoder.decode(result.files['ads.js']),names=new Set(['computePageTypePrefixes','baseUnitConfigById','getUnitConfigById','findExplicitUnit','adConditionalConfig','adGeoSelect','adGeoKeywords','adRuleMatches']);
  const functions=[];function walk(node){if(!node||typeof node!=='object')return;if(node.type==='FunctionDeclaration'&&names.has(node.id?.name))functions.push(source.slice(node.start,node.end));for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);}
  walk(parse(source,{ecmaVersion:2015}));assert.equal(functions.length,names.size);
  const config=result.config,ctx={window:{adsKeywords:{pageType:'Naslovna',category:'Naslovna'}},document:{getElementById:()=>({setAttribute(){}})},
    TESSERA_OVERLAY:config.adPosition,PAGE_TYPE_KEYS:['pageType'],UNIT_RANGE:null,UNIT_DEFAULTS:null,UNIT_OVERRIDES:{},EXPLICIT_UNITS:config.core.explicitUnits,SIZE_MAPS_RAW:config.core.sizeMapsRaw,PREBID_SIZE_CONFIGS_RAW:config.core.prebidSizeConfigsRaw,
    AD_CONDITIONAL_UNITS:config.conditionalUnits,AD_CONDITIONAL_DECISIONS:Object.create(null),AD_GEO_STATE:{settled:true,country:'RS'},AD_VIEWPORT_MAP_NAMES:Object.keys(config.core.sizeMapsRaw)};
  runInNewContext(functions.join('\n')+'\nvar PAGE_TYPE_PREFIXES=computePageTypePrefixes();var selected=getUnitConfigById("P2");',ctx);
  assert.equal(ctx.selected.sizeMapName,'naslovna_P2');assert.equal(ctx.selected.prebidSizeConfigName,'naslovna_P2');
}

test('3.21.1 TEST selection/save/generate/reopen retains category rules, PPS and TakeOver cap without changing the historical 3.21.0 ZIP',async()=>{
  const {f,cookie}=await ready();await select(f,cookie,'3.21.0');
  const old=await packageFromSaved(f,cookie,'Historical 3.21.0 package'),beforeReads=rows(f),oldObjectCount=f.objects.size;
  for(const path of ['/test-api/status','/test-api/site-settings','/test-api/releases'])ok(await req(f,path,cookie));
  const catalog=ok(await req(f,'/test-api/runtime-selection',cookie));
  assert.equal(catalog.selected.runtime.runtimeVersion,'3.21.0','Read endpoints never auto-upgrade a saved selection');
  assert.equal(rows(f),beforeReads);assert.equal(f.objects.size,oldObjectCount);

  const pin=await select(f,cookie,'3.21.1'),state=await settings(f,cookie);
  state.draft.bottomStickyId='';
  state.draft.units=[{code:'P2',type:'ATF',enabled:true,sizeMap:'P2'},
    {code:'Overlay',type:'ATF',enabled:true,sizeMap:'modal',display:'takeover',overlay:{...defaultOverlay(),frequencyMinutes:15}}];
  state.draft.maps=[{name:'P2',breakpoints:[{minWidth:0,sizes:[[300,250]]},{minWidth:768,sizes:[[300,600]]}]},
    {name:'naslovna_P2',breakpoints:[{minWidth:0,sizes:[[300,250]]},{minWidth:768,sizes:[[300,250],[250,250]]}]},
    {name:'modal',breakpoints:[{minWidth:0,sizes:[[300,250]]},{minWidth:1024,sizes:[[800,600]]}]}];
  ok(await save(f,cookie,state));
  const rules=ok(await req(f,'/api/publishers/test-site/unit-rules',cookie));
  const inherited=rules.unitRules.find(row=>row.ruleKey==='__DEFAULT__');assert(inherited);
  const mapping={id:'home-enabled',name:'Homepage enabled',enabled:true,priority:100,match:'all',conditions:[{id:'category',key:'category',operator:'equals',value:'Naslovna'}],sizeMapKey:null,slotAction:'enable'};
  ok(await req(f,'/api/publishers/test-site/unit-rules/'+inherited.id,cookie,{expectedUpdatedAt:inherited.updatedAt,rule:{...inherited.rule,conditionalMappings:[mapping]}},'PATCH'));
  const contextual=await saveContextual(f);
  const reopened=await settings(f,cookie);assert.equal(reopened.draft.units.find(unit=>unit.code==='Overlay').overlay.frequencyMinutes,15);
  ok(await save(f,cookie,reopened));
  assert.deepEqual((await getContextualSignalSettings(f.env,'test-site')).settings,contextual,'Saving/reopening site settings preserves separately saved contextual mappings');

  const current=await packageFromSaved(f,cookie,'3.21.1 combined package');
  assert.deepEqual(current.config.runtime,pin);assert.equal(current.config.contextualSignals.enabled,true);assert.equal(current.config.contextualSignals.sourceKey,'category');
  assert.deepEqual(current.config.contextualSignals.mappings,contextual.mappings);assert.equal(current.config.contextualSignals.gam.enabled,true);
  assert.equal(current.config.adPosition.frequencyMinutes,15);
  assert.equal(current.config.conditionalUnits.P2.rules[0].conditions[0].key,'category');assert.equal(current.config.conditionalUnits.P2.rules[0].sizeMapKey,null);
  assert.equal(current.config.conditionalUnits.Overlay,undefined);
  assert.deepEqual(current.config.conditionalRuleExclusions,[{code:'Overlay',format:'TakeOver',scopes:['__DEFAULT__']}]);
  assert(current.manifest.warnings.some(value=>value.includes('Overlay')&&value.includes('Banner and Sticky')));
  const code=decoder.decode(current.files['ads.js']);assert.match(code,/function createConsentStorage\(/);assert.match(code,/storageConsent:\s*_adStorage\.update/);
  assertPackagedMap(current);

  const savedRows=rows(f),count=f.objects.size;
  assert.deepEqual((await download(f,cookie,old.path)).bytes,old.bytes,'Older stored ZIP bytes remain immutable after selecting and saving 3.21.1');
  assert.deepEqual((await download(f,cookie,current.path)).bytes,current.bytes,'Reopened 3.21.1 ZIP bytes are stable');
  const final=ok(await req(f,'/test-api/runtime-selection',cookie));assert.equal(final.selected.runtime.runtimeVersion,'3.21.1');assert.deepEqual(final.runtimes,catalog.runtimes);
  assert.equal(rows(f),savedRows,'Package reads do not alter selected runtime or other saved rows');assert.equal(f.objects.size,count);
});
