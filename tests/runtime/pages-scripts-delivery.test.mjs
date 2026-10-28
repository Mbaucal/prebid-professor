import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,cpSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {workspaceStore} from '../support/test-workspace-store.mjs';
import {siteRuntimeSettings,changeSiteRuntime} from '../../worker/site-runtime/service.mjs';
import {generatePackage,readPackage,packageDownload,builtInCdn} from '../../worker/site-runtime/releases.mjs';
import {deploymentManifestPin} from '../../worker/deployment-manifest-pin.mjs';
import {verifyPreparedPages} from '../../scripts/pages-release-preflight.mjs';
const repo=resolve(import.meta.dirname,'../..'),sha=b=>createHash('sha256').update(b).digest('hex');
const fixtures=[];test.afterEach(()=>{while(fixtures.length)fixtures.pop()();});
async function generated(cleanComments){
 const f=workspaceStore();fixtures.push(()=>f.close());f.sqlite.exec(readFileSync('migrations/0001_initial.sql','utf8').split('INSERT OR IGNORE INTO publishers')[0]);
 f.sqlite.prepare("INSERT INTO publishers(id,name,domain,gam_path) VALUES('first','First','first.invalid','/123/first/')").run();
 f.sqlite.prepare("INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES('cfg','first',?)").run(JSON.stringify({enablePrebid:false,runtimeControls:{sticky:{bottomAdUnitId:''},floors:{enabled:false},output:{cleanComments}}}));
 f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,sort_order) VALUES('unit','first','Billboard','ATF','display',0)").run();
 f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('map','first','display',?)").run('[{"viewport":[0,0],"sizes":[[300,250]]}]');
 f.sqlite.prepare("INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES('rule','first','__DEFAULT__',?)").run('{"timeout":1500,"refresh":{"enabled":false}}');
 const objects=new Map();f.objects=objects;f.env.BUILDS={async get(k){const o=objects.get(k);return o?{size:o.bytes.length,customMetadata:o.meta,arrayBuffer:async()=>o.bytes.slice().buffer}:null;},async put(k,b,opt){if(objects.has(k))return null;objects.set(k,{bytes:new Uint8Array(b).slice(),meta:opt.customMetadata});return {};}};
 // The first catalog runtime has no deals-plan.json, which the Pages runner does not accept yet.
 let s=await siteRuntimeSettings(f.env,'first');await changeSiteRuntime(f.env,'first','tester',{action:'version',revision:s.revision,runtime:s.runtimes[0].pin,allowPreview:true});
 s=await siteRuntimeSettings(f.env,'first');const {release}=await generatePackage(f.env,'first','tester',{revision:s.revision,notes:'Pages'});return {f,id:release.id};
}
for(const cleanComments of [true,false])test('production Pages runner publishes the saved compact wrapper as ads.js and leaves the saved ZIP unchanged, cleanComments='+cleanComments,async()=>{
 const {f,id}=await generated(cleanComments),stored=await readPackage(f.env,'first',id);
 assert.notEqual(sha(stored.files['ads.js']),sha(stored.files['ads.min.js']));
 const zipBefore=sha(new Uint8Array(await (await packageDownload(f.env,'first',id)).arrayBuffer())),objectsBefore=[...f.objects].map(([k,o])=>[k,sha(o.bytes)]);
 const base=`https://prebid-professor.mbaucal.workers.dev/cdn/first/releases/${id}`,cdn={};
 for(const name of [...Object.keys(stored.manifest.files),'manifest.json']){const r=await builtInCdn(new Request(base+'/'+name),f.env);assert.equal(r.status,200);cdn[base+'/'+name]=Buffer.from(await r.arrayBuffer()).toString('base64');}
 const row=f.sqlite.prepare('SELECT * FROM releases WHERE id=?').get(id);
 const input={correlation_id:'22222222-2222-4222-8222-222222222222',callback_url:'https://prebid-professor.mbaucal.workers.dev/api/deployments/callback',site_id:'first',release_id:id,release_version:id,release_base_url:base,manifest_sha256:await deploymentManifestPin(f.env.BUILDS,'first',row),github_environment:'CLOUDFLARE_API_TOKEN',account_id:'a'.repeat(32),project_name:'pub-pages',branch:'main',channel:'production'};
 const root=mkdtempSync(resolve(tmpdir(),'mba332-'));fixtures.push(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(resolve(root,'tools'));cpSync(resolve(repo,'tools/historical-inputs.json'),resolve(root,'tools/historical-inputs.json'));
 const dist=resolve(root,'.generated/pages-release/dist'),publicUrl='https://1234abcd.pub-pages.pages.dev',mock=resolve(root,'fetch.mjs');
 writeFileSync(resolve(root,'cdn.json'),JSON.stringify(cdn));
 writeFileSync(mock,`import {readFileSync,existsSync} from 'node:fs';import {resolve} from 'node:path';
const cdn=JSON.parse(readFileSync(${JSON.stringify(resolve(root,'cdn.json'))},'utf8'));
globalThis.fetch=async url=>{
 if(url==='https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/pages/projects/pub-pages')return Response.json({success:true,result:{name:'pub-pages',production_branch:'main'}});
 if(cdn[url])return new Response(Buffer.from(cdn[url],'base64'));
 const path=url.startsWith(${JSON.stringify(publicUrl+'/')})&&resolve(${JSON.stringify(dist)},url.slice(${publicUrl.length+1}));
 if(path&&existsSync(path))return new Response(readFileSync(path),{headers:{'content-type':'application/javascript','access-control-allow-origin':'*','x-content-type-options':'nosniff','cache-control':'no-store'}});
 throw Error('Unexpected network '+url);};`);
 const env={...process.env,DEPLOY_INPUTS:JSON.stringify(input),GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'Mbaucal/prebid-professor',GITHUB_RUN_ID:'123456',GITHUB_SHA:'a'.repeat(40),CLOUDFLARE_API_TOKEN:'synthetic-only',PAGES_DEPLOYMENT_URL:publicUrl};
 for(const mode of ['prepare','verify-public']){const r=spawnSync(process.execPath,['--import',mock,resolve(repo,'scripts/pages-release-verification.mjs'),mode],{cwd:root,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
 assert.equal(await verifyPreparedPages(root,env),'main');
 assert.deepEqual(readdirSync(dist).sort(),['_headers','ads.js']);
 // Compare digests: a byte-array diff of a ~200 KB wrapper is too large to report.
 assert.equal(sha(readFileSync(resolve(dist,'ads.js'))),sha(stored.files['ads.min.js']),'public ads.js must be the archived ads.min.js');
 const evidence=JSON.parse(readFileSync(resolve(root,'.generated/pages-release/verification.json'),'utf8'));
 assert.equal(evidence.verified.deliveryProfile,'scripts-v1');assert.equal(evidence.verified.manifestSha256,input.manifest_sha256);
 assert.deepEqual(evidence.verified.files,[{name:'ads.js',byteSize:stored.manifest.files['ads.min.js'].byteSize,sha256:stored.manifest.files['ads.min.js'].sha256,sourceName:'ads.min.js'}]);
 assert(existsSync(resolve(root,'.generated/pages-release/public-verification.json')));
 assert.equal(sha(new Uint8Array(await (await packageDownload(f.env,'first',id)).arrayBuffer())),zipBefore);
 assert.deepEqual([...f.objects].map(([k,o])=>[k,sha(o.bytes)]),objectsBefore);
 assert(new TextDecoder().decode(stored.files['ads.js']).split('\n').length>100,'the saved ZIP keeps readable ads.js');
});
