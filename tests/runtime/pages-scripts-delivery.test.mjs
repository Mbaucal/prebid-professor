import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,cpSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {unzipSync,zipSync,Zip,ZipPassThrough} from 'fflate';
import {workspaceStore} from '../support/test-workspace-store.mjs';
import {siteRuntimeSettings,changeSiteRuntime} from '../../worker/site-runtime/service.mjs';
import {generatePackage,readPackage,packageDownload,packageAssetResponse,builtInCdn,changePackageChannel,channelRevision} from '../../worker/site-runtime/releases.mjs';
import {deploymentManifestPin} from '../../worker/deployment-manifest-pin.mjs';
import {parsePrebidHeader} from '../../worker/runtime/prebid-artifact-check.mjs';
import {describeCandidate} from '../../worker/runtime/draft-release-store.mjs';
import {readPreviewSnapshot} from '../../worker/runtime/builtin-preview-service.mjs';
import {runtimeCatalog,readPinnedSiteRuntime,buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {takeOverForBuild} from '../../worker/test-workspace/takeover-settings.mjs';
import {describeDelivery} from '../../worker/test-workspace/delivery-layout.mjs';
import {prepareDelivery} from '../../scripts/builtin-test-delivery.mjs';
import {verifyPackage} from '../../scripts/pages-release-verification.mjs';
import {verifyPreparedPages} from '../../scripts/pages-release-preflight.mjs';
import {downloadStoredPackage} from '../../src/download/saved-package.mjs';
const repo=resolve(import.meta.dirname,'../..'),sha=b=>createHash('sha256').update(b).digest('hex');
const encode=v=>new TextEncoder().encode(v),decode=b=>new TextDecoder().decode(b);
const fixtures=[];test.afterEach(()=>{while(fixtures.length)fixtures.pop()();});
async function workspace({site='first',cleanComments=true}={}){
 const f=workspaceStore();fixtures.push(()=>f.close());f.site=site;f.sqlite.exec(readFileSync('migrations/0001_initial.sql','utf8').split('INSERT OR IGNORE INTO publishers')[0]);
 f.sqlite.prepare("INSERT INTO publishers(id,name,domain,gam_path) VALUES(?,'First','first.invalid','/123/first/')").run(site);
 f.sqlite.prepare("INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES('cfg',?,?)").run(site,JSON.stringify({enablePrebid:false,runtimeControls:{sticky:{bottomAdUnitId:''},floors:{enabled:false},output:{cleanComments}}}));
 f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,sort_order) VALUES('unit',?,'Billboard','ATF','display',0)").run(site);
 f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('map',?,'display',?)").run(site,'[{"viewport":[0,0],"sizes":[[300,250]]}]');
 f.sqlite.prepare("INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES('rule',?,'__DEFAULT__',?)").run(site,'{"timeout":1500,"refresh":{"enabled":false}}');
 const objects=new Map();f.objects=objects;f.env.BUILDS={async get(k){const o=objects.get(k);return o?{size:o.bytes.length,customMetadata:o.meta,arrayBuffer:async()=>o.bytes.slice().buffer}:null;},async put(k,b,opt){if(objects.has(k))return null;objects.set(k,{bytes:new Uint8Array(b).slice(),meta:opt.customMetadata});return {};}};
 return f;
}
// Without a version this selects the first catalog runtime, which predates deals-plan.json.
async function selectRuntime(f,version=null,prebid=false){
 if(prebid){
  const bytes=new Uint8Array(readFileSync('vendor/prebid/tanjug-11.34.0/prebid.js')),header=parsePrebidHeader(decode(bytes)),path=`publishers/${f.site}/prebid-builds/original/prebid.js`;
  f.objects.set(path,{bytes,meta:{sha256:sha(bytes)}});
  f.sqlite.prepare("INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES('original',?,?,?,?, 'current')").run(f.site,header.version,path,JSON.stringify(header.modules));
  f.sqlite.prepare("INSERT INTO bidders(id,publisher_id,bidder,params_json,enabled) VALUES('pubmatic',?,'pubmatic',?,1)").run(f.site,JSON.stringify({publisherId:'synthetic',adSlot:'base'}));
  const config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);config.enablePrebid=true;
  f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
 }
 const s=await siteRuntimeSettings(f.env,f.site),runtime=version?s.runtimes.find(r=>r.version===version):s.runtimes[0];assert(runtime);
 await changeSiteRuntime(f.env,f.site,'tester',{action:prebid?'setup':'version',revision:s.revision,runtime:runtime.pin,allowPreview:runtime.channel!=='stable',...(prebid?{enablePrebid:true}:{})});
}
async function generate(f,notes){const s=await siteRuntimeSettings(f.env,f.site);return (await generatePackage(f.env,f.site,'tester',{revision:s.revision,notes})).release.id;}
async function promote(f,id,action){return changePackageChannel(f.env,f.site,id,'tester',action,{acknowledge:true,channelRevision:await channelRevision(f.env,f.site)});}
// Releases saved before MBA-332 stored the compact wrapper under both names. The runner checks README.txt
// only against its manifest checksum and never publishes it, so README text does not change what these packages publish.
function savedBeforeMba332(f,id){
 const key=name=>`publishers/${f.site}/releases/${id}/${name}`,min=f.objects.get(key('ads.min.js')).bytes,old=f.objects.get(key('manifest.json'));
 f.objects.set(key('ads.js'),{bytes:min.slice(),meta:{...f.objects.get(key('ads.js')).meta,sha256:sha(min)}});
 const manifest=JSON.parse(decode(old.bytes));manifest.files['ads.js']={...manifest.files['ads.js'],size:min.length,byteSize:min.length,sha256:sha(min)};
 const bytes=encode(JSON.stringify(manifest,null,2)+'\n');f.objects.set(key('manifest.json'),{bytes,meta:{...old.meta,sha256:sha(bytes)}});
}
const snapshot=async f=>({objects:[...f.objects].map(([k,o])=>[k,sha(o.bytes)]),zips:await Promise.all(f.sqlite.prepare('SELECT id FROM releases ORDER BY id').all().map(async r=>[r.id,sha(new Uint8Array(await (await packageDownload(f.env,f.site,r.id)).arrayBuffer()))]))});
// Server ZIP and the browser ZIP built from authenticated per-file reads.
async function downloads(f,id){
 const server=unzipSync(new Uint8Array(await (await packageDownload(f.env,f.site,id)).arrayBuffer()));
 const base=`/api/publishers/${f.site}/builtin-releases/${id}`,saved=[],original={fetch:globalThis.fetch,document:globalThis.document,create:URL.createObjectURL,timeout:globalThis.setTimeout};
 let blob;globalThis.fetch=async url=>{assert(url.startsWith(base+'/'));const rest=url.slice(base.length+1);return packageAssetResponse(new Request('https://tessera.invalid'+url),f.env,f.site,id,rest==='index'?null:decodeURIComponent(rest.replace(/^files\//,'')));};
 globalThis.document={body:{append(){}},createElement:()=>({click(){saved.push(blob);},remove(){}})};URL.createObjectURL=value=>{blob=value;return 'blob:local';};globalThis.setTimeout=()=>0;
 try{await downloadStoredPackage(id,()=>{},{siteId:f.site});}finally{globalThis.fetch=original.fetch;globalThis.document=original.document;URL.createObjectURL=original.create;globalThis.setTimeout=original.timeout;}
 assert.equal(saved.length,1);return {server,browser:unzipSync(new Uint8Array(await saved[0].arrayBuffer()))};
}
// Production Pages runner in a child process: its only network is the platform CDN, the provider check and the public deployment.
async function pagesRunner(f,id,tamper=()=>{}){
 const stored=await readPackage(f.env,f.site,id),base=`https://prebid-professor.mbaucal.workers.dev/cdn/${f.site}/releases/${id}`,cdn={};
 for(const name of [...Object.keys(stored.manifest.files),'manifest.json']){const r=await builtInCdn(new Request(base+'/'+name),f.env);assert.equal(r.status,200);cdn[base+'/'+name]=Buffer.from(await r.arrayBuffer());}
 tamper(cdn,base);
 const row=f.sqlite.prepare('SELECT * FROM releases WHERE id=?').get(id);
 const input={correlation_id:'22222222-2222-4222-8222-222222222222',callback_url:'https://prebid-professor.mbaucal.workers.dev/api/deployments/callback',site_id:f.site,release_id:id,release_version:id,release_base_url:base,manifest_sha256:await deploymentManifestPin(f.env.BUILDS,f.site,row),github_environment:'CLOUDFLARE_API_TOKEN',account_id:'a'.repeat(32),project_name:'pub-pages',branch:'main',channel:'production'};
 const root=mkdtempSync(resolve(tmpdir(),'mba333-'));fixtures.push(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(resolve(root,'tools'));cpSync(resolve(repo,'tools/historical-inputs.json'),resolve(root,'tools/historical-inputs.json'));
 const dist=resolve(root,'.generated/pages-release/dist'),publicUrl='https://1234abcd.pub-pages.pages.dev',mock=resolve(root,'fetch.mjs');
 writeFileSync(resolve(root,'cdn.json'),JSON.stringify(Object.fromEntries(Object.entries(cdn).map(([url,bytes])=>[url,bytes.toString('base64')]))));
 writeFileSync(mock,`import {readFileSync,existsSync} from 'node:fs';import {resolve} from 'node:path';
const cdn=JSON.parse(readFileSync(${JSON.stringify(resolve(root,'cdn.json'))},'utf8'));
globalThis.fetch=async url=>{
 if(url==='https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/pages/projects/pub-pages')return Response.json({success:true,result:{name:'pub-pages',production_branch:'main'}});
 if(cdn[url])return new Response(Buffer.from(cdn[url],'base64'));
 const path=url.startsWith(${JSON.stringify(publicUrl+'/')})&&resolve(${JSON.stringify(dist)},url.slice(${publicUrl.length+1}));
 if(path&&existsSync(path))return new Response(readFileSync(path),{headers:{'content-type':'application/javascript','access-control-allow-origin':'*','x-content-type-options':'nosniff','cache-control':'no-store'}});
 throw Error('Unexpected network '+url);};`);
 const env={...process.env,DEPLOY_INPUTS:JSON.stringify(input),GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'Mbaucal/prebid-professor',GITHUB_RUN_ID:'123456',GITHUB_SHA:'a'.repeat(40),CLOUDFLARE_API_TOKEN:'synthetic-only',PAGES_DEPLOYMENT_URL:publicUrl};
 const run=mode=>spawnSync(process.execPath,['--import',mock,resolve(repo,'scripts/pages-release-verification.mjs'),mode],{cwd:root,env,encoding:'utf8'});
 return {stored,input,env,root,dist,run,cdn,evidence:()=>JSON.parse(readFileSync(resolve(root,'.generated/pages-release/verification.json'),'utf8')).verified,
  // Workflow order: prepare, then preflight on the prepared directory, then the public check.
  async publish(){let r=run('prepare');assert.equal(r.status,0,r.stderr);assert.equal(await verifyPreparedPages(root,env),'main');r=run('verify-public');assert.equal(r.status,0,r.stderr);
   assert(existsSync(resolve(root,'.generated/pages-release/public-verification.json')));return Object.fromEntries(readdirSync(dist).sort().map(name=>[name,readFileSync(resolve(dist,name))]));}};
}
// README tells a manual installer which file to host and lists every other file in this package as not published.
function assertInstallReadme(files){
 const readme=decode(files['README.txt']),others=Object.keys(files).filter(n=>!['ads.js','ads.min.js','prebid.js'].includes(n)).sort().join(', ');
 assert.match(readme,/\nManual installation\nUpload ads\.min\.js and serve it under the public name ads\.js, at the script URL your pages already load\. Tessera's Pages publication does the same\./);
 assert.match(readme,/ads\.js in this archive is the readable review copy of the same script; do not upload it, and load the Tessera script only once\./);
 assert(readme.includes('The other files are for review and page setup and are not published with the script: '+others+'.\n'),others);
 assert.equal(readme.includes('Upload prebid.js unchanged and load it before ads.js.'),Boolean(files['prebid.js']));
 assert.doesNotMatch(readme,/Use ads\.js once|Use one, never both/);
 if(/^Tessera 3\.16\./.test(readme))assert(readme.includes('ads.js is the readable review copy of ads.min.js; both have the same parser-validated behavior. Of the two Tessera script copies, host only ads.min.js, under the public name ads.js (see Manual installation below).'));
}
const entry=(manifest,name,sourceName)=>({name,byteSize:manifest.files[sourceName??name].byteSize,sha256:manifest.files[sourceName??name].sha256,...(sourceName?{sourceName}:{})});
// The runner before MBA-332 kept the archived ads.js and prebid.js entries unchanged.
const earlierEvidence=verified=>({...verified,deliveryProfile:'scripts-v1',files:verified.files.filter(e=>['ads.js','prebid.js'].includes(e.name))});

for(const cleanComments of [true,false])test('production Pages runner publishes the saved compact wrapper as ads.js and leaves the saved ZIP unchanged, cleanComments='+cleanComments,async()=>{
 const f=await workspace({cleanComments});await selectRuntime(f);const id=await generate(f,'Pages'),stored=await readPackage(f.env,f.site,id);
 assert.notEqual(sha(stored.files['ads.js']),sha(stored.files['ads.min.js']));
 const before=await snapshot(f),runner=await pagesRunner(f,id),dist=await runner.publish();
 assert.deepEqual(Object.keys(dist),['_headers','ads.js']);
 // Compare digests: a byte-array diff of a ~200 KB wrapper is too large to report.
 assert.equal(sha(dist['ads.js']),sha(stored.files['ads.min.js']),'public ads.js must be the archived ads.min.js');
 const evidence=runner.evidence();assert.equal(evidence.deliveryProfile,'scripts-v1');assert.equal(evidence.manifestSha256,runner.input.manifest_sha256);
 assert.deepEqual(evidence.files,[entry(stored.manifest,'ads.js','ads.min.js')]);
 assert.deepEqual(await snapshot(f),before);
 assert(decode(stored.files['ads.js']).split('\n').length>100,'the saved ZIP keeps readable ads.js');
 assertInstallReadme(stored.files);
});

for(const [version,prebid] of [['3.16.0',false],['3.16.1',false],['3.16.2',false],['3.16.2',true]])test(`${version} ${prebid?'Prebid':'GAM-only'} package goes from Generate through reopen, both downloads, prepare, preflight and verify-public; deals-plan.json stays in the archive`,async()=>{
 const f=await workspace();await selectRuntime(f,version,prebid);const id=await generate(f,'MBA-333');
 const stored=await readPackage(f.env,f.site,id),names=Object.keys(stored.files).sort();
 assert.equal(stored.manifest.runtime.runtimeVersion,version);assert.equal(Boolean(stored.files['prebid.js']),prebid);
 assert(names.includes('deals-plan.json')&&names.includes('gam-reporting.json'));
 const plan=JSON.parse(decode(stored.files['deals-plan.json']));assert.equal(plan.schemaVersion,1);assert.equal(plan.siteId,f.site);assert.equal(plan.writeEnabled,false);
 const {server,browser}=await downloads(f,id);
 for(const zip of [server,browser]){assert.deepEqual(Object.keys(zip).sort(),names);for(const name of names)assert.equal(sha(zip[name]),sha(stored.files[name]),name);assertInstallReadme(zip);}
 const before=await snapshot(f),runner=await pagesRunner(f,id);
 for(const name of names)assert.equal(sha(runner.cdn[runner.input.release_base_url+'/'+name]),sha(server[name]),'runner source equals the downloaded ZIP: '+name);
 const dist=await runner.publish();
 assert.deepEqual(Object.keys(dist),['_headers','ads.js',...(prebid?['prebid.js']:[])]);
 assert.equal(sha(dist['ads.js']),sha(server['ads.min.js']),'public ads.js must be the archived ads.min.js');
 if(prebid)assert.equal(sha(dist['prebid.js']),sha(server['prebid.js']));
 assert.deepEqual(runner.evidence().files,[entry(stored.manifest,'ads.js','ads.min.js'),...(prebid?[entry(stored.manifest,'prebid.js')]:[])]);
 assert.equal(runner.evidence().manifestSha256,runner.input.manifest_sha256);
 assert.deepEqual(await snapshot(f),before,'publishing changes no saved object or ZIP');
});

for(const version of [null,'3.16.2'])test(`package saved before MBA-332 (${version??'pre-deals runtime'}) publishes its archived bytes with the earlier evidence and an unchanged ZIP`,async()=>{
 const f=await workspace();await selectRuntime(f,version);const id=await generate(f,'Saved before MBA-332');savedBeforeMba332(f,id);
 const stored=await readPackage(f.env,f.site,id);assert.equal(sha(stored.files['ads.js']),sha(stored.files['ads.min.js']));
 assert.equal(Boolean(stored.files['deals-plan.json']),version!==null);
 const before=await snapshot(f),runner=await pagesRunner(f,id),dist=await runner.publish();
 assert.deepEqual(Object.keys(dist),['_headers','ads.js']);assert.equal(sha(dist['ads.js']),sha(stored.files['ads.js']));
 assert.equal(JSON.stringify(runner.evidence()),JSON.stringify(earlierEvidence(await verifyPackage(stored.files,runner.input))));
 assert.deepEqual(await snapshot(f),before);
});

// The pre-deals runtime models a publication the main-branch runner could already make; 3.16.0 models the
// saved 3.16.x packages that could not be published before MBA-333.
for(const version of [null,'3.16.0'])test(`rollback to an earlier ${version??'pre-deals'} package republishes it byte for byte after a newer readable-source package`,async()=>{
 const f=await workspace();await selectRuntime(f,version);const earlier=await generate(f,'Saved before MBA-332');savedBeforeMba332(f,earlier);
 await promote(f,earlier,'staging');await promote(f,earlier,'production');
 const first=await pagesRunner(f,earlier),firstDist=await first.publish(),firstEvidence=JSON.stringify(first.evidence());
 assert.equal(firstEvidence,JSON.stringify(earlierEvidence(await verifyPackage(first.stored.files,first.input))));
 await selectRuntime(f,'3.16.2');const newer=await generate(f,'After MBA-332');await promote(f,newer,'staging');await promote(f,newer,'production');
 const status=()=>Object.fromEntries(f.sqlite.prepare('SELECT id,status FROM releases').all().map(r=>[r.id,r.status]));
 assert.deepEqual(status(),{[earlier]:'archived',[newer]:'production'});
 const next=await pagesRunner(f,newer),nextDist=await next.publish();
 assert.equal(sha(nextDist['ads.js']),sha(next.stored.files['ads.min.js']));assert.notEqual(sha(nextDist['ads.js']),sha(next.stored.files['ads.js']));
 const before=await snapshot(f);
 await promote(f,earlier,'rollback');
 assert.deepEqual(status(),{[earlier]:'production',[newer]:'archived'});
 const current=await builtInCdn(new Request(`https://prebid-professor.mbaucal.workers.dev/cdn/${f.site}/current/ads.js`),f.env);
 assert.equal(sha(new Uint8Array(await current.arrayBuffer())),sha(firstDist['ads.js']));
 const again=await pagesRunner(f,earlier),againDist=await again.publish();
 assert.equal(again.input.manifest_sha256,first.input.manifest_sha256);
 assert.deepEqual(Object.keys(againDist),Object.keys(firstDist));for(const name of Object.keys(firstDist))assert.equal(sha(againDist[name]),sha(firstDist[name]),name);
 assert.equal(JSON.stringify(again.evidence()),firstEvidence);
 assert.deepEqual(await snapshot(f),before,'rollback changes no saved object or ZIP');
});

test('Pages runner refuses changed, corrupted, missing, misplaced or unknown supporting data before writing anything',async()=>{
 const f=await workspace();await selectRuntime(f,'3.16.2');const id=await generate(f,'Guards');
 const flip=name=>(cdn,base)=>{const bytes=Buffer.from(cdn[base+'/'+name]);bytes[bytes.length-2]^=1;cdn[base+'/'+name]=bytes;};
 for(const [name,tamper,message] of [
  ['changed deals-plan.json bytes',flip('deals-plan.json'),/Release bytes do not match manifest: deals-plan\.json/],
  ['changed source manifest',flip('manifest.json'),/Source manifest differs from the dispatched checksum/],
 ]){const runner=await pagesRunner(f,id,tamper),r=runner.run('prepare');assert.notEqual(r.status,0,name);assert.match(r.stderr,message,name);assert(!existsSync(runner.dist),name);}
 const stored=await readPackage(f.env,f.site,id),expected={site_id:f.site,release_id:id,release_version:id};
 // Offline reseal: the manifest is rewritten consistently, so only the content rules can refuse it.
 const resealed=async(change)=>{const files={...stored.files},manifest=JSON.parse(decode(files['manifest.json']));change(files,manifest);
  for(const name of Object.keys(manifest.files))if(files[name])manifest.files[name]={...manifest.files[name],size:files[name].length,byteSize:files[name].length,sha256:sha(files[name])};
  files['manifest.json']=encode(JSON.stringify(manifest,null,2)+'\n');return verifyPackage(files,expected);};
 const plan=change=>files=>{const value=JSON.parse(decode(files['deals-plan.json']));change(value);files['deals-plan.json']=encode(JSON.stringify(value));};
 await resealed(()=>{});
 for(const [name,change,message] of [
  ['corrupted deals-plan.json',files=>{files['deals-plan.json']=encode('{"schemaVersion":1,');},/Deals plan is invalid/],
  ['deals-plan.json for another site',plan(p=>{p.siteId='other';}),/Deals plan is invalid/],
  ['deals-plan.json claiming GAM writes',plan(p=>{p.writeEnabled=true;}),/Deals plan is invalid/],
  ['deals-plan.json without entries',plan(p=>{delete p.entries;}),/Deals plan is invalid/],
  ['missing deals-plan.json',(files,m)=>{delete files['deals-plan.json'];delete m.files['deals-plan.json'];},/Deals plan differs from the release runtime/],
  ['deals-plan.json for a runtime whose capabilities are not a list',(files,m)=>{m.runtime={...m.runtime,capabilities:'prebid-deals'};},/Deals plan differs from the release runtime/],
  ['deals-plan.json for a runtime without deals',(files,m)=>{m.runtime={...m.runtime,capabilities:m.runtime.capabilities.filter(c=>c!=='prebid-deals')};},/Deals plan differs from the release runtime/],
  ['deals-plan.json in a legacy package',(files,m)=>{delete m.kind;delete m.completeRelease;},/unsupported file name/],
  ['deals-plan.json with another schema',plan(p=>{p.schemaVersion=2;}),/Deals plan is invalid/],
  ...['deals-plan.json.bak','nested/deals-plan.json','../deals-plan.json'].map(name=>[`supporting file named ${name}`,(files,m)=>{files[name]=files['deals-plan.json'];m.files[name]={...m.files['deals-plan.json']};delete files['deals-plan.json'];delete m.files['deals-plan.json'];},/unsupported file name/]),
  ['supporting file outside the manifest',files=>{files['extra.json']=encode('{}');},/file set differs/],
 ])await assert.rejects(resealed(change),message,name);
 const files={...stored.files},manifest=JSON.parse(decode(files['manifest.json']));manifest.files['deals-plan.json'].sha256='b'.repeat(64);files['manifest.json']=encode(JSON.stringify(manifest,null,2)+'\n');
 await assert.rejects(verifyPackage(files,expected),/Release bytes do not match manifest: deals-plan\.json/);
});

// TEST delivery verifies the private candidate ZIP and publishes only the reviewed script layout.
async function testCandidate(prebid){
 const f=await workspace({site:'test-site'});await selectRuntime(f,'3.16.2',prebid);
 const saved=await readPreviewSnapshot(f.env.DB.withSession('first-primary'),f.site,{includePrebid:true});
 const selected=await readPinnedSiteRuntime({siteId:f.site,snapshot:saved,catalog:runtimeCatalog},f.env.BUILDS);
 const candidate=await buildArtifactCandidate({snapshot:selected.snapshot,pin:selected.pin,prebid:selected.prebid,takeOver:takeOverForBuild(saved),buildTimestamp:'20261028_090000'});
 return describeCandidate(f.site,candidate);
}
const zipOf=entries=>{const chunks=[],zip=new Zip((error,data)=>{if(error)throw error;chunks.push(data);});for(const [name,bytes] of entries){const file=new ZipPassThrough(name);zip.add(file);file.push(bytes,true);}zip.end();return new Uint8Array(Buffer.concat(chunks));};
for(const prebid of [false,true])test(`TEST delivery accepts a 3.16.2 ${prebid?'Prebid':'GAM-only'} candidate with deals-plan.json and publishes only its scripts`,async()=>{
 const {descriptor,files}=await testCandidate(prebid),manifest=descriptor.files.find(e=>e.name==='manifest.json');
 assert(files['deals-plan.json']);
 // Offline verification of a built-in candidate accepts its deals plan; it still grants no publication.
 const offline=await verifyPackage(files,{site_id:'test-site',release_id:descriptor.releaseId,release_version:descriptor.releaseId});
 assert.equal(offline.packageSha256,descriptor.packageSha256);assert(offline.files.some(e=>e.name==='deals-plan.json'));
 const zip=zipSync(Object.fromEntries(Object.entries(files).map(([name,data])=>[name,[data,{level:0,mtime:new Date(1980,0,1,0,0,0)}]])),{level:0});
 const run={siteId:'test-site',githubRunId:'123456',commit:'a'.repeat(40),package:{descriptor,zipSha256:sha(zip)},delivery:await describeDelivery(descriptor)};
 const input={manifest_sha256:manifest.sha256,account_id:'a'.repeat(32),project_name:'tessera-fixture',branch:'tessera-test',channel:'staging'};
 const fetcher=bytes=>async url=>url.endsWith('/package')?new Response(bytes):Response.json({success:true,result:{name:'tessera-fixture',production_branch:'main'}});
 const prepared=await prepareDelivery({run,input:{...input,release_base_url:'https://tessera.invalid/run'},token:'synthetic',secret:'s'.repeat(32),fetcher:fetcher(zip)});
 assert.deepEqual(Object.keys(prepared.files).sort(),Object.keys(files).sort());
 assert.deepEqual(Object.keys(prepared.deploymentFiles).sort(),['ads.js',...(prebid?['prebid.js']:[])]);
 assert.equal(sha(prepared.deploymentFiles['ads.js']),sha(files['ads.min.js']));
 const entries=Object.entries(files),plan=files['deals-plan.json'],other=plan.slice();other[other.length-2]^=1;
 for(const [name,bytes,message] of [
  ['changed deals-plan.json',zipOf(entries.map(([n,b])=>[n,n==='deals-plan.json'?other:b])),/Candidate file checksum mismatch/],
  ['duplicate deals-plan.json',zipOf([...entries,['deals-plan.json',plan]]),/Unexpected or duplicate ZIP entry/],
  ...['deals-plan.json.bak','x/deals-plan.json','../deals-plan.json'].map(name=>[`supporting file named ${name}`,zipOf([...entries,[name,plan]]),/Unexpected or duplicate ZIP entry/]),
  ['missing deals-plan.json',zipOf(entries.filter(([n])=>n!=='deals-plan.json')),/Manifest file inventory differs from candidate/],
 ])await assert.rejects(prepareDelivery({run:{...run,package:{descriptor,zipSha256:sha(bytes)}},input:{...input,release_base_url:'https://tessera.invalid/run'},token:'synthetic',secret:'s'.repeat(32),fetcher:fetcher(bytes)}),message,name);
});
