import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {workspaceStore} from '../support/test-workspace-store.mjs';
import {siteRuntimeSettings,changeSiteRuntime} from '../../worker/site-runtime/service.mjs';
import {generatePackage,packageDownload,readPackage,changePackageChannel,channelRevision,builtInCdn,packageResponse} from '../../worker/site-runtime/releases.mjs';
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
