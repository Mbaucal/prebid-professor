import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {zipSync,Zip,ZipPassThrough} from 'fflate';
import {workspaceStore} from '../support/test-workspace-store.mjs';
import {TARGET,TRANSFER_SECRET} from '../support/deployment-store.mjs';
import {siteRuntimeSettings,changeSiteRuntime} from '../../worker/site-runtime/service.mjs';
import {parsePrebidHeader} from '../../worker/runtime/prebid-artifact-check.mjs';
import {describeCandidate} from '../../worker/runtime/draft-release-store.mjs';
import {readPreviewSnapshot} from '../../worker/runtime/builtin-preview-service.mjs';
import {runtimeCatalog,readPinnedSiteRuntime,buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {takeOverForBuild} from '../../worker/test-workspace/takeover-settings.mjs';
import {describeDelivery} from '../../worker/test-workspace/delivery-layout.mjs';
import {dispatchInputs,DEPLOY_REF,DEPLOY_REPO} from '../../worker/test-workspace/deployment-contract.mjs';
import {prepareDelivery} from '../../scripts/builtin-test-delivery.mjs';
import {verifyPreparedDelivery} from '../../scripts/builtin-pages-preflight.mjs';
import {verifyDeliveryPublication} from '../../scripts/publisher-delivery-verification.mjs';

// A 3.16.2 draft carries deals-plan.json (MBA-333). The TEST runner keeps it in the private archive,
// and prepare, preflight and the public check publish and accept only the reviewed scripts.
const sha=b=>createHash('sha256').update(b).digest('hex'),decode=b=>new TextDecoder().decode(b);
const url='https://1234abcd.tessera-fixture.pages.dev',alias=`https://${TARGET.previewBranch}.${TARGET.projectName}.pages.dev`,fixtures=[];
test.afterEach(async()=>{while(fixtures.length)await fixtures.pop()();});
async function candidate(prebid){
 const f=workspaceStore(),site='test-site';fixtures.push(()=>f.close());
 f.sqlite.exec(readFileSync('migrations/0001_initial.sql','utf8').split('INSERT OR IGNORE INTO publishers')[0]);
 f.sqlite.prepare("INSERT INTO publishers(id,name,domain,gam_path) VALUES(?,'Test','test.invalid','/123/test/')").run(site);
 f.sqlite.prepare("INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES('cfg',?,?)").run(site,JSON.stringify({enablePrebid:false,runtimeControls:{sticky:{bottomAdUnitId:''},floors:{enabled:false},output:{cleanComments:true}}}));
 f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,sort_order) VALUES('unit',?,'Billboard','ATF','display',0)").run(site);
 f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('map',?,'display',?)").run(site,'[{"viewport":[0,0],"sizes":[[300,250]]}]');
 f.sqlite.prepare("INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES('rule',?,'__DEFAULT__',?)").run(site,'{"timeout":1500,"refresh":{"enabled":false}}');
 const objects=new Map();f.env.BUILDS={async get(k){const o=objects.get(k);return o?{size:o.bytes.length,customMetadata:o.meta,arrayBuffer:async()=>o.bytes.slice().buffer}:null;},async put(k,b,opt){if(objects.has(k))return null;objects.set(k,{bytes:new Uint8Array(b).slice(),meta:opt.customMetadata});return {};}};
 if(prebid){
  const bytes=new Uint8Array(readFileSync('vendor/prebid/tanjug-11.34.0/prebid.js')),header=parsePrebidHeader(decode(bytes)),path=`publishers/${site}/prebid-builds/original/prebid.js`;
  objects.set(path,{bytes,meta:{sha256:sha(bytes)}});
  f.sqlite.prepare("INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES('original',?,?,?,?, 'current')").run(site,header.version,path,JSON.stringify(header.modules));
  f.sqlite.prepare("INSERT INTO bidders(id,publisher_id,bidder,params_json,enabled) VALUES('pubmatic',?,'pubmatic',?,1)").run(site,JSON.stringify({publisherId:'synthetic',adSlot:'base'}));
  const config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);config.enablePrebid=true;
  f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
 }
 const s=await siteRuntimeSettings(f.env,site),runtime=s.runtimes.find(r=>r.version==='3.16.2');assert(runtime);
 await changeSiteRuntime(f.env,site,'tester',{action:prebid?'setup':'version',revision:s.revision,runtime:runtime.pin,allowPreview:runtime.channel!=='stable',...(prebid?{enablePrebid:true}:{})});
 const saved=await readPreviewSnapshot(f.env.DB.withSession('first-primary'),site,{includePrebid:true});
 const selected=await readPinnedSiteRuntime({siteId:site,snapshot:saved,catalog:runtimeCatalog},f.env.BUILDS);
 const built=await buildArtifactCandidate({snapshot:selected.snapshot,pin:selected.pin,prebid:selected.prebid,takeOver:takeOverForBuild(saved),buildTimestamp:'20261028_090000'});
 return describeCandidate(site,built);
}
const zipOf=entries=>{const chunks=[],out=new Zip((error,data)=>{if(error)throw error;chunks.push(data);});for(const [name,bytes] of entries){const file=new ZipPassThrough(name);out.add(file);file.push(bytes,true);}out.end();return new Uint8Array(Buffer.concat(chunks));};
const fetcher=bytes=>async u=>u.endsWith('/package')?new Response(bytes):Response.json({success:true,result:{name:TARGET.projectName,production_branch:'main'}});
// Public Pages origins that serve only the prepared files; extra names can be exposed on one origin to prove the check fails there.
const published=(files,extra={},on=null)=>async(u,o)=>{const {origin,pathname}=new URL(u),name=pathname.slice(1),bytes=files[name]??(on===null||origin===on?extra[name]:undefined);if(!bytes)return new Response(null,{status:404});if(o.headers['If-None-Match'])return new Response(null,{status:304});
 return new Response(bytes,{headers:{'content-type':'application/javascript','access-control-allow-origin':'*','x-content-type-options':'nosniff','x-robots-tag':'noindex','cache-control':'public, max-age=0, must-revalidate',etag:'"fixture"'}});};

