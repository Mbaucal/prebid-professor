import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse} from 'acorn';
import {runtimeCatalog, previewInput, buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {compileRuntime3212} from '../../worker/runtime-3212/compiler.mjs';
import {compileRuntime3221} from '../../worker/runtime-3221/compiler.mjs';
import {runtime3221Source,sourceFiles} from '../../scripts/prepare-runtime3221.mjs';
import {sourceFiles as auditedFiles} from '../../scripts/prepare-runtime3212.mjs';
import {runtime322Source} from '../../scripts/prepare-runtime322.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {fixture,configure,checkedFixture,TS} from './artifact-fixture.mjs';
const descriptor=runtimeCatalog.find(r=>r.version==='3.22.1');
const text=bytes=>new TextDecoder().decode(bytes);
const policy={schemaVersion:1,enabled:true,rules:[{id:'country',name:'Serbia only',bidder:'ix',enabled:true,positions:['P1'],countries:{mode:'include',values:['RS'],unknown:'skip'},devices:['desktop']}]};
function topFunctions(source){
 const ast=parse(source,{ecmaVersion:2015}),out=new Map();
 const iife=ast.body.find(n=>n.type==='ExpressionStatement'&&n.expression.callee?.type==='FunctionExpression'&&n.expression.callee.body.body.some(f=>f.id?.name==='defineAllSlots'));
 assert(iife,'ad runtime IIFE');
 for(const n of iife.expression.callee.body.body)if(n.type==='FunctionDeclaration')out.set(n.id.name,source.slice(n.start,n.end));
 return out;
}
test('3.22.1 is an explicit preview, retains every audited source, and leaves the frozen 3.22.0 hash intact',async()=>{
 assert.equal(descriptor.channel,'preview');assert.throws(()=>pinRuntime(descriptor),/explicit opt-in/);
 // The immutable 3.23.0 historical channel stays stable; recommendation policy is tested separately.
 assert.equal(runtimeReleaseHistory.find(r=>r.channel==='stable').version,'3.23.0');
 for(const path of auditedFiles)assert(sourceFiles.includes(path),path);
 assert.equal((await runtime3221Source(process.cwd())).codeSha256,descriptor.codeSha256);
 assert.equal((await runtime322Source(process.cwd())).codeSha256,'1aa3c8ad0dcc1c94fddf6d50b0a7b3073a524dee4750563277fd5c6d22525268');
});
for(const prebid of [true,false])for(const frequency of [0,5])test(`3.22.1 retains audited generated map, contextual, storage and boot functions (${prebid}/${frequency})`,()=>{
 const snapshot=configure(positionFixture(prebid),c=>{c.runtimeControls.adPositions.Overlay.frequencyMinutes=frequency;});
 const input=previewInput(snapshot,descriptor,TS),old=compileRuntime3212(input),next=compileRuntime3221(input);
 const before=topFunctions(old.adsJs),after=topFunctions(next.adsJs);
 const names=['adConditionalConfig','createContextualSignals','createConsentStorage',...(frequency?['init','defineAllSlots','tesseraBootRelease','resolveTakeOverCap']:[])];
 for(const name of names){assert(before.has(name),name);assert.equal(after.get(name),before.get(name),name+' must preserve the audited implementation');}
 assert(next.patches.some(p=>p.startsWith('3.21.1:')));assert(next.patches.some(p=>p.startsWith('3.21.2:')));
 assert(next.adsJs.includes('rawRequest:_adBidderRules.request,rawDispatch:_adContext.dispatch'));
});
test('3.22.1 package carries exact bidder rules while older selected runtimes keep refusing active rules',async()=>{
 const snapshot=configure(fixture(),c=>{c.runtimeControls.bidderRules=policy;}),before=structuredClone(snapshot);
 const built=await buildArtifactCandidate({snapshot,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:TS,prebid:await checkedFixture(snapshot)});
 const config=JSON.parse(text(built.files['config.json']));
 assert.deepEqual(config.bidderRules,policy);assert.equal(config.runtime.runtimeVersion,'3.22.1');
 for(const name of ['ads.js','ads.min.js'])assert.doesNotThrow(()=>parse(text(built.files[name]),{ecmaVersion:2015}));
 assert(text(built.files['README.txt']).includes('Fixed in 3.21.2'));
 assert.deepEqual(snapshot,before);
 const old=runtimeCatalog.find(r=>r.version==='3.21.2');
 assert.throws(()=>previewInput(snapshot,old,TS),/Script 3\.21\.2 cannot apply enabled bidder rules\. Select 3\.22\.2 \(Preview\) or 3\.24\.0 \(Preview\) in Script setup and save, or turn off bidder rules\./);
});

async function checkedAccountPrebid(snapshot,version='11.11.0') {
 const {prebidRequirements,inspectPrebidArtifact,sha256}=await import('../../worker/runtime/prebid-artifact-check-v2.mjs');
 const required=prebidRequirements(previewInput(snapshot,descriptor,TS),JSON.parse(snapshot.config.config_json));
 assert.deepEqual(required.issues,[]);
 const bytes=new TextEncoder().encode(`/* prebid.js v${version}\nModules: ${required.modules.join(', ')} */\nvoid 0;`).buffer;
 const build={id:'checked',publisher_id:snapshot.site.id,status:'current',version,file_key:`publishers/${snapshot.site.id}/prebid-builds/checked/prebid.js`,modules_json:JSON.stringify(required.modules)};
 const object={size:bytes.byteLength,customMetadata:{sha256:await sha256(bytes),version},async arrayBuffer(){return bytes;}};
 const report=await inspectPrebidArtifact({siteId:snapshot.site.id,builds:[build],requirements:required},{async get(){return object;}});
 assert.equal(report.status,'checked',JSON.stringify(report.issues));
 return {bytes,report};
}
for (const mode of ['alias','custom','none','inherit']) test(`Prebid 9.18.0 generation gates only new account features: ${mode}`,async()=>{
 const snapshot=fixture();snapshot.overrides=[];
 const schain=mode==='custom'?{mode,config:{ver:'1.0',complete:1,nodes:[{asi:'seller.invalid',sid:'account',hp:1}]}}:{mode:mode==='none'?'none':'inherit'};
 snapshot.bidders=[{bidder:mode==='alias'?'adf_ag':'adf',enabled:1,params_json:'{"mid":111}',account_json:JSON.stringify({baseAdapter:'adf',schain})}];
 const args={snapshot,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:TS,prebid:await checkedAccountPrebid(snapshot,'9.18.0')};
 if(mode!=='inherit')await assert.rejects(buildArtifactCandidate(args),/Bidder aliases and per-account SChain require Prebid.js 10 or later/);
 else {const built=await buildArtifactCandidate(args);assert.equal(built.manifest.prebidBuild.version,'9.18.0');assert(!text(built.files['ads.js']).includes('__AD_BIDDER_ACCOUNTS'));}
});

for (const position of ['P1','m.box_1','__proto__']) test(`two-account package preserves parameters, chain policy and exact deal position ${position}`,async()=>{
 const {prebidRequirements}=await import('../../worker/runtime/prebid-artifact-check-v2.mjs');
 const snapshot=configure(fixture(),c=>{
  c.runtimeControls.schain={enabled:true,version:'1.0',complete:1,nodes:[{asi:'seller.invalid',sid:'site',hp:1}]};
  c.runtimeControls.deals={schemaVersion:1,entries:[{id:'agency',name:'Agency deal',bidder:'adf_ag',dealId:'fixture-deal',positions:[position],startsAt:'2026-01-01T00:00:00.000Z',endsAt:'2027-01-01T00:00:00.000Z',enabled:true,mode:'price'}]};
 });
 snapshot.bidders=[{bidder:'adf',enabled:1,params_json:'{"mid":111}',account_json:'{}'},
  {bidder:'adf_ag',enabled:1,params_json:'{"mid":222}',account_json:JSON.stringify({baseAdapter:'adf',displayName:'Agency',schain:{mode:'none'}})}];snapshot.overrides=[];
 snapshot.units.find(unit=>unit.code==='P1').code=position;
 const before=structuredClone(snapshot),input=previewInput(snapshot,descriptor,TS);
 const required=prebidRequirements(input,JSON.parse(snapshot.config.config_json));assert.deepEqual(required.issues,[]);
 assert(required.modules.includes('adfBidAdapter'));assert(!required.modules.includes('adf_agBidAdapter'));
 const built=await buildArtifactCandidate({snapshot,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:TS,prebid:await checkedAccountPrebid(snapshot)});
 const config=JSON.parse(text(built.files['config.json']));
 assert.deepEqual(config.bidderAccounts.map(a=>[a.bidder,a.baseAdapter,a.schain.mode]),[['adf','adf','inherit'],['adf_ag','adf','none']]);
 assert.deepEqual(config.core.bidders.map(a=>[a.bidder,a.params.mid]),[['adf',111],['adf_ag',222]]);
 assert.deepEqual(config.deals.entries[0].positions,[position]);
 const source=text(built.files['ads.js']),ast=parse(source,{ecmaVersion:2015});let deals;
 (function walk(node){if(!node||typeof node!=='object')return;if(node.type==='VariableDeclarator'&&node.id?.name==='TESSERA_DEALS')deals=node.init;for(const v of Object.values(node))if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);})(ast);
 assert(deals,'generated deal configuration');
 const {default:vm}=await import('node:vm');const emitted=vm.runInNewContext('('+source.slice(deals.start,deals.end)+')');
 assert.deepEqual(JSON.parse(JSON.stringify(emitted.entries[0].positions)),[position]);assert.equal(emitted.entries[0].bidder,'adf_ag');
 assert(source.includes('__AD_BIDDER_ACCOUNTS'));
 assert(source.includes('request: _adBidderRules.request'));
 assert.deepEqual(snapshot,before);
 for(const old of runtimeCatalog.filter(r=>!r.capabilities.includes('bidder-accounts')))assert.throws(()=>previewInput(snapshot,old,TS),/cannot apply bidder accounts \(adf_ag\)\. Select 3\.22\.2 \(Preview\) or 3\.24\.0 \(Preview\) in Script setup and save\./);
});
