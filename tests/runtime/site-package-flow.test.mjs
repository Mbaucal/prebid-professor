import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {workspaceStore} from '../support/test-workspace-store.mjs';
import {siteRuntimeSettings,changeSiteRuntime} from '../../worker/site-runtime/service.mjs';
import {generatePackage,packageDownload,readPackage,changePackageChannel,channelRevision,builtInCdn} from '../../worker/site-runtime/releases.mjs';
import {verifyPackage} from '../../scripts/pages-release-verification.mjs';
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
