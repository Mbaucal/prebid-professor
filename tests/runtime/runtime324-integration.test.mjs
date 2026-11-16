import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {runtimeCatalog,previewInput,buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {prebidRequirements,inspectPrebidArtifact,sha256} from '../../worker/runtime/prebid-artifact-check-v2.mjs';
import {runtime324Site} from './runtime324-site.mjs';
const TS='20261116_120000',text=bytes=>new TextDecoder().decode(bytes);
const descriptor=()=>{const value=runtimeCatalog.find(row=>row.id==='tessera-3.24.0');assert(value,'Combined runtime must be selectable');return value;};
async function checked(snapshot,version='11.34.0'){
 const input=previewInput(snapshot,descriptor(),TS),requirements=prebidRequirements(input,JSON.parse(snapshot.config.config_json));
 assert.deepEqual(requirements.issues,[]);if(!requirements.required)return null;
 const bytes=new TextEncoder().encode(`/* prebid.js v${version}\nModules: ${requirements.modules.join(', ')} */\nvoid 0;`).buffer;
 const build={id:'combined',publisher_id:snapshot.site.id,status:'current',version,file_key:`publishers/${snapshot.site.id}/prebid-builds/combined/prebid.js`,modules_json:JSON.stringify(requirements.modules)};
 const object={size:bytes.byteLength,customMetadata:{sha256:await sha256(bytes),version},async arrayBuffer(){return bytes;}};
 const report=await inspectPrebidArtifact({siteId:snapshot.site.id,builds:[build],requirements},{async get(){return object;}});
 assert.equal(report.status,'checked',JSON.stringify(report));return{bytes,report};
}
const build=async snapshot=>buildArtifactCandidate({snapshot,pin:pinRuntime(descriptor(),{allowPreview:true}),buildTimestamp:TS,prebid:await checked(snapshot)});
test('one selected package retains cache, exact aliases, account SChain, eligibility, contextual signals and deal identity',async()=>{
 const snapshot=runtime324Site(),before=structuredClone(snapshot),result=await build(snapshot),config=JSON.parse(text(result.files['config.json']));
 assert.deepEqual(snapshot,before,'Generating cannot rewrite saved settings');
 assert.equal(config.runtime.runtimeVersion,'3.24.0');assert.equal(descriptor().channel,'preview');
 assert.throws(()=>pinRuntime(descriptor()),/explicit opt-in/);
 assert.deepEqual(config.bidderAccounts.map(account=>[account.bidder,account.baseAdapter,account.schain.mode]),[
  ['pubmatic','pubmatic','inherit'],['pm_ag','pubmatic','custom'],['pm_no','pubmatic','none'],['openx','openx','inherit'],
 ]);
 assert.equal(config.bidderRules.enabled,true);assert.equal(config.bidCache.defaultEnabled,true);
 assert.equal(config.bidCache.positions.Billboard,true);assert.equal(config.bidCache.positions.P1,true);
 assert.equal(config.contextualSignals.enabled,true);assert.equal(config.deals.entries[0].bidder,'pm_ag');
 assert.equal(config.contextualSignals.bidders.find(row=>row.bidder==='pm_ag').taxonomy,'iab-content-3.0');
 const modules=result.manifest.prebidBuild.modules;
 assert(modules.includes('pubmaticBidAdapter'));assert(!modules.some(name=>name.startsWith('pm_ag')||name.startsWith('pm_no')));
 for(const file of ['ads.js','ads.min.js'])assert.doesNotThrow(()=>parse(text(result.files[file]),{ecmaVersion:2015}));
 const source=text(result.files['ads.js']);assert(source.includes('createTesseraBidCache'));assert(source.includes('createBidderAccounts'));assert(source.includes('createBidderRules'));
 for(const [file,metadata]of Object.entries(result.manifest.files))assert.equal(await sha256(result.files[file]),metadata.sha256,file);
});
test('older feature branches reject a combined saved configuration instead of silently dropping the other half',async()=>{
 const snapshot=runtime324Site();
 for(const version of ['3.21.2','3.22.2','3.23.0']){
  const old=runtimeCatalog.find(row=>row.version===version);assert(old,version);
  await assert.rejects(buildArtifactCandidate({snapshot,pin:pinRuntime(old,{allowPreview:true}),buildTimestamp:TS,prebid:await checked(snapshot)}),/require|requires|caching|Bidder|bid cache/i,version);
 }
});
test('TakeOver and Outstream settings are preserved while their saved cache overrides remain excluded',async()=>{
 const snapshot=runtime324Site({formats:true}),result=await build(snapshot),config=JSON.parse(text(result.files['config.json']));
 assert.equal(config.adPosition.code,'Overlay');assert(config.outstream.units.P2);
 assert.equal(Object.hasOwn(config.bidCache.positions,'Overlay'),false);assert.equal(Object.hasOwn(config.bidCache.positions,'P2'),false);
 assert.deepEqual(config.bidCacheExclusions.map(row=>row.code).sort(),['Overlay','P2']);
 assert(result.manifest.warnings.some(row=>row.includes('Overlay')));assert(result.manifest.warnings.some(row=>row.includes('P2')));
});
test('GAM-only keeps saved addon settings without shipping Prebid, aliases or a cache policy',async()=>{
 const snapshot=runtime324Site({prebid:false}),result=await build(snapshot),config=JSON.parse(text(result.files['config.json']));
 assert.equal(result.files['prebid.js'],undefined);assert.equal(config.bidCache,null);assert.equal(config.bidderRules.enabled,false);
 assert.deepEqual(config.contextualSignals.bidders,[]);assert(!text(result.files['ads.js']).includes('createTesseraBidCache'));
});
test('exact prototype-shaped position codes retain their own cache choice and deal references',async()=>{
 const snapshot=runtime324Site(),config=JSON.parse(snapshot.config.config_json);
 snapshot.units.find(row=>row.code==='Billboard').code='__proto__';config.runtimeControls.deals.entries[0].positions=['__proto__','P1'];
 snapshot.config.config_json=JSON.stringify(config);
 const result=await build(snapshot),saved=JSON.parse(text(result.files['config.json']));
 assert.equal(Object.hasOwn(saved.bidCache.positions,'__proto__'),true);assert.equal(saved.bidCache.positions.__proto__,true);
 assert.deepEqual(saved.deals.entries[0].positions,['P1','__proto__']);assert(saved.core.explicitUnits.some(row=>row.id==='__proto__'));
});
test('the combined snapshot retains the native targeting-key collision guard for long aliases',()=>{
 const snapshot=runtime324Site(),config=JSON.parse(snapshot.config.config_json);
 snapshot.bidders=[1,2].map(index=>({bidder:`pubmatic_agency_${index}`,enabled:1,params_json:'{"publisherId":"1","adSlot":"a"}',account_json:'{"baseAdapter":"pubmatic"}'}));
 config.runtimeControls.bidderRules={schemaVersion:1,enabled:false,rules:[]};
 config.runtimeControls.contextualSignals.enabled=false;delete config.runtimeControls.deals;snapshot.config.config_json=JSON.stringify(config);
 assert.throws(()=>previewInput(snapshot,descriptor(),TS),/targeting|collid|collision|same.*key/i);
});
test('a unique long original bidder keeps the exact identity and its valid truncated GAM deal keys',async()=>{
 const snapshot=runtime324Site(),config=JSON.parse(snapshot.config.config_json);
 snapshot.bidders=[{bidder:'improvedigital',enabled:1,params_json:'{"placementId":123}',account_json:'{}'}];
 config.runtimeControls.bidderRules={schemaVersion:1,enabled:false,rules:[]};config.runtimeControls.contextualSignals.enabled=false;
 config.runtimeControls.deals.entries[0].bidder='improvedigital';snapshot.config.config_json=JSON.stringify(config);
 const result=await build(snapshot),saved=JSON.parse(text(result.files['config.json'])),plan=JSON.parse(text(result.files['deals-plan.json']));
 assert.equal(saved.core.bidders[0].bidder,'improvedigital');
 assert.equal(plan.entries[0].targeting.key,'hb_deal_improvedigital'.slice(0,20));
 assert.equal(plan.entries[0].creativeAdIdMacro,'%%PATTERN:'+'hb_adid_improvedigital'.slice(0,20)+'%%');
});