for(const prebid of [false,true])test(`TEST runner prepares, preflights and publicly verifies a 3.16.2 ${prebid?'Prebid':'GAM-only'} draft with deals-plan.json as scripts only`,async()=>{
 const {descriptor,files}=await candidate(prebid);
 assert.equal(descriptor.runtime.runtimeVersion,'3.16.2');assert.equal(Boolean(files['prebid.js']),prebid);
 const plan=JSON.parse(decode(files['deals-plan.json']));assert.equal(plan.schemaVersion,1);assert.equal(plan.siteId,'test-site');assert.equal(plan.writeEnabled,false);
 const zip=zipSync(Object.fromEntries(Object.entries(files).map(([name,data])=>[name,[data,{level:0,mtime:new Date(1980,0,1,0,0,0)}]])),{level:0});
 const run={id:'builtin-test-12345678-1234-4123-8123-123456789abc',siteId:'test-site',githubRunId:'123456',commit:'a'.repeat(40),target:TARGET,package:{descriptor,zipSha256:sha(zip)},delivery:await describeDelivery(descriptor)};
 const input=dispatchInputs(run),secret=TRANSFER_SECRET;
 const prepared=await prepareDelivery({run,input,token:'synthetic',secret,fetcher:fetcher(zip)});
 assert.deepEqual(Object.keys(prepared.files).sort(),Object.keys(files).sort());
 for(const name of Object.keys(files))assert.equal(sha(prepared.files[name]),sha(files[name]),name);
 assert.deepEqual(Object.keys(prepared.deploymentFiles).sort(),['ads.js',...(prebid?['prebid.js']:[])]);
 assert.equal(sha(prepared.deploymentFiles['ads.js']),sha(files['ads.min.js']),'public ads.js must be the archived ads.min.js');
 if(prebid)assert.equal(sha(prepared.deploymentFiles['prebid.js']),sha(files['prebid.js']));
 assert(prepared.evidence.verified.files.some(e=>e.name==='deals-plan.json'),'the private inventory keeps the deals plan');
 // Preflight on the directory the workflow deploys: only the scripts and _headers, byte for byte.
 const root=await mkdtemp(resolve(tmpdir(),'mba333-test-'));fixtures.push(()=>rm(root,{recursive:true,force:true}));
 const dir=resolve(root,'.generated/builtin-delivery');await mkdir(resolve(dir,'dist'),{recursive:true});
 for(const [name,bytes] of Object.entries(prepared.deploymentFiles))await writeFile(resolve(dir,'dist',name),bytes);
 await writeFile(resolve(dir,'dist/_headers'),prepared.headers);await writeFile(resolve(dir,'request.json'),JSON.stringify(run));await writeFile(resolve(dir,'verification.json'),JSON.stringify(prepared.evidence));
 const env={DEPLOY_INPUTS:JSON.stringify(input),GITHUB_REF:'refs/heads/'+DEPLOY_REF,GITHUB_REPOSITORY:DEPLOY_REPO,GITHUB_RUN_ID:run.githubRunId,GITHUB_SHA:run.commit};
 assert.deepEqual((await verifyPreparedDelivery(root,env)).delivery,run.delivery);
 await writeFile(resolve(dir,'dist/deals-plan.json'),files['deals-plan.json']);
 await assert.rejects(verifyPreparedDelivery(root,env),/Prepared file set changed/);
 await rm(resolve(dir,'dist/deals-plan.json'));
 // Public check: the scripts are served, and supporting data must be absent on the deployment URL and on the preview alias.
 const receipt=await verifyDeliveryPublication(url,input,prepared.evidence.verified,prepared.evidence.delivery,published(prepared.deploymentFiles));
 assert.equal(receipt.fileCount,prebid?2:1);assert(receipt.immutable.excludedFilesAbsent&&receipt.preview.excludedFilesAbsent);
 for(const name of ['deals-plan.json','gam-reporting.json'])for(const on of [url,alias])await assert.rejects(verifyDeliveryPublication(url,input,prepared.evidence.verified,prepared.evidence.delivery,published(prepared.deploymentFiles,{[name]:files[name]},on)),new RegExp('still public: '+name.replace('.','\\.')),name+' on '+on);
 // The runner refuses a changed, duplicated, renamed or missing deals plan before preparing anything.
 const entries=Object.entries(files),bytes=files['deals-plan.json'],changed=bytes.slice();changed[changed.length-2]^=1;
 for(const [name,archive,message] of [
  ['changed deals-plan.json',zipOf(entries.map(([n,b])=>[n,n==='deals-plan.json'?changed:b])),/Candidate file checksum mismatch/],
  ['duplicate deals-plan.json',zipOf([...entries,['deals-plan.json',bytes]]),/Unexpected or duplicate ZIP entry/],
  ...['deals-plan.json.bak','x/deals-plan.json','../deals-plan.json'].map(n=>[`supporting file named ${n}`,zipOf([...entries,[n,bytes]]),/Unexpected or duplicate ZIP entry/]),
  ['missing deals-plan.json',zipOf(entries.filter(([n])=>n!=='deals-plan.json')),/Manifest file inventory differs from candidate/],
 ])await assert.rejects(prepareDelivery({run:{...run,package:{descriptor,zipSha256:sha(archive)}},input,token:'synthetic',secret,fetcher:fetcher(archive)}),message,name);
});
