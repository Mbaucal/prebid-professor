import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {unzipSync} from 'fflate';
import {parse} from 'acorn';
import {mainAbFixture} from '../support/ab-tests-main-fixture.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
import testWorker from '../../worker/test-workspace/index.mjs';
import {runtimeCatalog,previewInput,buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
import {runtime326Source} from '../../scripts/prepare-runtime326.mjs';
import {normalizeAdaptiveTimeout} from '../../shared/auction-timeout/settings.mjs';
import {packageDownload} from '../../worker/site-runtime/releases.mjs';
import {settingsForScript} from '../../worker/site-runtime/prebid-cache-settings.mjs';
import {runtime324Site} from './runtime324-site.mjs';
import {prebidRequirements,inspectPrebidArtifact,sha256} from '../../worker/runtime/prebid-artifact-check-v2.mjs';
const descriptor=runtimeCatalog.find(row=>row.version==='3.26.0'),stamp='20261120_120000',text=bytes=>new TextDecoder().decode(bytes),json=bytes=>JSON.parse(text(bytes));
test('historical named-script generators refuse an enabled unsupported adaptive policy',()=>{
 assert.throws(()=>settingsForScript({enablePrebid:true,adaptiveAuctionTimeout:{enabled:true}},30),/requires script 3\.26\.0/);
 assert.doesNotThrow(()=>settingsForScript({enablePrebid:true,adaptiveAuctionTimeout:{enabled:false}},30));
});

test('explicit new Preview retains every old release and full combined capability without changing the recommendation',async()=>{
 const old=JSON.parse(execFileSync('git',['show','f9cac007a1287ec1f108a8445a198f925d49ccbd:worker/runtime/runtime-releases.json'],{encoding:'utf8'}));
 assert.deepEqual(runtimeReleaseHistory.slice(1),old);assert.equal(descriptor.channel,'preview');assert.throws(()=>pinRuntime(descriptor),/explicit opt-in/);
 for(const capability of runtimeCatalog.find(row=>row.version==='3.25.1').capabilities)assert(descriptor.capabilities.includes(capability));
 assert(descriptor.capabilities.includes('adaptive-auction-timeout'));assert.equal((await runtime326Source(process.cwd())).codeSha256,descriptor.codeSha256);
 const oldSource=await import('../../scripts/prepare-runtime3251.mjs');assert.equal((await oldSource.runtime3251Source(process.cwd())).codeSha256,'e92b88fcb1ea6e48b1e7f4c92a6b78543e3682f6348833cfdefa072c593527c7');
});

for(const cache of [false,true])test(`complete combined artifact retains contracts, aliases, rules, maps and syntax (cache ${cache})`,async()=>{
 const snapshot=runtime324Site({cache}),config=json(new TextEncoder().encode(snapshot.config.config_json));config.adaptiveAuctionTimeout={enabled:true};snapshot.config.config_json=JSON.stringify(config);
 const before=structuredClone(snapshot),input=previewInput(snapshot,descriptor,stamp),requirements=prebidRequirements(input,config);
 const bytes=new TextEncoder().encode(`/* prebid.js v11.34.0\nModules: ${requirements.modules.join(', ')} */\nvoid 0;`).buffer;
 const build={id:'timeout-fixture',publisher_id:snapshot.site.id,status:'current',version:'11.34.0',file_key:`publishers/${snapshot.site.id}/prebid-builds/timeout-fixture/prebid.js`,modules_json:JSON.stringify(requirements.modules)};
 const object={size:bytes.byteLength,customMetadata:{sha256:await sha256(bytes),version:'11.34.0'},arrayBuffer:async()=>bytes};
 const report=await inspectPrebidArtifact({siteId:snapshot.site.id,builds:[build],requirements},{get:async()=>object});assert.equal(report.status,'checked');
 const result=await buildArtifactCandidate({snapshot,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:stamp,prebid:{bytes,report}});
 assert.deepEqual(snapshot,before);assert(result.files&&result.manifest,'Catalog dispatch must call the artifact builder');
 const output=json(result.files['config.json']);assert.equal(output.runtime.runtimeVersion,'3.26.0');assert.equal(output.bidderRules.enabled,true);assert(output.bidderAccounts.some(x=>x.bidder==='pm_ag'));assert.equal(output.contextualSignals.enabled,true);
 assert.deepEqual(output.adaptiveAuctionTimeout,normalizeAdaptiveTimeout({enabled:true}));assert.equal(!!output.bidCache,cache);
 assert(result.files['deals-plan.json']&&result.files['gam-reporting.json']);assert(!result.files['adaptive-timeout.json'],'Keep the established complete package inventory');
 assert(text(result.files['README.txt']).includes('publisher RTD'));assert(json(result.files['gam-reporting.json']).keys.aq_bid_origin);
 for(const file of ['ads.js','ads.min.js'])parse(text(result.files[file]),{ecmaVersion:2015});
 for(const [name,metadata]of Object.entries(result.manifest.files))assert.equal(await sha256(result.files[name]),metadata.sha256);
});

test('authenticated MAIN selection, revision-safe save and complete Generate/read/download preserve old ZIPs and other sites',async()=>{
 const h=await mainAbFixture();try{
  const endpoint='/api/publishers/alpha-site/builtin-site-settings',packages='/api/publishers/alpha-site/builtin-releases';
  const zipFor=async id=>new Uint8Array(await(await packageDownload(h.f.env,'alpha-site',id)).arrayBuffer());
  const oldId=h.versions['alpha-site'][0],oldZip=await zipFor(oldId);
  const beta=h.f.sqlite.prepare("SELECT config_json FROM publisher_configs WHERE publisher_id='beta-site'").get().config_json;
  let state=await h.json(endpoint);assert.equal(state.adaptiveTimeout.policy.enabled,false);assert.equal(state.adaptiveTimeout.supported,false);
  const before=h.persistent();await h.json(endpoint,{method:'POST',body:{action:'auction-timeout',revision:state.revision,policy:{enabled:true}}},422);assert.equal(h.persistent(),before);
  const selected=state.runtimes.find(x=>x.version==='3.26.0');await h.json(endpoint,{method:'POST',body:{action:'version',revision:state.revision,runtime:selected.pin,allowPreview:true}});
  state=await h.json(endpoint);assert.equal(state.adaptiveTimeout.supported,true);assert.equal(state.adaptiveTimeout.policy.enabled,false);
  const staleRevision=state.revision;await h.json(endpoint,{method:'POST',body:{action:'auction-timeout',revision:state.revision,policy:{enabled:true,minMs:900,maxMs:3600}}});
  state=await h.json(endpoint);assert.equal(state.adaptiveTimeout.policy.enabled,true);assert.equal(state.adaptiveTimeout.policy.minMs,900);
  const saved=h.persistent();await h.json(endpoint,{method:'POST',body:{action:'auction-timeout',revision:staleRevision,policy:{enabled:false}}},409);assert.equal(h.persistent(),saved);
  await h.json(endpoint,{method:'POST',body:{action:'version',revision:state.revision,runtime:state.runtimes.find(x=>x.version==='3.25.1').pin,allowPreview:true}},422);assert.equal(h.persistent(),saved);
  const listing=await h.json(packages),generated=await h.json(packages,{method:'POST',body:{action:'generate',revision:listing.revision,notes:'Adaptive timeout synthetic test'}},201);
  const inventory=await h.json(`${packages}/${generated.release.id}/index`);assert.equal(inventory.descriptor.releaseId,generated.release.id);
  const servedConfig=await h.json(`${packages}/${generated.release.id}/files/config.json`);assert.equal(servedConfig.adaptiveAuctionTimeout.maxMs,3600);
  const zip=unzipSync(await zipFor(generated.release.id));
  assert.equal(json(zip['manifest.json']).completeRelease,true);assert.equal(json(zip['manifest.json']).runtime.runtimeVersion,'3.26.0');assert.equal(json(zip['config.json']).adaptiveAuctionTimeout.maxMs,3600);assert(zip['deals-plan.json']);
  assert.deepEqual(await zipFor(oldId),oldZip);assert.equal(h.f.sqlite.prepare("SELECT config_json FROM publisher_configs WHERE publisher_id='beta-site'").get().config_json,beta);
  assert.equal((await h.request(endpoint,{method:'POST',auth:false,body:{}})).status,401);
  assert.equal((await h.request(endpoint,{method:'POST',origin:'https://foreign.invalid',body:{}})).status,403);
 }finally{h.close();}
});

test('isolated TEST authenticated editor selects, saves and generates 3.26 without changing earlier saved release bytes',async()=>{
 const f=workspaceStore();try{
  const login=await testWorker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);const cookie=login.headers.get('set-cookie').split(';')[0];
  const request=(path,body,origin=ORIGIN)=>testWorker.fetch(new Request(ORIGIN+path,{method:body?'POST':'GET',headers:{cookie,origin,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),f.env);
  const api=async(path,body,expected=200)=>{const r=await request(path,body),value=await r.json();assert.equal(r.status,expected,JSON.stringify(value));return value;};
  await api('/test-api/setup',{confirm:'prepare-empty-test-database'});
  const old=await api('/test-api/generate',{acknowledge:true});await api('/test-api/save',{receipt:old.receipt,acknowledge:true,note:'Original TEST package'});
  const objects=Object.fromEntries([...f.objects].map(([key,bytes])=>[key,bytes.slice()]));
  let state=await api('/test-api/site-runtime');const runtime=state.runtimes.find(x=>x.version==='3.26.0');
  await api('/test-api/site-runtime',{action:'version',revision:state.revision,runtime:runtime.pin,allowPreview:true});state=await api('/test-api/site-runtime');
  await api('/test-api/site-runtime',{action:'auction-timeout',revision:state.revision,policy:{enabled:true}});
  const generated=await api('/test-api/generate',{acknowledge:true});assert.equal(generated.descriptor.runtime.runtimeVersion,'3.26.0');assert(generated.adsJs.includes('__AD_AUCTION_TIMEOUT'));
  await api('/test-api/save',{receipt:generated.receipt,acknowledge:true,note:'Adaptive TEST package'});
  for(const [key,bytes]of Object.entries(objects))assert.deepEqual(f.objects.get(key),bytes,key);
  assert.equal((await request('/test-api/site-runtime',{action:'auction-timeout',revision:state.revision,policy:{enabled:false}},'https://foreign.invalid')).status,403);
 }finally{f.close();}
});
