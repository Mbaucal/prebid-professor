import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSiteRuntimeSelection, readPinnedSiteRuntime, RuntimeSelectionError } from '../../worker/runtime/site-runtime-selection.mjs';
import { pinRuntime } from '../../worker/runtime/version-pin.mjs';
import { digest } from '../../worker/runtime/preview-snapshot.mjs';
import { sha256 } from '../../worker/runtime/prebid-artifact-check.mjs';

const clone = (v) => structuredClone(v);
const baseRuntime = { id:'fixture-engine',version:'1.2.3',codeSha256:'a'.repeat(64),configSchemaVersion:1,channel:'stable',capabilities:['config-preview'] };
const modules = ['ixBidAdapter','consentManagementTcf','tcfControl','currency'].sort();
const content = (version='9.1.0',list=modules,tail='') => new TextEncoder().encode(
  `/* prebid.js v${version}\nModules: ${list.join(', ')} */\nthrow Error('SYNTHETIC FILE MUST NOT EXECUTE');\n${tail}`);
async function fixture() {
  const f = { calls:[],bodyReads:0,bytes:content(),metadata:null, runtime:clone(baseRuntime) };
  f.snapshot = {
    site:{id:'test-site',name:'Synthetic site',domain:'example.invalid',gam_path:'/123/test/'},
    config:{config_json:JSON.stringify({enablePrebid:false,runtimeControls:{sticky:{bottomAdUnitId:''},floors:{enabled:false},output:{cleanComments:true}},unrelated:{keep:'unchanged'}})},
    units:[{code:'Billboard',type:'ATF',media_type:'banner',size_map_key:'display',enabled:1,sort_order:0}],
    maps:[{name:'display',map_json:JSON.stringify([{viewport:[0,0],sizes:[[300,250]]}])}],
    rules:[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({timeout:1500,refresh:{enabled:false}})}],
    bidders:[{bidder:'ix',params_json:'{"siteId":"synthetic-only"}',enabled:1}],overrides:[],
    prebidBuilds:[{id:'pb-one',publisher_id:'test-site',version:'9.1.0',file_key:'publishers/test-site/prebid-builds/pb-one/prebid.js',modules_json:JSON.stringify(modules),status:'current',uploaded_at:'2026-01-01T00:00:00Z'}],
  };
  f.metadata = {sha256:await sha256(f.bytes),version:'9.1.0'};
  f.bucket = {async get(key) {
    f.calls.push(key);
    if (f.failRead) throw Error('SENSITIVE_STORAGE_ERROR');
    if (f.missing) return null;
    return {size:f.overrideSize ?? f.bytes.byteLength,customMetadata:f.metadata,async arrayBuffer() {
      f.bodyReads++;
      if (f.failBody) throw Error('SENSITIVE_BODY_ERROR');
      if (f.wrongLength) return new ArrayBuffer(1);
      return f.bytes.buffer.slice(f.bytes.byteOffset,f.bytes.byteOffset+f.bytes.byteLength);
    }};
  }};
  f.request = {siteId:'test-site',snapshot:f.snapshot,catalog:[f.runtime],expectedRevision:await digest(f.snapshot),
    selection:{runtime:clone(pinRuntime(f.runtime)),allowPreview:false,enablePrebid:false,prebidBuildId:null}};
  f.rebase = async () => { f.request.expectedRevision = await digest(f.snapshot); };
  f.enable = () => { f.request.selection.enablePrebid=true;f.request.selection.prebidBuildId='pb-one'; };
  f.prepare = () => prepareSiteRuntimeSelection(f.request,f.bucket);
  f.adoptInMemory = (plan) => { f.snapshot.config.config_json=plan.configJson; };
  f.resolve = () => readPinnedSiteRuntime({siteId:'test-site',snapshot:f.snapshot,catalog:f.request.catalog},f.bucket);
  return f;
}
const rejects = (operation,code) => assert.rejects(operation,(e)=>e instanceof RuntimeSelectionError && e.code===code);

