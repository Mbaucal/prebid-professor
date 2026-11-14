import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {workspaceStore} from '../support/test-workspace-store.mjs';
import {createSite,duplicateSite} from '../../worker/publishers.ts';
import {uploadPrebidBuild,activatePrebidBuild} from '../../worker/prebid-builds-identity.ts';
import {siteRuntimeSettings,changeSiteRuntime,siteRuntimeBundle} from '../../worker/site-runtime/service.mjs';
import {describeCandidate} from '../../worker/runtime/draft-release-store.mjs';
import {verifyPackage} from '../../scripts/pages-release-verification.mjs';

const modules=['consentManagementTcf','currency','priceFloors','pubmaticBidAdapter','tcfControl','33acrossBidAdapter','33acrossIdSystem','51DegreesRtdProvider','1plusXRtdProvider'];
const bytes=extra=>new TextEncoder().encode(`/* prebid.js v11.34.0\nModules: ${modules.join(', ')}${extra??''} */\nthrow Error('Synthetic upload must not execute');`);
const active=[];
test.afterEach(()=>{while(active.length)active.pop().close();});
const jsonRequest=body=>new Request('https://audit.invalid/api/sites',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
async function fixture(){
  const f=workspaceStore();active.push(f);
  f.sqlite.exec(readFileSync('migrations/0001_initial.sql','utf8').split('INSERT OR IGNORE INTO publishers')[0]);
  f.sqlite.exec(readFileSync('migrations/0002_publisher_accounts.sql','utf8').split('-- Politika.rs')[0]);
  assert.equal((await createSite(jsonRequest({id:'source',name:'Source',domain:'source.invalid',gamPath:'/123/source/'}),f.env)).status,201);
  f.sqlite.exec(`INSERT INTO ad_units(id,publisher_id,code,type,media_type,size_map_key,enabled,sort_order) VALUES('unit','source','P1','ATF','banner','display',1,0);
    INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('map','source','display','[{"minViewPort":[0,0],"sizes":[[300,250]]}]');
    INSERT INTO bidders(id,publisher_id,bidder,params_json,enabled) VALUES('bidder','source','pubmatic','{"publisherId":"synthetic","adSlot":"synthetic"}',1);`);
  f.env.BUILDS={
    async get(key){const b=f.objects.get(key);return b?{size:b.length,customMetadata:f.metadata.get(key),async arrayBuffer(){return b.slice().buffer;}}:null;},
    async head(key){return f.objects.has(key)?{size:f.objects.get(key).length}:null;},
    async put(key,input,options){if(options.onlyIf&&f.objects.has(key))return null;f.objects.set(key,new Uint8Array(input).slice());f.metadata.set(key,options.customMetadata);return {key};},
    async delete(key){f.objects.delete(key);},
  };
  return f;
}
async function upload(f,input){
  const form=new FormData();form.set('file',new File([input],'prebid.js',{type:'application/javascript'}));
  const response=await uploadPrebidBuild(new Request('https://audit.invalid/upload',{method:'POST',body:form}),f.env,'source');
  const payload=await response.json();assert.equal(response.status,201,JSON.stringify(payload));return payload;
}
async function select(f,version){const s=await siteRuntimeSettings(f.env,'source');const r=s.runtimes.find(r=>r.version===version);assert(r);await changeSiteRuntime(f.env,'source','tester',{action:'setup',revision:s.revision,runtime:r.pin,allowPreview:true,enablePrebid:true});}
async function bundle(f,site='source'){const s=await siteRuntimeSettings(f.env,site);const response=await siteRuntimeBundle(f.env,site,{action:'bundle',revision:s.revision,acknowledge:true});assert.equal(response.status,200);return unzipSync(new Uint8Array(await response.arrayBuffer()));}

test('MAIN upload, exact 3.16 selection, activation, generation and site copy keep digit-module bytes unchanged',async()=>{
  const f=await fixture(),original=bytes();const first=await upload(f,original);
  assert.equal(first.build.status,'current');assert.equal(first.warnings.length,0);
  await select(f,'3.16.0');const firstZip=await bundle(f);assert.deepEqual(firstZip['prebid.js'],original);
  const replacement=new TextEncoder().encode(new TextDecoder().decode(original)+'\n// replacement');
  const next=await upload(f,replacement);assert.equal(next.build.status,'archived');
  const activated=await activatePrebidBuild(new Request('https://audit.invalid/activate',{method:'POST'}),f.env,'source',next.build.id);
  assert.equal(activated.status,200,await activated.text());
  assert.deepEqual((await bundle(f))['prebid.js'],replacement);assert.deepEqual(firstZip['prebid.js'],original);
  assert.equal((await duplicateSite(jsonRequest({id:'copy',name:'Copy',domain:'copy.invalid',gamPath:'/123/copy/',copyPrebidBuild:true}),f.env,'source')).status,201);
  assert.deepEqual((await bundle(f,'copy'))['prebid.js'],replacement);
  await select(f,'3.14.0');const files=await bundle(f);assert.deepEqual(files['prebid.js'],replacement);
  const {descriptor}=await describeCandidate('source',{files});
  await verifyPackage(files,{site_id:'source',release_id:descriptor.releaseId,release_version:descriptor.releaseId});
});
test('MAIN upload marks malformed module declarations invalid and never current',async()=>{
  const f=await fixture();const malformed=await upload(f,bytes(', bad-module'));
  assert.equal(malformed.build.status,'invalid');assert(malformed.warnings.some(message=>/module name.*could not be read/.test(message)));
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM prebid_builds WHERE status='current'").get().n,0);
});
