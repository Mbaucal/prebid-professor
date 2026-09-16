import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {workspaceStore} from '../support/test-workspace-store.mjs';
import {siteRuntimeSettings,changeSiteRuntime} from '../../worker/site-runtime/service.mjs';
import {generatePackage,packageDownload,readPackage,changePackageChannel,channelRevision,builtInCdn,packageResponse,packageState} from '../../worker/site-runtime/releases.mjs';
import {verifyPackage,verifyPublicPackage,scriptsDelivery} from '../../scripts/pages-release-verification.mjs';
import {sha256} from '../../worker/runtime/prebid-artifact-check.mjs';
import {deploymentManifestPin} from '../../worker/deployment-manifest-pin.mjs';
const fixtures=[];test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
async function fixture(){const f=workspaceStore();fixtures.push(f);f.sqlite.exec(readFileSync('migrations/0001_initial.sql','utf8').split('INSERT OR IGNORE INTO publishers')[0]);
 f.sqlite.prepare("INSERT INTO publishers(id,name,domain,gam_path) VALUES('first','First','first.invalid','/123/first/')").run();
 f.sqlite.prepare("INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES('cfg','first',?)").run(JSON.stringify({enablePrebid:false,runtimeControls:{sticky:{bottomAdUnitId:''},floors:{enabled:false},output:{cleanComments:true}}}));
 f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,sort_order) VALUES('unit','first','Billboard','ATF','display',0)").run();
 f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('map','first','display',?)").run('[{"viewport":[0,0],"sizes":[[300,250]]}]');
 f.sqlite.prepare("INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES('rule','first','__DEFAULT__',?)").run('{"timeout":1500,"refresh":{"enabled":false}}');
 const objects=new Map();f.objects=objects;f.env.BUILDS={async get(k){const o=objects.get(k);return o?{size:o.bytes.length,customMetadata:o.meta,arrayBuffer:async()=>o.bytes.slice().buffer}:null;},async put(k,b,opt){assert.equal(opt.onlyIf.get('if-none-match'),'*');if(objects.has(k))return null;objects.set(k,{bytes:new Uint8Array(b).slice(),meta:opt.customMetadata});return {};}};
 const s=await siteRuntimeSettings(f.env,'first');await changeSiteRuntime(f.env,'first','tester',{action:'version',revision:s.revision,runtime:s.runtimes[0].pin,allowPreview:true});return f;}