test('GPT-only plans exact runtime, preserves other settings and never reads R2',async()=>{
  const f=await fixture(), original=clone(f.snapshot), plan=await f.prepare();
  assert.equal(plan.persisted,false);assert.equal(plan.publishable,false);assert.equal(plan.changed,true);
  assert.equal(plan.basedOnRevision,f.request.expectedRevision);assert.deepEqual(plan.selection.runtime,pinRuntime(f.runtime));
  const config=JSON.parse(plan.configJson);assert.deepEqual(config.unrelated,{keep:'unchanged'});
  assert.deepEqual(config.runtimeControls,JSON.parse(original.config.config_json).runtimeControls);
  assert.equal(config.enablePrebid,false);assert.equal(plan.selection.prebid,null);
  assert.deepEqual(f.snapshot,original);assert.equal(f.calls.length,0);
});
test('repeating the same selection is a no-change proposal',async()=>{
  const f=await fixture();f.adoptInMemory(await f.prepare());await f.rebase();
  assert.equal((await f.prepare()).changed,false);
});
test('GPT-only resolution uses saved pin, does not silently enable an available build',async()=>{
  const f=await fixture();f.adoptInMemory(await f.prepare());
  const result=await f.resolve();assert.equal(result.prebid,null);assert.equal(result.publishable,false);
  assert.deepEqual(result.pin,pinRuntime(f.runtime));assert.equal(result.snapshot.prebidBuilds,undefined);assert.equal(f.calls.length,0);
});
test('Prebid proposal pins exact verified bytes, version and module declarations',async()=>{
  const f=await fixture();f.enable();const plan=await f.prepare();
  assert.deepEqual(plan.selection.prebid,{id:'pb-one',version:'9.1.0',sha256:f.metadata.sha256,byteSize:f.bytes.byteLength,modules});
  assert.equal(f.calls.length,1);assert.equal(f.bodyReads,1);assert.equal(plan.persisted,false);
});
test('generation rechecks saved Prebid pin and returns the same inspected bytes',async()=>{
  const f=await fixture();f.enable();f.adoptInMemory(await f.prepare());f.calls=[];f.bodyReads=0;
  const result=await f.resolve();assert.equal(result.prebid.report.status,'checked');
  assert.deepEqual(new Uint8Array(result.prebid.bytes),f.bytes);assert.equal(f.calls.length,1);assert.equal(f.bodyReads,1);
  assert.equal(result.prebid.report.build.sha256,await sha256(result.prebid.bytes));
});
test('explicit GPT-only switch clears the proposal pin without deleting stored build records',async()=>{
  const f=await fixture();f.enable();f.adoptInMemory(await f.prepare());await f.rebase();f.calls=[];
  f.request.selection.enablePrebid=false;f.request.selection.prebidBuildId=null;
  const plan=await f.prepare();assert.equal(plan.selection.prebid,null);assert.equal(f.calls.length,0);assert.equal(f.snapshot.prebidBuilds.length,1);
});
for(const key of ['runtimeVersion','runtimeSha256','capabilities','configSchemaVersion'])test(`changed runtime ${key} is rejected before storage`,async()=>{
  const f=await fixture();f.enable();f.request.selection.runtime[key]=key==='capabilities'?[]:key==='configSchemaVersion'?2:key==='runtimeSha256'?'b'.repeat(64):'stable';
  await rejects(f.prepare,key==='runtimeVersion'?'runtime_unavailable':'runtime_changed');assert.equal(f.calls.length,0);
});
test('preview runtime requires explicit initial consent, not consent on every generation',async()=>{
  const f=await fixture();f.runtime.channel='preview';f.runtime.version='1.3.0-preview.1';
  f.request.selection.runtime=pinRuntime(f.runtime,{allowPreview:true});
  await rejects(f.prepare,'preview_opt_in_required');f.request.selection.allowPreview=true;
  f.adoptInMemory(await f.prepare());assert.equal((await f.resolve()).pin.runtimeVersion,'1.3.0-preview.1');
});
test('adding a newer stable version never upgrades an already pinned runtime',async()=>{
  const f=await fixture();f.adoptInMemory(await f.prepare());
  f.request.catalog.unshift({...clone(f.runtime),version:'2.0.0',codeSha256:'b'.repeat(64)});
  assert.equal((await f.resolve()).pin.runtimeVersion,'1.2.3');
});
test('missing exact runtime never falls back to a catalog entry',async()=>{
  const f=await fixture();f.adoptInMemory(await f.prepare());f.request.catalog=[{...clone(f.runtime),version:'2.0.0'}];
  await rejects(f.resolve,'runtime_unavailable');
});
test('duplicate catalog identity is ambiguous even when hash differs',async()=>{
  const f=await fixture();f.request.catalog.push({...clone(f.runtime),codeSha256:'b'.repeat(64)});await rejects(f.prepare,'invalid_catalog');
});
test('legacy/unpinned configuration requires selection instead of guessing',async()=>{
  const f=await fixture();await rejects(f.resolve,'runtime_selection_required');assert.equal(f.calls.length,0);
});
for(const mutate of [
  f=>{f.snapshot.site.name='changed';},
  f=>{f.snapshot.maps[0].map_json='[]';},
  f=>{f.snapshot.prebidBuilds[0].version='9.2.0';},
])test('stale review of site settings or build metadata is refused before R2',async()=>{
  const f=await fixture();f.enable();mutate(f);await rejects(f.prepare,'configuration_changed');assert.equal(f.calls.length,0);
});
test('caller mutations after the first await cannot alter the planned selection',async()=>{
  const f=await fixture();const pending=f.prepare();
  f.snapshot.site.id='other-site';f.request.selection.enablePrebid=true;f.runtime.codeSha256='b'.repeat(64);
  const plan=await pending;assert.equal(plan.siteId,'test-site');assert.equal(plan.selection.prebid,null);assert.equal(plan.selection.runtime.runtimeSha256,'a'.repeat(64));
});
for(const value of [null,'latest','other-build'])test(`explicit enabled build ID ${value} cannot select automatically`,async()=>{
  const f=await fixture();f.enable();f.request.selection.prebidBuildId=value;
  await rejects(f.prepare,'prebid_selection_required');assert.equal(f.calls.length,0);
});
test('two current builds cannot be hidden by choosing one ID',async()=>{
  const f=await fixture();f.enable();f.snapshot.prebidBuilds.push({...f.snapshot.prebidBuilds[0],id:'pb-two'});await f.rebase();
  await rejects(f.prepare,'prebid_selection_required');assert.equal(f.calls.length,0);
});
for(const mutate of [
  f=>{f.snapshot.prebidBuilds[0].publisher_id='other-site';},
  f=>{f.snapshot.prebidBuilds[0].file_key='publishers/other-site/prebid-builds/pb-one/prebid.js';},
  f=>{f.snapshot.prebidBuilds[0].status='archived';},
])test('wrong site, object path or archived build is not read or relabelled',async()=>{
  const f=await fixture();f.enable();mutate(f);await f.rebase();await rejects(f.prepare,'prebid_verification_failed');assert.equal(f.calls.length,0);
});
for(const kind of ['missing','checksum','header','modules','version','size','read','body','length'])test(`Prebid ${kind} failure blocks and redacts errors`,async()=>{
  const f=await fixture();f.enable();
  if(kind==='missing')f.missing=true;
  if(kind==='checksum')f.metadata.sha256='b'.repeat(64);
  if(kind==='header'){f.bytes=new TextEncoder().encode('<html>SENSITIVE_INPUT</html>');f.metadata.sha256=await sha256(f.bytes);}
  if(kind==='modules'){f.snapshot.prebidBuilds[0].modules_json='[]';await f.rebase();}
  if(kind==='version')f.metadata.version='9.2.0';
  if(kind==='size')f.overrideSize=8*1024*1024+1;
  if(kind==='read')f.failRead=true;
  if(kind==='body')f.failBody=true;
  if(kind==='length')f.wrongLength=true;
  await assert.rejects(f.prepare,e=>e.code==='prebid_verification_failed'&&!String(e).includes('SENSITIVE'));
  if(kind==='size')assert.equal(f.bodyReads,0);
});
test('self-consistently replaced Prebid bytes still conflict with persisted pin',async()=>{
  const f=await fixture();f.enable();f.adoptInMemory(await f.prepare());
  f.bytes=content('9.1.0',modules,'// replacement');f.metadata.sha256=await sha256(f.bytes);
  await rejects(f.resolve,'prebid_pin_changed');
});
test('changing current build does not automatically replace the saved one',async()=>{
  const f=await fixture();f.enable();f.adoptInMemory(await f.prepare());f.snapshot.prebidBuilds[0].id='pb-two';
  await rejects(f.resolve,'prebid_selection_required');
});
test('new configured bidder requirements are checked again before generation',async()=>{
  const f=await fixture();f.enable();f.adoptInMemory(await f.prepare());f.snapshot.bidders.push({bidder:'openx',params_json:'{}',enabled:1});
  await rejects(f.resolve,'prebid_verification_failed');
});
test('unsupported bidder mapping fails without reading artifact storage',async()=>{
  const f=await fixture();f.enable();f.snapshot.bidders[0].bidder='unknown';await f.rebase();
  await rejects(f.prepare,'unsupported_prebid_modules');assert.equal(f.calls.length,0);
});
test('unsupported existing top-sticky configuration is not silently discarded',async()=>{
  const f=await fixture();const c=JSON.parse(f.snapshot.config.config_json);c.runtimeControls.sticky.topAdUnitId='Top';f.snapshot.config.config_json=JSON.stringify(c);await f.rebase();
  await rejects(f.prepare,'unsupported_configuration');assert.equal(f.calls.length,0);
});
for(const key of ['source','template','file_url','configJson'])test(`browser ${key} is not a selection input`,async()=>{
  const f=await fixture();f.request.selection[key]='SENSITIVE_INPUT';await rejects(f.prepare,'invalid_selection');
});
test('site mismatch is refused before configuration or storage use',async()=>{
  const f=await fixture();f.request.siteId='other-site';await rejects(f.prepare,'site_snapshot_required');assert.equal(f.calls.length,0);
});
test('prototype keys nested inside arrays are rejected',async()=>{
  const f=await fixture();f.request.selection.extra=JSON.parse('[[{"__proto__":{"bad":true}}]]');await rejects(f.prepare,'invalid_input');
});
test('getter properties are rejected without execution',async()=>{
  const f=await fixture();Object.defineProperty(f.request.selection,'source',{enumerable:true,get(){assert.fail('getter executed');}});await rejects(f.prepare,'invalid_input');
});
test('cyclic and non-JSON values do not hang or get silently dropped',async()=>{
  const f=await fixture();f.request.selection.extra=f.request.selection;await rejects(f.prepare,'invalid_input');
  const g=await fixture();g.request.selection.allowPreview=undefined;await rejects(g.prepare,'invalid_input');
});
test('inconsistent GPT-only stored pin is rejected, not repaired',async()=>{
  const f=await fixture();f.enable();f.adoptInMemory(await f.prepare());const c=JSON.parse(f.snapshot.config.config_json);c.enablePrebid=false;f.snapshot.config.config_json=JSON.stringify(c);
  await rejects(f.resolve,'prebid_mode_mismatch');
});
test('returned bytes cannot mutate the stored fixture or a subsequent resolve',async()=>{
  const f=await fixture();f.enable();f.adoptInMemory(await f.prepare());const result=await f.resolve();new Uint8Array(result.prebid.bytes).fill(0);
  assert.equal((await f.resolve()).prebid.report.build.sha256,f.metadata.sha256);
});