async function generate(f,note='First package'){const s=await siteRuntimeSettings(f.env,'first');return (await generatePackage(f.env,'first','tester',{revision:s.revision,notes:note})).release;}
async function promote(f,id,action){return changePackageChannel(f.env,'first',id,'tester',action,{acknowledge:true,channelRevision:await channelRevision(f.env,'first')});}
test('release setup explains the missing file before version selection and keeps saved packages accessible',async()=>{
 const f=await fixture(),release=await generate(f);
 const config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);
 delete config.builtinRuntimeSelection;config.enablePrebid=true;
 f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
 let s=await packageState(f.env,'first');
 assert.equal(s.ready,false);assert.equal(s.nextStep,'prebid');assert.match(s.error,/No current Prebid file/);
 assert.doesNotMatch(s.error,/generator profile|missing .*BidAdapter/);assert.equal(s.releases[0].id,release.id);
 config.enablePrebid=false;f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
 s=await packageState(f.env,'first');assert.equal(s.ready,false);assert.equal(s.nextStep,'versions');assert.match(s.error,/no template is needed/);
 const versions=await siteRuntimeSettings(f.env,'first');
 await changeSiteRuntime(f.env,'first','tester',{action:'version',revision:versions.revision,runtime:versions.runtimes[0].pin,allowPreview:true});
 s=await packageState(f.env,'first');assert.equal(s.ready,true);assert.equal(s.nextStep,null);assert.equal(s.error,null);
});
test('built-in Generate stores original package; channels and rollback reuse its exact bytes',async()=>{
 const f=await fixture(),settings=f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json;
 const a=await generate(f);assert.equal(a.status,'draft');assert.equal(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json,settings);
 const original=await readPackage(f.env,'first',a.id);assert.deepEqual(original.files['ads.js'],original.files['ads.min.js']);
 const verified=await verifyPackage(original.files,{site_id:'first',release_id:a.id,release_version:a.id});assert.equal(verified.builtinDraft,false);
 assert.equal(await deploymentManifestPin(f.env.BUILDS,'first',original.release),verified.manifestSha256);
 await assert.rejects(promote(f,a.id,'production'),/Stage/);await promote(f,a.id,'staging');await promote(f,a.id,'production');
 const served=await builtInCdn(new Request('https://tessera.invalid/cdn/first/current/ads.js'),f.env);assert.deepEqual(new Uint8Array(await served.arrayBuffer()),original.files['ads.js']);
 f.sqlite.prepare("UPDATE unit_rules SET rule_json='{\"timeout\":1700,\"refresh\":{\"enabled\":false}}'").run();
 const b=await generate(f,'New timeout');assert.notEqual(b.id,a.id);await promote(f,b.id,'staging');await promote(f,b.id,'production');await promote(f,a.id,'rollback');
 assert.equal(f.sqlite.prepare('SELECT current_release_id FROM publishers').get().current_release_id,a.id);
 assert.deepEqual((await readPackage(f.env,'first',a.id)).files,original.files);
 assert.equal((await packageDownload(f.env,'first',a.id)).status,200);
 assert.match(f.sqlite.prepare('SELECT rule_json FROM unit_rules').get().rule_json,/1700/);
});
test('corrupt files and cross-site IDs cannot publish; concurrent channel changes are rejected',async()=>{
 const f=await fixture(),a=await generate(f);await assert.rejects(readPackage(f.env,'second',a.id));
 const revision=await channelRevision(f.env,'first');await promote(f,a.id,'staging');await assert.rejects(changePackageChannel(f.env,'first',a.id,'tester','production',{acknowledge:true,channelRevision:revision}),/changed/);
 f.objects.get(`publishers/first/releases/${a.id}/ads.js`).bytes=new TextEncoder().encode('corrupt');await assert.rejects(promote(f,a.id,'production'),/missing|checksum/);
 assert.equal(f.sqlite.prepare('SELECT status FROM releases').get().status,'staging');
});
test('snapshot change during upload cannot register a release or audit',async()=>{
 const f=await fixture(),put=f.env.BUILDS.put;let changed=false;
 f.env.BUILDS.put=async(...args)=>{const r=await put(...args);if(!changed){changed=true;f.sqlite.prepare("UPDATE ad_units SET enabled=0").run();}return r;};
 await assert.rejects(generate(f),/Settings changed/);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM releases').get().n,0);
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM audit_log WHERE action='builtin_release.generated'").get().n,0);
});
test('complete Prebid package keeps the uploaded file and passes Pages source verification',async()=>{
 const f=await fixture();
 const bytes=new TextEncoder().encode('/* prebid.js v11.11.0\nModules: consentManagementTcf, tcfControl, currency, adformBidAdapter */\nwindow.prebidFixtureOnly=true;');
 const path='publishers/first/prebid-builds/original/prebid.js';f.objects.set(path,{bytes,meta:{sha256:await sha256(bytes)}});
 f.sqlite.prepare("INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES('original','first','11.11.0',?,?, 'current')").run(path,JSON.stringify(['adformBidAdapter','consentManagementTcf','currency','tcfControl']));
 f.sqlite.prepare("INSERT INTO bidders(id,publisher_id,bidder,params_json,enabled) VALUES('bidder','first','adform','{\"mid\":123}',1)").run();
 const config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);config.enablePrebid=true;f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
 const s=await siteRuntimeSettings(f.env,'first');await changeSiteRuntime(f.env,'first','tester',{action:'version',revision:s.revision,runtime:s.runtimes[0].pin,allowPreview:true});
 const release=await generate(f),p=await readPackage(f.env,'first',release.id);assert.deepEqual(p.files['prebid.js'],bytes);
 await verifyPackage(p.files,{site_id:'first',release_id:release.id,release_version:release.id});
});

test('download errors keep the JSON API contract',async()=>{
 const f=await fixture();
 const response=await packageResponse(new Request('https://tessera.invalid/api/packages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'download',releaseId:'unknown'})}),f.env,'first','tester');
 assert.equal(response.status,404);assert.match(response.headers.get('content-type'),/application\/json/);assert.match((await response.json()).error,/Unknown/);
});

test('compact delivery verifies one or two public scripts and keeps the source manifest pin',async()=>{
 const f=await fixture(),release=await generate(f),p=await readPackage(f.env,'first',release.id);
 const source=await verifyPackage(p.files,{site_id:'first',release_id:release.id,release_version:release.version});
 const compact=scriptsDelivery(source);assert.equal(compact.manifestSha256,source.manifestSha256);
 const fetcher=async url=>new Response(p.files[new URL(url).pathname.slice(1)],{headers:{'content-type':'application/javascript','access-control-allow-origin':'*','x-content-type-options':'nosniff','cache-control':'no-store'}});
 assert.equal((await verifyPublicPackage('https://0123abcd.first.pages.dev','first',compact,fetcher)).fileCount,1);
 await assert.rejects(verifyPublicPackage('https://0123abcd.first.pages.dev','first',{...compact,files:[]},fetcher));
 await assert.rejects(verifyPublicPackage('https://0123abcd.first.pages.dev','first',{...compact,manifestSha256:''},fetcher));
 p.files['prebid.js']=new TextEncoder().encode('original prebid bytes');
 compact.files.push({name:'prebid.js',byteSize:p.files['prebid.js'].length,sha256:await sha256(p.files['prebid.js'])});
 assert.equal((await verifyPublicPackage('https://0123abcd.first.pages.dev','first',compact,fetcher)).fileCount,2);
});
test('registered draft source URLs support preview jobs and read only the requested artifact',async()=>{
 const f=await fixture(),release=await generate(f),get=f.env.BUILDS.get,reads=[];
 f.env.BUILDS.get=async key=>{reads.push(key);return get(key);};
 const base=`https://tessera.invalid/cdn/first/releases/${release.id}/`;
 const manifest=await builtInCdn(new Request(base+'manifest.json'),f.env);assert.equal(manifest.status,200);assert.equal(reads.length,1);
 reads.length=0;const script=await builtInCdn(new Request(base+'ads.js'),f.env);assert.equal(script.status,200);assert.equal(reads.length,2);
 assert.equal(await builtInCdn(new Request('https://tessera.invalid/cdn/first/current/ads.js'),f.env),null);
 assert.equal(f.sqlite.prepare('SELECT status FROM releases').get().status,'draft');
});

test('channel lookup failure preserves legacy fallback but immutable built-in failures remain closed',async()=>{
 const env={DB:{withSession(){throw Error('D1 unavailable');}}};
 assert.equal(await builtInCdn(new Request('https://tessera.invalid/cdn/first/current/ads.js'),env),null);
 await assert.rejects(builtInCdn(new Request('https://tessera.invalid/cdn/first/releases/builtin-release-'+ 'a'.repeat(64)+'/ads.js'),env),/D1 unavailable/);
});
test('monitoring follows the immutable production package after publishing and rollback',async()=>{
 const {getMonitoringStatus}=await import('../../worker/monitoring-readonly.ts');
 const f=await fixture(),a=await generate(f);await promote(f,a.id,'staging');await promote(f,a.id,'production');
 const get=f.env.BUILDS.get;f.env.BUILDS.get=async key=>{const o=await get(key);return o?{...o,text:async()=>new TextDecoder().decode(await o.arrayBuffer())}:null;};
 f.env.BUILDS.head=async key=>get(key);
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('google.com, 123, DIRECT',{headers:{'content-type':'text/plain'}});
 try{
  const inspect=async id=>{const response=await getMonitoringStatus(new Request('https://tessera.invalid/api/monitor'),f.env,'first');assert.equal(response.status,200);const data=await response.json();assert.equal(data.runtime.manifestVersion,id);assert.equal(data.runtime.versionMatches,true);assert.equal(data.runtime.artifacts.filter(a=>a.required&&!a.found).length,0);};
  await inspect(a.id);f.sqlite.prepare("UPDATE unit_rules SET rule_json='{\"timeout\":1800,\"refresh\":{\"enabled\":false}}'").run();
  const b=await generate(f);await promote(f,b.id,'staging');await promote(f,b.id,'production');await inspect(b.id);await promote(f,a.id,'rollback');await inspect(a.id);
 }finally{globalThis.fetch=originalFetch;}
});

test('main browser ZIP uses scoped artifact reads, preserves stored bytes and refuses wrong-site/corrupt packages',async()=>{
 const {packageAssetResponse}=await import('../../worker/site-runtime/releases.mjs');
 const {downloadStoredPackage}=await import('../../src/download/saved-package.mjs');
 const {unzipSync}=await import('fflate');
 const {default:mainWorker}=await import('../../worker/app-builtin-runtime-preview.ts');
 const {handleLogin}=await import('../../worker/auth.ts');
 const {TEST_EMAIL,TEST_PASSWORD,TEST_SECRET}=await import('../support/test-workspace-store.mjs');
 const f=await fixture(),release=await generate(f),original=await readPackage(f.env,'first',release.id);
 Object.assign(f.env,{ADMIN_EMAIL:TEST_EMAIL,ADMIN_PASSWORD:TEST_PASSWORD,SESSION_SECRET:TEST_SECRET});
 const login=await handleLogin(new Request('https://tessera.invalid/api/auth/login',{method:'POST',headers:{origin:'https://tessera.invalid','content-type':'application/json'},body:JSON.stringify({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const get=f.env.BUILDS.get,reads=[];f.env.BUILDS.get=async key=>{reads.push(key);return get(key);};
 const base=`https://tessera.invalid/api/publishers/first/builtin-releases/${release.id}`;
 assert.equal((await mainWorker.fetch(new Request(base+'/index'),f.env,{})).status,401);
 assert.equal((await mainWorker.fetch(new Request(base+'/files/README.txt'),f.env,{})).status,401);
 assert.equal(reads.length,0);
 const index=await mainWorker.fetch(new Request(base+'/index',{headers:{cookie}}),f.env,{});
 assert.equal(index.status,200);assert.equal(reads.length,1);
 const readme=await mainWorker.fetch(new Request(`https://tessera.invalid/cdn/first/releases/${release.id}/README.txt`),f.env,{});
 assert.equal(readme.status,200);assert.deepEqual(new Uint8Array(await readme.arrayBuffer()),original.files['README.txt']);
 const descriptor=(await index.json()).descriptor;assert.equal(descriptor.siteId,'first');assert.equal(descriptor.files.length,9);
 assert.equal((await packageAssetResponse(new Request(base+'/index'),f.env,'second',release.id,null)).status,404);
 assert.equal((await packageAssetResponse(new Request(base+'/index',{method:'POST'}),f.env,'first',release.id,null)).status,405);
 const saved={fetch:globalThis.fetch,document:globalThis.document,create:URL.createObjectURL,revoke:URL.revokeObjectURL,timeout:globalThis.setTimeout};
 let blob,clicks=0,wrongSite=false;
 globalThis.fetch=async url=>{
  assert.ok(url.startsWith(new URL(base).pathname));reads.length=0;
  const name=url.endsWith('/index')?null:url.split('/').pop();
  const response=await mainWorker.fetch(new Request('https://tessera.invalid'+url,{headers:{cookie}}),f.env,{});
  assert.ok(reads.length<=(name?2:1),'each HTTP request reads at most manifest + requested file');
  return wrongSite?Response.json({descriptor:{...descriptor,siteId:'second'}}):response;
 };
 globalThis.document={body:{append(){}},createElement(){return {click(){clicks++},remove(){}}}};
 URL.createObjectURL=value=>{blob=value;return 'blob:local'};URL.revokeObjectURL=()=>{};globalThis.setTimeout=fn=>{fn();return 0};
 try{
  await downloadStoredPackage(release.id,()=>{},{siteId:'first'});assert.equal(clicks,1);
  const files=unzipSync(new Uint8Array(await blob.arrayBuffer()));assert.deepEqual(files,original.files);
  wrongSite=true;await assert.rejects(downloadStoredPackage(release.id,()=>{},{siteId:'first'}),/inventory/);assert.equal(clicks,1);
  wrongSite=false;f.objects.get(`publishers/first/releases/${release.id}/ads.js`).bytes[0]^=1;
  await assert.rejects(downloadStoredPackage(release.id,()=>{},{siteId:'first'}),/Could not download/);assert.equal(clicks,1);
  assert.equal(f.sqlite.prepare('SELECT status FROM releases').get().status,'draft');
 }finally{Object.assign(globalThis,{fetch:saved.fetch,document:saved.document,setTimeout:saved.timeout});URL.createObjectURL=saved.create;URL.revokeObjectURL=saved.revoke;}
});

test('saved site-demand TakeOver cannot generate after Prebid is disabled, and can be explicitly repaired',async()=>{
 const {packageState}=await import('../../worker/site-runtime/releases.mjs');
 const {siteRuntimeBundle}=await import('../../worker/site-runtime/service.mjs');
 const {defaultOverlay}=await import('../../worker/runtime-next/position-settings.mjs');
 const f=await fixture(),config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);
 // This is also the state left by an older demand-mode editor switching Prebid off.
 config.runtimeControls.adPositions={Billboard:{...defaultOverlay(),demand:'site'}};
 config.enablePrebid=false;config.builtinRuntimeSelection.prebid=null;
 f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
 const before=f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json;
 let state=await siteRuntimeSettings(f.env,'first');assert.match(state.validationIssue,/Prebid \+ GAM/);
 assert.equal((await packageState(f.env,'first')).ready,false);
 await assert.rejects(generate(f),/saved settings are not supported/);
 await assert.rejects(siteRuntimeBundle(f.env,'first',{action:'bundle',revision:state.revision,acknowledge:true}),/saved settings are not supported/);
 await assert.rejects(changeSiteRuntime(f.env,'first','tester',{action:'version',revision:state.revision,runtime:state.runtimes[0].pin,allowPreview:true}),/saved settings are not supported/);
 assert.equal(f.objects.size,0);assert.equal(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json,before);
 await changeSiteRuntime(f.env,'first','tester',{action:'position',revision:state.revision,position:{code:'Billboard',display:'takeover',overlay:{...defaultOverlay(),demand:'gam'},lazy:null}});
 assert.equal((await packageState(f.env,'first')).ready,true);
});

test('first built-in publication retains the prior legacy release and its existing rollback route',async()=>{
 const {packageState}=await import('../../worker/site-runtime/releases.mjs');
 const {default:mainWorker}=await import('../../worker/app-builtin-runtime-preview.ts');
 const {handleLogin}=await import('../../worker/auth.ts');
 const {TEST_EMAIL,TEST_PASSWORD,TEST_SECRET}=await import('../support/test-workspace-store.mjs');
 const f=await fixture(),release=await generate(f),builtin=await readPackage(f.env,'first',release.id);
 const version='20260901_120000',legacyId='legacy-live',prefix=`publishers/first/releases/${version}/`;
 f.sqlite.prepare("INSERT INTO releases(id,publisher_id,version,status,manifest_key,created_at,published_at) VALUES(?,'first',?,'production',?,'2000-01-01','2000-01-02')").run(legacyId,version,prefix+'manifest.json');
 f.sqlite.prepare("UPDATE publishers SET current_release_id=?,current_version=? WHERE id='first'").run(legacyId,version);
 for(let i=0;i<51;i++)f.sqlite.prepare("INSERT INTO releases(id,publisher_id,version,status) VALUES(?,'first',?,'draft')").run('old-draft-'+i,'older-package-'+i);
 for(const [id,action] of [['legacy-earlier','release.production_published'],['legacy-restored','release.rolled_back']]){
  f.sqlite.prepare("INSERT INTO releases(id,publisher_id,version,status,created_at) VALUES(?,'first',?,'archived','1999-01-01')").run(id,id);
  f.sqlite.prepare("INSERT INTO audit_log(id,actor,action,publisher_id,entity_type,entity_id,details_json) VALUES(?,'tester',?,'first','release',?,'{}')").run(id+'-audit',action,id);
 }
 const legacyFiles={};
 for(const name of ['ads.js','ads.min.js','prebid.js','config.json','manifest.json','min-height.css','sticky.css','div-export.csv','implementation.html']){
  const bytes=new TextEncoder().encode(name==='manifest.json'?JSON.stringify({version,siteId:'first'}):'saved legacy '+name);
  legacyFiles[name]=bytes;f.objects.set(prefix+name,{bytes,meta:{sha256:await sha256(bytes)}});
 }
 const settings=f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json;
 await promote(f,release.id,'staging');await promote(f,release.id,'production');
 const earlier=(await packageState(f.env,'first')).earlierReleases;
 assert.equal(earlier.length,50);assert.equal(earlier[0].id,legacyId);assert.equal(earlier[0].canRestore,true);assert.deepEqual(earlier.slice(1,3).map(r=>r.id).sort(),['legacy-earlier','legacy-restored']);assert.ok(earlier.slice(1,3).every(r=>r.canRestore));
 const rawGet=f.env.BUILDS.get;
 f.env.BUILDS.get=async key=>{const o=await rawGet(key);if(!o)return null;const bytes=new Uint8Array(await o.arrayBuffer());return {...o,body:bytes,httpEtag:'"fixture"',text:async()=>new TextDecoder().decode(bytes),writeHttpMetadata(headers){headers.set('content-type','application/javascript');}};};
 let copies=0;f.env.BUILDS.put=async(key,bytes,options)=>{
  assert.ok(key.startsWith('publishers/first/current/'));
  const current=await builtInCdn(new Request('https://tessera.invalid/cdn/first/current/ads.js'),f.env);
  assert.deepEqual(new Uint8Array(await current.arrayBuffer()),builtin.files['ads.js'],'active built-in stays intact while old files are prepared');
  copies++;f.objects.set(key,{bytes:new Uint8Array(bytes),meta:options.customMetadata});
 };
 Object.assign(f.env,{ADMIN_EMAIL:TEST_EMAIL,ADMIN_PASSWORD:TEST_PASSWORD,SESSION_SECRET:TEST_SECRET});
 const login=await handleLogin(new Request('https://tessera.invalid/api/auth/login',{method:'POST',headers:{origin:'https://tessera.invalid','content-type':'application/json'},body:JSON.stringify({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const response=await mainWorker.fetch(new Request(`https://tessera.invalid/api/publishers/first/releases/${legacyId}/rollback`,{method:'POST',headers:{cookie,origin:'https://tessera.invalid'}}),f.env,{});
 assert.equal(response.status,200,await response.text());assert.equal(copies,9);
 assert.equal(f.sqlite.prepare("SELECT current_release_id FROM publishers WHERE id='first'").get().current_release_id,legacyId);
 assert.equal(f.sqlite.prepare('SELECT status FROM releases WHERE id=?').get(release.id).status,'archived');
 const current=await mainWorker.fetch(new Request('https://tessera.invalid/cdn/first/current/ads.js'),f.env,{});
 assert.equal(current.status,200);assert.deepEqual(new Uint8Array(await current.arrayBuffer()),legacyFiles['ads.js']);
 assert.equal(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json,settings);
 assert.deepEqual((await readPackage(f.env,'first',release.id)).files,builtin.files);
});

test('main demand-mode API rejects TakeOver conflicts, synchronizes the exact Prebid pin and preserves concurrent settings',async()=>{
 const {default:mainWorker}=await import('../../worker/app-builtin-runtime-preview.ts');
 const {packageState}=await import('../../worker/site-runtime/releases.mjs');
 const {defaultOverlay}=await import('../../worker/runtime-next/position-settings.mjs');
 const {TEST_EMAIL,TEST_PASSWORD,TEST_SECRET}=await import('../support/test-workspace-store.mjs');
 const f=await fixture();Object.assign(f.env,{ADMIN_EMAIL:TEST_EMAIL,ADMIN_PASSWORD:TEST_PASSWORD,SESSION_SECRET:TEST_SECRET});
 const login=await mainWorker.fetch(new Request('https://tessera.invalid/api/auth/login',{method:'POST',headers:{origin:'https://tessera.invalid','content-type':'application/json'},body:JSON.stringify({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env,{});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const mode=enabled=>mainWorker.fetch(new Request('https://tessera.invalid/api/publishers/first/prebid-mode',{method:'PUT',headers:{cookie,origin:'https://tessera.invalid','content-type':'application/json'},body:JSON.stringify({enabled})}),f.env,{});
 const bytes=new TextEncoder().encode('/* prebid.js v11.11.0\nModules: consentManagementTcf,tcfControl,currency,adformBidAdapter */\nwindow.fixtureOnly=true;');
 const path='publishers/first/prebid-builds/original/prebid.js';f.objects.set(path,{bytes,meta:{sha256:await sha256(bytes)}});
 f.sqlite.prepare("INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES('original','first','11.11.0',?,?, 'current')").run(path,JSON.stringify(['adformBidAdapter','consentManagementTcf','currency','tcfControl']));
 f.sqlite.prepare("INSERT INTO bidders(id,publisher_id,bidder,params_json,enabled) VALUES('bidder','first','adform','{\"mid\":123}',1)").run();
 let response=await mode(true);assert.equal(response.status,200,await response.text());
 let s=await siteRuntimeSettings(f.env,'first');
 await changeSiteRuntime(f.env,'first','tester',{action:'position',revision:s.revision,position:{code:'Billboard',display:'takeover',overlay:{...defaultOverlay(),demand:'site'},lazy:null}});
 const before=f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json;
 const auditCount=()=>f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n;
 let audits=auditCount();response=await mode(false);assert.equal(response.status,422);assert.match(await response.text(),/GAM only before disabling/);
 assert.equal(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json,before);assert.equal(auditCount(),audits);
 s=await siteRuntimeSettings(f.env,'first');await changeSiteRuntime(f.env,'first','tester',{action:'position',revision:s.revision,position:{code:'Billboard',display:'takeover',overlay:{...defaultOverlay(),demand:'gam'},lazy:null}});
 response=await mode(false);assert.equal(response.status,200,await response.text());
 let config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);
 assert.equal(config.enablePrebid,false);assert.equal(config.builtinRuntimeSelection.prebid,null);assert.equal((await packageState(f.env,'first')).ready,true);
 const transitions=f.sqlite.prepare("SELECT actor,entity_type,entity_id,details_json FROM audit_log WHERE action='prebid_mode.updated' ORDER BY rowid").all();
 assert.equal(transitions.length,2);assert.equal(transitions[1].entity_type,'prebid_mode');assert.equal(transitions[1].entity_id,'first');assert.ok(transitions[1].actor);
 assert.deepEqual(JSON.parse(transitions[1].details_json),{previousEnabled:true,enabled:false,mode:'gam-adx-only',savedBidderConfigurationPreserved:true});
 assert.deepEqual(JSON.parse(transitions[0].details_json),{previousEnabled:false,enabled:true,mode:'gam-prebid',savedBidderConfigurationPreserved:true});
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM bidders').get().n,1);assert.deepEqual(f.objects.get(path).bytes,bytes);
 response=await mode(true);assert.equal(response.status,200,await response.text());
 config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);assert.equal(config.builtinRuntimeSelection.prebid.sha256,await sha256(bytes));
 const batch=f.env.DB.batch;audits=auditCount();
 f.env.DB.batch=async items=>{if(items.some(item=>item.sql.startsWith('UPDATE publisher_configs'))){const next=structuredClone(config);next.runtimeControls.adPositions.Billboard.demand='site';f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(next));}return batch(items);};
 response=await mode(false);assert.equal(response.status,409,await response.text());assert.equal(auditCount(),audits);
 config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);assert.equal(config.enablePrebid,true);assert.equal(config.runtimeControls.adPositions.Billboard.demand,'site');
});

test('legacy demand-mode writer cannot discard a concurrently saved built-in runtime selection',async()=>{
 const {updatePrebidMode}=await import('../../worker/prebid-mode.ts');const f=await fixture();
 const chosen=f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json;
 const legacy=JSON.parse(chosen);delete legacy.builtinRuntimeSelection;
 f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(legacy));
 const audits=f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n,batch=f.env.DB.batch;
 f.env.DB.batch=async items=>{f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(chosen);return batch(items);};
 const response=await updatePrebidMode(new Request('https://tessera.invalid/api/mode',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:false})}),f.env,'first');
 assert.equal(response.status,409,await response.text());assert.equal(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json,chosen);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n,audits);
});

test('main Prebid activation updates the runtime pin atomically and rejects corrupt or concurrent replacements',async()=>{
 const {default:mainWorker}=await import('../../worker/app-builtin-runtime-preview.ts');
 const {packageState}=await import('../../worker/site-runtime/releases.mjs');
 const {TEST_EMAIL,TEST_PASSWORD,TEST_SECRET}=await import('../support/test-workspace-store.mjs');
 const f=await fixture();Object.assign(f.env,{ADMIN_EMAIL:TEST_EMAIL,ADMIN_PASSWORD:TEST_PASSWORD,SESSION_SECRET:TEST_SECRET});
 f.env.BUILDS.head=async key=>{const o=f.objects.get(key);return o?{size:o.bytes.length,customMetadata:o.meta}:null;};
 const login=await mainWorker.fetch(new Request('https://tessera.invalid/api/auth/login',{method:'POST',headers:{origin:'https://tessera.invalid','content-type':'application/json'},body:JSON.stringify({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env,{});
 const cookie=login.headers.get('set-cookie').split(';')[0],headers={cookie,origin:'https://tessera.invalid','content-type':'application/json'};
 const mode=enabled=>mainWorker.fetch(new Request('https://tessera.invalid/api/publishers/first/prebid-mode',{method:'PUT',headers,body:JSON.stringify({enabled})}),f.env,{});
 const activate=id=>mainWorker.fetch(new Request(`https://tessera.invalid/api/publishers/first/prebid-builds/${id}/activate`,{method:'POST',headers}),f.env,{});
 const modules=['adformBidAdapter','consentManagementTcf','currency','tcfControl'];
 f.sqlite.prepare("INSERT INTO bidders(id,publisher_id,bidder,params_json,enabled) VALUES('bidder','first','adform','{\"mid\":123}',1)").run();
 for(const [id,version,status] of [['original','11.11.0','current'],['replacement','11.34.0','archived'],['broken','11.34.0','archived']]){
  const bytes=new TextEncoder().encode(`/* prebid.js v${version}\nModules: ${modules.join(',')} */\nwindow.fixtureOnly=true;`),path=`publishers/first/prebid-builds/${id}/prebid.js`;
  f.objects.set(path,{bytes,meta:{sha256:await sha256(bytes)}});
  f.sqlite.prepare('INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES(?,?,?,?,?,?)').run(id,'first',version,path,JSON.stringify(modules),status);
 }
 let response=await mode(true);assert.equal(response.status,200,await response.text());
 const originalRelease=await generate(f),originalPackage=await readPackage(f.env,'first',originalRelease.id);
 response=await activate('replacement');assert.equal(response.status,200,await response.text());
 let config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);
 assert.equal(config.builtinRuntimeSelection.prebid.id,'replacement');assert.equal(config.builtinRuntimeSelection.prebid.version,'11.34.0');assert.equal((await packageState(f.env,'first')).ready,true);
 assert.equal(f.sqlite.prepare("SELECT status FROM prebid_builds WHERE id='original'").get().status,'archived');
 const nextPackage=await readPackage(f.env,'first',(await generate(f)).id);
 assert.deepEqual(nextPackage.files['prebid.js'],f.objects.get('publishers/first/prebid-builds/replacement/prebid.js').bytes);
 assert.deepEqual((await readPackage(f.env,'first',originalRelease.id)).files,originalPackage.files);
 f.objects.get('publishers/first/prebid-builds/broken/prebid.js').bytes=new TextEncoder().encode('corrupted file');
 const snapshot=()=>({config:f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json,builds:f.sqlite.prepare('SELECT id,status FROM prebid_builds ORDER BY id').all(),audits:f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n});
 const before=snapshot();response=await activate('broken');assert.equal(response.status,422);assert.deepEqual(snapshot(),before);
 const batch=f.env.DB.batch;let race=false;
 f.env.DB.batch=async items=>{if(items.some(item=>item.sql.startsWith('UPDATE publisher_configs'))){race=true;f.sqlite.prepare("UPDATE unit_rules SET rule_json='{\"timeout\":1900,\"refresh\":{\"enabled\":false}}'").run();}return batch(items);};
 response=await activate('original');assert.equal(response.status,409,await response.text());assert.equal(race,true);assert.deepEqual(snapshot(),before);
 f.env.DB.batch=batch;
 response=await mode(false);assert.equal(response.status,200,await response.text());
 response=await activate('original');assert.equal(response.status,200,await response.text());
 config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);assert.equal(config.enablePrebid,false);assert.equal(config.builtinRuntimeSelection.prebid,null);assert.equal((await packageState(f.env,'first')).ready,true);
 response=await mode(true);assert.equal(response.status,200,await response.text());
 config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);assert.equal(config.builtinRuntimeSelection.prebid.id,'original');
});

test('disabled TakeOver and unsupported page-type maps stop generation without changing saved files or settings',async()=>{
 const {packageState}=await import('../../worker/site-runtime/releases.mjs');
 const {siteRuntimeBundle}=await import('../../worker/site-runtime/service.mjs');
 const {defaultOverlay}=await import('../../worker/runtime-next/position-settings.mjs');
 const f=await fixture();let s=await siteRuntimeSettings(f.env,'first');
 await changeSiteRuntime(f.env,'first','tester',{action:'position',revision:s.revision,position:{code:'Billboard',display:'takeover',overlay:defaultOverlay(),lazy:null}});
 const release=await generate(f),original=await readPackage(f.env,'first',release.id);
 f.sqlite.prepare("UPDATE ad_units SET enabled=0 WHERE code='Billboard'").run();
 s=await siteRuntimeSettings(f.env,'first');assert.match(s.validationIssue,/Enable the TakeOver ad position/);
 assert.equal((await packageState(f.env,'first')).ready,false);await assert.rejects(generate(f),/saved settings are not supported/);
 f.sqlite.prepare("UPDATE ad_units SET enabled=1 WHERE code='Billboard'").run();
 const config=f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json,objectCount=f.objects.size;
 for(const sizes of [[[320,480]],[]]){
  const map=JSON.stringify([{viewport:[0,0],sizes}]);
  f.sqlite.prepare("INSERT OR REPLACE INTO size_maps(id,publisher_id,name,map_json) VALUES('sport-map','first','sport_display',?)").run(map);
  s=await siteRuntimeSettings(f.env,'first');assert.match(s.validationIssue,/maps by page type/);
  assert.equal((await packageState(f.env,'first')).ready,false);
  await assert.rejects(generate(f),/saved settings are not supported/);
  await assert.rejects(siteRuntimeBundle(f.env,'first',{action:'bundle',revision:s.revision,acknowledge:true}),/saved settings are not supported/);
  assert.equal(f.sqlite.prepare("SELECT map_json FROM size_maps WHERE name='sport_display'").get().map_json,map);
  assert.equal(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json,config);assert.equal(f.objects.size,objectCount);
 }
 await changeSiteRuntime(f.env,'first','tester',{action:'position',revision:s.revision,position:{code:'Billboard',display:'standard',overlay:null,lazy:null}});
 assert.equal((await packageState(f.env,'first')).ready,true);assert.deepEqual((await readPackage(f.env,'first',release.id)).files,original.files);
});
